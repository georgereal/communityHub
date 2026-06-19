/**
 * Phase 5 — Visitor parking passes & violation fines
 */
import { portalState, supabase, pullState } from './store.js';
import { getOpenInvoicesForUnit, invoiceBalance } from './maintenanceBilling.js';
import { logActivity } from './activityAudit.js';
import { bindBusyClick, withButtonBusy } from './buttonBusy.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;
const unitLabel = (id) => portalState.units.find((u) => u.id === id)?.number || '—';
const todayISO = () => new Date().toISOString().slice(0, 10);

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

// ——— Violations ———
export const getParkingFineRules = () => portalState.parking?.fineRules || [];
export const getParkingViolations = () => portalState.parking?.violations || [];

export async function saveFineRule(name, amount) {
    const apartment_id = portalState.access?.activeApartmentId;
    const { error } = await supabase.from('parking_fine_rules').insert({
        id: crypto.randomUUID(),
        apartment_id,
        name: name.trim(),
        flat_amount: parseFloat(amount),
    });
    if (error) throw new Error(error.message);
    await pullState();
}

export async function recordViolation({ unit_id, rule_id, violation_date, description, amount }) {
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const rule = getParkingFineRules().find((r) => r.id === rule_id);
    const amt = amount ?? rule?.flat_amount ?? 0;
    const { data, error } = await supabase.from('parking_violations').insert({
        id: crypto.randomUUID(),
        apartment_id,
        unit_id,
        rule_id: rule_id || null,
        violation_date: violation_date || todayISO(),
        description,
        amount: amt,
        created_by: user?.id,
    }).select('id').single();
    if (error) throw new Error(error.message);
    await logActivity({
        entityType: 'PARKING_VIOLATION',
        entityId: data.id,
        action: 'CREATE',
        summary: `Parking fine ${formatMoney(amt)} — ${unitLabel(unit_id)}`,
    });
    await pullState();
    return data.id;
}

export async function waiveViolation(id) {
    const { error } = await supabase.from('parking_violations').update({ status: 'WAIVED' }).eq('id', id);
    if (error) throw new Error(error.message);
    await logActivity({ entityType: 'PARKING_VIOLATION', entityId: id, action: 'WAIVE', summary: 'Parking violation waived' });
    await pullState();
}

export async function applyViolationToInvoice(violationId) {
    const v = getParkingViolations().find((x) => x.id === violationId);
    if (!v || v.status !== 'PENDING') throw new Error('Violation not eligible.');
    const apartment_id = portalState.access?.activeApartmentId;
    const open = getOpenInvoicesForUnit(v.unit_id);
    if (!open.length) throw new Error('No open invoice for this flat. Raise an invoice first.');
    const inv = open[0];
    const amount = parseFloat(v.amount);
    const lineId = crypto.randomUUID();

    const { error: lineErr } = await supabase.from('maintenance_invoice_lines').insert({
        id: lineId,
        apartment_id,
        invoice_id: inv.id,
        head_id: null,
        head_name: `Parking fine — ${v.description || 'Violation'}`,
        calc_type: 'PARKING_FINE',
        quantity: 1,
        rate: amount,
        amount,
        sort_order: 950,
    });
    if (lineErr) throw new Error(lineErr.message);

    const newAmount = parseFloat(inv.amount) + amount;
    const { error: invErr } = await supabase.from('maintenance_invoices')
        .update({ amount: newAmount })
        .eq('id', inv.id);
    if (invErr) throw new Error(invErr.message);

    const { error: vErr } = await supabase.from('parking_violations')
        .update({ status: 'INVOICED', invoice_line_id: lineId })
        .eq('id', violationId);
    if (vErr) throw new Error(vErr.message);

    await pullState();
    if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();
}

export const renderParkingViolations = () => {
    const rulesEl = document.getElementById('parking-fine-rules-list');
    const violEl = document.getElementById('parking-violations-list');
    const rules = getParkingFineRules();
    const violations = getParkingViolations();

    if (rulesEl) {
        rulesEl.innerHTML = rules.length
            ? rules.map((r) => `<div class="ops-fine-rule-row">
              <strong>${r.name}</strong> ${formatMoney(r.flat_amount)}
              ${r.is_active ? '' : ' (inactive)'}
            </div>`).join('')
            : '<p class="ops-empty">No fine rules yet.</p>';
    }
    if (violEl) {
        violEl.innerHTML = violations.length
            ? violations.map((v) => `<div class="ops-violation-row">
              <div><strong>${unitLabel(v.unit_id)}</strong> ${formatMoney(v.amount)}</div>
              <div>${v.violation_date} — ${v.description || '—'}</div>
              <div><span class="portal-status portal-status--${v.status.toLowerCase()}">${v.status}</span></div>
              <div>
                ${v.status === 'PENDING' ? `<button type="button" class="btn btn-primary btn--small" data-apply-violation="${v.id}">Bill</button>
                <button type="button" class="btn btn-outline btn--small" data-waive-violation="${v.id}">Waive</button>` : ''}
              </div>
            </div>`).join('')
            : '<p class="ops-empty">No violations recorded.</p>';
        violEl.querySelectorAll('[data-apply-violation]').forEach((btn) => {
            btn.onclick = () => void applyViolationToInvoice(btn.dataset.applyViolation)
                .then(() => renderParkingViolations())
                .catch((e) => alert(e.message));
        });
        violEl.querySelectorAll('[data-waive-violation]').forEach((btn) => {
            btn.onclick = () => void waiveViolation(btn.dataset.waiveViolation).then(() => renderParkingViolations());
        });
    }
};

export const initParkingOps = () => {
    bindBusyClick(document.getElementById('visitor-pass-save'), 'Saving…', saveVisitorPassFromForm);
    document.getElementById('parking-fine-rule-save')?.addEventListener('click', async () => {
        const name = document.getElementById('parking-fine-rule-name')?.value;
        const amt = document.getElementById('parking-fine-rule-amount')?.value;
        if (!name?.trim()) return alert('Rule name required.');
        const btn = document.getElementById('parking-fine-rule-save');
        await withButtonBusy(btn, 'Saving…', async () => {
            await saveFineRule(name, amt);
            renderParkingViolations();
        }).catch((e) => alert(e.message));
    });
    bindBusyClick(document.getElementById('parking-violation-save'), 'Recording…', async () => {
        await recordViolation({
            unit_id: document.getElementById('parking-violation-unit')?.value,
            rule_id: document.getElementById('parking-violation-rule')?.value || null,
            violation_date: document.getElementById('parking-violation-date')?.value,
            description: document.getElementById('parking-violation-desc')?.value,
        });
        renderParkingViolations();
    });
    document.addEventListener('apartment-data-loaded', () => {
        const opts = portalState.units.map((u) => `<option value="${u.id}">${u.number}</option>`).join('');
        ['visitor-pass-unit', 'parking-violation-unit'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<option value="">Select flat</option>${opts}`;
        });
        const ruleSel = document.getElementById('parking-violation-rule');
        if (ruleSel) {
            ruleSel.innerHTML = '<option value="">Custom amount</option>' +
                getParkingFineRules().filter((r) => r.is_active).map((r) =>
                    `<option value="${r.id}">${r.name} (${formatMoney(r.flat_amount)})</option>`).join('');
        }
    });
};

export const refreshParkingUi = () => {
    renderVisitorPassesPanel();
    renderParkingViolations();
};
