/**
 * Security gate — step-by-step visitor entry wizard (4 steps)
 */
import './gateWizard.css';
import { portalState, pullState } from './store.js';
import { initFlatPicker } from './flatPicker.js';
import { DELIVERY_COMPANIES } from './visitorGate.js';
import {
    lookupVisitorByContactRemote,
    createVisitorWithApprovals,
    getVisitorLogUnits,
    approvalStatusLabel,
} from './visitorApprovals.js';

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unitLabel = (id) => portalState.units.find((u) => u.id === id)?.number || '—';

const STEP_LABELS = ['Type & contact', 'Details & flat', 'Review', 'Approval'];
const TOTAL_STEPS = 4;

const defaultWizard = () => ({
    step: 1,
    purpose: 'GUEST',
    phone: '',
    email: '',
    lookup: null,
    visitorName: '',
    deliveryCompany: '',
    packageCount: 1,
    holdParcel: true,
    notes: '',
    unitIds: [],
    vehicleReg: '',
    submittedVisitorId: null,
});

let wizard = defaultWizard();
let flatPicker = null;
let pollTimer = null;

const isMultiFlat = () => wizard.purpose === 'DELIVERY' || wizard.purpose === 'SERVICE';

function wizardHasDraft() {
    if (wizard.submittedVisitorId) return true;
    return !!(wizard.phone || wizard.email || wizard.visitorName || wizard.unitIds.length
        || wizard.vehicleReg || wizard.notes || wizard.deliveryCompany || wizard.step > 1);
}

function renderStepDots() {
    const active = wizard.step;
    return STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const cls = n < active ? 'gate-wizard__step-dot--done' : n === active ? 'gate-wizard__step-dot--active' : '';
        return `<div class="gate-wizard__step-dot ${cls}" title="${label}"></div>`;
    }).join('');
}

function renderStepLabel() {
    return `Step ${wizard.step} of ${TOTAL_STEPS} · ${STEP_LABELS[wizard.step - 1]}`;
}

function renderFlatChips() {
    if (!wizard.unitIds.length) return '';
    return wizard.unitIds.map((id) => `
      <span class="gate-wizard__flat-chip">
        ${esc(unitLabel(id))}
        <button type="button" data-remove-flat="${id}" aria-label="Remove ${esc(unitLabel(id))}">×</button>
      </span>`).join('');
}

function renderDeliveryFields() {
    if (wizard.purpose !== 'DELIVERY') return '';
    return `
      <div class="gate-wizard__section">
        <span class="gate-wizard__section-label">Delivery</span>
        <div class="gate-wizard__field">
          <label class="gate-wizard__label" for="gw-company">Company</label>
          <input type="text" id="gw-company" class="expense-combobox" value="${esc(wizard.deliveryCompany)}" list="gw-company-list" placeholder="e.g. Amazon" />
          <datalist id="gw-company-list">${DELIVERY_COMPANIES.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
        </div>
        <div class="gate-wizard__field-row">
          <div class="gate-wizard__field">
            <label class="gate-wizard__label" for="gw-packages">Packages</label>
            <input type="number" id="gw-packages" class="expense-combobox" min="1" value="${wizard.packageCount}" />
          </div>
        </div>
        <label class="visitor-entry-form__check">
          <input type="checkbox" id="gw-hold-parcel" ${wizard.holdParcel ? 'checked' : ''} />
          Hold parcel(s) at gate until resident collects
        </label>
      </div>`;
}

