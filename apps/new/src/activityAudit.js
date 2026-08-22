/**
 * New UI activity trail — consolidated Mongo `/api/activity/events`
 * (activity_audit_log + vehicle_audit_log / parking).
 *
 * Client writes use a durable local outbox: network / 5xx failures are queued in
 * localStorage and flushed when online again (idempotent client-generated ids).
 */
import { portalState } from './store.js';
import { readApiJson } from './apiJson.js';

/** Friendly labels when we know them; unknown codes show as-is / title-cased. */
const ENTITY_LABELS = {
    INVOICE: 'Invoice',
    RESIDENT: 'Resident',
    ROLE: 'Role',
    ALLOCATION: 'Payment allocation',
    REMINDER: 'Reminder',
    BANK_MATCH: 'Bank reconciliation',
    VISITOR: 'Visitor',
    PARKING: 'Parking',
    PARKING_VIOLATION: 'Parking violation',
    PAYMENT_INTENT: 'Payment',
    GATE_PARCEL: 'Gate parcel',
    UNIT: 'Unit',
    UNIT_TRANSITION: 'Unit transition',
    PAYROLL: 'Payroll',
    LEDGER_SYNC: 'Spreadsheet sync',
    TRANSACTION: 'Transaction',
    VISITOR_PASS: 'Visitor pass',
    VEHICLE: 'Parking',
    SOCIETY: 'Society',
    MODULE_ACCESS: 'Module access',
    BANK_ACCOUNT: 'Bank account',
    VENDOR: 'Vendor',
    EXPENSE_CATEGORY: 'Expense category',
    STAFF: 'Staff',
    INTEGRATION: 'Integration',
    CHARGE_HEAD: 'Charge head',
    BILLING_GROUP: 'Billing group',
    BANK_STATEMENT: 'Bank statement',
    VOUCHER: 'Voucher',
};

const ACTION_LABELS = {
    CREATE: 'Created',
    UPDATE: 'Updated',
    DELETE: 'Deleted',
    SEND_PDF: 'Sent PDF',
    SEND_EMAIL: 'Sent email',
    IMPORT: 'Imported',
    GRANT: 'Granted',
    REVOKE: 'Revoked',
    MATCH: 'Matched',
    UNMATCH: 'Unmatched',
    IGNORE: 'Ignored',
    INSERT: 'Created',
};

const OUTBOX_KEY = 'ch_activity_audit_outbox_v1';
const MAX_OUTBOX = 200;
const MAX_ATTEMPTS = 12;
const FLUSH_INTERVAL_MS = 30_000;

let flushTimer = null;
let flushInFlight = null;
let flushersInstalled = false;

