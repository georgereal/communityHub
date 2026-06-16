/**
 * Visitor gate approvals — notify residents, track per-flat sign-off
 */
import { portalState, supabase, pullState } from './store.js';
import { loadResidents, getResidentsForUnit, normUnit } from './residents.js';
import { logActivity } from './activityAudit.js';

const unitLabel = (id) => portalState.units.find((u) => u.id === id)?.number || '—';

export const normalizePhone = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits.slice(-10);
    return digits;
};

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export function lookupVisitorByContact({ phone, email }) {
    const p = normalizePhone(phone);
    const e = normalizeEmail(email);
    if (!p && !e) return null;

    const logs = (portalState.operations?.visitorLog || [])
        .filter((v) => {
            if (p && normalizePhone(v.visitor_phone) === p) return true;
            if (e && normalizeEmail(v.visitor_email) === e) return true;
            return false;
        })
        .sort((a, b) => new Date(b.entry_at || b.requested_at || 0) - new Date(a.entry_at || a.requested_at || 0));

    if (!logs.length) return null;
    const hit = logs[0];
    return {
        visitor_name: hit.visitor_name,
        visitor_phone: hit.visitor_phone,
        visitor_email: hit.visitor_email,
        vehicle_reg: hit.vehicle_reg,
        delivery_company: hit.delivery_company,
        purpose: hit.purpose,
        visit_count: logs.length,
    };
}

export async function lookupVisitorByContactRemote({ phone, email }) {
    const local = lookupVisitorByContact({ phone, email });
    if (local || !supabase) return local;

    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return null;

    const p = normalizePhone(phone);
    const e = normalizeEmail(email);
    let query = supabase.from('visitor_log').select('*').eq('apartment_id', apartment_id)
        .order('entry_at', { ascending: false }).limit(20);

    const { data } = await query;
    const logs = (data || []).filter((v) => {
        if (p && normalizePhone(v.visitor_phone) === p) return true;
        if (e && normalizeEmail(v.visitor_email) === e) return true;
        return false;
    });
    if (!logs.length) return null;
    const hit = logs[0];
    return {
        visitor_name: hit.visitor_name,
        visitor_phone: hit.visitor_phone,
        visitor_email: hit.visitor_email,
        vehicle_reg: hit.vehicle_reg,
        delivery_company: hit.delivery_company,
        purpose: hit.purpose,
        visit_count: logs.length,
    };
}

export function getVisitorLogUnits(visitorLogId) {
    return (portalState.operations?.visitorLogUnits || []).filter((u) => u.visitor_log_id === visitorLogId);
}

export function getPendingVisitorUnits() {
    return (portalState.operations?.visitorLogUnits || []).filter((u) => u.approval_status === 'PENDING');
}

export async function getPortalUserIdsForUnit(unitId) {
    await loadResidents();
    const unit = portalState.units.find((u) => u.id === unitId);
    if (!unit) return [];
    const residents = getResidentsForUnit(unit.number).filter((r) => r.is_residing !== false);
    const links = portalState.portal?.residentLinks || [];
    const userIds = new Set();
    residents.forEach((r) => {
        links.filter((l) => l.resident_id === r.id && l.user_id).forEach((l) => userIds.add(l.user_id));
    });
    return [...userIds];
}

function computeOverallApproval(units) {
    if (!units.length) return 'NOT_REQUIRED';
    if (units.some((u) => u.approval_status === 'DENIED')) return 'DENIED';
    if (units.every((u) => u.approval_status === 'APPROVED')) return 'APPROVED';
    if (units.some((u) => u.approval_status === 'APPROVED')) return 'PARTIAL';
    return 'PENDING';
}

export async function syncVisitorApprovalStatus(visitorLogId) {
    const units = getVisitorLogUnits(visitorLogId);
    const status = computeOverallApproval(units);
    const log = (portalState.operations?.visitorLog || []).find((v) => v.id === visitorLogId);
    const updates = { approval_status: status };

    if (status === 'APPROVED' && log && !log.entry_at) {
        updates.entry_at = new Date().toISOString();
    }

    const { error } = await supabase.from('visitor_log').update(updates).eq('id', visitorLogId);
    if (error) throw new Error(error.message);
    return status;
}

async function queueVisitorApprovalNotifications(visitorLog, unitRows) {
    const apartment_id = portalState.access?.activeApartmentId;
    const purposeLabel = visitorLog.purpose || 'VISITOR';
    const payload = [];

    for (const row of unitRows) {
        const flat = unitLabel(row.unit_id);
        const userIds = await getPortalUserIdsForUnit(row.unit_id);
        const title = `${purposeLabel} at gate — Flat ${flat}`;
        const body = `${visitorLog.visitor_name} is at the security gate for Flat ${flat}. Approve or deny entry.`;

        userIds.forEach((user_id) => {
            payload.push({
                id: crypto.randomUUID(),
                apartment_id,
                user_id,
                visitor_log_id: visitorLog.id,
                visitor_unit_id: row.id,
                title,
                body,
            });
        });
    }

    if (!payload.length || !supabase) return 0;
    const { error } = await supabase.from('user_notifications').insert(payload);
    if (error) throw new Error(error.message);
    return payload.length;
}

