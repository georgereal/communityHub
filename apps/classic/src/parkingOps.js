/**
 * Visitor parking passes (Security Gate).
 */
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';
import { bindBusyClick } from './buttonBusy.js';

const unitLabel = (id) => portalState.units.find((u) => u.id === id)?.number || '—';

export const getActiveVisitorPasses = () => {
    const now = Date.now();
    return (portalState.parking?.visitorPasses || []).filter((p) => {
        if (p.status !== 'ACTIVE') return false;
        return new Date(p.valid_until).getTime() >= now;
    });
};

export async function createVisitorPass({ unit_id, vehicle_reg, valid_from, valid_until, host_resident_id }) {
    if (!supabase) throw new Error('Supabase required.');
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('visitor_parking_passes').insert({
        id: crypto.randomUUID(),
        apartment_id,
        unit_id,
        host_resident_id: host_resident_id || null,
        vehicle_reg: String(vehicle_reg || '').trim().toUpperCase(),
        valid_from: valid_from || new Date().toISOString(),
        valid_until,
        created_by: user?.id,
    });
    if (error) throw new Error(error.message);
    await logActivity({
        entityType: 'VISITOR_PASS',
        entityId: vehicle_reg,
        action: 'CREATE',
        summary: `Visitor pass ${vehicle_reg} for ${unitLabel(unit_id)}`,
    });
    await pullState();
}

export async function revokeVisitorPass(id) {
    const { error } = await supabase.from('visitor_parking_passes')
        .update({ status: 'REVOKED' })
        .eq('id', id);
    if (error) throw new Error(error.message);
    await pullState();
}

export const renderVisitorPassesPanel = () => {
    const el = document.getElementById('visitor-passes-list');
    if (!el) return;
    const passes = getActiveVisitorPasses();
    if (!passes.length) {
        el.innerHTML = '<p class="pool-section-empty">No active visitor passes.</p>';
        return;
    }
    el.innerHTML = passes.map((p) => `<div class="visitor-pass-row">
      <strong>${p.vehicle_reg}</strong>
      <span>${unitLabel(p.unit_id)}</span>
      <span>Until ${new Date(p.valid_until).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</span>
      <button type="button" class="btn btn-outline btn--small" data-revoke-pass="${p.id}">Revoke</button>
    </div>`).join('');
    el.querySelectorAll('[data-revoke-pass]').forEach((btn) => {
        btn.onclick = () => void revokeVisitorPass(btn.dataset.revokePass).then(() => renderVisitorPassesPanel());
    });
};

export const saveVisitorPassFromForm = async () => {
    const unit_id = document.getElementById('visitor-pass-unit')?.value;
    const vehicle_reg = document.getElementById('visitor-pass-reg')?.value;
    const hours = parseInt(document.getElementById('visitor-pass-hours')?.value, 10) || 4;
    if (!unit_id || !vehicle_reg?.trim()) return alert('Flat and vehicle registration required.');
    const valid_from = new Date().toISOString();
    const valid_until = new Date(Date.now() + hours * 3600000).toISOString();
    try {
        await createVisitorPass({ unit_id, vehicle_reg, valid_from, valid_until });
        document.getElementById('visitor-pass-form')?.reset();
        renderVisitorPassesPanel();
    } catch (err) {
        alert(err?.message || 'Could not create pass.');
    }
};

export const initParkingOps = () => {
    bindBusyClick(document.getElementById('visitor-pass-save'), 'Saving…', saveVisitorPassFromForm);
    document.addEventListener('apartment-data-loaded', () => {
        const opts = portalState.units.map((u) => `<option value="${u.id}">${u.number}</option>`).join('');
        const el = document.getElementById('visitor-pass-unit');
        if (el) el.innerHTML = `<option value="">Select flat</option>${opts}`;
    });
};

export const refreshParkingUi = () => {
    renderVisitorPassesPanel();
};
