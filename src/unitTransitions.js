/**
 * Move-in / move-out — flat-centric occupancy changes with enforced rules
 */
import { portalState, supabase, pullState } from './store.js';
import { invoiceBalance, getOpenInvoicesForUnit, openMaintenanceCollectionForFlat } from './maintenanceBilling.js';
import { loadResidents, getResidentsForUnit, clearResidentsCache } from './residents.js';
import { logActivity } from './activityAudit.js';
import { initFlatPicker, getFlatPickerUnitId } from './flatPicker.js';
import {
    renderTransitionChargesSection,
    bindTransitionChargesHandlers,
    collectTransitionFeeFromForm,
    applyTransitionFee,
} from './transitionFees.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unitById = (id) => portalState.units.find((u) => u.id === id);
const unitLabel = (id) => unitById(id)?.number || '—';

const ACTIONS = [
    {
        key: 'owner-move-in',
        type: 'MOVE_IN',
        party: 'OWNER',
        label: 'Owner move-in',
        icon: 'fa-key',
        summary: 'Add owner or mark as residing',
        detail: 'Register a co-owner or mark an existing owner as residing at this flat.',
    },
    {
        key: 'tenant-move-in',
        type: 'MOVE_IN',
        party: 'TENANT',
        label: 'Tenant move-in',
        icon: 'fa-user-plus',
        summary: 'Add a tenant to this flat',
        detail: 'Only allowed when no owner is residing here.',
    },
    {
        key: 'owner-move-out',
        type: 'MOVE_OUT',
        party: 'OWNER',
        label: 'Owner move-out',
        icon: 'fa-door-open',
        summary: 'Owner is leaving',
        detail: 'Marks owners as not residing and removes all vehicles on this flat.',
    },
    {
        key: 'tenant-move-out',
        type: 'MOVE_OUT',
        party: 'TENANT',
        label: 'Tenant move-out',
        icon: 'fa-user-minus',
        summary: 'Remove tenant(s)',
        detail: 'Deletes tenant records and portal links. Removes vehicles if the flat becomes vacant.',
    },
];

let activeActionKey = null;

export const getUnitOccupancyState = (unitId, residents = null) => {
    const unit = unitById(unitId);
    if (!unit) return null;
    const rows = residents || getResidentsForUnit(unit.number);
    const owners = rows.filter((r) => (r.kind || '').toUpperCase() === 'OWNER');
    const tenants = rows.filter((r) => (r.kind || '').toUpperCase() === 'TENANT');
    const residingOwners = owners.filter((r) => r.is_residing !== false);
    const vehicles = unit.vehicles || [];
    let status = unit.occupancy_status || 'VACANT';
    if (tenants.length) status = 'TENANT_OCCUPIED';
    else if (residingOwners.length) status = 'OWNER_OCCUPIED';
    else if (!unit.occupancy_status) status = 'VACANT';

    return { unit, owners, tenants, residingOwners, vehicles, status };
};

const deriveOccupancyStatus = (tenantCount, residingOwnerCount) => {
    if (tenantCount > 0) return 'TENANT_OCCUPIED';
    if (residingOwnerCount > 0) return 'OWNER_OCCUPIED';
    return 'VACANT';
};

/** True when this action changes flat occupancy status (VACANT / OWNER / TENANT). */
export const willOccupancyStatusChange = (unitId, action, draft = {}) => {
    const state = getUnitOccupancyState(unitId);
    if (!state) return false;
    const before = state.status;

    if (action.type === 'MOVE_IN' && action.party === 'OWNER') {
        return state.residingOwners.length === 0;
    }
    if (action.type === 'MOVE_IN' && action.party === 'TENANT') {
        return before !== 'TENANT_OCCUPIED';
    }
    if (action.type === 'MOVE_OUT' && action.party === 'TENANT') {
        const removeIds = draft.resident_ids || state.tenants.map((t) => t.id);
        const remainingTenants = state.tenants.filter((t) => !removeIds.includes(t.id)).length;
        const after = deriveOccupancyStatus(remainingTenants, state.residingOwners.length);
        return before !== after;
    }
    if (action.type === 'MOVE_OUT' && action.party === 'OWNER') {
        const removeIds = draft.resident_ids || state.residingOwners.map((o) => o.id);
        const remainingResiding = state.residingOwners.filter((o) => !removeIds.includes(o.id)).length;
        const after = deriveOccupancyStatus(state.tenants.length, remainingResiding);
        return before !== after;
    }
    return false;
};

function renderChargesWrap(unitId, action, actionKey, draft = {}) {
    const show = willOccupancyStatusChange(unitId, action, draft);
    if (!show) return '';
    return `<div id="transition-charges-wrap">${renderTransitionChargesSection(actionKey)}</div>`;
}

function syncChargesVisibility(formEl, unitId, action, draft = {}) {
    const wrap = formEl?.querySelector('#transition-charges-wrap');
    if (!wrap) return;
    wrap.hidden = !willOccupancyStatusChange(unitId, action, draft);
};

export const validateTransitionStart = (unitId, transitionType, partyKind) => {
    const state = getUnitOccupancyState(unitId);
    if (!state) return 'Flat not found.';

    const inProgress = (portalState.operations?.unitTransitions || [])
        .filter((t) => t.unit_id === unitId && t.status === 'IN_PROGRESS');
    if (inProgress.length) {
        return 'A move is already pending for this flat. Complete or cancel it first.';
    }

    if (transitionType === 'MOVE_IN') {
        if (partyKind === 'TENANT') {
            if (state.residingOwners.length) {
                return 'An owner is still residing here. Do an owner move-out before adding a tenant.';
            }
            if (state.tenants.length) {
                return 'Tenant(s) already on record. Do a tenant move-out first.';
            }
        }
        if (partyKind === 'OWNER') {
            if (state.tenants.length) {
                return 'Tenant(s) still on record. Do a tenant move-out before owner move-in.';
            }
        }
    }

    if (transitionType === 'MOVE_OUT') {
        if (partyKind === 'TENANT') {
            if (!state.tenants.length) return 'No tenants on record for this flat.';
        }
        if (partyKind === 'OWNER') {
            if (!state.owners.length) return 'No owner on record for this flat.';
            if (!state.residingOwners.length) return 'No owner is marked as residing.';
            if (state.tenants.length) {
                return 'Tenant(s) still on record. Do a tenant move-out first.';
            }
        }
    }

    return null;
};

