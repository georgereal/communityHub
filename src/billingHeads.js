/**
 * Maintenance charge heads: definitions, calculation engine, CRUD
 */
import { portalState, supabase, pullState } from './store.js';
import { countExtraPoolVehicles, getExtraPoolVehicles } from './allocation.js';

export const CALC_TYPES = {
    FLAT: {
        label: 'Fixed per flat',
        hint: 'Same amount for every selected flat',
        amountLabel: 'Amount per flat (₹)',
    },
    PER_SQFT: {
        label: 'Rate × sq ft',
        hint: 'Multiply rate by each flat\'s area (sq ft)',
        amountLabel: 'Rate per sq ft (₹)',
        needsArea: true,
    },
    PRO_RATA_AREA: {
        label: 'Split total by sq ft',
        hint: 'Divide a pool amount across flats by area share',
        amountLabel: 'Total to distribute (₹)',
        needsArea: true,
    },
    MANUAL: {
        label: 'Variable per flat',
        hint: 'Enter amount per flat in preview (e.g. water meter)',
        amountLabel: 'Not used — enter in preview',
        isManual: true,
    },
    PER_CAR_SLOT: {
        label: 'Rate × car slots',
        hint: 'Rate multiplied by base car slot limit',
        amountLabel: 'Rate per car slot (₹)',
    },
    PER_BIKE_SLOT: {
        label: 'Rate × bike slots',
        hint: 'Rate multiplied by base bike slot limit',
        amountLabel: 'Rate per bike slot (₹)',
    },
    PER_PARKING_SLOT: {
        label: 'Rate × parking slots',
        hint: 'Rate × (car slots + bike slots)',
        amountLabel: 'Rate per slot (₹)',
    },
    PER_EXTRA_CAR_ALLOCATION: {
        label: 'Rate × extra car pool (EH)',
        hint: 'Counts active cars allocated to EH community pool slots for this flat',
        amountLabel: 'Rate per extra car (₹)',
        isLiveRegistry: true,
    },
    PER_EXTRA_BIKE_ALLOCATION: {
        label: 'Rate × extra bike pool (BH)',
        hint: 'Counts active bikes allocated to BH community pool slots for this flat',
        amountLabel: 'Rate per extra bike (₹)',
        isLiveRegistry: true,
    },
};

export const getChargeHeads = () =>
    (portalState.finances.maintenanceChargeHeads || [])
        .filter((h) => h.is_active !== false)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''));

export const getAllChargeHeads = () =>
    [...(portalState.finances.maintenanceChargeHeads || [])]
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''));

export const getInvoiceLines = (invoiceId) =>
    (portalState.finances.maintenanceInvoiceLines || [])
        .filter((l) => l.invoice_id === invoiceId)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

const roundMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const unitArea = (unit) => parseFloat(unit?.area_sqft) || 0;

const totalSelectedArea = (units) =>
    units.reduce((sum, u) => sum + unitArea(u), 0);

const manualKey = (unitId, headId) => `${unitId}:${headId}`;

/**
 * @param {object} head charge head row
 * @param {object} unit unit row
 * @param {{ units: object[], manualAmounts: Record<string, number> }} ctx
 */
