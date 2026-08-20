/**
 * Phase 2.1 — Cross-module activity audit trail
 * Office manager entries enter PENDING review until association office bearers approve.
 */
import { portalState, supabase } from './store.js';
import { canReviewAudit, isOfficeManager } from './rbac.js';
import { getReviewerUserIds, queueStaffNotifications, refreshStaffNotifications } from './staffNotifications.js';

const ENTITY_LABELS = {
    INVOICE: 'Invoice',
    RESIDENT: 'Resident',
    ROLE: 'Role',
    ALLOCATION: 'Payment allocation',
    REMINDER: 'Reminder',
    BANK_MATCH: 'Bank reconciliation',
    VISITOR: 'Visitor',
    PARKING_VIOLATION: 'Parking violation',
    PAYMENT_INTENT: 'Payment',
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
};

const REVIEW_LABELS = {
    PENDING: 'Awaiting review',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
};

const actorLabel = async () => {
    if (portalState.auth?.name) return portalState.auth.name;
    if (portalState.auth?.email) return portalState.auth.email;
    if (!supabase) return 'System';
    const { data: { user } } = await supabase.auth.getUser();
    return user?.email || user?.id || 'System';
};

const reviewStatusForActor = () => (isOfficeManager() ? 'PENDING' : 'APPROVED');

async function notifyReviewersOfPendingEntry({ entryId, summary, actorLabel, apartmentId, actorId }) {
    const reviewerIds = await getReviewerUserIds(apartmentId, actorId);
    if (!reviewerIds.length) return 0;
    const count = await queueStaffNotifications(reviewerIds.map((user_id) => ({
        apartment_id: apartmentId,
        user_id,
        activity_audit_log_id: entryId,
        title: 'Audit entry awaiting review',
        body: `${actorLabel || 'Office manager'} submitted: ${summary || 'New activity entry'}. Review and approve or reject.`,
    })));
    if (count) refreshStaffNotifications().catch(() => {});
    return count;
}

async function notifyActorOfReviewOutcome({ entry, approved, reviewerLabel, notes }) {
    if (!entry?.actor_id || entry.actor_id === portalState.auth?.id) return 0;
    const apartmentId = entry.apartment_id || portalState.access?.activeApartmentId;
    const statusWord = approved ? 'approved' : 'rejected';
    const body = approved
        ? `${reviewerLabel || 'An office bearer'} approved your entry: ${entry.summary || '—'}.`
        : `${reviewerLabel || 'An office bearer'} rejected your entry: ${entry.summary || '—'}${notes ? ` — ${notes}` : ''}.`;
    const count = await queueStaffNotifications([{
        apartment_id: apartmentId,
        user_id: entry.actor_id,
        activity_audit_log_id: entry.id,
        title: `Audit entry ${statusWord}`,
        body,
    }]);
    if (count) refreshStaffNotifications().catch(() => {});
    return count;
}

export async function logActivity({
    entityType,
    entityId,
    action,
    summary,
    oldData = null,
    newData = null,
    apartmentId = portalState.access?.activeApartmentId,
}) {
    if (!supabase || !apartmentId) return null;

    const { data: { user } } = await supabase.auth.getUser();
    const reviewStatus = reviewStatusForActor();
    const row = {
        id: crypto.randomUUID(),
        apartment_id: apartmentId,
        entity_type: entityType,
        entity_id: String(entityId),
        action,
        actor_id: user?.id || null,
        actor_label: await actorLabel(),
        summary: summary || `${ACTION_LABELS[action] || action} ${ENTITY_LABELS[entityType] || entityType}`,
        old_data: oldData,
        new_data: newData,
        review_status: reviewStatus,
    };

    const { data, error } = await supabase.from('activity_audit_log').insert(row).select('id, review_status').single();
    if (error) {
        if (/activity_audit_log/i.test(error.message)) {
            console.warn('[audit] activity_audit_log table missing — run supabase_activity_audit_log.sql');
            return null;
        }
        if (/review_status/i.test(error.message)) {
            delete row.review_status;
            const { data: fallback, error: fallbackErr } = await supabase
                .from('activity_audit_log')
                .insert(row)
                .select('id')
                .single();
            if (fallbackErr) {
                console.warn('[audit] log failed:', fallbackErr.message);
                return null;
            }
            return { id: fallback?.id || null, reviewStatus: 'APPROVED' };
        }
        console.warn('[audit] log failed:', error.message);
        return null;
    }
    const result = { id: data?.id || null, reviewStatus: data?.review_status || reviewStatus };
    if (result.reviewStatus === 'PENDING' && result.id) {
        await notifyReviewersOfPendingEntry({
            entryId: result.id,
            summary: row.summary,
            actorLabel: row.actor_label,
            apartmentId,
            actorId: user?.id,
        });
    }
    return result;
}

/** Message shown after office manager submits an auditable action */
export function auditSubmitHint(result) {
    const status = typeof result === 'object' ? result?.reviewStatus : null;
    if (status === 'PENDING') {
        return 'Saved — submitted for review. Association office bearers have been notified.';
    }
    return null;
}