function getActionAvailability(unitId) {
    const pending = (portalState.operations?.unitTransitions || [])
        .find((t) => t.unit_id === unitId && t.status === 'IN_PROGRESS');
    const globalBlock = pending ? 'A move is already pending for this flat.' : null;

    return ACTIONS.map((action) => {
        const ruleBlock = validateTransitionStart(unitId, action.type, action.party);
        const blockedReason = globalBlock || ruleBlock;
        return { ...action, enabled: !blockedReason, blockedReason };
    });
}

function statusLabel(status) {
    return (status || 'VACANT').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function residentLine(r) {
    const residing = r.is_residing !== false;
    const tag = (r.kind || '').toUpperCase() === 'OWNER'
        ? (residing ? 'Residing' : 'Not residing')
        : 'Tenant';
    const contact = [r.phone, r.email].filter(Boolean).join(' · ');
    return `<li class="occ-person">
      <span class="occ-person__name">${r.full_name || '—'}</span>
      <span class="occ-person__tag occ-person__tag--${residing ? 'active' : 'inactive'}">${tag}</span>
      ${contact ? `<span class="occ-person__contact">${contact}</span>` : ''}
    </li>`;
}

function renderOccupancySnapshot(state) {
    const { owners, tenants, residingOwners, vehicles, status } = state;
    return `
      <div class="occ-snapshot">
        <div class="occ-snapshot__head">
          <span class="occ-snapshot__status occ-snapshot__status--${status.toLowerCase()}">${statusLabel(status)}</span>
        </div>
        <div class="occ-snapshot__grid">
          <section class="occ-block">
            <h4>Owners <span class="occ-count">${owners.length}</span></h4>
            ${owners.length
        ? `<ul class="occ-people">${owners.map(residentLine).join('')}</ul>`
        : '<p class="occ-empty">No owner on record</p>'}
          </section>
          <section class="occ-block">
            <h4>Tenants <span class="occ-count">${tenants.length}</span></h4>
            ${tenants.length
        ? `<ul class="occ-people">${tenants.map(residentLine).join('')}</ul>`
        : '<p class="occ-empty">No tenants</p>'}
          </section>
          <section class="occ-block">
            <h4>Vehicles <span class="occ-count">${vehicles.length}</span></h4>
            ${vehicles.length
        ? `<ul class="occ-vehicles">${vehicles.map((v) =>
        `<li>${v.plate || '—'} <span class="occ-vehicle-type">${v.type || ''}</span></li>`,
    ).join('')}</ul>`
        : '<p class="occ-empty">No vehicles registered</p>'}
          </section>
        </div>
        ${residingOwners.length && !tenants.length
        ? '<p class="occ-rule-hint"><i class="fa-solid fa-circle-info"></i> Owner is residing — tenant move-in is blocked until owner move-out. Use Owner move-in to add a co-owner or mark another owner as residing.</p>'
        : ''}
        ${tenants.length
        ? '<p class="occ-rule-hint"><i class="fa-solid fa-circle-info"></i> Tenant(s) on record — owner move-in is blocked until tenant move-out.</p>'
        : ''}
      </div>`;
}

function residentPickRow(r, { checked = true, disabled = false } = {}) {
    const residing = r.is_residing !== false;
    const kind = (r.kind || '').toUpperCase();
    const tag = kind === 'OWNER' ? (residing ? 'Owner · residing' : 'Owner · not residing') : 'Tenant';
    const contact = [r.phone, r.email].filter(Boolean).join(' · ');
    return `<label class="occ-pick-row ${disabled ? 'occ-pick-row--disabled' : ''}">
      <input type="checkbox" class="occ-pick-checkbox" data-transition-pick="resident" value="${r.id}"
        ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span class="occ-pick-row__main">
        <span class="occ-pick-row__label">${r.full_name || '—'}</span>
        <span class="occ-pick-row__meta">${tag}${contact ? ` · ${contact}` : ''}</span>
      </span>
    </label>`;
}

function vehiclePickRow(v, { checked = true } = {}) {
    return `<label class="occ-pick-row">
      <input type="checkbox" class="occ-pick-checkbox" data-transition-pick="vehicle" value="${v.id}" ${checked ? 'checked' : ''} />
      <span class="occ-pick-row__main">
        <span class="occ-pick-row__label">${v.plate || '—'}</span>
        <span class="occ-pick-row__meta">${v.type || 'Vehicle'}${v.allocation_type ? ` · ${v.allocation_type}` : ''}</span>
      </span>
    </label>`;
}

function renderPickSection(title, pickKind, rowsHtml, emptyText, icon = 'fa-user') {
    if (!rowsHtml) {
        return `<section class="occ-pick-card occ-pick-card--empty">
          <div class="occ-pick-card__head"><span class="occ-pick-card__title"><i class="fa-solid ${icon}"></i> ${title}</span></div>
          <p class="occ-empty">${emptyText}</p>
        </section>`;
    }
    return `<section class="occ-pick-card">
      <div class="occ-pick-card__head">
        <span class="occ-pick-card__title"><i class="fa-solid ${icon}"></i> ${title}</span>
        <span class="occ-pick-card__actions">
          <button type="button" class="occ-pick-toggle" data-pick-all="${pickKind}">All</button>
          <button type="button" class="occ-pick-toggle" data-pick-none="${pickKind}">None</button>
        </span>
      </div>
      <div class="occ-pick-list">${rowsHtml}</div>
    </section>`;
}

function renderFinancesPanel(duesHtml, chargesHtml) {
    if (!duesHtml && !chargesHtml) return '';
    const subtitle = duesHtml && chargesHtml
        ? 'Clear prior maintenance dues and apply move charges before you confirm.'
        : duesHtml
            ? 'Clear outstanding maintenance dues or defer collection before you confirm.'
            : 'Apply move charges before you confirm.';
    return `
      <section class="occ-form-step occ-form-step--finances">
        <div class="occ-form-step__head">
          <span class="occ-form-step__num">2</span>
          <div>
            <h5>Settle finances</h5>
            <p>${subtitle}</p>
          </div>
        </div>
        <div class="occ-finances-panel">
          ${duesHtml ? `<div class="occ-finances-block">${duesHtml}</div>` : ''}
          ${chargesHtml ? `<div class="occ-finances-block">${chargesHtml}</div>` : ''}
        </div>
      </section>`;
}

function renderFormFooter(confirmLabel, actionKey, duePending) {
    return `
      <footer class="occ-form-footer">
        <div class="occ-form-notes">
          <label class="occ-form-notes__label" for="transition-notes">Notes <span class="occ-form-notes__opt">(optional)</span></label>
          <textarea id="transition-notes" class="occ-form-notes__input" rows="2" placeholder="Add context for this move…"></textarea>
        </div>
        <div class="occ-form-actions">
          <button type="button" class="btn btn-outline btn--small" data-cancel-action>Back</button>
          <button type="button" class="btn btn-primary btn--small ${duePending ? 'occ-confirm-btn--dues-pending' : ''}" data-confirm-action="${actionKey}">${confirmLabel}</button>
        </div>
      </footer>`;
}

function getOutstandingDueForUnit(unitId) {
    const open = getOpenInvoicesForUnit(unitId);
    return open.reduce((s, inv) => s + invoiceBalance(inv), 0);
}

function renderDuesBlock(unitId, due, { context = 'move-out' } = {}) {
    if (due <= 0.001) return '';
    const open = getOpenInvoicesForUnit(unitId);
    const invoiceRows = open.map((inv) => {
        const bal = invoiceBalance(inv);
        const dueDate = inv.due_date
            ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-IN')
            : '—';
        return `<li class="occ-dues-invoice">
          <span class="occ-dues-invoice__period">${inv.period_label || 'Invoice'}</span>
          <span class="occ-dues-invoice__due">Due ${dueDate}</span>
          <strong class="occ-dues-invoice__amt">${formatMoney(bal)}</strong>
        </li>`;
    }).join('');

    const deferLabel = context === 'move-in'
        ? 'Proceed with move-in — previous dues remain and will be cleared separately'
        : 'Proceed without clearing dues — outstanding amount to be collected later';

    return `
      <div class="occ-dues-inner">
        <div class="occ-dues-inner__head">
          <div>
            <span class="occ-finances-block__title">Prior maintenance dues</span>
            <strong class="occ-dues-total">${formatMoney(due)} outstanding</strong>
          </div>
          <button type="button" class="btn btn-primary btn--small" data-record-dues-payment>
            <i class="fa-solid fa-indian-rupee-sign"></i> Record payment
          </button>
        </div>
        <ul class="occ-dues-invoices">${invoiceRows}</ul>
        <label class="occ-dues-defer">
          <input type="checkbox" id="transition-dues-deferred" class="occ-dues-defer__check" />
          <span>${deferLabel}</span>
        </label>
      </div>`;
}

function renderMoveOutPickForm({ unitId, title, intro, residents, vehicles, due, confirmLabel, actionKey, partyKind }) {
    const action = { type: 'MOVE_OUT', party: partyKind };
    const defaultResidentIds = partyKind === 'OWNER'
        ? residents.filter((r) => r.is_residing !== false).map((r) => r.id)
        : residents.map((r) => r.id);
    const residentRows = residents.map((r) => residentPickRow(r, {
        checked: r.is_residing !== false,
        disabled: r.is_residing === false,
    })).join('');

    const vehicleRows = vehicles.map((v) => vehiclePickRow(v)).join('');

    const duesHtml = due > 0.001 ? renderDuesBlock(unitId, due, { context: 'move-out' }) : '';
    const chargesHtml = renderChargesWrap(unitId, action, actionKey, { resident_ids: defaultResidentIds });
    const hasFinances = duesHtml || chargesHtml;

    return `
      <div class="occ-action-form">
        <header class="occ-form-header">
          <h4>${title}</h4>
          <p>${intro}</p>
        </header>

        <section class="occ-form-step">
          <div class="occ-form-step__head">
            <span class="occ-form-step__num">1</span>
            <div>
              <h5>Select what to update</h5>
              <p>Uncheck anyone or any vehicle that should remain on this flat.</p>
            </div>
          </div>
          <div class="occ-pick-grid">
            ${renderPickSection('Residents', 'resident', residentRows, 'No residents on record.', 'fa-users')}
            ${renderPickSection('Vehicles', 'vehicle', vehicleRows, 'No vehicles registered.', 'fa-car')}
          </div>
          <div class="occ-impact-card" id="transition-moveout-summary">
            <span class="occ-impact-card__label"><i class="fa-solid fa-eye"></i> Preview</span>
            <p class="occ-impact-card__placeholder">Adjust selections above to see what will change.</p>
          </div>
        </section>

        ${hasFinances ? renderFinancesPanel(duesHtml, chargesHtml) : ''}

        ${renderFormFooter(confirmLabel, actionKey, due > 0.001)}
      </div>`;
}

function bindDuesFormHandlers(formEl, unitId, paymentContext = 'move-out') {
    if (!formEl) return;

    formEl.querySelector('[data-record-dues-payment]')?.addEventListener('click', () => {
        const unit = unitById(unitId);
        if (!unit) return;
        const due = getOutstandingDueForUnit(unitId);
        if (due <= 0.001) {
            alert('No outstanding dues for this flat.');
            return;
        }
        openMaintenanceCollectionForFlat(unit.number, 'BANK', {
            amount: due,
            description: `${paymentContext === 'move-in' ? 'Move-in' : 'Move-out'} clearance — ${unit.number}`,
            autoApply: true,
            context: 'move-out',
        });
    });

    const syncDuesDeferUi = () => {
        const deferCb = formEl.querySelector('#transition-dues-deferred');
        const confirmBtn = formEl.querySelector('[data-confirm-action]');
        if (!confirmBtn) return;
        const deferred = deferCb?.checked;
        confirmBtn.classList.toggle('occ-confirm-btn--dues-pending', !deferred && getOutstandingDueForUnit(unitId) > 0.001);
    };

    formEl.querySelector('#transition-dues-deferred')?.addEventListener('change', syncDuesDeferUi);
    syncDuesDeferUi();
}

function bindMoveOutPickHandlers(formEl, state, partyKind, unitId) {
    if (!formEl) return;

    const action = { type: 'MOVE_OUT', party: partyKind };
    const actionKey = `${partyKind.toLowerCase()}-move-out`;

    bindDuesFormHandlers(formEl, unitId, 'move-out');
    if (formEl.querySelector('#transition-charges-wrap')) {
        bindTransitionChargesHandlers(formEl, actionKey);
    }

    const updateSummary = () => {
        const summaryEl = formEl.querySelector('#transition-moveout-summary');
        if (!summaryEl) return;
        const residentIds = collectCheckedIds('resident');
        const vehicleIds = collectCheckedIds('vehicle');
        const residentCount = residentIds.length;
        const vehicleCount = vehicleIds.length;

        syncChargesVisibility(formEl, unitId, action, { resident_ids: residentIds });

        if (partyKind === 'OWNER') {
            const remaining = state.residingOwners.filter((o) => !residentIds.includes(o.id)).length;
            const status = remaining ? 'Owner occupied' : 'Vacant';
            summaryEl.innerHTML = residentCount ? `
              <span class="occ-impact-card__label"><i class="fa-solid fa-eye"></i> Preview</span>
              <ul class="occ-impact-list">
                <li><i class="fa-solid fa-user-minus"></i> <strong>${residentCount}</strong> owner(s) marked not residing</li>
                <li><i class="fa-solid fa-car"></i> <strong>${vehicleCount}</strong> vehicle(s) removed</li>
                <li><i class="fa-solid fa-building"></i> Flat status → <strong>${status}</strong></li>
              </ul>` : `
              <span class="occ-impact-card__label"><i class="fa-solid fa-eye"></i> Preview</span>
              <p class="occ-impact-card__placeholder">Select at least one owner to move out.</p>`;
        } else {
            const remainingTenants = state.tenants.filter((t) => !residentIds.includes(t.id)).length;
            const vacant = !state.residingOwners.length && remainingTenants === 0;
            summaryEl.innerHTML = residentCount ? `
              <span class="occ-impact-card__label"><i class="fa-solid fa-eye"></i> Preview</span>
              <ul class="occ-impact-list">
                <li><i class="fa-solid fa-user-minus"></i> <strong>${residentCount}</strong> tenant(s) removed</li>
                <li><i class="fa-solid fa-car"></i> <strong>${vehicleCount}</strong> vehicle(s) removed</li>
                ${vacant ? '<li><i class="fa-solid fa-building"></i> Flat becomes <strong>vacant</strong></li>' : ''}
              </ul>` : `
              <span class="occ-impact-card__label"><i class="fa-solid fa-eye"></i> Preview</span>
              <p class="occ-impact-card__placeholder">Select at least one tenant to remove.</p>`;
        }
    };

    formEl.querySelectorAll('[data-pick-all]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = btn.dataset.pickAll;
            formEl.querySelectorAll(`input[data-transition-pick="${kind}"]:not(:disabled)`).forEach((cb) => {
                cb.checked = true;
            });
            updateSummary();
        });
    });

    formEl.querySelectorAll('[data-pick-none]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const kind = btn.dataset.pickNone;
            formEl.querySelectorAll(`input[data-transition-pick="${kind}"]:not(:disabled)`).forEach((cb) => {
                cb.checked = false;
            });
            updateSummary();
        });
    });

    formEl.querySelectorAll('.occ-pick-checkbox').forEach((cb) => {
        cb.addEventListener('change', updateSummary);
    });

    updateSummary();
}