export const computeLineAmount = (head, unit, ctx) => {
    const rate = parseFloat(head.default_amount) || 0;
    const type = head.calc_type || 'FLAT';
    let quantity = 1;
    let amount = 0;
    let warning = null;

    switch (type) {
        case 'FLAT':
            amount = rate;
            break;
        case 'PER_SQFT': {
            quantity = unitArea(unit);
            if (quantity <= 0) {
                warning = 'Missing sq ft';
                amount = 0;
            } else {
                amount = rate * quantity;
            }
            break;
        }
        case 'PRO_RATA_AREA': {
            const totalArea = totalSelectedArea(ctx.units || []);
            quantity = unitArea(unit);
            if (totalArea <= 0 || quantity <= 0) {
                warning = totalArea <= 0 ? 'No sq ft data for selected flats' : 'Missing sq ft';
                amount = 0;
            } else {
                amount = (rate * quantity) / totalArea;
            }
            break;
        }
        case 'MANUAL': {
            const key = manualKey(unit.id, head.id);
            const manual = ctx.manualAmounts?.[key];
            if (manual == null || manual === '' || isNaN(parseFloat(manual))) {
                warning = 'Enter amount';
                amount = 0;
            } else {
                amount = parseFloat(manual);
                quantity = 1;
            }
            break;
        }
        case 'PER_CAR_SLOT':
            quantity = parseFloat(unit.car_limit) || 0;
            amount = rate * quantity;
            break;
        case 'PER_BIKE_SLOT':
            quantity = parseFloat(unit.bike_limit) || 0;
            amount = rate * quantity;
            break;
        case 'PER_PARKING_SLOT':
            quantity = (parseFloat(unit.car_limit) || 0) + (parseFloat(unit.bike_limit) || 0);
            amount = rate * quantity;
            break;
        case 'PER_EXTRA_CAR_ALLOCATION':
            quantity = countExtraPoolVehicles(unit, 'car');
            amount = rate * quantity;
            break;
        case 'PER_EXTRA_BIKE_ALLOCATION':
            quantity = countExtraPoolVehicles(unit, 'bike');
            amount = rate * quantity;
            break;
        default:
            amount = rate;
    }

    return {
        amount: roundMoney(Math.max(0, amount)),
        quantity: quantity || null,
        rate: type === 'MANUAL' ? null : rate,
        warning,
        calc_type: type,
        head_name: head.name,
        head_id: head.id,
        detail: formatLineDetail(type, unit, quantity),
    };
};

const formatLineDetail = (type, unit, quantity) => {
    if (type === 'PER_EXTRA_CAR_ALLOCATION' && quantity > 0) {
        const plates = getExtraPoolVehicles(unit, 'car').map((v) => v.plate).join(', ');
        return `${quantity} EH · ${plates}`;
    }
    if (type === 'PER_EXTRA_BIKE_ALLOCATION' && quantity > 0) {
        const plates = getExtraPoolVehicles(unit, 'bike').map((v) => v.plate).join(', ');
        return `${quantity} BH · ${plates}`;
    }
    if (type === 'PER_EXTRA_CAR_ALLOCATION') return '0 EH';
    if (type === 'PER_EXTRA_BIKE_ALLOCATION') return '0 BH';
    return null;
};

/**
 * Build preview rows for bulk billing
 */
export const buildBillingPreview = ({ unitIds, headIds, manualAmounts = {} }) => {
    const units = portalState.units
        .filter((u) => unitIds.includes(u.id))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

    const heads = getChargeHeads().filter((h) => headIds.includes(h.id));
    const ctx = { units, manualAmounts };

    const rows = units.map((unit) => {
        const lines = heads.map((head) => {
            const computed = computeLineAmount(head, unit, ctx);
            return { head, ...computed };
        });
        const total = roundMoney(lines.reduce((s, l) => s + l.amount, 0));
        const warnings = lines.filter((l) => l.warning).map((l) => `${l.head_name}: ${l.warning}`);
        return { unit, lines, total, warnings };
    });

    const grandTotal = roundMoney(rows.reduce((s, r) => s + r.total, 0));
    return { rows, heads, grandTotal };
};

/** Apply imported or overridden amounts onto a billing preview */
export const applyLineOverrides = (preview, overrides = {}) => {
    if (!overrides || !preview?.rows) return preview;
    for (const row of preview.rows) {
        for (const line of row.lines) {
            const ov = overrides[row.unit.id]?.[line.head.id];
            if (ov != null && !isNaN(parseFloat(ov))) {
                line.amount = roundMoney(Math.max(0, parseFloat(ov)));
                line.warning = null;
            }
        }
        row.total = roundMoney(row.lines.reduce((s, l) => s + l.amount, 0));
        row.warnings = row.lines.filter((l) => l.warning).map((l) => `${l.head.name}: ${l.warning}`);
    }
    preview.grandTotal = roundMoney(preview.rows.reduce((s, r) => s + r.total, 0));
    return preview;
};

export const setBulkHeadCheckboxes = (headIds) => {
    document.querySelectorAll('.bulk-head-checkbox').forEach((el) => {
        el.checked = headIds.includes(el.value);
    });
};

export const calcTypeLabel = (type) => CALC_TYPES[type]?.label || type;

