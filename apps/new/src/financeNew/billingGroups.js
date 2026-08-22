/** Finance-New clone (billingGroups.js) */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
import { bindFinanceNewWindow } from './windowBridge.js';
/**
 * Billing groups — combine multiple flats into one invoice
 */
import { portalState } from '../store.js';
import { pullState } from './pull.js';
import { mongoInsert, mongoUpsert, mongoDelete } from './mongoWrite.js';
import { logActivity } from '../activityAudit.js';
import { withButtonBusy } from '../buttonBusy.js';

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normUnit = (n) => String(n || '').trim().toUpperCase();

export const getBillingGroupUnits = () => fnFinances().maintenanceBillingGroupUnits || [];

export const getBillingGroups = () =>
    (fnFinances().maintenanceBillingGroups || [])
        .filter((g) => g.is_active !== false)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''));

export const getAllBillingGroups = () =>
    [...(fnFinances().maintenanceBillingGroups || [])]
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''));

export const getUnitIdsForGroup = (groupId) =>
    getBillingGroupUnits()
        .filter((m) => m.group_id === groupId)
        .map((m) => m.unit_id);

export const getGroupById = (groupId) =>
    getAllBillingGroups().find((g) => g.id === groupId) || null;

/** unit_id -> group (active groups only) */
export const buildUnitToGroupMap = () => {
    const activeIds = new Set(getBillingGroups().map((g) => g.id));
    const map = new Map();
    getBillingGroupUnits().forEach((m) => {
        if (activeIds.has(m.group_id)) map.set(m.unit_id, getGroupById(m.group_id));
    });
    return map;
};

export const getGroupIdsForUnit = (unitId) => {
    const g = buildUnitToGroupMap().get(unitId);
    return g ? [g.id] : [];
};

export const formatGroupUnitLabels = (groupId, unitLabelFn) => {
    const ids = getUnitIdsForGroup(groupId);
    const units = portalState.units
        .filter((u) => ids.includes(u.id))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
    return units.map((u) => (unitLabelFn ? unitLabelFn(u.id) : u.number)).join(', ');
};

export const getInvoiceGroupLabel = (inv, unitLabelFn) => {
    if (!inv?.billing_group_id) return null;
    const group = getGroupById(inv.billing_group_id);
    const flats = formatGroupUnitLabels(inv.billing_group_id, unitLabelFn);
    return group ? `${group.name}${flats ? ` (${flats})` : ''}` : flats || 'Combined invoice';
};

export async function fetchResidentsForApartment(apartmentId) {
    // Finance-New: use residents module / portal cache (no Postgres query).
    if (!apartmentId) return [];
    try {
        const { getResidents, loadResidents } = await import('../residents.js');
        await loadResidents(false);
        return (getResidents() || []).filter((r) => !r.apartment_id || String(r.apartment_id) === String(apartmentId));
    } catch {
        return [];
    }
}

/** Suggest groups from owners with the same name on multiple flats */
export const suggestGroupsFromOwners = (residents = []) => {
    const byOwner = new Map();
    residents
        .filter((r) => (r.kind || '').toUpperCase() === 'OWNER')
        .forEach((r) => {
            const key = normName(r.full_name);
            if (!key || key.length < 2) return;
            if (!byOwner.has(key)) byOwner.set(key, { name: r.full_name.trim(), unitNumbers: new Set() });
            byOwner.get(key).unitNumbers.add(normUnit(r.unit_number));
        });

    const unitByNumber = new Map(
        portalState.units.map((u) => [normUnit(u.number), u]),
    );
    const assigned = new Set(getBillingGroupUnits().map((m) => m.unit_id));

    const suggestions = [];
    byOwner.forEach(({ name, unitNumbers }) => {
        if (unitNumbers.size < 2) return;
        const units = [...unitNumbers]
            .map((n) => unitByNumber.get(n))
            .filter(Boolean)
            .filter((u) => !assigned.has(u.id));
        if (units.length < 2) return;
        suggestions.push({
            name,
            contact_name: name,
            unitIds: units.map((u) => u.id),
            unitLabels: units.map((u) => u.number).join(', '),
        });
    });

    return suggestions.sort((a, b) => a.name.localeCompare(b.name));
};