function renderStepContent() {
    switch (wizard.step) {
        case 1:
            return `
              <h3 class="gate-wizard__title">Who is at the gate?</h3>
              <p class="gate-wizard__hint">Choose visit type, then enter a phone or email to look up past visits.</p>
              <div class="gate-wizard__purpose-grid">
                ${['GUEST', 'DELIVERY', 'SERVICE'].map((p) => `
                  <button type="button" class="gate-wizard__purpose-btn${wizard.purpose === p ? ' active' : ''}" data-wizard-purpose="${p}">
                    <i class="fa-solid ${p === 'GUEST' ? 'fa-user' : p === 'DELIVERY' ? 'fa-box' : 'fa-wrench'}"></i>
                    ${p === 'GUEST' ? 'Guest' : p === 'DELIVERY' ? 'Delivery' : 'Service'}
                  </button>`).join('')}
              </div>
              <div class="gate-wizard__section">
                <span class="gate-wizard__section-label">Contact</span>
                <div class="gate-wizard__field">
                  <label class="gate-wizard__label" for="gw-phone">Mobile number</label>
                  <input type="tel" id="gw-phone" class="expense-combobox" placeholder="e.g. 9876543210" value="${esc(wizard.phone)}" />
                </div>
                <p class="gate-wizard__or">or</p>
                <div class="gate-wizard__field">
                  <label class="gate-wizard__label" for="gw-email">Email</label>
                  <input type="email" id="gw-email" class="expense-combobox" placeholder="courier@company.com" value="${esc(wizard.email)}" />
                </div>
                ${wizard.lookup ? `<div class="gate-wizard__lookup-hit">
                  <strong>Found in gate records</strong>
                  ${esc(wizard.lookup.visitor_name)}${wizard.lookup.visit_count > 1 ? ` · ${wizard.lookup.visit_count} past visits` : ''}
                  ${wizard.lookup.vehicle_reg ? `<br>Last vehicle: ${esc(wizard.lookup.vehicle_reg)}` : ''}
                </div>` : ''}
              </div>`;

        case 2:
            return `
              <h3 class="gate-wizard__title">Visitor &amp; destination</h3>
              <p class="gate-wizard__hint">${isMultiFlat()
        ? 'Type a flat number and pick from the list — each one becomes a tag. Keep typing to add more.'
        : 'Type and select the flat the guest is visiting.'}</p>
              <div class="gate-wizard__field">
                <label class="gate-wizard__label" for="gw-name">Full name</label>
                <input type="text" id="gw-name" class="expense-combobox" value="${esc(wizard.visitorName)}" required />
              </div>
              ${renderDeliveryFields()}
              <div class="gate-wizard__section">
                <span class="gate-wizard__section-label">${isMultiFlat() ? 'Flats' : 'Visiting flat'}</span>
                <div id="gw-flat-block-filter"></div>
                <div class="gate-wizard__flat-tags">
                  <div class="gate-wizard__flat-chips" id="gw-flat-chips">${renderFlatChips()}</div>
                  <div class="flat-picker gate-wizard__flat-picker">
                    <div class="flat-picker__wrap">
                      <input type="search" id="gw-flat-input" class="flat-picker__input expense-combobox"
                        placeholder="${isMultiFlat() ? 'Type next flat…' : 'Search flat number…'}" autocomplete="off" />
                      <input type="hidden" id="gw-flat-hidden" value="" />
                      <ul id="gw-flat-list" class="flat-picker__list" role="listbox" hidden></ul>
                    </div>
                  </div>
                </div>
              </div>
              <div class="gate-wizard__section">
                <span class="gate-wizard__section-label">Vehicle <span class="gate-wizard__optional">(optional)</span></span>
                <div class="gate-wizard__field" style="margin-bottom:0;">
                  <input type="text" id="gw-vehicle" class="expense-combobox" placeholder="e.g. KA01AB1234" value="${esc(wizard.vehicleReg)}" />
                </div>
              </div>
              <div class="gate-wizard__field" style="margin-top:0.85rem;">
                <label class="gate-wizard__label" for="gw-notes">Notes <span class="gate-wizard__optional">(optional)</span></label>
                <input type="text" id="gw-notes" class="expense-combobox" value="${esc(wizard.notes)}" placeholder="Any extra detail" />
              </div>`;

        case 3:
            return `
              <h3 class="gate-wizard__title">Review &amp; send for approval</h3>
              <p class="gate-wizard__hint">Residents will be notified on the portal to approve this visit.</p>
              <dl class="gate-wizard__review">
                <dt>Type</dt><dd>${esc(wizard.purpose)}</dd>
                <dt>Visitor</dt><dd>${esc(wizard.visitorName)}</dd>
                <dt>Contact</dt><dd>${esc(wizard.phone || wizard.email || '—')}</dd>
                <dt>Flat(s)</dt><dd>${wizard.unitIds.map((id) => esc(unitLabel(id))).join(', ')}</dd>
                ${wizard.vehicleReg ? `<dt>Vehicle</dt><dd>${esc(wizard.vehicleReg)}</dd>` : ''}
                ${wizard.purpose === 'DELIVERY' ? `<dt>Company</dt><dd>${esc(wizard.deliveryCompany || '—')}</dd>` : ''}
                ${wizard.notes ? `<dt>Notes</dt><dd>${esc(wizard.notes)}</dd>` : ''}
              </dl>`;

        case 4: {
            const units = getVisitorLogUnits(wizard.submittedVisitorId);
            const log = (portalState.operations?.visitorLog || []).find((v) => v.id === wizard.submittedVisitorId);
            const allApproved = log?.approval_status === 'APPROVED';
            const denied = log?.approval_status === 'DENIED';
            return `
              <div class="gate-wizard__waiting">
                <div class="gate-wizard__waiting-icon"><i class="fa-solid ${allApproved ? 'fa-circle-check' : denied ? 'fa-circle-xmark' : 'fa-hourglass-half'}"></i></div>
                <h3 class="gate-wizard__title">${allApproved ? 'Entry approved' : denied ? 'Entry denied' : 'Waiting for approval'}</h3>
                <p class="gate-wizard__hint">${allApproved
        ? 'Allow the visitor in. You can start a new entry below.'
        : denied
            ? 'A resident denied this visit. Do not allow entry.'
            : 'Residents are being notified. You can start another entry — this request stays in the queue.'}</p>
              </div>
              ${units.map((u) => `
                <div class="gate-wizard__unit-status">
                  <span>Flat ${esc(unitLabel(u.unit_id))}</span>
                  <span class="portal-status portal-status--${u.approval_status.toLowerCase()}">${u.approval_status}</span>
                </div>`).join('')}`;
        }
        default:
            return '';
    }
}