export async function saveChargeHead(payload) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Head name is required.');
    if (!CALC_TYPES[payload.calc_type]) throw new Error('Invalid calculation type.');

    const default_amount = parseFloat(payload.default_amount);
    if (payload.calc_type !== 'MANUAL' && (isNaN(default_amount) || default_amount < 0)) {
        throw new Error('Enter a valid default amount or rate.');
    }

    const row = {
        id: payload.id || crypto.randomUUID(),
        apartment_id,
        name,
        calc_type: payload.calc_type,
        default_amount: payload.calc_type === 'MANUAL' ? 0 : default_amount,
        sort_order: parseInt(payload.sort_order, 10) || 0,
        is_active: payload.is_active !== false,
        notes: payload.notes?.trim() || null,
    };

    const { error } = await supabase.from('maintenance_charge_heads').upsert(row);
    if (error) throw new Error(error.message);
    await pullState();
}

export async function deleteChargeHead(id) {
    if (!supabase) return;
    if (!confirm('Delete this charge head? Existing invoice lines keep the name snapshot.')) return;
    const { error } = await supabase.from('maintenance_charge_heads').delete().eq('id', id);
    if (error) return alert(error.message);
    await pullState();
}

export async function seedDefaultChargeHeads() {
    if (!supabase) return;
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return;
    if (getAllChargeHeads().length) return;

    const defaults = [
        { name: 'Maintenance', calc_type: 'FLAT', default_amount: 3500, sort_order: 1 },
        { name: 'Sinking Fund', calc_type: 'FLAT', default_amount: 500, sort_order: 2 },
        { name: 'Water', calc_type: 'MANUAL', default_amount: 0, sort_order: 3 },
    ];
    for (const d of defaults) {
        await saveChargeHead(d);
    }
}