function titleCaseCode(code) {
    return String(code || '')
        .toLowerCase()
        .split(/[_\s]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ') || '—';
}

export function activityEntityLabel(entityType) {
    if (!entityType) return '—';
    return ENTITY_LABELS[entityType] || titleCaseCode(entityType);
}

export function activityActionLabel(action) {
    if (!action) return '—';
    return ACTION_LABELS[action] || titleCaseCode(action);
}

function newClientId() {
    try {
        return crypto.randomUUID();
    } catch {
        return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
}

function readOutbox() {
    try {
        const raw = localStorage.getItem(OUTBOX_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function writeOutbox(list) {
    try {
        localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-MAX_OUTBOX)));
    } catch (err) {
        console.warn('[audit] outbox persist failed', err);
    }
}

function enqueueOutbox(entry) {
    const list = readOutbox().filter((e) => e.id !== entry.id);
    list.push(entry);
    writeOutbox(list);
}

function buildPayload({
    id,
    apartmentId,
    entityType,
    entityId,
    action,
    summary,
    oldData,
    newData,
    actorLabel,
    createdAt,
}) {
    return {
        id,
        apartment_id: apartmentId,
        entity_type: entityType,
        entity_id: String(entityId),
        action,
        summary: summary || `${activityActionLabel(action)} ${activityEntityLabel(entityType)}`,
        old_data: oldData,
        new_data: newData,
        actor_label: actorLabel || portalState.auth?.name || portalState.auth?.email || null,
        created_at: createdAt || new Date().toISOString(),
    };
}

async function postActivityEvent(payload) {
    const res = await fetch('/api/activity/events', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) {
        const err = new Error(json?.error || error || `Audit POST failed (${res.status})`);
        err.status = res.status;
        err.retryable = res.status >= 500 || res.status === 0 || res.status === 408 || res.status === 429;
        // Auth failures should not spin forever in outbox with bad payload, but
        // session may refresh — keep retryable for 401/403 briefly.
        if (res.status === 401 || res.status === 403) err.retryable = true;
        throw err;
    }
    return json;
}

/**
 * Flush queued audit events to Mongo. Safe to call often (single-flight).
 * @returns {Promise<{ sent: number, remaining: number, failed: number }>}
 */
export async function flushActivityOutbox() {
    if (flushInFlight) return flushInFlight;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { sent: 0, remaining: readOutbox().length, failed: 0 };
    }

    flushInFlight = (async () => {
        const queue = readOutbox();
        if (!queue.length) return { sent: 0, remaining: 0, failed: 0 };

        const sentIds = [];
        let failed = 0;
        const next = [];

        for (const item of queue) {
            if ((item.attempts || 0) >= MAX_ATTEMPTS) {
                failed += 1;
                console.warn('[audit] dropping after max attempts', item.id, item.lastError);
                continue;
            }
            try {
                await postActivityEvent(item.payload);
                sentIds.push(item.id);
            } catch (err) {
                failed += 1;
                next.push({
                    ...item,
                    attempts: (item.attempts || 0) + 1,
                    lastError: err.message || String(err),
                    lastAttemptAt: new Date().toISOString(),
                });
                // Stop early on likely session/network issues — retry later.
                if (err.retryable !== false) break;
            }
        }

        // Preserve unprocessed + failed-for-retry; drop sent.
        const remainingTail = queue.filter((e) => !sentIds.includes(e.id) && !next.some((n) => n.id === e.id));
        writeOutbox([...next, ...remainingTail]);
        return { sent: sentIds.length, remaining: readOutbox().length, failed };
    })();

    try {
        return await flushInFlight;
    } finally {
        flushInFlight = null;
    }
}

/** Pending outbox size (for Activity page / diagnostics). */
export function getActivityOutboxStatus() {
    const items = readOutbox();
    return {
        pending: items.length,
        oldest: items[0]?.queuedAt || null,
        newest: items[items.length - 1]?.queuedAt || null,
    };
}

/**
 * Install online / visibility / interval flushers once per page.
 * Call after workspace boot on New MPAs.
 */
export function installActivityOutboxFlushers() {
    if (flushersInstalled || typeof window === 'undefined') return;
    flushersInstalled = true;

    const kick = () => { void flushActivityOutbox(); };

    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') kick();
    });
    window.addEventListener('focus', kick);
    flushTimer = window.setInterval(kick, FLUSH_INTERVAL_MS);
    kick();
}

export async function logActivity({
    entityType,
    entityId,
    action,
    summary,
    oldData = null,
    newData = null,
    apartmentId = portalState.access?.activeApartmentId,
} = {}) {
    if (!apartmentId || !entityType || !entityId || !action) return null;

    const id = newClientId();
    const createdAt = new Date().toISOString();
    const payload = buildPayload({
        id,
        apartmentId,
        entityType,
        entityId,
        action,
        summary,
        oldData,
        newData,
        createdAt,
    });

    try {
        // Drain older failures first so chronology stays roughly ordered.
        await flushActivityOutbox();
        const json = await postActivityEvent(payload);
        return { id: json.event?.id || id, reviewStatus: json.event?.review_status || 'APPROVED' };
    } catch (err) {
        enqueueOutbox({
            id,
            queuedAt: createdAt,
            attempts: 1,
            lastError: err.message || String(err),
            lastAttemptAt: createdAt,
            payload,
        });
        console.warn('[audit] queued for retry', err.message || err);
        // Best-effort: schedule another flush soon.
        if (typeof window !== 'undefined') {
            window.setTimeout(() => { void flushActivityOutbox(); }, 5_000);
        }
        return { id, queued: true, reviewStatus: null };
    }
}

export async function fetchActivityEvents(apartmentId, {
    entityType = '',
    action = '',
    limit = 500,
} = {}) {
    if (!apartmentId) throw new Error('Select a society first.');
    // Deliver any queued audits before reading the trail.
    await flushActivityOutbox().catch(() => {});
    const params = new URLSearchParams({ apartment_id: apartmentId, limit: String(limit) });
    if (entityType) params.set('entity_type', entityType);
    if (action) params.set('action', action);
    const res = await fetch(`/api/activity/events?${params}`, { credentials: 'include' });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Could not load activity.');
    return {
        events: json.events || [],
        counts: json.counts || { total: 0, by_entity: {}, activity: 0, parking: 0 },
        facets: json.facets || { entity_types: [], actions: [] },
        meta: json.meta || {},
        outbox: getActivityOutboxStatus(),
    };
}

/** Invoice history panel — no-op until entity detail UIs call Mongo. */
export async function renderInvoiceActivityHistory() {
    return null;
}