export async function saveBillingGroup(payload) {
        const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Group name is required.');

    const unitIds = [...new Set((payload.unitIds || []).filter(Boolean))];
    if (!unitIds.length) throw new Error('Select at least one flat for the group.');

    const groupId = payload.id || crypto.randomUUID();
    const row = {
        id: groupId,
        apartment_id,
        name,
        contact_name: payload.contact_name?.trim() || null,
        notes: payload.notes?.trim() || null,
        sort_order: parseInt(payload.sort_order, 10) || 0,
        is_active: payload.is_active !== false,
    };

    await mongoUpsert('maintenance_billing_groups', row, { rehydrate: false });
    await mongoDelete('maintenance_billing_group_units', { group_id: groupId }, { rehydrate: false });
    const memberRows = unitIds.map((unit_id) => ({
        group_id: groupId,
        unit_id,
        apartment_id,
    }));
    await mongoInsert('maintenance_billing_group_units', memberRows);
    await pullState({ packs: ['billing', 'boot'] });
    void logActivity({
        entityType: 'BILLING_GROUP',
        entityId: groupId,
        action: payload.id ? 'UPDATE' : 'CREATE',
        summary: `${payload.id ? 'Updated' : 'Added'} billing group ${name}`,
        newData: { ...row, unitIds },
    });
}

export async function deleteBillingGroup(id) {
    if (!confirm('Delete this billing group? Existing combined invoices are kept.')) return;
    try {
        await mongoDelete('maintenance_billing_groups', { id });
        await pullState({ packs: ['billing', 'boot'] });
        void logActivity({
            entityType: 'BILLING_GROUP',
            entityId: id,
            action: 'DELETE',
            summary: `Deleted billing group ${id}`,
        });
    } catch (err) {
        alert(err.message);
    }
}

export async function createSuggestedGroups(suggestions) {
    for (const s of suggestions) {
        await saveBillingGroup({
            name: s.name,
            contact_name: s.contact_name,
            unitIds: s.unitIds,
        });
    }
}

/** Selection state while the group editor is open (survives search/filter) */
let editorSelectedUnitIds = new Set();

const getUnitNumber = (unitId) =>
    portalState.units.find((u) => u.id === unitId)?.number || '—';

const renderSelectedUnitsList = () => {
    const container = document.getElementById('billing-group-selected-list');
    if (!container) return;

    const ids = [...editorSelectedUnitIds];
    if (!ids.length) {
        container.innerHTML = '<p class="maintenance-alloc-hint billing-group-selected-empty">No flats selected — pick from the list below.</p>';
        return;
    }

    const sorted = ids
        .map((id) => ({ id, number: getUnitNumber(id) }))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

    container.innerHTML = `
      <div class="billing-group-selected-head">
        <span class="billing-group-selected-count">${sorted.length} flat${sorted.length === 1 ? '' : 's'} selected</span>
        <button type="button" class="btn btn-outline btn--small" id="billing-group-clear-selected">Clear all</button>
      </div>
      <ul class="billing-group-selected-chips">${sorted.map(({ id, number }) => `
        <li class="billing-group-selected-chip">
          <span>${number}</span>
          <button type="button" class="billing-group-remove-unit" data-unit-id="${id}" aria-label="Remove ${number}">&times;</button>
        </li>`).join('')}
      </ul>`;

    container.querySelectorAll('.billing-group-remove-unit').forEach((btn) => {
        btn.addEventListener('click', () => {
            editorSelectedUnitIds.delete(btn.dataset.unitId);
            renderSelectedUnitsList();
            renderGroupUnitPicker();
        });
    });
    document.getElementById('fn-billing-group-clear-selected')?.addEventListener('click', () => {
        editorSelectedUnitIds.clear();
        renderSelectedUnitsList();
        renderGroupUnitPicker();
    });
};