export const renderChargeHeadsList = () => {
    const container = document.getElementById('charge-heads-list');
    if (!container) return;

    const heads = getAllChargeHeads();
    if (!heads.length) {
        container.innerHTML = '<p class="maintenance-alloc-hint">No charge heads yet. Add one or load suggested defaults.</p>';
        return;
    }

    container.innerHTML = heads.map((h) => {
        const meta = CALC_TYPES[h.calc_type] || {};
        const amt = h.calc_type === 'MANUAL'
            ? 'Per flat in preview'
            : `₹${parseFloat(h.default_amount || 0).toLocaleString('en-IN')}${h.calc_type === 'PER_SQFT' ? '/sqft' : ''}`;
        return `<div class="charge-head-row ${h.is_active === false ? 'charge-head-row--inactive' : ''}">
          <div class="charge-head-row__main">
            <strong>${h.name}</strong>
            <span class="charge-head-row__meta">${calcTypeLabel(h.calc_type)} · ${amt}</span>
            ${h.notes ? `<span class="charge-head-row__notes">${h.notes}</span>` : ''}
          </div>
          <div class="charge-head-row__actions">
            <button type="button" class="btn btn-outline btn--small" data-edit-head="${h.id}"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="btn btn-outline btn--small" style="color:var(--danger);" data-del-head="${h.id}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-edit-head]').forEach((btn) => {
        btn.addEventListener('click', () => openChargeHeadEditor(btn.dataset.editHead));
    });
    container.querySelectorAll('[data-del-head]').forEach((btn) => {
        btn.addEventListener('click', () => deleteChargeHead(btn.dataset.delHead).then(() => {
            renderChargeHeadsList();
            refreshBulkInvoiceHeads();
        }));
    });
};

const openChargeHeadEditor = (headId = null) => {
    const form = document.getElementById('charge-head-form');
    const title = document.getElementById('charge-head-editor-title');
    if (!form) return;

    form.reset();
    form.dataset.headId = headId || '';

    const head = headId ? getAllChargeHeads().find((h) => h.id === headId) : null;
    if (title) title.textContent = head ? `Edit — ${head.name}` : 'Add charge head';

    const typeEl = document.getElementById('charge-head-calc-type');
    const amountWrap = document.getElementById('charge-head-amount-wrap');
    const amountLabel = document.getElementById('charge-head-amount-label');
    const amountEl = document.getElementById('charge-head-default-amount');

    if (head) {
        document.getElementById('charge-head-name').value = head.name;
        if (typeEl) typeEl.value = head.calc_type;
        if (amountEl) amountEl.value = head.default_amount;
        document.getElementById('charge-head-notes').value = head.notes || '';
        document.getElementById('charge-head-sort').value = head.sort_order || 0;
        document.getElementById('charge-head-active').checked = head.is_active !== false;
    }

    const syncAmountField = () => {
        const type = typeEl?.value || 'FLAT';
        const meta = CALC_TYPES[type] || CALC_TYPES.FLAT;
        if (amountLabel) amountLabel.textContent = meta.amountLabel;
        if (amountWrap) amountWrap.hidden = !!meta.isManual;
        if (amountEl) amountEl.required = !meta.isManual;
    };
    typeEl?.removeEventListener('change', typeEl._syncHandler);
    typeEl._syncHandler = syncAmountField;
    typeEl?.addEventListener('change', syncAmountField);
    syncAmountField();

    document.getElementById('charge-head-editor-panel')?.removeAttribute('hidden');
};

export const closeChargeHeadEditor = () => {
    document.getElementById('charge-head-editor-panel')?.setAttribute('hidden', '');
};

export const openChargeHeadsModal = async () => {
    if (!getAllChargeHeads().length) await seedDefaultChargeHeads().catch(() => {});
    renderChargeHeadsList();
    closeChargeHeadEditor();
    document.getElementById('charge-heads-modal')?.classList.add('active');
};

export const closeChargeHeadsModal = () => {
    document.getElementById('charge-heads-modal')?.classList.remove('active');
    refreshBulkInvoiceHeads();
};

export const refreshBulkInvoiceHeads = () => {
    const container = document.getElementById('bulk-invoice-heads');
    if (!container) return;

    const heads = getChargeHeads();
    if (!heads.length) {
        container.innerHTML = `<p class="maintenance-alloc-hint">No charge heads configured.
          <button type="button" class="btn btn-outline btn--small" id="bulk-open-heads-inline">Set up heads</button></p>`;
        document.getElementById('bulk-open-heads-inline')?.addEventListener('click', openChargeHeadsModal);
        return;
    }

    container.innerHTML = heads.map((h) => {
        const meta = CALC_TYPES[h.calc_type] || {};
        return `<label class="bulk-head-check">
          <input type="checkbox" class="bulk-head-checkbox" value="${h.id}" checked />
          <span class="bulk-head-check__body">
            <strong>${h.name}</strong>
            <span>${meta.label}${h.calc_type !== 'MANUAL' ? ` · ₹${parseFloat(h.default_amount || 0).toLocaleString('en-IN')}` : ''}</span>
          </span>
        </label>`;
    }).join('');

    container.querySelectorAll('.bulk-head-checkbox').forEach((el) => {
        el.addEventListener('change', () => window.refreshBulkInvoicePreview?.());
    });
};

export const getSelectedBulkHeadIds = () =>
    [...document.querySelectorAll('.bulk-head-checkbox:checked')].map((el) => el.value);

export const initChargeHeadsUi = () => {
    document.getElementById('charge-head-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('charge-head-save-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
            await saveChargeHead({
                id: document.getElementById('charge-head-form')?.dataset.headId || null,
                name: document.getElementById('charge-head-name')?.value,
                calc_type: document.getElementById('charge-head-calc-type')?.value,
                default_amount: document.getElementById('charge-head-default-amount')?.value,
                sort_order: document.getElementById('charge-head-sort')?.value,
                notes: document.getElementById('charge-head-notes')?.value,
                is_active: document.getElementById('charge-head-active')?.checked,
            });
            closeChargeHeadEditor();
            renderChargeHeadsList();
            refreshBulkInvoiceHeads();
        } catch (err) {
            alert(err?.message || 'Could not save charge head.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save head'; }
        }
    });

    document.getElementById('charge-head-add-btn')?.addEventListener('click', () => openChargeHeadEditor());
    document.getElementById('charge-head-seed-btn')?.addEventListener('click', async () => {
        try {
            await seedDefaultChargeHeads();
            renderChargeHeadsList();
            refreshBulkInvoiceHeads();
        } catch (err) {
            alert(err?.message || 'Could not load defaults.');
        }
    });
    document.getElementById('charge-head-cancel-btn')?.addEventListener('click', closeChargeHeadEditor);

    document.getElementById('charge-heads-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'charge-heads-modal') closeChargeHeadsModal();
    });
};

window.openChargeHeadsModal = openChargeHeadsModal;
window.closeChargeHeadsModal = closeChargeHeadsModal;