export async function fetchActivityLog(
    apartmentId,
    { entityType = '', fromDate = '', toDate = '', actor = '', reviewStatus = '', limit = 200 } = {},
) {
    if (!supabase) throw new Error('Supabase is not configured.');
    if (!apartmentId) throw new Error('No apartment selected.');
    let q = supabase
        .from('activity_audit_log')
        .select('*')
        .eq('apartment_id', apartmentId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (entityType) q = q.eq('entity_type', entityType);
    if (fromDate) q = q.gte('created_at', `${fromDate}T00:00:00`);
    if (toDate) q = q.lte('created_at', `${toDate}T23:59:59`);
    if (actor) q = q.ilike('actor_label', `%${actor}%`);
    if (reviewStatus) {
        q = q.eq('review_status', reviewStatus);
    }

    const { data, error } = await q;
    if (error) {
        if (/activity_audit_log/i.test(error.message)) {
            throw new Error('Activity log table is not set up yet. Run the activity_audit_log SQL migration.');
        }
        if (/review_status/i.test(error.message)) {
            return fetchActivityLogLegacy(apartmentId, { entityType, fromDate, toDate, actor, limit });
        }
        throw error;
    }

    let rows = data || [];
    // Client-side review filter: custom /api/db query builder has no .or().
    // Treat legacy null status as approved/visible.
    if (!reviewStatus) {
        if (isOfficeManager()) {
            rows = rows.filter((r) => !r.review_status || r.review_status === 'APPROVED' || r.review_status === 'PENDING');
        } else if (!canReviewAudit()) {
            rows = rows.filter((r) => !r.review_status || r.review_status === 'APPROVED');
        }
    }
    return rows;
}

async function fetchActivityLogLegacy(apartmentId, { entityType, fromDate, toDate, actor, limit }) {
    let q = supabase
        .from('activity_audit_log')
        .select('*')
        .eq('apartment_id', apartmentId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (entityType) q = q.eq('entity_type', entityType);
    if (fromDate) q = q.gte('created_at', `${fromDate}T00:00:00`);
    if (toDate) q = q.lte('created_at', `${toDate}T23:59:59`);
    if (actor) q = q.ilike('actor_label', `%${actor}%`);
    const { data, error } = await q;
    if (error) return [];
    return data || [];
}

export async function fetchPendingAuditEntries(apartmentId, limit = 50) {
    if (!supabase || !apartmentId || !canReviewAudit()) return [];
    const { data, error } = await supabase
        .from('activity_audit_log')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('review_status', 'PENDING')
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) {
        if (/review_status/i.test(error.message)) return [];
        throw error;
    }
    return data || [];
}

export async function reviewAuditEntry(entryId, approved, notes = '') {
    if (!supabase) throw new Error('Supabase is not configured.');
    if (!canReviewAudit()) throw new Error('Only association office bearers can review audit entries.');
    const { data: { user } } = await supabase.auth.getUser();
    const reviewerLabel = portalState.auth?.name || portalState.auth?.email || 'Reviewer';
    const { data, error } = await supabase
        .from('activity_audit_log')
        .update({
            review_status: approved ? 'APPROVED' : 'REJECTED',
            reviewed_by: user?.id || null,
            reviewed_at: new Date().toISOString(),
            review_notes: notes?.trim() || null,
        })
        .eq('id', entryId)
        .eq('review_status', 'PENDING')
        .select('id, review_status, summary, actor_id, actor_label, entity_type, action, apartment_id')
        .single();
    if (error) throw new Error(error.message);
    await notifyActorOfReviewOutcome({ entry: data, approved, reviewerLabel, notes });
    return data;
}

export async function fetchEntityActivity(entityType, entityId, limit = 20) {
    if (!supabase) return [];
    const apartmentId = portalState.access?.activeApartmentId;
    let q = supabase
        .from('activity_audit_log')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('entity_type', entityType)
        .eq('entity_id', String(entityId))
        .order('created_at', { ascending: false })
        .limit(limit);
    if (!canReviewAudit()) q = q.eq('review_status', 'APPROVED');
    const { data, error } = await q;
    if (error) return [];
    return data || [];
}

const formatWhen = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
};

const reviewBadgeHtml = (status) => {
    if (!status || status === 'APPROVED') return '';
    const cls = status === 'PENDING' ? 'activity-review-badge--pending' : 'activity-review-badge--rejected';
    return `<span class="activity-review-badge ${cls}">${REVIEW_LABELS[status] || status}</span>`;
};