const renderGroupUnitPicker = () => {
    const grid = document.getElementById('billing-group-unit-grid');
    if (!grid) return;

    const q = (document.getElementById('billing-group-unit-search')?.value || '').trim().toUpperCase();
    const units = portalState.units
        .filter((u) => !q || String(u.number).toUpperCase().includes(q))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

    if (!units.length) {
        grid.innerHTML = '<p class="maintenance-alloc-hint">No flats match your search.</p>';
        return;
    }

    grid.innerHTML = units.map((u) => {
        const checked = editorSelectedUnitIds.has(u.id);
        const selectedClass = checked ? ' bulk-unit-check--selected' : '';
        return `<label class="bulk-unit-check${selectedClass}">
          <input type="checkbox" class="billing-group-unit-checkbox" value="${u.id}" ${checked ? 'checked' : ''} />
          <span>${u.number}</span>
        </label>`;
    }).join('');

    grid.querySelectorAll('.billing-group-unit-checkbox').forEach((el) => {
        el.addEventListener('change', () => {
            if (el.checked) editorSelectedUnitIds.add(el.value);
            else editorSelectedUnitIds.delete(el.value);
            renderSelectedUnitsList();
            el.closest('.bulk-unit-check')?.classList.toggle('bulk-unit-check--selected', el.checked);
        });
    });
};

const getSelectedGroupUnitIds = () => [...editorSelectedUnitIds];

const openBillingGroupEditor = (groupId = null) => {
    const form = document.getElementById('billing-group-form');
    if (!form) return;
    form.reset();
    form.dataset.groupId = groupId || '';

    const searchEl = document.getElementById('billing-group-unit-search');
    if (searchEl) searchEl.value = '';

    const group = groupId ? getAllBillingGroups().find((g) => g.id === groupId) : null;
    document.getElementById('billing-group-editor-title').textContent = group
        ? `Edit — ${group.name}`
        : 'Add billing group';

    editorSelectedUnitIds = new Set(group ? getUnitIdsForGroup(group.id) : []);

    if (group) {
        document.getElementById('billing-group-name').value = group.name;
        document.getElementById('billing-group-contact').value = group.contact_name || '';
        document.getElementById('billing-group-notes').value = group.notes || '';
        document.getElementById('billing-group-sort').value = group.sort_order || 0;
        document.getElementById('billing-group-active').checked = group.is_active !== false;
    }

    renderSelectedUnitsList();
    renderGroupUnitPicker();
    document.getElementById('billing-group-editor-panel')?.removeAttribute('hidden');
};

export const closeBillingGroupEditor = () => {
    editorSelectedUnitIds.clear();
    document.getElementById('billing-group-editor-panel')?.setAttribute('hidden', '');
};

