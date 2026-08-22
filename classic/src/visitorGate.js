/**
 * Shared visitor / parcel gate logic (admin ops + security portal)
 */
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';
import { bindBusyClick } from './buttonBusy.js';

function getVisitorLogUnits(visitorLogId) {
    return (portalState.operations?.visitorLogUnits || []).filter((u) => u.visitor_log_id === visitorLogId);
}

export const DELIVERY_COMPANIES = [
    'Amazon', 'Flipkart', 'Meesho', 'Swiggy', 'Zomato', 'Blinkit', 'Dunzo', 'Porter', 'Delhivery', 'Blue Dart',
];

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const contexts = new Map();

export const GATE_UI = {
    visitor: {
        stats: 'visitor-stats',
        logList: 'ops-visitors-list',
        entryForm: 'visitor-entry-form',
        purposeTabs: 'visitor-purpose-tabs',
        parcelsList: 'visitor-parcels-list',
        parcelReceive: 'visitor-parcel-receive',
        receiveForm: 'visitor-receive-form',
        receiveToggle: 'visitor-receive-toggle',
        logFilters: 'visitor-log-filters',
        companyChips: 'visitor-company-chips',
        receiveChips: 'visitor-receive-chips',
        entrySave: 'visitor-entry-save',
        receiveSave: 'visitor-receive-save',
        unitSelects: ['visitor-entry-unit', 'visitor-receive-unit'],
        scopeRoot: 'ops-subview-visitors',
    },
    sec: {
        stats: 'sec-stats',
        logList: 'sec-active-list',
        entryForm: 'sec-entry-form',
        purposeTabs: 'sec-purpose-tabs',
        parcelsList: 'sec-parcels-list',
        parcelReceive: 'sec-parcel-receive',
        receiveForm: 'sec-receive-form',
        receiveToggle: 'sec-receive-toggle',
        companyChips: 'sec-company-chips',
        receiveChips: 'sec-receive-chips',
        entrySave: 'sec-entry-save',
        receiveSave: 'sec-receive-save',
        unitSelects: ['sec-receive-unit', 'sec-pass-unit'],
        scopeRoot: 'security-subview-gate',
    },
};

export function ensureGateContext(prefix) {
    if (!contexts.has(prefix)) {
        contexts.set(prefix, {
            prefix,
            entryPurpose: 'GUEST',
            logFilter: prefix === 'sec' ? 'today' : 'on-premises',
            expandedParcelId: null,
            showParcelReceive: false,
            wired: false,
        });
    }
    return contexts.get(prefix);
}

const unitLabel = (id) => portalState.units.find((u) => u.id === id)?.number || '—';

const todayStart = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};

const purposeClass = (p) => {
    const key = (p || '').toLowerCase();
    if (key === 'delivery') return 'visitor-row__purpose--delivery';
    if (key === 'guest') return 'visitor-row__purpose--guest';
    if (key === 'service') return 'visitor-row__purpose--service';
    return '';
};

const waitingLabel = (receivedAt) => {
    const ms = Date.now() - new Date(receivedAt).getTime();
    const hrs = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    const text = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    const long = hrs >= 24;
    return `<span class="visitor-waiting${long ? ' visitor-waiting--long' : ''}">${text} waiting</span>`;
};

const ui = (prefix) => GATE_UI[prefix] || GATE_UI.visitor;

export function populateGateUnitSelects(prefix) {
    const cfg = ui(prefix);
    const opts = portalState.units.map((u) => `<option value="${u.id}">${esc(u.number)}</option>`).join('');
    (cfg.unitSelects || []).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = `<option value="">${el.dataset.placeholder || 'Select flat'}</option>${opts}`;
    });
}

function togglePurposeFields(prefix) {
    const ctx = ensureGateContext(prefix);
    const root = document.getElementById(ui(prefix).scopeRoot);
    if (!root) return;
    root.querySelectorAll('[data-purpose-field]').forEach((el) => {
        const purposes = (el.dataset.purposeField || '').split(',');
        el.hidden = !purposes.includes(ctx.entryPurpose);
    });
}