function collectCheckedIds(pickKind) {
    return [...document.querySelectorAll(`input[data-transition-pick="${pickKind}"]:checked`)].map((el) => el.value);
}

function renderActionForm(unitId, action, state) {
    const due = getOutstandingDueForUnit(unitId);

    if (action.type === 'MOVE_OUT' && action.party === 'OWNER') {
        return renderMoveOutPickForm({
            unitId,
            title: 'Confirm owner move-out',
            intro: 'Choose which owners to mark as not residing and which vehicles to remove from this flat.',
            residents: state.owners,
            vehicles: state.vehicles,
            due,
            confirmLabel: 'Confirm owner move-out',
            actionKey: action.key,
            partyKind: 'OWNER',
        });
    }

    if (action.type === 'MOVE_OUT' && action.party === 'TENANT') {
        return renderMoveOutPickForm({
            unitId,
            title: 'Confirm tenant move-out',
            intro: 'Choose which tenants to remove and which vehicles to de-register from this flat.',
            residents: state.tenants,
            vehicles: state.vehicles,
            due,
            confirmLabel: 'Confirm tenant move-out',
            actionKey: action.key,
            partyKind: 'TENANT',
        });
    }

    if (action.party === 'OWNER') {
        const ownerAction = { type: 'MOVE_IN', party: 'OWNER' };
        const showCharges = willOccupancyStatusChange(unitId, ownerAction);
        const ownerOpts = state.owners.map((o) =>
            `<option value="${o.id}">${o.full_name}${o.is_residing === false ? ' (not residing)' : ''}</option>`,
        ).join('');
        return `
          <div class="occ-action-form">
            <header class="occ-form-header">
              <h4>Owner move-in</h4>
              <p>${state.residingOwners.length
        ? 'Add a co-owner or mark an existing owner as residing. Flat stays owner-occupied — no move charges.'
        : 'Register who will occupy this flat. Move charges apply when the flat becomes owner-occupied.'}</p>
            </header>
            <section class="occ-form-step">
              <div class="occ-form-step__head">
                <span class="occ-form-step__num">1</span>
                <div><h5>Owner details</h5></div>
              </div>
              <div class="occ-form-fields">
                ${state.owners.length ? `
                  <label class="resident-link-label">Existing owner</label>
                  <select id="transition-owner-pick" class="resident-link-field">
                    <option value="">— Add new owner —</option>
                    ${ownerOpts}
                  </select>` : ''}
                <div class="occ-form-fields__row">
                  <div><label class="resident-link-label">Full name</label>
                  <input id="transition-owner-name" class="resident-link-field" placeholder="Owner name" required /></div>
                  <div><label class="resident-link-label">Phone</label>
                  <input id="transition-owner-phone" class="resident-link-field" /></div>
                  <div><label class="resident-link-label">Email</label>
                  <input id="transition-owner-email" type="email" class="resident-link-field" /></div>
                </div>
              </div>
            </section>
            ${(due > 0.001 || showCharges) ? renderFinancesPanel(
        due > 0.001 ? renderDuesBlock(unitId, due, { context: 'move-in' }) : '',
        showCharges ? renderChargesWrap(unitId, ownerAction, action.key) : '',
    ) : ''}
            ${renderFormFooter('Confirm owner move-in', action.key, due > 0.001)}
          </div>`;
    }

    const tenantAction = { type: 'MOVE_IN', party: 'TENANT' };
    const showTenantCharges = willOccupancyStatusChange(unitId, tenantAction);
    return `
      <div class="occ-action-form">
        <header class="occ-form-header">
          <h4>Tenant move-in</h4>
          <p>Add the primary tenant for this flat. Move charges apply when occupancy changes.</p>
        </header>
        <section class="occ-form-step">
          <div class="occ-form-step__head">
            <span class="occ-form-step__num">1</span>
            <div><h5>Tenant details</h5></div>
          </div>
          <div class="occ-form-fields">
            <div class="occ-form-fields__row">
              <div><label class="resident-link-label">Full name</label>
              <input id="transition-tenant-name" class="resident-link-field" placeholder="Tenant name" required /></div>
              <div><label class="resident-link-label">Phone</label>
              <input id="transition-tenant-phone" class="resident-link-field" /></div>
              <div><label class="resident-link-label">Email</label>
              <input id="transition-tenant-email" type="email" class="resident-link-field" /></div>
            </div>
            <p class="resident-link-hint">Additional tenants can be added later from Property → Residents.</p>
          </div>
        </section>
        ${(due > 0.001 || showTenantCharges) ? renderFinancesPanel(
        due > 0.001 ? renderDuesBlock(unitId, due, { context: 'move-in' }) : '',
        showTenantCharges ? renderChargesWrap(unitId, tenantAction, action.key) : '',
    ) : ''}
        ${renderFormFooter('Confirm tenant move-in', action.key, due > 0.001)}
      </div>`;
}