export const renderBillingGroupsList = () => {
    const container = document.getElementById('billing-groups-list');
    if (!container) return;

    const groups = getAllBillingGroups();
    if (!groups.length) {
        container.innerHTML = '<p class="maintenance-alloc-hint">No billing groups yet. Add one or suggest from owner records.</p>';
        return;
    }

    container.innerHTML = groups.map((g) => {
        const flats = formatGroupUnitLabels(g.id, null);
        const inactive = g.is_active === false ? ' charge-head-row--inactive' : '';
        return `<div class="charge-head-row${inactive}">
          <div class="charge-head-row__main">
            <strong>${g.name}</strong>
            <span class="charge-head-row__meta">${flats || 'No flats'}${g.contact_name ? ` · ${g.contact_name}` : ''}</span>
            ${g.notes ? `<span class="charge-head-row__notes">${g.notes}</span>` : ''}
          </div>
          <div class="charge-head-row__actions">
            <button type="button" class="btn btn-outline btn--small" data-edit-billing-group="${g.id}"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="btn btn-outline btn--small" style="color:var(--danger);" data-del-billing-group="${g.id}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-edit-billing-group]').forEach((btn) => {
        btn.addEventListener('click', () => openBillingGroupEditor(btn.dataset.editBillingGroup));
    });
    container.querySelectorAll('[data-del-billing-group]').forEach((btn) => {
        btn.addEventListener('click', () => deleteBillingGroup(btn.dataset.delBillingGroup).then(() => {
            renderBillingGroupsList();
        }));
    });
};

const renderSuggestPanel = async () => {
    const panel = document.getElementById('billing-group-suggest-panel');
    if (!panel) return;

    const apartmentId = portalState.access?.activeApartmentId;
    const residents = await fetchResidentsForApartment(apartmentId);
    const suggestions = suggestGroupsFromOwners(residents);

    if (!suggestions.length) {
        panel.innerHTML = '<p class="maintenance-alloc-hint">No new multi-flat owner matches found (owners must share a name on 2+ ungrouped flats).</p>';
        return;
    }

    panel.innerHTML = `
      <p class="maintenance-alloc-hint" style="margin-bottom:0.5rem;">Found ${suggestions.length} owner name(s) with multiple flats:</p>
      <div class="billing-group-suggest-list">${suggestions.map((s, i) => `
        <label class="bulk-head-check">
          <input type="checkbox" class="billing-group-suggest-check" value="${i}" checked />
          <span class="bulk-head-check__body">
            <strong>${s.name}</strong>
            <span>${s.unitLabels}</span>
          </span>
        </label>`).join('')}
      </div>
      <button type="button" class="btn btn-primary btn--small" id="billing-group-suggest-create" style="margin-top:0.5rem;">
        Create selected groups
      </button>`;

    panel.dataset.suggestions = JSON.stringify(suggestions);
    document.getElementById('fn-billing-group-suggest-create')?.addEventListener('click', async () => {
        const raw = panel.dataset.suggestions;
        if (!raw) return;
        const all = JSON.parse(raw);
        const picked = [...document.querySelectorAll('.billing-group-suggest-check:checked')]
            .map((el) => all[parseInt(el.value, 10)])
            .filter(Boolean);
        if (!picked.length) {
            alert('Select at least one suggestion.');
            return;
        }
        const btn = document.getElementById('fn-billing-group-suggest-create');
        await withButtonBusy(btn, 'Creating…', async () => {
            await createSuggestedGroups(picked);
            panel.innerHTML = `<p class="maintenance-alloc-hint">Created ${picked.length} group(s).</p>`;
            renderBillingGroupsList();
        }).catch((err) => alert(err?.message || 'Could not create groups.'));
    });
};

export const openBillingGroupsModal = () => {
    renderBillingGroupsList();
    closeBillingGroupEditor();
    renderSuggestPanel();
    document.getElementById('billing-groups-modal')?.classList.add('active');
};

export const closeBillingGroupsModal = () => {
    document.getElementById('billing-groups-modal')?.classList.remove('active');
};

export const isCombineGroupsEnabled = () =>
    document.getElementById('bulk-combine-groups')?.checked === true;

export const initBillingGroupsUi = () => {
    document.getElementById('billing-group-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('billing-group-save-btn');
        await withButtonBusy(btn, 'Saving…', async () => {
            await saveBillingGroup({
                id: document.getElementById('billing-group-form')?.dataset.groupId || null,
                name: document.getElementById('billing-group-name')?.value,
                contact_name: document.getElementById('billing-group-contact')?.value,
                notes: document.getElementById('billing-group-notes')?.value,
                sort_order: document.getElementById('billing-group-sort')?.value,
                is_active: document.getElementById('billing-group-active')?.checked,
                unitIds: getSelectedGroupUnitIds(),
            });
            closeBillingGroupEditor();
            renderBillingGroupsList();
            renderSuggestPanel();
        }).catch((err) => alert(err?.message || 'Could not save group.'));
    });

    document.getElementById('billing-group-add-btn')?.addEventListener('click', () => openBillingGroupEditor());
    document.getElementById('billing-group-cancel-btn')?.addEventListener('click', closeBillingGroupEditor);
    document.getElementById('billing-group-unit-search')?.addEventListener('input', () => {
        renderGroupUnitPicker();
    });
    document.getElementById('billing-group-suggest-btn')?.addEventListener('click', renderSuggestPanel);
    document.getElementById('billing-groups-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'billing-groups-modal') closeBillingGroupsModal();
    });
    document.getElementById('bulk-combine-groups')?.addEventListener('change', () => {
        window.refreshBulkInvoicePreview?.();
    });
};

bindFinanceNewWindow('openBillingGroupsModal', openBillingGroupsModal);
bindFinanceNewWindow('closeBillingGroupsModal', closeBillingGroupsModal);