export async function createVisitorWithApprovals({
    purpose,
    visitor_name,
    visitor_phone,
    visitor_email,
    vehicle_reg,
    delivery_company,
    package_count,
    parcel_held,
    notes,
    unit_ids,
}) {
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const visitorId = crypto.randomUUID();
    const now = new Date().toISOString();

    const { error: logErr } = await supabase.from('visitor_log').insert({
        id: visitorId,
        apartment_id,
        unit_id: unit_ids[0] || null,
        visitor_name,
        visitor_phone: visitor_phone || null,
        visitor_email: visitor_email || null,
        vehicle_reg: vehicle_reg || null,
        purpose,
        delivery_company: purpose === 'DELIVERY' ? delivery_company : null,
        package_count: purpose === 'DELIVERY' ? (package_count || 0) : 0,
        parcel_held: purpose === 'DELIVERY' && parcel_held,
        notes: notes || null,
        approval_status: 'PENDING',
        requested_at: now,
        entry_at: null,
        logged_by: user?.id,
    });
    if (logErr) throw new Error(logErr.message);

    const unitRows = unit_ids.map((unit_id) => ({
        id: crypto.randomUUID(),
        apartment_id,
        visitor_log_id: visitorId,
        unit_id,
        approval_status: 'PENDING',
    }));

    const { error: unitsErr } = await supabase.from('visitor_log_units').insert(unitRows);
    if (unitsErr) throw new Error(unitsErr.message);

    const visitorLog = {
        id: visitorId,
        visitor_name,
        purpose,
        apartment_id,
    };
    await queueVisitorApprovalNotifications(visitorLog, unitRows);

    if (purpose === 'DELIVERY' && parcel_held) {
        for (const unit_id of unit_ids) {
            await supabase.from('gate_parcels').insert({
                id: crypto.randomUUID(),
                apartment_id,
                unit_id,
                visitor_log_id: visitorId,
                courier_name: visitor_name,
                delivery_company,
                description: notes,
                package_count: package_count || 1,
                logged_by: user?.id,
            });
        }
    }

    await logActivity({
        entityType: 'VISITOR',
        entityId: visitorId,
        action: 'APPROVAL_REQUEST',
        summary: `${purpose} — ${visitor_name} → ${unit_ids.map(unitLabel).join(', ')} (awaiting resident approval)`,
    });

    await pullState();
    return { visitorId, unitRows };
}

export async function respondVisitorApproval(visitorUnitId, approved, deniedReason = '') {
    const row = (portalState.operations?.visitorLogUnits || []).find((u) => u.id === visitorUnitId);
    if (!row) throw new Error('Approval request not found.');

    const { data: { user } } = await supabase.auth.getUser();
    const now = new Date().toISOString();

    const { error } = await supabase.from('visitor_log_units').update({
        approval_status: approved ? 'APPROVED' : 'DENIED',
        approved_by: user?.id,
        approved_at: now,
        denied_reason: approved ? null : (deniedReason || 'Denied by resident'),
    }).eq('id', visitorUnitId);
    if (error) throw new Error(error.message);

    const status = await syncVisitorApprovalStatus(row.visitor_log_id);

    await logActivity({
        entityType: 'VISITOR',
        entityId: row.visitor_log_id,
        action: approved ? 'APPROVE' : 'DENY',
        summary: `Flat ${unitLabel(row.unit_id)} ${approved ? 'approved' : 'denied'} visitor entry`,
    });

    await pullState();
    document.dispatchEvent(new CustomEvent('gate-data-updated'));
    return status;
}

export async function getPendingApprovalsForMyUnits(getMyUnitIds) {
    const unitIds = new Set(await getMyUnitIds());
    const pending = (portalState.operations?.visitorLogUnits || [])
        .filter((u) => unitIds.has(u.unit_id) && u.approval_status === 'PENDING');
    const logs = portalState.operations?.visitorLog || [];
    return pending.map((u) => ({
        ...u,
        visitor: logs.find((v) => v.id === u.visitor_log_id),
    })).filter((x) => x.visitor);
}

export function approvalStatusLabel(status) {
    const map = {
        PENDING: 'Awaiting approval',
        APPROVED: 'Approved',
        DENIED: 'Denied',
        PARTIAL: 'Partially approved',
        NOT_REQUIRED: 'No approval needed',
    };
    return map[status] || status;
}