function renderWizardFooter() {
    if (wizard.step === 4) {
        return `<div class="gate-wizard__footer gate-wizard__footer--end">
          <button type="button" class="btn btn-primary" id="gw-new-entry">Start new entry</button>
        </div>`;
    }

    const showBack = wizard.step > 1;
    const primaryLabel = wizard.step === 3 ? 'Request approval' : 'Continue';

    return `<div class="gate-wizard__footer">
      ${wizardHasDraft() ? '<button type="button" class="gate-wizard__cancel-btn" id="gw-cancel">Start over</button>' : '<span></span>'}
      <div class="gate-wizard__footer-nav">
        ${showBack ? '<button type="button" class="btn btn-outline" id="gw-back">Back</button>' : ''}
        <button type="button" class="btn btn-primary" id="gw-next">${primaryLabel}</button>
      </div>
    </div>`;
}

export function renderGateWizard() {
    const mount = document.getElementById('sec-wizard-mount');
    if (!mount) return;

    mount.innerHTML = `
      <div class="gate-wizard metric-card gate-wizard__card">
        <div class="gate-wizard__toolbar">
          <span class="gate-wizard__step-label">${renderStepLabel()}</span>
          ${wizardHasDraft() && wizard.step < 4 ? '<button type="button" class="gate-wizard__cancel-link" id="gw-cancel-top">Cancel</button>' : ''}
        </div>
        <div class="gate-wizard__steps" aria-hidden="true">${renderStepDots()}</div>
        <div id="gw-step-body">${renderStepContent()}</div>
        ${renderWizardFooter()}
      </div>`;

    wireStepHandlers();
    if (wizard.step === 2) initWizardFlatPicker();
    if (wizard.step === 4) startApprovalPoll();
    else stopApprovalPoll();
}