function renderActionCards(unitId, availability) {
    return `
      <div class="occ-actions">
        <h4>What do you want to do?</h4>
        <div class="occ-actions__grid">
          ${availability.map((a) => `
            <button type="button"
              class="occ-action-card ${a.enabled ? '' : 'occ-action-card--disabled'} ${activeActionKey === a.key ? 'occ-action-card--active' : ''}"
              data-action="${a.key}"
              ${a.enabled ? '' : 'disabled'}
              title="${a.blockedReason || ''}">
              <i class="fa-solid ${a.icon} occ-action-card__icon"></i>
              <span class="occ-action-card__label">${a.label}</span>
              <span class="occ-action-card__summary">${a.summary}</span>
              ${!a.enabled && a.blockedReason
        ? `<span class="occ-action-card__block">${a.blockedReason}</span>`
        : ''}
            </button>`).join('')}
        </div>
      </div>`;
}

function renderPendingBanner(unitId) {
    const pending = (portalState.operations?.unitTransitions || [])
        .find((t) => t.unit_id === unitId && t.status === 'IN_PROGRESS');
    if (!pending) return '';
    const party = pending.party_kind ? ` (${pending.party_kind.toLowerCase()})` : '';
    return `
      <div class="occ-pending-banner">
        <div>
          <strong>Pending:</strong> ${pending.transition_type.replace('_', ' ').toLowerCase()}${party}
          <span class="occ-pending-date">started ${new Date(pending.created_at).toLocaleDateString('en-IN')}</span>
        </div>
        <div class="occ-pending-banner__btns">
          <button type="button" class="btn btn-primary btn--small" data-resume-pending="${pending.id}">Complete</button>
          <button type="button" class="btn btn-outline btn--small btn--danger" data-cancel-pending="${pending.id}">Cancel</button>
        </div>
      </div>`;
}