export function renderGateStats(prefix) {
    const el = document.getElementById(ui(prefix).stats);
    if (!el) return;
    const rows = portalState.operations?.visitorLog || [];
    const parcels = (portalState.operations?.gateParcels || []).filter((p) => p.status === 'AT_GATE');
    const onPremises = rows.filter((v) => {
        if (v.exit_at) return false;
        if (v.approval_status === 'PENDING' || v.approval_status === 'DENIED') return false;
        return !!v.entry_at;
    }).length;
    const today = rows.filter((v) => new Date(v.entry_at) >= todayStart()).length;
    el.innerHTML = `
      <div class="metric-card">
        <span class="label">On premises</span>
        <span class="value value--accent">${onPremises}</span>
      </div>
      <div class="metric-card">
        <span class="label">Parcels at gate</span>
        <span class="value${parcels.length ? ' value--accent' : ''}">${parcels.length}</span>
      </div>
      <div class="metric-card">
        <span class="label">Entries today</span>
        <span class="value">${today}</span>
      </div>`;
}

function filterVisitorRows(rows, logFilter) {
    const onPremises = (v) => {
        if (v.exit_at) return false;
        if (v.approval_status === 'PENDING' || v.approval_status === 'DENIED') return false;
        return !!v.entry_at;
    };
    if (logFilter === 'on-premises') return rows.filter(onPremises);
    if (logFilter === 'today') return rows.filter((v) => new Date(v.entry_at || v.requested_at || 0) >= todayStart());
    return rows;
}