export const renderActivityLogList = (rows, containerId = 'activity-log-list') => {
    const list = document.getElementById(containerId);
    if (!list) return;

    if (!rows.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No activity recorded for these filters.</p>';
        return;
    }

    list.innerHTML = rows.map((r) => `
      <div class="apt-row activity-log-row">
        <div class="activity-log-row__when">${formatWhen(r.created_at)}</div>
        <div><span class="activity-entity-badge">${ENTITY_LABELS[r.entity_type] || r.entity_type}</span></div>
        <div class="activity-log-row__summary"><strong>${r.summary || '—'}</strong>
          ${reviewBadgeHtml(r.review_status)}
          <span>${ACTION_LABELS[r.action] || r.action} · ${r.actor_label || '—'}</span></div>
      </div>`).join('');
};

export const renderPendingAuditQueue = async () => {
    const wrap = document.getElementById('activity-review-queue');
    const list = document.getElementById('activity-review-list');
    if (!wrap || !list) return;

    if (!canReviewAudit()) {
        wrap.style.display = 'none';
        return;
    }

    const apartmentId = portalState.access?.activeApartmentId;
    const pending = await fetchPendingAuditEntries(apartmentId);
    wrap.style.display = pending.length ? 'block' : 'none';

    if (!pending.length) {
        list.innerHTML = '';
        return;
    }

    list.innerHTML = pending.map((r) => `
      <div class="apt-row activity-review-row" data-audit-id="${r.id}">
        <div class="activity-log-row__when">${formatWhen(r.created_at)}</div>
        <div><span class="activity-entity-badge">${ENTITY_LABELS[r.entity_type] || r.entity_type}</span></div>
        <div class="activity-log-row__summary">
          <strong>${r.summary || '—'}</strong>
          <span>${ACTION_LABELS[r.action] || r.action} · ${r.actor_label || '—'}</span>
        </div>
        <div class="activity-review-row__actions">
          <button type="button" class="btn btn-primary btn--small activity-review-approve" data-id="${r.id}" title="Approve">
            <i class="fa-solid fa-check"></i> Approve
          </button>
          <button type="button" class="btn btn-outline btn--small activity-review-reject" data-id="${r.id}" title="Reject">
            <i class="fa-solid fa-xmark"></i> Reject
          </button>
        </div>
      </div>`).join('');
};

const handleReviewAction = async (entryId, approved) => {
    const notes = approved
        ? ''
        : (window.prompt('Reason for rejection (optional):') || '');
    try {
        await reviewAuditEntry(entryId, approved, notes);
        await renderPendingAuditQueue();
        await renderActivityLogPage();
        refreshStaffNotifications().catch(() => {});
    } catch (err) {
        alert(err?.message || 'Review action failed.');
    }
};

export const renderInvoiceActivityHistory = async (invoiceId, containerId = 'invoice-detail-history') => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const rows = await fetchEntityActivity('INVOICE', invoiceId);
    if (!rows.length) {
        el.innerHTML = '<p class="maintenance-alloc-hint">No audit history for this invoice.</p>';
        return;
    }
    el.innerHTML = `<ul class="invoice-history-list">${rows.map((r) =>
        `<li><span>${formatWhen(r.created_at)}</span> <strong>${r.summary}</strong> <em>${r.actor_label || ''}</em></li>`,
    ).join('')}</ul>`;
};

export const renderActivityLogPage = async () => {
    const list = document.getElementById('activity-log-list');
    if (list) list.innerHTML = '<p class="maintenance-dues-empty">Loading activity…</p>';

    try {
        const apartmentId = portalState.access?.activeApartmentId;
        const entityType = document.getElementById('activity-filter-entity')?.value || '';
        const fromDate = document.getElementById('activity-filter-from')?.value || '';
        const toDate = document.getElementById('activity-filter-to')?.value || '';
        const actor = (document.getElementById('activity-filter-actor')?.value || '').trim();

        await renderPendingAuditQueue();
        const rows = await fetchActivityLog(apartmentId, { entityType, fromDate, toDate, actor });
        renderActivityLogList(rows);
    } catch (err) {
        console.warn('[activity] load failed', err);
        if (list) {
            list.innerHTML = `<p class="maintenance-dues-empty">${err?.message || 'Could not load activity log.'}</p>`;
        }
        throw err;
    }
};

export const initActivityAuditUi = () => {
    if (document.body.dataset.activityAuditWired === '1') return;
    document.body.dataset.activityAuditWired = '1';

    document.getElementById('activity-filter-apply')?.addEventListener('click', () => {
        renderActivityLogPage().catch(() => {});
    });
    document.getElementById('activity-filter-reset')?.addEventListener('click', () => {
        ['activity-filter-entity', 'activity-filter-from', 'activity-filter-to', 'activity-filter-actor']
            .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
        renderActivityLogPage().catch(() => {});
    });

    document.getElementById('activity-review-list')?.addEventListener('click', (e) => {
        const approveBtn = e.target.closest('.activity-review-approve');
        const rejectBtn = e.target.closest('.activity-review-reject');
        if (approveBtn) handleReviewAction(approveBtn.dataset.id, true);
        if (rejectBtn) handleReviewAction(rejectBtn.dataset.id, false);
    });
};

window.renderActivityLogPage = renderActivityLogPage;