function wireStepHandlers() {
    document.querySelectorAll('[data-wizard-purpose]').forEach((btn) => {
        btn.onclick = () => {
            wizard.purpose = btn.dataset.wizardPurpose;
            if (wizard.purpose === 'GUEST' && wizard.unitIds.length > 1) {
                wizard.unitIds = wizard.unitIds.slice(0, 1);
            }
            renderGateWizard();
        };
    });

    document.getElementById('gw-back')?.addEventListener('click', () => {
        captureStepFields();
        wizard.step = Math.max(1, wizard.step - 1);
        renderGateWizard();
    });

    document.getElementById('gw-next')?.addEventListener('click', () => void goNext());
    document.getElementById('gw-new-entry')?.addEventListener('click', () => resetWizard());
    document.getElementById('gw-cancel')?.addEventListener('click', () => confirmCancel());
    document.getElementById('gw-cancel-top')?.addEventListener('click', () => confirmCancel());

    document.querySelectorAll('[data-remove-flat]').forEach((btn) => {
        btn.onclick = () => {
            wizard.unitIds = wizard.unitIds.filter((id) => id !== btn.dataset.removeFlat);
            updateFlatChipsDom();
        };
    });
}

function updateFlatChipsDom() {
    const el = document.getElementById('gw-flat-chips');
    if (!el) return;
    el.innerHTML = renderFlatChips();
    document.querySelectorAll('[data-remove-flat]').forEach((btn) => {
        btn.onclick = () => {
            wizard.unitIds = wizard.unitIds.filter((id) => id !== btn.dataset.removeFlat);
            updateFlatChipsDom();
            flatPicker?.renderList?.();
        };
    });
}

function pickFlatUnit(unit) {
    if (!unit?.id) return;
    if (isMultiFlat()) {
        if (wizard.unitIds.includes(unit.id)) return;
        wizard.unitIds.push(unit.id);
    } else {
        wizard.unitIds = [unit.id];
    }
    updateFlatChipsDom();
    flatPicker?.renderList?.();
}

function confirmCancel() {
    if (!wizardHasDraft()) {
        resetWizard();
        return;
    }
    if (!confirm('Discard this entry and start fresh?')) return;
    resetWizard();
}

function captureStepFields() {
    if (wizard.step === 1) {
        wizard.phone = document.getElementById('gw-phone')?.value?.trim() || '';
        wizard.email = document.getElementById('gw-email')?.value?.trim() || '';
    }
    if (wizard.step === 2) {
        wizard.visitorName = document.getElementById('gw-name')?.value?.trim() || '';
        wizard.deliveryCompany = document.getElementById('gw-company')?.value?.trim() || '';
        wizard.packageCount = parseInt(document.getElementById('gw-packages')?.value, 10) || 1;
        wizard.holdParcel = document.getElementById('gw-hold-parcel')?.checked ?? true;
        wizard.notes = document.getElementById('gw-notes')?.value?.trim() || '';
        wizard.vehicleReg = document.getElementById('gw-vehicle')?.value?.trim() || '';
    }
}

async function goNext() {
    captureStepFields();

    if (wizard.step === 1) {
        if (!wizard.phone && !wizard.email) return alert('Enter a phone number or email.');
        wizard.lookup = await lookupVisitorByContactRemote({ phone: wizard.phone, email: wizard.email });
        if (wizard.lookup) {
            wizard.visitorName = wizard.lookup.visitor_name || wizard.visitorName;
            wizard.vehicleReg = wizard.lookup.vehicle_reg || wizard.vehicleReg;
            wizard.deliveryCompany = wizard.lookup.delivery_company || wizard.deliveryCompany;
            if (!wizard.phone) wizard.phone = wizard.lookup.visitor_phone || '';
            if (!wizard.email) wizard.email = wizard.lookup.visitor_email || '';
        }
        wizard.step = 2;
        renderGateWizard();
        return;
    }

    if (wizard.step === 2) {
        if (!wizard.visitorName) return alert('Enter visitor name.');
        if (!wizard.unitIds.length) return alert(isMultiFlat() ? 'Add at least one flat.' : 'Select a flat.');
        wizard.step = 3;
        renderGateWizard();
        return;
    }

    if (wizard.step === 3) {
        try {
            const { visitorId } = await createVisitorWithApprovals({
                purpose: wizard.purpose,
                visitor_name: wizard.visitorName,
                visitor_phone: wizard.phone,
                visitor_email: wizard.email,
                vehicle_reg: wizard.vehicleReg,
                delivery_company: wizard.deliveryCompany,
                package_count: wizard.packageCount,
                parcel_held: wizard.holdParcel,
                notes: wizard.notes,
                unit_ids: wizard.unitIds,
            });
            wizard.submittedVisitorId = visitorId;
            wizard.step = 4;
            renderGateWizard();
            renderPendingApprovalsPanel();
            document.dispatchEvent(new CustomEvent('gate-data-updated'));
        } catch (e) {
            alert(e.message);
        }
    }
}