function visitorRowHtml(v, compact = false) {
    const units = getVisitorLogUnits(v.id);
    const flatLabel = units.length
        ? units.map((u) => unitLabel(u.unit_id)).join(', ')
        : unitLabel(v.unit_id);
    const sub = v.purpose === 'DELIVERY' && v.delivery_company
        ? `<span class="visitor-row__sub">${esc(v.delivery_company)}${v.package_count ? ` · ${v.package_count} pkg` : ''}${v.parcel_held ? ' · parcel at gate' : ''}</span>`
        : v.vehicle_reg
            ? `<span class="visitor-row__sub">Vehicle ${esc(v.vehicle_reg)}</span>`
            : '';
    const exitBtn = compact
        ? `<button type="button" class="btn btn-primary sec-exit-btn" data-exit-visitor="${v.id}">Exit</button>`
        : `<button type="button" class="btn btn-outline btn--small" data-exit-visitor="${v.id}">Mark exit</button>`;
    return `<div class="visitor-row${compact ? ' visitor-row--compact' : ''}">
      <div>
        <span class="visitor-row__name">${esc(v.visitor_name)}</span>
        <span class="visitor-row__purpose ${purposeClass(v.purpose)}">${esc(v.purpose)}</span>
        ${sub}
      </div>
      <div>${esc(flatLabel)}</div>
      <div>${esc(v.visitor_phone || '—')}</div>
      <div>${new Date(v.entry_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</div>
      <div class="visitor-row__actions">
        ${v.exit_at
            ? `<span class="visitor-parcel-row__meta">Out ${new Date(v.exit_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>`
            : exitBtn}
      </div>
    </div>`;
}

export function renderGateParcels(prefix) {
    const cfg = ui(prefix);
    const ctx = ensureGateContext(prefix);
    const el = document.getElementById(cfg.parcelsList);
    if (!el) return;

    const parcels = (portalState.operations?.gateParcels || [])
        .filter((p) => p.status === 'AT_GATE')
        .sort((a, b) => new Date(a.received_at) - new Date(b.received_at));

    const receiveEl = document.getElementById(cfg.parcelReceive);
    if (receiveEl) receiveEl.hidden = !ctx.showParcelReceive;

    if (!parcels.length) {
        el.innerHTML = '<p class="visitor-empty">No parcels waiting at the gate.</p>';
        return;
    }

    el.innerHTML = parcels.map((p) => {
        const expanded = ctx.expandedParcelId === p.id;
        const collectBtnClass = prefix === 'sec' ? 'btn btn-primary sec-collect-btn' : 'btn btn-primary btn--small';
        return `<div class="visitor-parcel-row" data-parcel-id="${p.id}">
          <div>
            <strong>Flat ${esc(unitLabel(p.unit_id))}</strong>
            <span class="visitor-parcel-row__meta">${esc(p.delivery_company || p.courier_name || 'Parcel')}</span>
          </div>
          <div>${p.package_count} pkg${p.package_count > 1 ? 's' : ''}${p.description ? ` · ${esc(p.description)}` : ''}</div>
          <div>${waitingLabel(p.received_at)}</div>
          <div>
            <button type="button" class="${collectBtnClass}" data-collect-parcel="${p.id}" data-gate-prefix="${prefix}">
              ${expanded ? 'Cancel' : 'Collect'}
            </button>
          </div>
          ${expanded ? `<div class="visitor-parcel-collect">
            <form data-collect-form="${p.id}" data-gate-prefix="${prefix}" onsubmit="return false">
              <div class="visitor-entry-form__field">
                <label class="visitor-entry-form__label">Collected by</label>
                <input type="text" class="expense-combobox" name="collected_by_name" placeholder="Name" required />
              </div>
              <div class="visitor-entry-form__field">
                <label class="visitor-entry-form__label">Relation</label>
                <select class="expense-combobox" name="collected_by_relation">
                  <option value="RESIDENT">Resident</option>
                  <option value="STAFF">Staff</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <button type="submit" class="btn btn-primary btn--small">Confirm pickup</button>
            </form>
          </div>` : ''}
        </div>`;
    }).join('');

    el.querySelectorAll('[data-collect-parcel]').forEach((btn) => {
        btn.onclick = () => {
            const pfx = btn.dataset.gatePrefix || prefix;
            const c = ensureGateContext(pfx);
            const id = btn.dataset.collectParcel;
            c.expandedParcelId = c.expandedParcelId === id ? null : id;
            renderGateParcels(pfx);
        };
    });

    el.querySelectorAll('[data-collect-form]').forEach((form) => {
        form.onsubmit = () => void submitParcelCollection(form.dataset.collectForm, form, form.dataset.gatePrefix || prefix);
    });
}

export function renderGateLog(prefix, { listId, logFilter, compact = false, emptyMessages } = {}) {
    const cfg = ui(prefix);
    const ctx = ensureGateContext(prefix);
    const filter = logFilter ?? ctx.logFilter;
    const el = document.getElementById(listId || cfg.logList);
    if (!el) return;

    const rows = filterVisitorRows(portalState.operations?.visitorLog || [], filter);
    if (!rows.length) {
        const defaults = {
            'on-premises': 'No visitors currently on premises.',
            today: 'No entries logged today.',
            all: 'No visitor entries yet.',
        };
        const msg = emptyMessages?.[filter] || defaults[filter] || defaults.all;
        el.innerHTML = `<p class="visitor-empty">${msg}</p>`;
        return;
    }

    const head = compact ? '' : `
      <div class="registry-list__head visitor-row visitor-row--head">
        <span>Visitor</span>
        <span>Flat</span>
        <span>Contact</span>
        <span>Entry</span>
        <span></span>
      </div>`;

    el.innerHTML = `${head}${rows.map((v) => visitorRowHtml(v, compact)).join('')}`;

    el.querySelectorAll('[data-exit-visitor]').forEach((btn) => {
        btn.onclick = () => void markVisitorExit(btn.dataset.exitVisitor, prefix);
    });
}

export function refreshGate(prefix) {
    populateGateUnitSelects(prefix);
    togglePurposeFields(prefix);
    renderGateStats(prefix);
    renderGateParcels(prefix);
    if (prefix === 'sec') {
        renderGateLog('sec', {
            listId: 'sec-active-list',
            logFilter: 'on-premises',
            compact: true,
            emptyMessages: { 'on-premises': 'Nobody on premises right now.' },
        });
    } else {
        renderGateLog(prefix);
    }
}

export function refreshAllGates() {
    Object.keys(GATE_UI).forEach((prefix) => {
        if (document.getElementById(ui(prefix).stats)) refreshGate(prefix);
    });
}

async function markVisitorExit(id, prefix) {
    const { error } = await supabase.from('visitor_log')
        .update({ exit_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return alert(error.message);
    await logActivity({
        entityType: 'VISITOR',
        entityId: id,
        action: 'EXIT',
        summary: 'Visitor marked exit at gate',
    });
    await pullState();
    refreshAllGates();
    document.dispatchEvent(new CustomEvent('gate-data-updated'));
}

async function createGateParcel(payload) {
    const { error } = await supabase.from('gate_parcels').insert({
        id: crypto.randomUUID(),
        ...payload,
        package_count: payload.package_count || 1,
    });
    if (error) throw new Error(error.message);
}

function fieldId(prefix, name) {
    return prefix === 'visitor' ? `visitor-entry-${name}` : `sec-entry-${name}`;
}

function receiveFieldId(prefix, name) {
    return prefix === 'visitor' ? `visitor-receive-${name}` : `sec-receive-${name}`;
}

async function saveVisitorEntry(prefix) {
    const cfg = ui(prefix);
    const ctx = ensureGateContext(prefix);
    const apartment_id = portalState.access?.activeApartmentId;
    const form = document.getElementById(cfg.entryForm);
    if (!form) return;

    const visitor_name = form.querySelector(`#${fieldId(prefix, 'name')}`)?.value?.trim();
    const unit_id = form.querySelector(`#${fieldId(prefix, 'unit')}`)?.value || null;
    const visitor_phone = form.querySelector(`#${fieldId(prefix, 'phone')}`)?.value?.trim() || null;
    const vehicle_reg = form.querySelector(`#${fieldId(prefix, 'vehicle')}`)?.value?.trim() || null;
    const notes = form.querySelector(`#${fieldId(prefix, 'notes')}`)?.value?.trim() || null;
    const delivery_company = form.querySelector(`#${fieldId(prefix, 'company')}`)?.value?.trim() || null;
    const package_count = parseInt(form.querySelector(`#${fieldId(prefix, 'packages')}`)?.value, 10) || 0;
    const holdParcel = form.querySelector(`#${fieldId(prefix, 'hold-parcel')}`)?.checked;

    if (!visitor_name) return alert('Enter visitor / courier name.');
    if (ctx.entryPurpose === 'DELIVERY' && !unit_id) return alert('Select flat for delivery.');
    if (ctx.entryPurpose === 'GUEST' && !unit_id) return alert('Select flat for guest visit.');

    const { data: { user } } = await supabase.auth.getUser();
    const visitorId = crypto.randomUUID();
    const parcelHeld = ctx.entryPurpose === 'DELIVERY' && holdParcel && unit_id;

    const { error } = await supabase.from('visitor_log').insert({
        id: visitorId,
        apartment_id,
        unit_id,
        visitor_name,
        visitor_phone,
        vehicle_reg,
        purpose: ctx.entryPurpose,
        delivery_company: ctx.entryPurpose === 'DELIVERY' ? delivery_company : null,
        package_count: ctx.entryPurpose === 'DELIVERY' ? package_count : 0,
        parcel_held: parcelHeld,
        notes,
        logged_by: user?.id,
    });
    if (error) return alert(error.message);

    if (parcelHeld) {
        try {
            await createGateParcel({
                apartment_id,
                unit_id,
                visitor_log_id: visitorId,
                courier_name: visitor_name,
                delivery_company,
                description: notes,
                package_count: package_count || 1,
                logged_by: user?.id,
            });
        } catch (e) {
            alert(`Entry logged but parcel hold failed: ${e.message}`);
        }
    }

    await logActivity({
        entityType: 'VISITOR',
        entityId: visitorId,
        action: 'ENTRY',
        summary: `${ctx.entryPurpose} entry — ${visitor_name}${unit_id ? ` → ${unitLabel(unit_id)}` : ''}${parcelHeld ? ' (parcel at gate)' : ''}`,
    });

    await pullState();
    form.reset();
    document.querySelectorAll(`#${cfg.companyChips} .visitor-company-chip.active`).forEach((c) => c.classList.remove('active'));
    refreshAllGates();
    document.dispatchEvent(new CustomEvent('gate-data-updated'));
}

async function saveStandaloneParcel(prefix) {
    const cfg = ui(prefix);
    const ctx = ensureGateContext(prefix);
    const apartment_id = portalState.access?.activeApartmentId;
    const unit_id = document.getElementById(receiveFieldId(prefix, 'unit'))?.value;
    const courier_name = document.getElementById(receiveFieldId(prefix, 'courier'))?.value?.trim();
    const delivery_company = document.getElementById(receiveFieldId(prefix, 'company'))?.value?.trim();
    const description = document.getElementById(receiveFieldId(prefix, 'desc'))?.value?.trim();
    const package_count = parseInt(document.getElementById(receiveFieldId(prefix, 'packages'))?.value, 10) || 1;

    if (!unit_id) return alert('Select flat.');
    if (!courier_name && !delivery_company) return alert('Enter courier or company name.');

    const { data: { user } } = await supabase.auth.getUser();
    try {
        await createGateParcel({
            apartment_id,
            unit_id,
            courier_name,
            delivery_company,
            description,
            package_count,
            logged_by: user?.id,
        });
    } catch (e) {
        return alert(e.message);
    }

    await logActivity({
        entityType: 'GATE_PARCEL',
        entityId: unit_id,
        action: 'RECEIVE',
        summary: `Parcel received at gate for ${unitLabel(unit_id)}`,
    });

    await pullState();
    ctx.showParcelReceive = false;
    document.getElementById(cfg.receiveForm)?.reset();
    refreshAllGates();
    document.dispatchEvent(new CustomEvent('gate-data-updated'));
}

async function submitParcelCollection(parcelId, form, prefix) {
    const collected_by_name = form.querySelector('[name="collected_by_name"]')?.value?.trim();
    const collected_by_relation = form.querySelector('[name="collected_by_relation"]')?.value || 'RESIDENT';
    if (!collected_by_name) return alert('Enter who collected the parcel.');

    const parcel = (portalState.operations?.gateParcels || []).find((p) => p.id === parcelId);
    const now = new Date().toISOString();
    const ctx = ensureGateContext(prefix);

    const { error } = await supabase.from('gate_parcels').update({
        status: 'COLLECTED',
        collected_at: now,
        collected_by_name,
        collected_by_relation,
    }).eq('id', parcelId);
    if (error) return alert(error.message);

    if (parcel?.visitor_log_id) {
        await supabase.from('visitor_log').update({ exit_at: now }).eq('id', parcel.visitor_log_id);
    }

    await logActivity({
        entityType: 'GATE_PARCEL',
        entityId: parcelId,
        action: 'COLLECT',
        summary: `Parcel collected by ${collected_by_name} (${unitLabel(parcel?.unit_id)})`,
    });

    ctx.expandedParcelId = null;
    await pullState();
    refreshAllGates();
    document.dispatchEvent(new CustomEvent('gate-data-updated'));
}

function renderCompanyChips(containerId) {
    const el = document.getElementById(containerId);
    if (!el || el.dataset.rendered) return;
    el.dataset.rendered = '1';
    el.innerHTML = DELIVERY_COMPANIES.map((c) =>
        `<button type="button" class="visitor-company-chip" data-company="${esc(c)}">${esc(c)}</button>`,
    ).join('');
}

export function initGate(prefix) {
    const cfg = ui(prefix);
    const ctx = ensureGateContext(prefix);
    if (ctx.wired) return;
    ctx.wired = true;

    renderCompanyChips(cfg.companyChips);
    renderCompanyChips(cfg.receiveChips);

    document.getElementById(cfg.purposeTabs)?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-purpose]');
        if (!btn) return;
        ctx.entryPurpose = btn.dataset.purpose;
        document.querySelectorAll(`#${cfg.purposeTabs} [data-purpose]`).forEach((b) => {
            b.classList.toggle('active', b === btn);
        });
        togglePurposeFields(prefix);
    });

    bindBusyClick(document.getElementById(cfg.entrySave), 'Saving…', () => saveVisitorEntry(prefix));

    document.getElementById(cfg.logFilters)?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-visitor-filter]');
        if (!btn) return;
        ctx.logFilter = btn.dataset.visitorFilter;
        document.querySelectorAll(`#${cfg.logFilters} [data-visitor-filter]`).forEach((b) => {
            b.classList.toggle('active', b === btn);
        });
        renderGateLog(prefix);
    });

    document.getElementById(cfg.receiveToggle)?.addEventListener('click', () => {
        ctx.showParcelReceive = !ctx.showParcelReceive;
        renderGateParcels(prefix);
    });

    bindBusyClick(document.getElementById(cfg.receiveSave), 'Saving…', () => saveStandaloneParcel(prefix));

    document.getElementById(cfg.companyChips)?.addEventListener('click', (e) => {
        const chip = e.target.closest('.visitor-company-chip');
        if (!chip) return;
        const input = document.getElementById(fieldId(prefix, 'company'));
        if (input) input.value = chip.dataset.company;
        document.querySelectorAll(`#${cfg.companyChips} .visitor-company-chip`).forEach((c) => {
            c.classList.toggle('active', c === chip);
        });
    });

    document.getElementById(cfg.receiveChips)?.addEventListener('click', (e) => {
        const chip = e.target.closest('.visitor-company-chip');
        if (!chip) return;
        const input = document.getElementById(receiveFieldId(prefix, 'company'));
        if (input) input.value = chip.dataset.company;
    });

    populateGateUnitSelects(prefix);
    document.addEventListener('apartment-data-loaded', () => populateGateUnitSelects(prefix));
}
