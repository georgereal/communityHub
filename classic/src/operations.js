/**
 * Phase 4 — Operations & facilities (helpdesk through payroll)
 */
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';
import { renderNoticesAdmin } from './notices.js';
import { renderTransitions, initUnitTransitions } from './unitTransitions.js';
import { renderVisitors, initVisitors } from './visitors.js';
import { bindBusyClick } from './buttonBusy.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;
const unitLabel = (id) => portalState.units.find((u) => u.id === id)?.number || '—';
const staffLabel = (id) => portalState.admin.staff.find((s) => s.id === id)?.full_name || '—';
const todayISO = () => new Date().toISOString().slice(0, 10);

// ——— Helpdesk ———
export const renderHelpdesk = () => {
    const el = document.getElementById('ops-helpdesk-list');
    if (!el) return;
    const tickets = portalState.operations?.helpdeskTickets || [];
    if (!tickets.length) {
        el.innerHTML = '<p class="ops-empty">No tickets yet.</p>';
        return;
    }
    el.innerHTML = tickets.map((t) => `<div class="ops-ticket-row">
      <div><strong>${t.subject}</strong> <span class="ops-ticket-cat">${t.category}</span></div>
      <div>${unitLabel(t.unit_id)}</div>
      <div><span class="portal-status portal-status--${t.status.toLowerCase()}">${t.status}</span></div>
      <div>${staffLabel(t.assigned_to)}</div>
      <div>${new Date(t.created_at).toLocaleDateString('en-IN')}</div>
      <div>
        <select class="ops-ticket-status" data-id="${t.id}">
          ${['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].map((s) =>
        `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>`).join('');
    el.querySelectorAll('.ops-ticket-status').forEach((sel) => {
        sel.onchange = () => void updateTicketStatus(sel.dataset.id, sel.value);
    });
};

async function updateTicketStatus(id, status) {
    const patch = { status };
    if (status === 'RESOLVED' || status === 'CLOSED') patch.resolved_at = new Date().toISOString();
    const { error } = await supabase.from('helpdesk_tickets').update(patch).eq('id', id);
    if (error) return alert(error.message);
    await pullState();
    renderHelpdesk();
}

// ——— Assets ———
export const renderAssets = () => {
    const el = document.getElementById('ops-assets-list');
    if (!el) return;
    const assets = portalState.operations?.societyAssets || [];
    const soon = (d) => {
        if (!d) return false;
        const diff = (new Date(d) - new Date()) / (1000 * 60 * 60 * 24);
        return diff >= 0 && diff <= 30;
    };
    if (!assets.length) {
        el.innerHTML = '<p class="ops-empty">No assets registered.</p>';
        return;
    }
    el.innerHTML = assets.map((a) => `<div class="ops-asset-row ${soon(a.amc_end_date) ? 'ops-asset-row--warn' : ''}">
      <div><strong>${a.name}</strong> <span class="ops-asset-type">${a.asset_type}</span></div>
      <div>${a.location || '—'}</div>
      <div>${a.amc_end_date || '—'} ${soon(a.amc_end_date) ? '<span class="ops-alert">AMC expiring</span>' : ''}</div>
      <div>${a.next_service_due || '—'}</div>
    </div>`).join('');
};

export const saveAsset = async () => {
    const apartment_id = portalState.access?.activeApartmentId;
    const name = document.getElementById('ops-asset-name')?.value?.trim();
    const asset_type = document.getElementById('ops-asset-type')?.value?.trim() || 'Equipment';
    const location = document.getElementById('ops-asset-location')?.value?.trim();
    const amc_end_date = document.getElementById('ops-asset-amc')?.value || null;
    if (!name) return alert('Asset name required.');
    const { error } = await supabase.from('society_assets').insert({
        id: crypto.randomUUID(),
        apartment_id,
        name,
        asset_type,
        location,
        amc_end_date,
    });
    if (error) return alert(error.message);
    await pullState();
    document.getElementById('ops-asset-form')?.reset();
    renderAssets();
};

// ——— Amenities ———
export const renderAmenities = () => {
    const listEl = document.getElementById('ops-amenities-list');
    const bookEl = document.getElementById('ops-bookings-list');
    const amenities = portalState.operations?.amenities || [];
    const bookings = portalState.operations?.amenityBookings || [];

    if (listEl) {
        listEl.innerHTML = amenities.length
            ? amenities.map((a) => `<div class="ops-amenity-row">
          <strong>${a.name}</strong>
          <span>${a.slot_duration_minutes} min slots</span>
          <span>${a.is_active ? 'Active' : 'Inactive'}</span>
        </div>`).join('')
            : '<p class="ops-empty">No amenities configured.</p>';
    }
    if (bookEl) {
        bookEl.innerHTML = bookings.length
            ? bookings.filter((b) => b.status === 'CONFIRMED').map((b) => {
                const am = amenities.find((x) => x.id === b.amenity_id);
                return `<div class="ops-booking-row">
            <strong>${am?.name || 'Amenity'}</strong>
            <span>${unitLabel(b.unit_id)}</span>
            <span>${new Date(b.starts_at).toLocaleString('en-IN')}</span>
          </div>`;
            }).join('')
            : '<p class="ops-empty">No upcoming bookings.</p>';
    }
};

export const saveAmenity = async () => {
    const apartment_id = portalState.access?.activeApartmentId;
    const name = document.getElementById('ops-amenity-name')?.value?.trim();
    if (!name) return alert('Amenity name required.');
    const { error } = await supabase.from('amenities').insert({
        id: crypto.randomUUID(),
        apartment_id,
        name,
        slot_duration_minutes: 60,
    });
    if (error) return alert(error.message);
    await pullState();
    renderAmenities();
};

export const saveBooking = async () => {
    const apartment_id = portalState.access?.activeApartmentId;
    const amenity_id = document.getElementById('ops-booking-amenity')?.value;
    const unit_id = document.getElementById('ops-booking-unit')?.value;
    const date = document.getElementById('ops-booking-date')?.value;
    const time = document.getElementById('ops-booking-time')?.value || '10:00';
    if (!amenity_id || !unit_id || !date) return alert('Fill all booking fields.');
    const am = portalState.operations.amenities.find((x) => x.id === amenity_id);
    const starts_at = new Date(`${date}T${time}:00`).toISOString();
    const ends = new Date(starts_at);
    ends.setMinutes(ends.getMinutes() + (am?.slot_duration_minutes || 60));
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('amenity_bookings').insert({
        id: crypto.randomUUID(),
        apartment_id,
        amenity_id,
        unit_id,
        starts_at,
        ends_at: ends.toISOString(),
        created_by: user?.id,
    });
    if (error) return alert(error.message);
    await pullState();
    renderAmenities();
};

// ——— Staff payroll ———
export const renderPayroll = () => {
    const attEl = document.getElementById('ops-attendance-list');
    const payEl = document.getElementById('ops-payroll-list');
    const staff = portalState.admin.staff || [];
    const attendance = portalState.operations?.staffAttendance || [];
    const payroll = portalState.operations?.payrollRuns || [];

    if (attEl) {
        const recent = attendance.slice(0, 50);
        attEl.innerHTML = recent.length
            ? recent.map((a) => `<div class="ops-att-row">
          <span>${staffLabel(a.staff_id)}</span>
          <span>${a.work_date}</span>
          <span class="portal-status portal-status--${a.status.toLowerCase()}">${a.status}</span>
        </div>`).join('')
            : '<p class="ops-empty">No attendance marked.</p>';
    }
    if (payEl) {
        payEl.innerHTML = payroll.length
            ? payroll.map((p) => `<div class="ops-payroll-row">
          <strong>${p.period_label}</strong>
          <span>${formatMoney(p.total_amount)}</span>
          <span>${new Date(p.created_at).toLocaleDateString('en-IN')}</span>
        </div>`).join('')
            : '<p class="ops-empty">No payroll runs yet.</p>';
    }

    const staffSel = document.getElementById('ops-att-staff');
    if (staffSel && staffSel.options.length <= 1) {
        staffSel.innerHTML = '<option value="">Select staff</option>' +
            staff.map((s) => `<option value="${s.id}">${s.full_name}</option>`).join('');
    }
};

export const saveAttendance = async () => {
    const apartment_id = portalState.access?.activeApartmentId;
    const staff_id = document.getElementById('ops-att-staff')?.value;
    const work_date = document.getElementById('ops-att-date')?.value || todayISO();
    const status = document.getElementById('ops-att-status')?.value || 'PRESENT';
    if (!staff_id) return alert('Select staff member.');
    const { error } = await supabase.from('staff_attendance').upsert({
        id: crypto.randomUUID(),
        apartment_id,
        staff_id,
        work_date,
        status,
    }, { onConflict: 'staff_id,work_date' });
    if (error) return alert(error.message);
    await pullState();
    renderPayroll();
};

export const savePayrollRun = async () => {
    const apartment_id = portalState.access?.activeApartmentId;
    const period_label = document.getElementById('ops-payroll-period')?.value?.trim();
    const total_amount = parseFloat(document.getElementById('ops-payroll-total')?.value) || 0;
    if (!period_label) return alert('Enter period label.');
    const { error } = await supabase.from('payroll_runs').insert({
        id: crypto.randomUUID(),
        apartment_id,
        period_label,
        total_amount,
    });
    if (error) return alert(error.message);
    await logActivity({
        entityType: 'PAYROLL',
        entityId: period_label,
        action: 'CREATE',
        summary: `Payroll run ${period_label} — ${formatMoney(total_amount)}`,
    });
    await pullState();
    renderPayroll();
};

// ——— Unit documents (used from unitDirectory) ———
export const getDocumentsForUnit = (unitId) =>
    (portalState.operations?.unitDocuments || []).filter((d) => d.unit_id === unitId);

export const saveUnitDocument = async (unitId, { title, doc_type, file_path, expires_at }) => {
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('unit_documents').insert({
        id: crypto.randomUUID(),
        apartment_id,
        unit_id: unitId,
        doc_type,
        title,
        file_path,
        expires_at: expires_at || null,
        uploaded_by: user?.id,
    });
    if (error) throw new Error(error.message);
    await pullState();
};

export const deleteUnitDocument = async (id) => {
    const { error } = await supabase.from('unit_documents').delete().eq('id', id);
    if (error) throw new Error(error.message);
    await pullState();
};

export const renderOperationsSubview = (subview) => {
    if (subview === 'helpdesk') renderHelpdesk();
    else if (subview === 'transitions') void renderTransitions();
    else if (subview === 'notices') renderNoticesAdmin();
    else if (subview === 'assets') renderAssets();
    else if (subview === 'amenities') renderAmenities();
    else if (subview === 'visitors') renderVisitors();
    else if (subview === 'payroll') renderPayroll();
};

async function saveStaffHelpdeskTicket() {
    if (!supabase) return alert('Supabase required.');
    const apartment_id = portalState.access?.activeApartmentId;
    const subject = document.getElementById('ops-ticket-subject')?.value?.trim();
    const category = document.getElementById('ops-ticket-category')?.value?.trim() || 'General';
    const description = document.getElementById('ops-ticket-desc')?.value?.trim();
    const unit_id = document.getElementById('ops-ticket-unit')?.value || null;
    if (!subject) return alert('Enter a subject.');
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('helpdesk_tickets').insert({
        id: crypto.randomUUID(),
        apartment_id,
        unit_id,
        category,
        subject,
        description,
        created_by: user?.id,
    });
    if (error) return alert(error.message);
    await pullState();
    document.getElementById('ops-helpdesk-create')?.reset();
    renderHelpdesk();
}

export const initOperations = () => {
    bindBusyClick(document.getElementById('ops-ticket-save'), 'Saving…', saveStaffHelpdeskTicket);
    bindBusyClick(document.getElementById('ops-asset-save'), 'Saving…', saveAsset);
    bindBusyClick(document.getElementById('ops-amenity-save'), 'Saving…', saveAmenity);
    bindBusyClick(document.getElementById('ops-booking-save'), 'Saving…', saveBooking);
    initVisitors();
    bindBusyClick(document.getElementById('ops-att-save'), 'Saving…', saveAttendance);
    bindBusyClick(document.getElementById('ops-payroll-save'), 'Saving…', savePayrollRun);
    initUnitTransitions();
    const populateUnitSelects = () => {
        const opts = portalState.units.map((u) => `<option value="${u.id}">${u.number}</option>`).join('');
        ['ops-booking-unit', 'ops-ticket-unit'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<option value="">Select flat</option>${opts}`;
        });
    };
    populateUnitSelects();
    document.addEventListener('apartment-data-loaded', populateUnitSelects);

    const amenitySel = document.getElementById('ops-booking-amenity');
    if (amenitySel) {
        const refreshAmenities = () => {
            amenitySel.innerHTML = (portalState.operations?.amenities || [])
                .filter((a) => a.is_active)
                .map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
        };
        refreshAmenities();
        document.addEventListener('apartment-data-loaded', refreshAmenities);
    }
};

window.switchOperationsSubView = (subview) => {
    document.querySelectorAll('.ops-subview').forEach((el) => {
        el.hidden = el.id !== `ops-subview-${subview}`;
    });
    if (subview === 'notices') renderNoticesAdmin();
    else renderOperationsSubview(subview);
};