function renderUnitPanel(unitId) {
    const panel = document.getElementById('ops-transition-panel');
    if (!panel) return;

    const state = getUnitOccupancyState(unitId);
    if (!state) {
        panel.innerHTML = '<p class="ops-empty">Flat not found.</p>';
        return;
    }

    const availability = getActionAvailability(unitId);
    const activeMeta = availability.find((a) => a.key === activeActionKey);

    panel.innerHTML = `
      ${renderPendingBanner(unitId)}
      ${renderOccupancySnapshot(state)}
      ${renderActionCards(unitId, availability)}
      ${activeMeta?.enabled ? renderActionForm(unitId, activeMeta, state) : ''}`;

    panel.querySelector('[data-cancel-action]')?.addEventListener('click', () => {
        activeActionKey = null;
        renderUnitPanel(unitId);
    });

    panel.querySelector('#transition-owner-pick')?.addEventListener('change', (e) => {
        const o = state.owners.find((x) => x.id === e.target.value);
        if (!o) return;
        document.getElementById('transition-owner-name').value = o.full_name || '';
        document.getElementById('transition-owner-phone').value = o.phone || '';
        document.getElementById('transition-owner-email').value = o.email || '';
    });

    panel.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            activeActionKey = btn.dataset.action;
            renderUnitPanel(unitId);
            panel.querySelector('.occ-action-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    });

    panel.querySelectorAll('[data-confirm-action]').forEach((btn) => {
        btn.addEventListener('click', () => void executeAction(unitId, btn.dataset.confirmAction));
    });

    const actionForm = panel.querySelector('.occ-action-form');
    if (actionForm && activeMeta?.type === 'MOVE_OUT') {
        bindMoveOutPickHandlers(actionForm, state, activeMeta.party, unitId);
    } else if (actionForm && activeMeta) {
        if (actionForm.querySelector('.occ-dues-block')) {
            bindDuesFormHandlers(actionForm, unitId, 'move-in');
        }
        if (actionForm.querySelector('#transition-charges-wrap')) {
            bindTransitionChargesHandlers(actionForm, activeMeta.key);
        }
    }

    panel.querySelector('[data-resume-pending]')?.addEventListener('click', (e) => {
        const t = portalState.operations.unitTransitions.find((x) => x.id === e.target.dataset.resumePending);
        if (t?.party_kind) {
            activeActionKey = ACTIONS.find((a) => a.type === t.transition_type && a.party === t.party_kind)?.key;
            renderUnitPanel(unitId);
        }
    });

    panel.querySelector('[data-cancel-pending]')?.addEventListener('click', (e) => {
        void cancelTransition(e.target.dataset.cancelPending);
    });
}

function snapshotTransitionPayload(unitId, action, payload) {
    const unit = unitById(unitId);
    if (!unit) return payload;

    const out = { ...payload };

    if (action.type === 'MOVE_OUT') {
        const residents = getResidentsForUnit(unit.number);
        const idSet = new Set(payload.resident_ids || []);
        out.residents_snapshot = residents
            .filter((r) => idSet.has(r.id))
            .map((r) => ({ id: r.id, name: (r.full_name || '—').trim() }));

        const vidSet = new Set(payload.vehicle_ids || []);
        out.vehicles_snapshot = (unit.vehicles || [])
            .filter((v) => vidSet.has(v.id))
            .map((v) => ({
                id: v.id,
                plate: (v.plate || '—').trim(),
                type: v.type || null,
            }));
    } else {
        const existing = payload.resident_id
            ? getResidentsForUnit(unit.number).find((r) => r.id === payload.resident_id)
            : null;
        out.person_snapshot = {
            name: (payload.full_name?.trim() || existing?.full_name || '—').trim(),
            phone: payload.phone?.trim() || existing?.phone || null,
            email: payload.email?.trim() || existing?.email || null,
        };
    }

    return out;
}

function transitionActionLabel(t) {
    const verb = t.transition_type === 'MOVE_IN' ? 'Move in' : 'Move out';
    const party = t.party_kind === 'OWNER' ? 'owner' : 'tenant';
    return `${verb} · ${party}`;
}

function fallbackResidentNames(unitId, ids = []) {
    if (!ids.length) return [];
    const unit = unitById(unitId);
    if (!unit) return [];
    const byId = new Map(getResidentsForUnit(unit.number).map((r) => [r.id, r.full_name]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
}

function transitionPeopleLine(t) {
    const p = t.payload || {};
    if (t.transition_type === 'MOVE_OUT') {
        const names = (p.residents_snapshot || []).map((r) => r.name).filter((n) => n && n !== '—');
        if (!names.length) names.push(...fallbackResidentNames(t.unit_id, p.resident_ids));
        if (names.length) return names.join(', ');
        if (p.resident_ids?.length) {
            const who = t.party_kind === 'OWNER' ? 'owner' : 'tenant';
            return `${p.resident_ids.length} ${who}(s)`;
        }
        return null;
    }
    const person = p.person_snapshot;
    const name = person?.name || p.full_name?.trim();
    return name && name !== '—' ? name : null;
}

function transitionVehiclesLine(t) {
    const p = t.payload || {};
    if (t.transition_type !== 'MOVE_OUT') return null;
    const plates = (p.vehicles_snapshot || []).map((v) => v.plate).filter((pl) => pl && pl !== '—');
    if (!plates.length && p.vehicle_ids?.length) {
        const unit = unitById(t.unit_id);
        const byId = new Map((unit?.vehicles || []).map((v) => [v.id, v.plate]));
        plates.push(...p.vehicle_ids.map((id) => byId.get(id)).filter(Boolean));
    }
    if (plates.length) return plates.join(', ');
    if (p.vehicle_ids?.length) return `${p.vehicle_ids.length} vehicle(s)`;
    return null;
}

function transitionMetaBadges(t) {
    const p = t.payload || {};
    const badges = [];
    if (p.dues_deferred) {
        badges.push('<span class="occ-history-badge occ-history-badge--warn">dues deferred</span>');
    }
    if (p.transition_fee?.apply) {
        const label = p.transition_fee.paid ? 'fee paid' : 'fee invoiced';
        badges.push(`<span class="occ-history-badge occ-history-badge--ok">${label}</span>`);
    }
    return badges.join('');
}

function renderHistoryRow(t, { showUnit = false } = {}) {
    const when = t.completed_at || t.created_at;
    const dateStr = when ? new Date(when).toLocaleDateString('en-IN') : '—';
    const people = transitionPeopleLine(t);
    const vehicles = transitionVehiclesLine(t);
    const badges = transitionMetaBadges(t);
    const moveClass = t.transition_type === 'MOVE_IN' ? 'occ-history-item--in' : 'occ-history-item--out';
    const icon = t.transition_type === 'MOVE_IN' ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket';

    const detailParts = [];
    if (people) {
        detailParts.push(`<span class="occ-history-detail__people"><i class="fa-solid fa-user"></i> ${escHtml(people)}</span>`);
    }
    if (vehicles) {
        detailParts.push(`<span class="occ-history-detail__vehicles"><i class="fa-solid fa-car"></i> ${escHtml(vehicles)}</span>`);
    }
    const detailHtml = detailParts.length
        ? `<div class="occ-history-item__detail">${detailParts.join('')}</div>`
        : '';

    const unitHtml = showUnit
        ? `<span class="occ-history-item__flat">${unitLabel(t.unit_id)}</span>`
        : '';

    const notes = t.payload?.notes?.trim();
    const notesHtml = notes
        ? `<div class="occ-history-item__notes" title="${escHtml(notes)}">${escHtml(notes)}</div>`
        : '';

    return `<article class="occ-history-item ${moveClass}">
      <div class="occ-history-item__icon"><i class="fa-solid ${icon}"></i></div>
      <div class="occ-history-item__body">
        <div class="occ-history-item__head">
          <span class="occ-history-item__action">${transitionActionLabel(t)}</span>
          ${unitHtml}
          <span class="occ-history-item__date">${dateStr}</span>
        </div>
        ${detailHtml}
        ${notesHtml}
        ${badges ? `<div class="occ-history-item__badges">${badges}</div>` : ''}
      </div>
    </article>`;
}

function renderHistory(unitId) {
    const el = document.getElementById('ops-transitions-list');
    if (!el) return;

    const rows = (portalState.operations?.unitTransitions || [])
        .filter((t) => t.status !== 'CANCELLED' && (!unitId || t.unit_id === unitId))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, 20);

    if (!rows.length) {
        el.innerHTML = `<p class="ops-empty">${unitId
            ? 'No move-in/out history for this flat yet.'
            : 'No move-in/out activity recorded yet.'}</p>`;
        return;
    }

    el.innerHTML = rows.map((t) => renderHistoryRow(t, { showUnit: !unitId })).join('');
}

export const renderTransitions = async () => {
    const panel = document.getElementById('ops-transition-panel');
    if (!panel) return;

    await loadResidents(true);

    const unitId = getFlatPickerUnitId();
    if (!unitId) {
        panel.innerHTML = '<p class="ops-empty">Choose a block (optional) and flat above to see who lives there and what move-in or move-out actions are available.</p>';
        renderHistory(null);
        return;
    }

    renderUnitPanel(unitId);
    renderHistory(unitId);
};

function collectPayload(action) {
    const unitId = getFlatPickerUnitId();
    const duesOutstanding = unitId ? getOutstandingDueForUnit(unitId) : 0;
    const duesDeferred = document.getElementById('transition-dues-deferred')?.checked || false;
    const notes = document.getElementById('transition-notes')?.value?.trim() || '';

    const duesMeta = duesOutstanding > 0.001
        ? { dues_deferred: duesDeferred, dues_outstanding: duesOutstanding }
        : {};

    const transition_fee = collectTransitionFeeFromForm();
    const occupancy_status_changed = willOccupancyStatusChange(
        getFlatPickerUnitId(),
        { type: action.type, party: action.party },
        action.type === 'MOVE_OUT' ? { resident_ids: collectCheckedIds('resident') } : {},
    );

    const baseMeta = { occupancy_status_changed, transition_fee, ...duesMeta };

    if (action.type === 'MOVE_OUT') {
        return {
            notes,
            resident_ids: collectCheckedIds('resident'),
            vehicle_ids: collectCheckedIds('vehicle'),
            ...baseMeta,
        };
    }
    if (action.party === 'OWNER') {
        return {
            resident_id: document.getElementById('transition-owner-pick')?.value || null,
            full_name: document.getElementById('transition-owner-name')?.value?.trim(),
            phone: document.getElementById('transition-owner-phone')?.value?.trim(),
            email: document.getElementById('transition-owner-email')?.value?.trim(),
            notes,
            ...baseMeta,
        };
    }
    return {
        full_name: document.getElementById('transition-tenant-name')?.value?.trim(),
        phone: document.getElementById('transition-tenant-phone')?.value?.trim(),
        email: document.getElementById('transition-tenant-email')?.value?.trim(),
        notes,
        ...baseMeta,
    };
}

async function syncUnitOccupancy(unitId) {
    await loadResidents(true);
    const state = getUnitOccupancyState(unitId);
    if (!state?.unit) return;
    let occupancy_status = 'VACANT';
    if (state.tenants.length) occupancy_status = 'TENANT_OCCUPIED';
    else if (state.residingOwners.length) occupancy_status = 'OWNER_OCCUPIED';
    await supabase.from('units').update({ occupancy_status }).eq('id', unitId);
}

async function deleteResidentLinks(residentIds) {
    if (!residentIds.length) return;
    await supabase.from('resident_user_links').delete().in('resident_id', residentIds);
}

async function removeVehiclesByIds(vehicleIds) {
    if (!vehicleIds?.length) return;
    await supabase.from('vehicles').delete().in('id', vehicleIds);
}

async function applyMoveOut(t, payload) {
    const unit = unitById(t.unit_id);
    if (!unit) throw new Error('Flat not found.');
    await loadResidents(true);
    const residents = getResidentsForUnit(unit.number);
    const residentIds = payload?.resident_ids || [];
    const vehicleIds = payload?.vehicle_ids || [];

    if (t.party_kind === 'TENANT') {
        if (!residentIds.length) throw new Error('Select at least one tenant to remove.');
        const tenantIds = residents
            .filter((r) => (r.kind || '').toUpperCase() === 'TENANT' && residentIds.includes(r.id))
            .map((r) => r.id);
        if (!tenantIds.length) throw new Error('Selected tenants not found.');
        await deleteResidentLinks(tenantIds);
        await supabase.from('residents').delete().in('id', tenantIds);
        if (vehicleIds.length) await removeVehiclesByIds(vehicleIds);
    } else if (t.party_kind === 'OWNER') {
        if (!residentIds.length) throw new Error('Select at least one owner to move out.');
        const ownerIds = residents
            .filter((r) => (r.kind || '').toUpperCase() === 'OWNER' && residentIds.includes(r.id))
            .map((r) => r.id);
        if (!ownerIds.length) throw new Error('Selected owners not found.');
        for (const id of ownerIds) {
            await supabase.from('residents').update({ is_residing: false }).eq('id', id);
        }
        if (vehicleIds.length) await removeVehiclesByIds(vehicleIds);
    }

    clearResidentsCache();
    await syncUnitOccupancy(t.unit_id);
    await pullState();
}

async function applyMoveIn(t, payload) {
    const unit = unitById(t.unit_id);
    if (!unit) throw new Error('Flat not found.');
    const apartment_id = portalState.access?.activeApartmentId;

    if (t.party_kind === 'OWNER') {
        const name = payload?.full_name?.trim();
        if (!name) throw new Error('Owner name is required.');
        const existingId = payload?.resident_id;
        const row = {
            apartment_id,
            unit_number: unit.number,
            kind: 'OWNER',
            full_name: name,
            phone: payload?.phone?.trim() || null,
            email: payload?.email?.trim() || null,
            is_residing: true,
            is_primary: true,
        };
        if (existingId) {
            await supabase.from('residents').update(row).eq('id', existingId);
        } else {
            await supabase.from('residents').insert({ ...row, id: crypto.randomUUID() });
        }
        await supabase.from('units').update({ occupancy_status: 'OWNER_OCCUPIED' }).eq('id', t.unit_id);
    } else if (t.party_kind === 'TENANT') {
        const name = payload?.full_name?.trim();
        if (!name) throw new Error('Tenant name is required.');
        await supabase.from('residents').insert({
            id: crypto.randomUUID(),
            apartment_id,
            unit_number: unit.number,
            kind: 'TENANT',
            full_name: name,
            phone: payload?.phone?.trim() || null,
            email: payload?.email?.trim() || null,
            is_residing: true,
            is_primary: false,
        });
        await supabase.from('units').update({ occupancy_status: 'TENANT_OCCUPIED' }).eq('id', t.unit_id);
    }

    clearResidentsCache();
    await pullState();
}

async function executeAction(unitId, actionKey) {
    const action = ACTIONS.find((a) => a.key === actionKey);
    if (!action) return;

    const err = validateTransitionStart(unitId, action.type, action.party);
    if (err) return alert(err);

    await loadResidents();
    const payload = snapshotTransitionPayload(unitId, action, collectPayload(action));
    const due = getOutstandingDueForUnit(unitId);

    const assertDuesClearedOrDeferred = (actionLabel) => {
        if (due <= 0.001) return true;
        if (payload.dues_deferred) {
            const noteHint = payload.notes ? '' : '\n\nConsider adding a note about when/how dues will be collected.';
            return confirm(
                `${actionLabel} for ${unitLabel(unitId)} with ${formatMoney(due)} still outstanding?\n\n`
                + 'Dues are marked for future collection and remain on this flat\'s account.'
                + noteHint,
            );
        }
        alert(
            `Outstanding maintenance dues: ${formatMoney(due)}.\n\n`
            + 'Either record payment using "Record payment", or tick '
            + '"Proceed without clearing dues" to continue and track for future collection.',
        );
        return false;
    };

    if (action.type === 'MOVE_OUT') {
        if (!payload.resident_ids?.length) {
            return alert(action.party === 'OWNER'
                ? 'Select at least one owner to move out.'
                : 'Select at least one tenant to remove.');
        }
        if (!assertDuesClearedOrDeferred('Confirm move-out')) return;
        if (due <= 0.001) {
            const who = action.party === 'OWNER' ? 'owner' : 'tenant';
            const parts = [
                `${payload.resident_ids.length} ${who}(s)`,
                payload.vehicle_ids?.length ? `${payload.vehicle_ids.length} vehicle(s)` : null,
            ].filter(Boolean).join(', ');
            if (!confirm(`Confirm move-out for ${unitLabel(unitId)}?\n\nWill update: ${parts}.`)) return;
        }
    }

    if (action.type === 'MOVE_IN') {
        if (action.party === 'OWNER' && !payload.full_name) {
            return alert('Owner name is required.');
        }
        if (action.party === 'TENANT' && !payload.full_name) {
            return alert('Tenant name is required.');
        }
        if (!assertDuesClearedOrDeferred('Confirm move-in')) return;
    }

    const apartment_id = portalState.access?.activeApartmentId;
    const id = crypto.randomUUID();
    const t = { id, unit_id: unitId, transition_type: action.type, party_kind: action.party };

    const { error: insErr } = await supabase.from('unit_transitions').insert({
        id,
        apartment_id,
        unit_id: unitId,
        transition_type: action.type,
        party_kind: action.party,
        checklist: {},
        payload,
        status: 'COMPLETED',
        completed_at: new Date().toISOString(),
    });
    if (insErr) return alert(insErr.message);

    try {
        if (action.type === 'MOVE_OUT') await applyMoveOut(t, payload);
        else await applyMoveIn(t, payload);

        if (payload.transition_fee?.apply && payload.occupancy_status_changed) {
            const feeResult = await applyTransitionFee({
                unitId,
                transitionId: id,
                transitionType: action.type,
                partyKind: action.party,
                actionKey,
                fee: payload.transition_fee,
            });
            if (feeResult) {
                payload.transition_fee = { ...payload.transition_fee, ...feeResult };
                await supabase.from('unit_transitions').update({ payload }).eq('id', id);
            }
        }
    } catch (e) {
        await supabase.from('unit_transitions').delete().eq('id', id);
        return alert(e.message || 'Could not apply changes.');
    }

    const feeNote = payload.transition_fee?.apply
        ? (payload.transition_fee.paid
            ? ` · fee ${formatMoney(payload.transition_fee.amount)} paid`
            : ` · fee invoice ${formatMoney(payload.transition_fee.amount)}`)
        : '';

    await logActivity({
        entityType: 'UNIT_TRANSITION',
        entityId: id,
        action: action.type,
        summary: payload.dues_deferred
            ? `${action.label} completed for ${unitLabel(unitId)} (dues ${formatMoney(payload.dues_outstanding)} deferred)${feeNote}`
            : `${action.label} completed for ${unitLabel(unitId)}${feeNote}`,
        newData: payload,
    });

    activeActionKey = null;
    await renderTransitions();
}

async function cancelTransition(id) {
    if (!confirm('Cancel this pending move? No changes will be applied.')) return;
    const { error } = await supabase.from('unit_transitions').update({ status: 'CANCELLED' }).eq('id', id);
    if (error) return alert(error.message);
    activeActionKey = null;
    await pullState();
    await renderTransitions();
}

export const initUnitTransitions = () => {
    initFlatPicker({
        blockContainerId: 'ops-transition-block-filter',
        inputId: 'ops-transition-unit-input',
        hiddenId: 'ops-transition-unit',
        listId: 'ops-transition-unit-list',
        onChange: (unitId) => {
            activeActionKey = null;
            const panel = document.getElementById('ops-transition-panel');
            if (!panel) return;
            if (unitId) {
                void renderTransitions();
            } else {
                panel.innerHTML = '<p class="ops-empty">Choose a block (optional) and flat above to see who lives there and what move-in or move-out actions are available.</p>';
                renderHistory(null);
            }
        },
    });

    document.addEventListener('maintenance-payment-saved', () => {
        if (!getFlatPickerUnitId()) return;
        void renderTransitions();
    });
};

// Legacy export — no-op; UI is inline now
export const openTransitionWizard = () => {
    const unitId = getFlatPickerUnitId();
    if (!unitId) return alert('Choose a flat first.');
    void renderTransitions();
};
