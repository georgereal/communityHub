/**
 * Ledger spreadsheet sync — Mongo Integrations API (New Admin only).
 * No classic portalState / Supabase panel.
 */
import { portalState } from './store.js';
import { readApiJson } from './apiJson.js';

const aptId = () => portalState.access?.activeApartmentId;

/** @returns {Promise<{
 *   ledgerSyncSettings: object|null,
 *   ledgerOAuthApps: object[],
 *   myOAuthConnections: object[],
 *   syncServiceAccounts: object[],
 * }>} */
export async function fetchSpreadsheetSyncBoot() {
    const apartment_id = aptId();
    if (!apartment_id) throw new Error('Select a society first.');

    const res = await fetch(
        `/api/integrations/spreadsheet/boot?apartment_id=${encodeURIComponent(apartment_id)}`,
        { credentials: 'include' },
    );
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Could not load spreadsheet sync.');
    return {
        ledgerSyncSettings: json.ledgerSyncSettings || null,
        ledgerOAuthApps: json.ledgerOAuthApps || [],
        myOAuthConnections: json.myOAuthConnections || [],
        syncServiceAccounts: json.syncServiceAccounts || [],
    };
}

/** Keep list-page status in sync without classic store. */
export async function loadSpreadsheetSyncBoot() {
    const boot = await fetchSpreadsheetSyncBoot();
    portalState.finances = portalState.finances || {};
    portalState.finances.ledgerSyncSettings = boot.ledgerSyncSettings;
    portalState.finances.ledgerOAuthApps = boot.ledgerOAuthApps;
    portalState.finances.myOAuthConnections = boot.myOAuthConnections;
    portalState.finances.syncServiceAccounts = boot.syncServiceAccounts;
    portalState.finances._spreadsheetSyncSource = 'mongo';
    return boot;
}

export async function saveSpreadsheetSettings(patch) {
    const apartment_id = aptId();
    if (!apartment_id) throw new Error('Select a society first.');
    const res = await fetch(
        `/api/integrations/spreadsheet/settings?apartment_id=${encodeURIComponent(apartment_id)}`,
        {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apartment_id, ...patch }),
        },
    );
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Could not save settings.');
    const settings = json.settings;
    const { logActivity } = await import('./activityAudit.js');
    void logActivity({
        entityType: 'LEDGER_SYNC',
        entityId: apartment_id,
        action: 'UPDATE',
        summary: 'Updated spreadsheet sync workbook settings',
        newData: {
            provider: settings?.provider,
            spreadsheet_url: settings?.spreadsheet_url,
            sheet_name: settings?.sheet_name,
        },
    });
    return settings;
}

export async function saveSpreadsheetOAuthApp(payload) {
    const apartment_id = aptId();
    if (!apartment_id) throw new Error('Select a society first.');
    const res = await fetch(
        `/api/integrations/spreadsheet/oauth-apps?apartment_id=${encodeURIComponent(apartment_id)}`,
        {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apartment_id, ...payload }),
        },
    );
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Could not save OAuth app.');
    const row = json.row;
    const { logActivity } = await import('./activityAudit.js');
    void logActivity({
        entityType: 'LEDGER_SYNC',
        entityId: `${apartment_id}:${payload.provider || row?.provider}`,
        action: 'UPDATE',
        summary: `Updated spreadsheet OAuth app (${payload.provider || row?.provider})`,
        newData: { provider: payload.provider || row?.provider, client_id: row?.client_id },
    });
    return row;
}

export async function fetchSpreadsheetRuns(apartmentId, { limit = 100 } = {}) {
    const apartment_id = apartmentId || aptId();
    if (!apartment_id) throw new Error('Select a society first.');
    const params = new URLSearchParams({ apartment_id, limit: String(limit) });
    const res = await fetch(`/api/integrations/spreadsheet/runs?${params}`, { credentials: 'include' });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Could not load spreadsheet runs.');
    return {
        runs: json.runs || [],
        counts: json.counts || { total: 0, failed: 0, ok: 0 },
    };
}

export function spreadsheetStatusFromBoot(boot) {
    const s = boot?.ledgerSyncSettings;
    if (s?.spreadsheet_url) {
        const provider = String(s.provider || '').toLowerCase();
        const sub = provider === 'microsoft' ? 'Microsoft Excel'
            : provider === 'google' ? 'Google Sheets'
                : 'Linked';
        return { key: 'ready', label: 'Configured', tone: 'success', detail: sub };
    }
    const apps = boot?.ledgerOAuthApps || [];
    if (apps.some((a) => a.client_id)) {
        return { key: 'missing', label: 'Partial setup', tone: 'warning', detail: 'OAuth app only' };
    }
    return { key: 'missing', label: 'Not configured', tone: 'warning', detail: '' };
}
