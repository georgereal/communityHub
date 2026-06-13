/**
 * Phase 2.1 — Cross-module activity audit trail
 */
import { portalState, supabase } from './store.js';

const ENTITY_LABELS = {
    INVOICE: 'Invoice',
    RESIDENT: 'Resident',
    ROLE: 'Role',
    ALLOCATION: 'Payment allocation',
    REMINDER: 'Reminder',
    BANK_MATCH: 'Bank reconciliation',
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

const actorLabel = async () => {
    if (portalState.auth?.name) return portalState.auth.name;
    if (portalState.auth?.email) return portalState.auth.email;
    if (!supabase) return 'System';
    const { data: { user } } = await supabase.auth.getUser();
    return user?.email || user?.id || 'System';
};

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
    };

    const { data, error } = await supabase.from('activity_audit_log').insert(row).select('id').single();
    if (error) {
        if (/activity_audit_log/i.test(error.message)) {
            console.warn('[audit] activity_audit_log table missing — run supabase_activity_audit_log.sql');
            return null;
        }
        console.warn('[audit] log failed:', error.message);
        return null;
    }
    return data?.id || null;
}

export async function fetchActivityLog(apartmentId, { entityType = '', fromDate = '', toDate = '', actor = '', limit = 200 } = {}) {
    if (!supabase || !apartmentId) return [];
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
    if (error) {
        if (/activity_audit_log/i.test(error.message)) return [];
        throw error;
    }
    return data || [];
}

export async function fetchEntityActivity(entityType, entityId, limit = 20) {
    if (!supabase) return [];
    const apartmentId = portalState.access?.activeApartmentId;
    const { data, error } = await supabase
        .from('activity_audit_log')
        .select('*')
        .eq('apartment_id', apartmentId)
        .eq('entity_type', entityType)
        .eq('entity_id', String(entityId))
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) return [];
    return data || [];
}

const formatWhen = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
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
          <span>${ACTION_LABELS[r.action] || r.action} · ${r.actor_label || '—'}</span></div>
      </div>`).join('');
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
    const apartmentId = portalState.access?.activeApartmentId;
    const entityType = document.getElementById('activity-filter-entity')?.value || '';
    const fromDate = document.getElementById('activity-filter-from')?.value || '';
    const toDate = document.getElementById('activity-filter-to')?.value || '';
    const actor = (document.getElementById('activity-filter-actor')?.value || '').trim();

    const rows = await fetchActivityLog(apartmentId, { entityType, fromDate, toDate, actor });
    renderActivityLogList(rows);
};

export const initActivityAuditUi = () => {
    document.getElementById('activity-filter-apply')?.addEventListener('click', () => {
        renderActivityLogPage().catch((err) => alert(err?.message || 'Could not load activity log.'));
    });
    document.getElementById('activity-filter-reset')?.addEventListener('click', () => {
        ['activity-filter-entity', 'activity-filter-from', 'activity-filter-to', 'activity-filter-actor']
            .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
        renderActivityLogPage().catch(() => {});
    });
};

window.renderActivityLogPage = renderActivityLogPage;