function initWizardFlatPicker() {
    flatPicker = initFlatPicker({
        blockContainerId: 'gw-flat-block-filter',
        inputId: 'gw-flat-input',
        hiddenId: 'gw-flat-hidden',
        listId: 'gw-flat-list',
        tagMode: true,
        getExcludeUnitIds: () => wizard.unitIds,
        onUnitPicked: (unit) => pickFlatUnit(unit),
    });

    const input = document.getElementById('gw-flat-input');
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && wizard.unitIds.length) {
            wizard.unitIds.pop();
            updateFlatChipsDom();
            flatPicker?.renderList?.();
        }
    });
}

function resetWizard() {
    stopApprovalPoll();
    wizard = defaultWizard();
    flatPicker = null;
    renderGateWizard();
    renderPendingApprovalsPanel();
}

function startApprovalPoll() {
    stopApprovalPoll();
    pollTimer = setInterval(async () => {
        await pullState();
        renderGateWizard();
        renderPendingApprovalsPanel();
        const log = (portalState.operations?.visitorLog || []).find((v) => v.id === wizard.submittedVisitorId);
        if (log && (log.approval_status === 'APPROVED' || log.approval_status === 'DENIED')) {
            stopApprovalPoll();
            document.dispatchEvent(new CustomEvent('gate-data-updated'));
        }
    }, 8000);
}

function stopApprovalPoll() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

export function renderPendingApprovalsPanel() {
    const el = document.getElementById('sec-pending-approvals');
    if (!el) return;

    const pendingLogs = (portalState.operations?.visitorLog || [])
        .filter((v) => v.approval_status === 'PENDING' || v.approval_status === 'PARTIAL');

    if (!pendingLogs.length) {
        el.innerHTML = '';
        el.hidden = true;
        return;
    }

    el.hidden = false;
    el.innerHTML = `
      <div class="gate-pending-panel metric-card" style="padding:1rem 1.1rem;margin-bottom:1rem;">
        <h4>Awaiting resident approval</h4>
        ${pendingLogs.map((v) => {
        const units = getVisitorLogUnits(v.id);
        const flats = units.map((u) => `${unitLabel(u.unit_id)} (${u.approval_status})`).join(', ');
        return `<div class="gate-pending-row">
            <div>
              <strong>${esc(v.visitor_name)}</strong>
              <span class="visitor-row__purpose ${v.purpose?.toLowerCase()}">${esc(v.purpose)}</span>
              <div class="visitor-parcel-row__meta">${esc(flats)}</div>
            </div>
            <span class="portal-status portal-status--pending">${approvalStatusLabel(v.approval_status)}</span>
          </div>`;
    }).join('')}
      </div>`;
}

export function initGateWizard() {
    document.addEventListener('gate-data-updated', () => {
        renderPendingApprovalsPanel();
        if (wizard.submittedVisitorId && wizard.step === 4) renderGateWizard();
    });
}

export function resetGateWizardIfNeeded() {
    if (!document.getElementById('sec-wizard-mount')) return;
    if (!wizard.submittedVisitorId) renderGateWizard();
}
