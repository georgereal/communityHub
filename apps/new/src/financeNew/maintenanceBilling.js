/** Finance-New clone of classic module (maintenanceBilling.js) — Mongo-backed, isolated DOM (fn-*). */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
import { bindFinanceNewWindow } from './windowBridge.js';
/**
 * Maintenance billing: flat invoices + payment allocation against collections
 */
import { portalState } from '../store.js';
import { pullState } from './pull.js';
import { mongoInsert, mongoUpdate, mongoDelete } from './mongoWrite.js';
import {
    buildBillingPreview,
    calcTypeLabel,
    getChargeHeads,
    getInvoiceLines,
    getSelectedBulkHeadIds,
    initChargeHeadsUi,
    openChargeHeadsModal,
    refreshBulkInvoiceHeads,
    seedDefaultChargeHeads,
    applyLineOverrides,
    setBulkHeadCheckboxes,
} from './billingHeads.js';
import {
    downloadBulkInvoiceTemplate,
    parseBulkInvoiceExcel,
    resolveImportHeads,
    buildLineOverridesFromImport,
    formatDateForInput,
} from '../bulkInvoiceImport.js';
import {
    buildPenaltyPreview,
    computePenaltyAmount,
    getSelectedBulkPenaltyRuleIds,
    getPenaltyRules,
    initPenaltyRulesUi,
    openPenaltyRulesModal,
    refreshBulkPenaltyRules,
    ruleTypeLabel,
    seedDefaultPenaltyRules,
    setBulkPenaltyCheckboxes,
} from '../penaltyRules.js';
import {
    buildUnitToGroupMap,
    formatGroupUnitLabels,
    getGroupIdsForUnit,
    getInvoiceGroupLabel,
    getUnitIdsForGroup,
    initBillingGroupsUi,
    isCombineGroupsEnabled,
    openBillingGroupsModal,
} from './billingGroups.js';
import {
    downloadInvoicePdf,
    emailInvoicePdf,
    initInvoicePdfUi,
    openSendInvoicesModal,
} from '../invoicePdf.js';
import { initBillingBatchesUi, renderBillingRunsList } from './billingBatches.js';
import { initDuesAgingUi, renderAgingPage, sendReminderForInvoice } from './duesAging.js';
import ExcelJS from 'exceljs';
import {
    initBlockFilterListener,
    invoiceMatchesBlock,
    renderBlockFilterSelect,
    renderBlockKpiStrip,
    unitMatchesBlock,
} from '../blockFilter.js';
import { clearResidentsCache } from '../residents.js';
import { logActivity, renderInvoiceActivityHistory } from '../activityAudit.js';
import { deriveBlockFromFlat } from '../parkingImport.js';
import { withButtonBusy } from '../buttonBusy.js';
import { INVOICE_PAGE_HELP, applyFinancePageHeader, wireFinancePageHelp } from '../financePageHelp.js';
import { can } from '../capabilities.js';

const canDeleteAccounts = () => can('accounts.delete');

let pendingLineOverrides = {};
let pendingPenaltyOverrides = {};

const UNIT_DATALIST_IDS = ['maintenance-unit-datalist'];

export const invoiceBalance = (inv) =>
    Math.max(0, parseFloat(inv.amount || 0) - parseFloat(inv.amount_paid || 0));

export const invoiceStatus = (inv) => {
    const bal = invoiceBalance(inv);
    const paid = parseFloat(inv.amount_paid || 0);
    if (bal <= 0.001) return 'PAID';
    if (paid > 0.001) return 'PARTIAL';
    return 'OPEN';
};

export const getUnitByNumber = (unitNumber) => {
    const needle = String(unitNumber || '').trim().toUpperCase();
    return portalState.units.find((u) => String(u.number || '').trim().toUpperCase() === needle);
};

export const getUnitLabel = (unitId) =>
    portalState.units.find((u) => u.id === unitId)?.number || '—';

export const getInvoiceDisplayLabel = (inv) => {
    if (inv?.billing_group_id) {
        return getInvoiceGroupLabel(inv, getUnitLabel) || 'Combined invoice';
    }
    return getUnitLabel(inv?.unit_id);
};

export const getOpenInvoicesForUnit = (unitId) => {
    const groupIds = new Set(getGroupIdsForUnit(unitId));
    return (fnFinances().maintenanceInvoices || [])
        .filter((inv) => {
            if (invoiceBalance(inv) <= 0.001) return false;
            if (inv.unit_id === unitId) return true;
            if (inv.billing_group_id && groupIds.has(inv.billing_group_id)) {
                return getUnitIdsForGroup(inv.billing_group_id).includes(unitId);
            }
            return false;
        })
        .sort((a, b) => {
            const da = a.due_date || '9999-12-31';
            const db = b.due_date || '9999-12-31';
            if (da !== db) return da.localeCompare(db);
            return (a.period_label || '').localeCompare(b.period_label || '');
        });
};

export const getAllocationsForTxn = (txnId) =>
    (fnFinances().maintenanceAllocations || []).filter((a) => a.transaction_id === txnId);

export const getAllocationsForInvoice = (invoiceId) =>
    (fnFinances().maintenanceAllocations || []).filter((a) => a.invoice_id === invoiceId);

export const formatAllocationSummary = (txnId) => {
    const allocs = getAllocationsForTxn(txnId);
    if (!allocs.length) return '';
    const parts = allocs.map((a) => {
        const inv = fnFinances().maintenanceInvoices.find((i) => i.id === a.invoice_id);
        const flat = getInvoiceDisplayLabel(inv);
        const period = inv?.period_label || 'Invoice';
        return `${flat} · ${period} (₹${parseFloat(a.amount).toLocaleString('en-IN')})`;
    });
    return parts.join('; ');
};

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const roundMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const statusBadge = (inv) => {
    const status = invoiceStatus(inv);
    const statusClass = { OPEN: 'dues-open', PARTIAL: 'dues-partial', PAID: 'dues-paid' }[status];
    return `<span class="maintenance-dues-badge ${statusClass}">${status}</span>`;
};

export const populateUnitDatalist = () => {
    const html = portalState.units.map((u) => `<option value="${u.number}"></option>`).join('');
    UNIT_DATALIST_IDS.forEach((id) => {
        const list = document.getElementById(id);
        if (list) list.innerHTML = html;
    });
};

const invoiceAppliesToUnit = (inv, unitId) => {
    if (!inv || !unitId) return false;
    if (inv.unit_id === unitId) return true;
    if (inv.billing_group_id && getUnitIdsForGroup(inv.billing_group_id).includes(unitId)) return true;
    return false;
};

export const getTxnUnallocatedAmount = (txnId) => {
    const txn = fnFinances().txns.find((t) => t.id === txnId);
    if (!txn) return 0;
    const allocated = getAllocationsForTxn(txnId).reduce((s, a) => s + parseFloat(a.amount || 0), 0);
    return Math.max(0, roundMoney(parseFloat(txn.amount || 0) - allocated));
};

const parseFlatFromMaintenanceTxn = (txn) => {
    const desc = String(txn?.description || '').trim();
    if (!desc) return null;
    const maintMatch = desc.match(/Maintenance collection\s*[—–-]\s*(.+?)(?:\s*·|$)/i);
    if (maintMatch) return maintMatch[1].trim();
    const flatMatch = desc.match(/·\s*Flat\s+(.+)$/i);
    if (flatMatch) return flatMatch[1].trim();
    const needle = desc.toUpperCase();
    const hit = portalState.units.find((u) => {
        const num = String(u.number || '').trim();
        return num && needle.includes(num.toUpperCase());
    });
    return hit?.number || null;
};

const maintenanceTxnBelongsToUnit = (txn, unitId) => {
    const allocs = getAllocationsForTxn(txn.id);
    if (allocs.length) {
        return allocs.some((a) => {
            const inv = fnFinances().maintenanceInvoices.find((i) => i.id === a.invoice_id);
            return inv && invoiceAppliesToUnit(inv, unitId);
        });
    }
    const flatNum = parseFlatFromMaintenanceTxn(txn);
    const unit = flatNum ? getUnitByNumber(flatNum) : null;
    return unit?.id === unitId;
};

/** Unallocated maintenance collection balance per flat (oldest payment first). */
export const getMaintenanceCreditTxnsForUnit = (unitId) =>
    (fnFinances().txns || [])
        .filter((t) => t.type === 'IN' && t.cat === 'Maintenance Collection')
        .filter((t) => maintenanceTxnBelongsToUnit(t, unitId))
        .map((t) => ({ txnId: t.id, available: getTxnUnallocatedAmount(t.id), date: t.date }))
        .filter((t) => t.available > 0.001)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

export const getFlatCreditBalance = (unitId) =>
    getMaintenanceCreditTxnsForUnit(unitId).reduce((s, t) => s + t.available, 0);

/** Apply unallocated flat credit to open invoices (oldest due first). */
export async function applyFlatCreditToOpenInvoices(apartment_id, unitIds = []) {
    if (!apartment_id || !unitIds?.length) {
        return { allocationCount: 0, unitsProcessed: 0 };
    }

    const uniqueUnits = [...new Set(unitIds.filter(Boolean))];
    const toInsert = [];
    const toUpdate = [];

    for (const unitId of uniqueUnits) {
        const creditTxns = getMaintenanceCreditTxnsForUnit(unitId);
        if (!creditTxns.length) continue;

        const openInvoices = getOpenInvoicesForUnit(unitId);

        for (const { txnId, available } of creditTxns) {
            let remaining = available;
            if (remaining <= 0.001) continue;

            const existingByInvoice = new Map(
                getAllocationsForTxn(txnId).map((a) => [a.invoice_id, a]),
            );

            for (const inv of openInvoices) {
                if (remaining <= 0.001) break;
                const bal = invoiceBalance(inv);
                if (bal <= 0.001) continue;

                const apply = Math.min(remaining, bal);
                if (apply <= 0.001) continue;

                const existing = existingByInvoice.get(inv.id);
                if (existing) {
                    toUpdate.push({
                        id: existing.id,
                        amount: roundMoney(parseFloat(existing.amount || 0) + apply),
                    });
                } else {
                    toInsert.push({
                        id: crypto.randomUUID(),
                        apartment_id,
                        transaction_id: txnId,
                        invoice_id: inv.id,
                        amount: roundMoney(apply),
                    });
                }

                inv.amount_paid = roundMoney(parseFloat(inv.amount_paid || 0) + apply);
                remaining = roundMoney(remaining - apply);
            }
        }
    }

    if (!toInsert.length && !toUpdate.length) {
        return { allocationCount: 0, unitsProcessed: uniqueUnits.length };
    }

    for (const row of toUpdate) {
        // Embedded payment updates are not remodeled yet — fail loudly on Finance-New.
        await mongoUpdate('maintenance_payment_allocations', { id: row.id }, { amount: row.amount }, { rehydrate: false });
    }

    if (toInsert.length) {
        await mongoInsert('maintenance_payment_allocations', toInsert, { rehydrate: false });
    }

    const allocationCount = toInsert.length + toUpdate.length;
    await logActivity({
        entityType: 'ALLOCATION',
        entityId: toInsert[0]?.transaction_id || toUpdate[0]?.id,
        action: 'CREATE',
        summary: `Auto-applied flat credit to ${allocationCount} invoice(s)`,
        newData: { inserted: toInsert, updated: toUpdate },
    });

    return { allocationCount, unitsProcessed: uniqueUnits.length };
}

const toggleMaintenancePaymentModalLayout = (active) => {
    document.querySelector('#fn-cash-modal .modal-content')
        ?.classList.toggle('expense-modal--maintenance-payment', !!active);
    document.getElementById('income-form-view')
        ?.classList.toggle('expense-form--maintenance-payment', !!active);
};

const maybeAutoApplyMaintenanceAllocations = (paymentAmount, hasExistingAllocs) => {
    const pay = parseFloat(paymentAmount) || 0;
    if (pay > 0 && !hasExistingAllocs) autoApplyOldestFirst();
    else updateAllocationSummary(pay);
};

const fillInvoiceAllocation = (invoiceId) => {
    const check = document.querySelector(`.maintenance-alloc-check[data-invoice-id="${invoiceId}"]`);
    const amtInput = document.querySelector(`.maintenance-alloc-amt[data-invoice-id="${invoiceId}"]`);
    if (!check || !amtInput) return;
    const pay = parseFloat(document.getElementById('income-amt')?.value) || 0;
    const current = parseFloat(amtInput.value) || 0;
    const { total } = collectAllocationDraft();
    const remaining = pay - total + (check.checked ? current : 0);
    const max = parseFloat(amtInput.max) || 0;
    const apply = Math.min(max, Math.max(0, remaining));
    check.checked = apply > 0;
    amtInput.value = apply > 0 ? apply.toFixed(2) : '';
    updateAllocationSummary(pay);
};

const renderAllocationRows = (unitId, paymentAmount, existingAllocs = []) => {
    const container = document.getElementById('maintenance-allocation-rows');
    const summary = document.getElementById('maintenance-allocation-summary');
    if (!container) return;

    if (!unitId) {
        container.innerHTML = '<p class="maintenance-alloc-hint">Select a flat to see outstanding invoices.</p>';
        if (summary) summary.textContent = '';
        updateAllocationSummary(parseFloat(paymentAmount) || 0);
        return;
    }

    const open = getOpenInvoicesForUnit(unitId);
    if (!open.length) {
        container.innerHTML = '<p class="maintenance-alloc-hint">No open invoices for this flat. The full payment will be saved as <strong>flat credit</strong> for future invoices.</p>';
        if (summary) summary.textContent = '';
        updateAllocationSummary(parseFloat(paymentAmount) || 0);
        return;
    }

    const existingByInvoice = new Map(existingAllocs.map((a) => [a.invoice_id, parseFloat(a.amount)]));
    container.innerHTML = `
      <div class="maintenance-alloc-head">
        <span aria-hidden="true"></span>
        <span>Invoice</span>
        <span>Balance</span>
        <span>Apply</span>
      </div>
      ${open.map((inv) => {
        const bal = invoiceBalance(inv);
        const prefill = existingByInvoice.get(inv.id);
        const prefillVal = prefill != null && prefill > 0 ? prefill : '';
        const checked = prefillVal !== '' ? 'checked' : '';
        const due = inv.due_date
            ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
            : '—';
        return `<label class="maintenance-alloc-row">
          <input type="checkbox" class="maintenance-alloc-check" data-invoice-id="${inv.id}" ${checked} />
          <span class="maintenance-alloc-row__meta">
            <strong>${inv.period_label}${inv.billing_group_id ? ` · ${getInvoiceDisplayLabel(inv)}` : ''}</strong>
            <span>Due ${due}</span>
          </span>
          <span class="maintenance-alloc-row__balance">${formatMoney(bal)}</span>
          <span class="maintenance-alloc-row__apply">
            <input type="number" class="maintenance-alloc-amt expense-combobox" data-invoice-id="${inv.id}"
              min="0" max="${bal}" step="0.01" placeholder="0" value="${prefillVal}" inputmode="decimal" />
            <button type="button" class="maintenance-alloc-fill-btn" data-invoice-id="${inv.id}" title="Apply up to balance">Full</button>
          </span>
        </label>`;
    }).join('')}`;

    container.querySelectorAll('.maintenance-alloc-check, .maintenance-alloc-amt').forEach((el) => {
        el.addEventListener('change', () => updateAllocationSummary(paymentAmount));
        el.addEventListener('input', () => {
            if (el.classList.contains('maintenance-alloc-amt')) {
                const row = el.closest('.maintenance-alloc-row');
                const check = row?.querySelector('.maintenance-alloc-check');
                const val = parseFloat(el.value);
                if (check && val > 0) check.checked = true;
                if (check && (!val || val <= 0)) check.checked = false;
            }
            updateAllocationSummary(paymentAmount);
        });
    });
    container.querySelectorAll('.maintenance-alloc-fill-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            fillInvoiceAllocation(btn.dataset.invoiceId);
        });
    });
    updateAllocationSummary(parseFloat(paymentAmount) || 0);
};

export const updateAllocationSummary = (paymentAmount) => {
    const summary = document.getElementById('maintenance-allocation-summary');
    const creditEl = document.getElementById('maintenance-alloc-credit');
    if (!summary) return;
    const { total, rows } = collectAllocationDraft();
    const pay = parseFloat(paymentAmount) || 0;
    const unallocated = Math.max(0, pay - total);

    if (pay > 0) {
        const parts = [`Applied to invoices: <strong>${formatMoney(total)}</strong> of ${formatMoney(pay)}`];
        if (rows.length === 0 && pay > 0) {
            parts.push(`<span class="maintenance-alloc-credit-tag">All ${formatMoney(pay)} → flat credit</span>`);
        } else if (unallocated > 0.001) {
            parts.push(`<span class="maintenance-alloc-credit-tag">${formatMoney(unallocated)} → flat credit</span>`);
        }
        summary.innerHTML = parts.join(' · ');
    } else {
        summary.innerHTML = rows.length
            ? `Selected ${formatMoney(total)} across ${rows.length} invoice(s) — enter payment amount above`
            : 'Select invoices and enter how much to apply to each (partial amounts OK).';
    }

    if (creditEl) {
        const showCredit = pay > 0.001 && (unallocated > 0.001 || rows.length === 0);
        creditEl.hidden = !showCredit;
        creditEl.innerHTML = showCredit
            ? `<i class="fa-solid fa-piggy-bank"></i> ${formatMoney(unallocated > 0.001 ? unallocated : pay)} will remain as <strong>flat credit</strong> and auto-apply to open invoices when the next invoice is raised (oldest first).`
            : '';
    }
};

export const collectAllocationDraft = () => {
    const rows = [];
    let total = 0;
    document.querySelectorAll('.maintenance-alloc-row').forEach((row) => {
        const check = row.querySelector('.maintenance-alloc-check');
        const amtEl = row.querySelector('.maintenance-alloc-amt');
        if (!check?.checked) return;
        const invoice_id = check.dataset.invoiceId;
        const amount = parseFloat(amtEl?.value);
        if (!invoice_id || isNaN(amount) || amount <= 0) return;
        rows.push({ invoice_id, amount });
        total += amount;
    });
    return { rows, total };
};

export const autoApplyOldestFirst = () => {
    const amtEl = document.getElementById('income-amt');
    let remaining = parseFloat(amtEl?.value) || 0;
    document.querySelectorAll('.maintenance-alloc-row').forEach((row) => {
        const check = row.querySelector('.maintenance-alloc-check');
        const amtInput = row.querySelector('.maintenance-alloc-amt');
        const max = parseFloat(amtInput?.max) || 0;
        if (remaining <= 0) {
            check.checked = false;
            amtInput.value = '';
            return;
        }
        const apply = Math.min(remaining, max);
        check.checked = apply > 0;
        amtInput.value = apply > 0 ? apply.toFixed(2) : '';
        remaining -= apply;
    });
    updateAllocationSummary(parseFloat(amtEl?.value) || 0);
};

export const syncMaintenanceIncomeSection = (catKey, txnId = null, prefilledAllocs = null) => {
    const section = document.getElementById('income-maintenance-section');
    const flatWrap = document.getElementById('payment-record-flat-wrap');
    if (!section) return;
    const isMaintenance = catKey === 'Maintenance Collection';
    section.hidden = !isMaintenance;
    if (flatWrap) flatWrap.hidden = !isMaintenance;
    toggleMaintenancePaymentModalLayout(isMaintenance);
    if (!isMaintenance) return;

    populateUnitDatalist();
    const unitInput = document.getElementById('maintenance-unit-input');
    const existing = txnId
        ? getAllocationsForTxn(txnId)
        : (prefilledAllocs || []);
    let unitId = null;
    if (existing.length) {
        const inv = fnFinances().maintenanceInvoices.find((i) => i.id === existing[0].invoice_id);
        unitId = inv?.unit_id;
        if (unitInput && inv) {
            const flat = getUnitLabel(inv.unit_id);
            if (flat && flat !== '—') unitInput.value = flat;
        }
    } else if (unitInput?.value) {
        unitId = getUnitByNumber(unitInput.value)?.id;
    }

    const payAmt = parseFloat(document.getElementById('income-amt')?.value) || 0;
    renderAllocationRows(unitId, payAmt, existing);
    maybeAutoApplyMaintenanceAllocations(payAmt, existing.length > 0);
};

export const wireMaintenanceIncomeForm = () => {
    const unitInput = document.getElementById('maintenance-unit-input');
    const amtInput = document.getElementById('income-amt');

    const refreshUnitAllocations = () => {
        const unit = getUnitByNumber(unitInput?.value);
        const pay = parseFloat(amtInput?.value) || 0;
        renderAllocationRows(unit?.id, pay);
        maybeAutoApplyMaintenanceAllocations(pay, false);
    };

    unitInput?.addEventListener('change', refreshUnitAllocations);
    unitInput?.addEventListener('blur', refreshUnitAllocations);
    amtInput?.addEventListener('input', () => {
        const section = document.getElementById('income-maintenance-section');
        if (section?.hidden) return;
        maybeAutoApplyMaintenanceAllocations(parseFloat(amtInput.value) || 0, false);
    });
};

export const validateMaintenanceAllocations = (paymentAmount, catKey) => {
    if (catKey !== 'Maintenance Collection') return true;
    const unitInput = document.getElementById('maintenance-unit-input');
    const unit = getUnitByNumber(unitInput?.value);
    const { rows, total } = collectAllocationDraft();
    const pay = parseFloat(paymentAmount) || 0;

    if (rows.length && !unit) return 'Select a valid flat number for this maintenance payment.';
    if (total > pay + 0.001) return 'Allocated amount cannot exceed the payment amount.';

    for (const row of rows) {
        const inv = fnFinances().maintenanceInvoices.find((i) => i.id === row.invoice_id);
        if (!inv) return 'One of the selected invoices is no longer available.';
        if (row.amount > invoiceBalance(inv) + 0.001) {
            return `Allocation for ${inv.period_label} exceeds the outstanding balance.`;
        }
        if (unit && !invoiceAppliesToUnit(inv, unit.id)) {
            return 'All selected invoices must belong to the chosen flat.';
        }
    }
    return true;
};

export async function saveMaintenanceAllocations(apartment_id, txnId, catKey) {
    if (catKey !== 'Maintenance Collection') return { ok: true };

    const { rows } = collectAllocationDraft();

    if (!rows.length) return { ok: true };

    const payload = rows.map((r) => ({
        id: crypto.randomUUID(),
        apartment_id,
        transaction_id: txnId,
        invoice_id: r.invoice_id,
        amount: r.amount,
    }));

    try {
        await mongoInsert('maintenance_payment_allocations', payload, { rehydrate: false });
    } catch (err) {
        return { ok: false, error: err.message };
    }

    await logActivity({
        entityType: 'ALLOCATION',
        entityId: txnId,
        action: 'CREATE',
        summary: `Applied ${rows.length} payment allocation(s) to maintenance invoices`,
        newData: { transaction_id: txnId, rows },
    });

    return { ok: true };
}

export async function recordMaintenanceCollectionPayment({
    unitNumber,
    amount,
    date,
    description,
    wallet = 'BANK',
    bankReference = null,
    bankPaymentType = 'UPI',
    allocations = [],
}) {
    
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const unit = getUnitByNumber(unitNumber);
    if (!unit) throw new Error(`Unknown flat: ${unitNumber}`);

    const pay = parseFloat(amount);
    if (!Number.isFinite(pay) || pay <= 0) throw new Error('Invalid payment amount.');

    if (bankReference) {
        const dup = (fnFinances().txns || []).some(
            (t) => (t.bank_reference || '').trim().toLowerCase() === bankReference.trim().toLowerCase(),
        );
        if (dup) throw new Error(`Reference ${bankReference} already recorded.`);
    }

    let allocRows = allocations;
    if (!allocRows?.length) {
        let remaining = pay;
        allocRows = [];
        getOpenInvoicesForUnit(unit.id).forEach((inv) => {
            if (remaining <= 0.001) return;
            const bal = invoiceBalance(inv);
            const apply = Math.min(remaining, bal);
            if (apply <= 0) return;
            allocRows.push({ invoice_id: inv.id, amount: apply });
            remaining -= apply;
        });
    }

    const allocTotal = allocRows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    if (allocTotal > pay + 0.001) throw new Error('Allocations exceed payment amount.');

    const txnId = crypto.randomUUID();
    for (const row of allocRows) {
        const inv = fnFinances().maintenanceInvoices.find((i) => i.id === row.invoice_id);
        if (!inv) throw new Error('Invoice not found for allocation.');
        if (unit && !invoiceAppliesToUnit(inv, unit.id)) {
            throw new Error('Invoice does not belong to this flat.');
        }
        if (row.amount > invoiceBalance(inv) + 0.001) {
            throw new Error(`Allocation exceeds balance for ${inv.period_label}.`);
        }
    }

    const dateIso = new Date(`${date}T12:00:00`).toISOString();
    const desc = description || `Maintenance collection — ${unitNumber}`;

    const core = {
        id: txnId,
        apartment_id,
        amount: pay,
        cat: 'Maintenance Collection',
        description: desc,
        wallet,
        type: 'IN',
        date: dateIso,
    };

    let payload = {
        ...core,
        bank_payment_type: bankPaymentType,
        bank_reference: bankReference,
    };

    await mongoInsert('transactions', payload, { rehydrate: false });

    if (allocRows.length) {
        await mongoInsert(
            'maintenance_payment_allocations',
            allocRows.map((r) => ({
                id: crypto.randomUUID(),
                apartment_id,
                transaction_id: txnId,
                invoice_id: r.invoice_id,
                amount: r.amount,
            })),
            { rehydrate: false },
        );
    }

    await logActivity({
        entityType: 'TRANSACTION',
        entityId: txnId,
        action: 'CREATE',
        summary: `Bulk collection ${formatMoney(pay)} for ${unitNumber}`,
        newData: { txnId, unitNumber, allocations: allocRows },
    });

    return { txnId };
}

export async function createBulkMaintenanceInvoices({
    periodLabel,
    dueDate,
    notes,
    unitIds,
    headIds,
    manualAmounts = {},
    lineOverrides = {},
    penaltyRuleIds = [],
    penaltyOverrides = {},
    combineGroups = false,
}) {
    
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const period_label = String(periodLabel || '').trim();
    if (!period_label) throw new Error('Enter a period label (e.g. Apr 2026).');
    if (!unitIds?.length) throw new Error('Select at least one flat.');
    if (!headIds?.length) throw new Error('Select at least one charge head.');

    let preview = buildBillingPreview({ unitIds, headIds, manualAmounts });
    preview = applyLineOverrides(preview, lineOverrides);

    const currentSubtotals = Object.fromEntries(preview.rows.map((r) => [r.unit.id, r.total]));
    const penaltyPreview = penaltyRuleIds.length
        ? buildPenaltyPreview({
            unitIds,
            ruleIds: penaltyRuleIds,
            overrides: penaltyOverrides,
            periodLabel: period_label,
            currentSubtotalsByUnit: currentSubtotals,
        })
        : null;
    const penaltyByUnit = new Map((penaltyPreview?.rows || []).map((r) => [r.unit.id, r]));
    const invalidManual = preview.rows.some((r) =>
        r.lines.some((l) => l.head.calc_type === 'MANUAL' && l.warning));
    if (invalidManual) throw new Error('Enter amounts for all manual heads in the preview table.');

    const zeroRows = preview.rows.filter((r) => r.total <= 0);
    if (zeroRows.length === preview.rows.length && !(penaltyPreview?.grandPenalty > 0)) {
        throw new Error('All preview totals are zero. Check charge head rates and flat data.');
    }

    const allInvoices = fnFinances().maintenanceInvoices || [];
    const existingUnitPeriods = new Set(
        allInvoices
            .filter((inv) => !inv.billing_group_id && inv.period_label === period_label && unitIds.includes(inv.unit_id))
            .map((inv) => inv.unit_id),
    );
    const existingGroupPeriods = new Set(
        allInvoices
            .filter((inv) => inv.billing_group_id && inv.period_label === period_label)
            .map((inv) => inv.billing_group_id),
    );

    const unitToGroup = combineGroups ? buildUnitToGroupMap() : new Map();
    const groupBuckets = new Map();
    const individualCandidates = [];

    preview.rows.forEach((row) => {
        const pen = penaltyByUnit.get(row.unit.id);
        const total = row.total + (pen?.penaltyTotal || 0);
        if (total <= 0) return;

        const group = unitToGroup.get(row.unit.id);
        if (combineGroups && group) {
            if (!groupBuckets.has(group.id)) groupBuckets.set(group.id, { group, rows: [] });
            groupBuckets.get(group.id).rows.push(row);
        } else if (!existingUnitPeriods.has(row.unit.id)) {
            individualCandidates.push(row);
        }
    });

    const groupsToCreate = [];
    groupBuckets.forEach(({ group, rows }) => {
        if (existingGroupPeriods.has(group.id)) return;
        if (rows.some((r) => existingUnitPeriods.has(r.unit.id))) return;
        groupsToCreate.push({ group, rows });
    });

    const groupedUnitIds = new Set();
    groupsToCreate.forEach((g) => g.rows.forEach((r) => groupedUnitIds.add(r.unit.id)));
    const toCreateIndividual = individualCandidates.filter((r) => !groupedUnitIds.has(r.unit.id));

    if (!toCreateIndividual.length && !groupsToCreate.length) {
        throw new Error(`All selected flats already have an invoice for "${period_label}".`);
    }

    const skipped = preview.rows.length - toCreateIndividual.length
        - groupsToCreate.reduce((s, g) => s + g.rows.length, 0);
    const batch_id = crypto.randomUUID();
    const invoiceCount = toCreateIndividual.length + groupsToCreate.length;

    const createdUnitIds = new Set();
    toCreateIndividual.forEach((r) => createdUnitIds.add(r.unit.id));
    groupsToCreate.forEach((g) => g.rows.forEach((r) => createdUnitIds.add(r.unit.id)));

    const skipEntries = [];
    preview.rows.forEach((row) => {
        if (createdUnitIds.has(row.unit.id)) return;
        let reason = `Skipped for period "${period_label}"`;
        if (existingUnitPeriods.has(row.unit.id)) {
            reason = `Invoice already exists for period "${period_label}"`;
        } else {
            const group = unitToGroup.get(row.unit.id);
            if (group && existingGroupPeriods.has(group.id)) {
                reason = `Combined invoice already exists for group "${group.name}"`;
            } else {
                const pen = penaltyByUnit.get(row.unit.id);
                const total = row.total + (pen?.penaltyTotal || 0);
                if (total <= 0) reason = 'Zero amount after calculation';
            }
        }
        skipEntries.push({ unit_id: row.unit.id, reason });
    });

    let totalAmount = 0;
    let batchOk = true;
    try {
        await mongoInsert('maintenance_billing_batches', {
            id: batch_id,
            apartment_id,
            period_label,
            due_date: dueDate || null,
            notes: notes?.trim() || null,
            unit_count: toCreateIndividual.length + groupsToCreate.reduce((s, g) => s + g.rows.length, 0),
            skipped_count: skipEntries.length,
            total_amount: 0,
            created_by: portalState.access?.userId || null,
        }, { rehydrate: false });
    } catch (err) {
        batchOk = false;
        console.warn('Billing batch header not saved:', err.message);
    }

    const insertInvoiceWithLines = async ({
        unit_id,
        billing_group_id,
        lineRows,
        penRows,
        invoiceTotal,
    }) => {
        const invoice_id = crypto.randomUUID();
        let sortOrder = 0;
        const linePayload = [];

        lineRows.forEach((row) => {
            const penRow = penRows.get(row.unit.id);
            row.lines.filter((l) => l.amount > 0).forEach((l) => {
                linePayload.push({
                    id: crypto.randomUUID(),
                    apartment_id,
                    invoice_id,
                    head_id: l.head_id,
                    head_name: l.head_name,
                    calc_type: l.calc_type,
                    quantity: l.quantity,
                    rate: l.rate,
                    amount: l.amount,
                    sort_order: sortOrder++,
                    penalty_rule_id: null,
                    unit_id: row.unit.id,
                });
            });
            (penRow?.penalties || []).filter((p) => p.amount > 0).forEach((p) => {
                linePayload.push({
                    id: crypto.randomUUID(),
                    apartment_id,
                    invoice_id,
                    head_id: null,
                    head_name: p.rule.name,
                    calc_type: `PENALTY_${p.rule.rule_type}`,
                    quantity: p.quantity,
                    rate: p.rate,
                    amount: p.amount,
                    sort_order: sortOrder++,
                    penalty_rule_id: p.rule.id,
                    unit_id: row.unit.id,
                });
            });
        });

        await mongoInsert('maintenance_invoices', {
            id: invoice_id,
            apartment_id,
            unit_id: unit_id || null,
            billing_group_id: billing_group_id || null,
            period_label,
            due_date: dueDate || null,
            amount: invoiceTotal,
            notes: notes?.trim() || null,
            batch_id: batchOk ? batch_id : null,
            lines: linePayload,
        }, { rehydrate: false });
    };

    for (const row of toCreateIndividual) {
        const penRow = penaltyByUnit.get(row.unit.id);
        const invoiceTotal = roundMoney(row.total + (penRow?.penaltyTotal || 0));
        totalAmount += invoiceTotal;
        await insertInvoiceWithLines({
            unit_id: row.unit.id,
            billing_group_id: null,
            lineRows: [row],
            penRows: penaltyByUnit,
            invoiceTotal,
        });
    }

    for (const { group, rows } of groupsToCreate) {
        const invoiceTotal = roundMoney(rows.reduce((s, row) => {
            const pen = penaltyByUnit.get(row.unit.id);
            return s + row.total + (pen?.penaltyTotal || 0);
        }, 0));
        totalAmount += invoiceTotal;
        const primaryUnit = rows[0]?.unit?.id || null;
        await insertInvoiceWithLines({
            unit_id: primaryUnit,
            billing_group_id: group.id,
            lineRows: rows,
            penRows: penaltyByUnit,
            invoiceTotal,
        });
    }

    if (batchOk && batch_id) {
        await mongoUpdate(
            'maintenance_billing_batches',
            { id: batch_id },
            { total_amount: roundMoney(totalAmount) },
            { rehydrate: false },
        );

        if (skipEntries.length) {
            const skipPayload = skipEntries.map((s) => ({
                id: crypto.randomUUID(),
                batch_id,
                apartment_id,
                unit_id: s.unit_id,
                reason: s.reason,
            }));
            try {
                await mongoInsert('maintenance_billing_batch_skips', skipPayload, { rehydrate: false });
            } catch (err) {
                console.warn('Batch skips not saved:', err.message);
            }
        }
    }

    const affectedUnitIds = [];
    toCreateIndividual.forEach((row) => affectedUnitIds.push(row.unit.id));
    groupsToCreate.forEach(({ rows }) => rows.forEach((row) => affectedUnitIds.push(row.unit.id)));

    clearResidentsCache();
    await pullState({ packs: ['billing', 'ledger'] });

    if (affectedUnitIds.length) {
        try {
            await applyFlatCreditToOpenInvoices(apartment_id, affectedUnitIds);
            await pullState({ packs: ['billing', 'ledger'] });
        } catch (err) {
            console.warn('Flat credit auto-apply failed:', err?.message || err);
        }
    }

    renderInvoicesPage();

    if (batch_id) {
        await logActivity({
            entityType: 'INVOICE',
            entityId: batch_id,
            action: 'CREATE',
            summary: `Bulk raise: ${invoiceCount} invoice(s), ${skipped} skipped — ${period_label}`,
            newData: { batch_id, invoice_count: invoiceCount, skipped, period_label, total_amount: totalAmount },
        });
    }

    return { created: invoiceCount, skipped };
}

/** Apply selected penalty rules to all overdue open invoices */
export async function applyPenaltiesToOverdue({ ruleIds, overrides = {}, asOfDate = null }) {
    
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');
    if (!ruleIds?.length) throw new Error('Select at least one penalty rule.');

    const asOf = asOfDate || new Date().toISOString().slice(0, 10);
    const overdueInvoices = (fnFinances().maintenanceInvoices || []).filter((inv) => {
        if (invoiceBalance(inv) <= 0.001) return false;
        return inv.due_date && inv.due_date < asOf;
    });

    if (!overdueInvoices.length) throw new Error('No overdue open invoices found.');

    let applied = 0;
    let linesAdded = 0;

    for (const inv of overdueInvoices) {
        const bal = invoiceBalance(inv);
        const daysOverdue = Math.max(0, Math.floor(
            (new Date(`${asOf}T12:00:00`) - new Date(`${inv.due_date}T12:00:00`)) / 86400000,
        ));
        const existingPenaltyRules = new Set(
            (fnFinances().maintenanceInvoiceLines || [])
                .filter((l) => l.invoice_id === inv.id && l.penalty_rule_id)
                .map((l) => l.penalty_rule_id),
        );

        const rules = getPenaltyRules().filter((r) => ruleIds.includes(r.id));
        const ctx = {
            overdueBalance: bal,
            daysOverdue,
            currentInvoiceSubtotal: bal,
            asOfDate: asOf,
        };

        const newLines = [];
        rules.forEach((rule, idx) => {
            if (existingPenaltyRules.has(rule.id)) return;
            const key = `${inv.unit_id}:${rule.id}`;
            let computed = computePenaltyAmount(rule, ctx);
            const ov = overrides[key];
            if (ov != null && !isNaN(parseFloat(ov))) {
                computed = { ...computed, amount: roundMoney(Math.max(0, parseFloat(ov))) };
            }
            if (computed.amount <= 0) return;
            newLines.push({
                id: crypto.randomUUID(),
                apartment_id,
                invoice_id: inv.id,
                head_id: null,
                head_name: rule.name,
                calc_type: `PENALTY_${rule.rule_type}`,
                quantity: computed.quantity,
                rate: computed.rate,
                amount: computed.amount,
                sort_order: 900 + idx,
                penalty_rule_id: rule.id,
            });
        });

        if (!newLines.length) continue;

        const addTotal = roundMoney(newLines.reduce((s, l) => s + l.amount, 0));
        const newAmount = roundMoney(parseFloat(inv.amount) + addTotal);

        await mongoInsert('maintenance_invoice_lines', newLines, { rehydrate: false });
        await mongoUpdate('maintenance_invoices', { id: inv.id }, { amount: newAmount }, { rehydrate: false });

        applied += 1;
        linesAdded += newLines.length;
    }

    if (!applied) throw new Error('No new penalty lines to apply (rules may already be on invoices or amounts are zero).');

    await pullState({ packs: ['billing', 'ledger'] });
    renderInvoicesPage();
    return { applied, linesAdded };
}

let applyPenaltyOverrides = {};

export const refreshApplyPenaltyPreview = () => {
    const wrap = document.getElementById('apply-penalty-preview-wrap');
    const table = document.getElementById('apply-penalty-preview');
    const summary = document.getElementById('apply-penalty-preview-summary');
    if (!table) return;

    const ruleIds = [...document.querySelectorAll('.apply-penalty-checkbox:checked')].map((el) => el.value);
    const asOf = document.getElementById('apply-penalty-asof')?.value || new Date().toISOString().slice(0, 10);

    const overdueInvoices = (fnFinances().maintenanceInvoices || []).filter((inv) => {
        if (invoiceBalance(inv) <= 0.001) return false;
        return inv.due_date && inv.due_date < asOf;
    });

    if (!ruleIds.length || !overdueInvoices.length) {
        if (wrap) wrap.hidden = true;
        return;
    }

    if (wrap) wrap.hidden = false;
    const unitIds = [...new Set(overdueInvoices.map((i) => i.unit_id))];
    const penaltyPreview = buildPenaltyPreview({
        unitIds,
        ruleIds,
        overrides: applyPenaltyOverrides,
        asOfDate: asOf,
    });
    const penaltyByUnit = new Map(penaltyPreview.rows.map((r) => [r.unit.id, r]));

    const ruleCols = penaltyPreview.rules.map((r) =>
        `<th class="bulk-preview-penalty-col">${r.name}</th>`,
    ).join('');

    let grand = 0;
    table.innerHTML = `<thead><tr><th>Flat</th><th>Period</th><th>Balance</th>${ruleCols}<th>Penalty</th></tr></thead>
      <tbody>${overdueInvoices.map((inv) => {
        const penRow = penaltyByUnit.get(inv.unit_id);
        const bal = invoiceBalance(inv);
        const penTotal = penRow?.penaltyTotal || 0;
        grand += penTotal;
        const cells = (penRow?.penalties || []).map((p) =>
            `<td>₹${p.amount.toLocaleString('en-IN')}</td>`,
        ).join('');
        return `<tr>
          <td><strong>${getUnitLabel(inv.unit_id)}</strong></td>
          <td>${inv.period_label}</td>
          <td>${formatMoney(bal)}</td>
          ${cells}
          <td><strong>${formatMoney(penTotal)}</strong></td>
        </tr>`;
    }).join('')}</tbody>`;

    if (summary) summary.textContent = `${overdueInvoices.length} overdue · Penalties ${formatMoney(grand)}`;
};

export const openApplyPenaltiesModal = async () => {
    applyPenaltyOverrides = {};
    if (!(fnFinances().maintenancePenaltyRules || []).length) {
        await seedDefaultPenaltyRules().catch(() => {});
    }
    const container = document.getElementById('apply-penalty-rules');
    const rules = (fnFinances().maintenancePenaltyRules || []).filter((r) => r.is_active !== false);
    if (container) {
        container.innerHTML = rules.length
            ? rules.map((r) => `<label class="bulk-head-check">
                <input type="checkbox" class="apply-penalty-checkbox" value="${r.id}" checked />
                <span class="bulk-head-check__body"><strong>${r.name}</strong>
                  <span>${ruleTypeLabel(r.rule_type)}</span></span>
              </label>`).join('')
            : '<p class="maintenance-alloc-hint">No rules — set up penalty rules first.</p>';
        container.querySelectorAll('.apply-penalty-checkbox').forEach((el) => {
            el.addEventListener('change', refreshApplyPenaltyPreview);
        });
    }
    const asOfEl = document.getElementById('apply-penalty-asof');
    if (asOfEl && !asOfEl.value) asOfEl.value = new Date().toISOString().slice(0, 10);
    refreshApplyPenaltyPreview();
    document.getElementById('apply-penalties-modal')?.classList.add('active');
};

export const closeApplyPenaltiesModal = () => {
    document.getElementById('apply-penalties-modal')?.classList.remove('active');
};

bindFinanceNewWindow('openApplyPenaltiesModal', openApplyPenaltiesModal);
bindFinanceNewWindow('closeApplyPenaltiesModal', closeApplyPenaltiesModal);

/** @deprecated Use bulk raise; kept for compatibility */
export async function createMaintenanceInvoice({ unitNumber, periodLabel, dueDate, amount, notes }) {
    const unit = getUnitByNumber(unitNumber);
    if (!unit) throw new Error('Flat not found.');
    await createBulkMaintenanceInvoices({
        periodLabel,
        dueDate,
        notes,
        unitIds: [unit.id],
        headIds: getChargeHeads().slice(0, 1).map((h) => h.id),
        manualAmounts: { [`${unit.id}:${getChargeHeads()[0]?.id}`]: parseFloat(amount) },
    });
}

export async function deleteMaintenanceInvoice(id, { confirm: askConfirm = true, silent = false } = {}) {
    if (!canDeleteAccounts()) {
        if (!silent) alert('You do not have permission to delete invoices.');
        return { ok: false, reason: 'forbidden' };
    }
    
    const inv = fnFinances().maintenanceInvoices.find((i) => i.id === id);
    if (!inv) return { ok: false, reason: 'missing' };
    if (parseFloat(inv.amount_paid || 0) > 0.001) {
        if (!silent) alert('Cannot delete an invoice that has payments applied. Remove allocations first.');
        return { ok: false, reason: 'has_payments' };
    }
    if (askConfirm && !confirm(`Delete invoice ${inv.period_label} for ${getUnitLabel(inv.unit_id)}?`)) {
        return { ok: false, reason: 'cancelled' };
    }

    const snapshot = { ...inv };
    try {
        await mongoDelete('maintenance_invoices', { id });
    } catch (error) {
        if (!silent) alert(error.message);
        return { ok: false, reason: 'error', error };
    }

    await logActivity({
        entityType: 'INVOICE',
        entityId: id,
        action: 'DELETE',
        summary: `Deleted invoice ${inv.period_label} for ${getInvoiceDisplayLabel(inv)}`,
        oldData: snapshot,
    });

    if (!silent) {
        await pullState({ packs: ['billing', 'ledger'] });
        renderInvoicesPage();
    }
    return { ok: true };
}

let activeInvoiceSubView = 'pending-dues';
let detailInvoiceId = null;
const selectedPendingUnitIds = new Set();
const selectedInvoiceIds = new Set();

const escAttr = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;');

const selectedPendingRows = () => {
    const byId = new Map(getPendingDuesRows({ ignoreFilter: true }).map((r) => [r.unit.id, r]));
    return [...selectedPendingUnitIds].map((id) => byId.get(id)).filter(Boolean);
};

const syncPendingDuesBulkBar = () => {
    const bar = document.getElementById('fn-pending-dues-bulk-bar');
    const countEl = document.getElementById('fn-pending-dues-bulk-count');
    const remindBtn = document.getElementById('fn-pending-dues-bulk-remind');
    const exportBtn = document.getElementById('fn-pending-dues-bulk-export');
    const clearBtn = document.getElementById('fn-pending-dues-bulk-clear');
    const selectAll = document.getElementById('fn-pending-dues-select-all');
    if (!bar) return;

    const visible = getPendingDuesRows();
    const selected = selectedPendingRows();
    const total = selected.reduce((s, r) => s + r.displayOutstanding, 0);
    const n = selected.length;

    bar.hidden = n === 0;
    if (countEl) {
        countEl.textContent = n
            ? `${n} selected · ${formatMoney(total)}`
            : '0 selected';
    }
    if (remindBtn) remindBtn.disabled = n === 0;
    if (exportBtn) exportBtn.disabled = n === 0;
    if (clearBtn) clearBtn.disabled = n === 0;

    if (selectAll) {
        const visibleIds = visible.map((r) => r.unit.id);
        const allSelected = visibleIds.length > 0
            && visibleIds.every((id) => selectedPendingUnitIds.has(id));
        const someSelected = visibleIds.some((id) => selectedPendingUnitIds.has(id));
        selectAll.checked = allSelected;
        selectAll.indeterminate = someSelected && !allSelected;
    }
};

const openInvoicesForPendingUnit = (unitId) =>
    getOpenInvoicesForUnit(unitId).filter((inv) => invoiceMatchesBlock(inv) && invoiceBalance(inv) > 0.001);

const exportSelectedPendingDues = async () => {
    const rows = selectedPendingRows();
    if (!rows.length) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pending Dues');
    ws.addRow(['Flat', 'Block', 'Outstanding', 'Open invoices', 'Oldest due', 'Open periods']);
    rows.forEach((r) => {
        ws.addRow([
            r.unit.number,
            r.block,
            r.displayOutstanding,
            r.openCount,
            r.oldestDue || '',
            (r.periods || []).join(', '),
        ]);
    });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Pending_Dues_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
};

const sendRemindersForSelectedPending = async () => {
    const rows = selectedPendingRows();
    if (!rows.length) return;
    const invoiceIds = [];
    rows.forEach((r) => {
        openInvoicesForPendingUnit(r.unit.id).forEach((inv) => {
            if (!invoiceIds.includes(inv.id)) invoiceIds.push(inv.id);
        });
    });
    if (!invoiceIds.length) {
        alert('No open invoices for the selected flats.');
        return;
    }
    if (!confirm(`Send reminders for ${invoiceIds.length} open invoice(s) across ${rows.length} flat(s)?`)) return;

    let sent = 0;
    let skipped = 0;
    for (const id of invoiceIds) {
        try {
            const result = await sendReminderForInvoice(id, { force: true });
            if (result?.skipped || result?.cancelled) skipped += 1;
            else sent += 1;
        } catch (err) {
            alert(err?.message || `Failed for invoice ${id}`);
            break;
        }
    }
    alert(`Reminders: ${sent} sent${skipped ? `, ${skipped} skipped` : ''}.`);
    renderPendingDues();
};

const syncInvoiceListBulkBar = () => {
    const bar = document.getElementById('fn-invoice-list-bulk-bar');
    const countEl = document.getElementById('fn-invoice-list-bulk-count');
    const deleteBtn = document.getElementById('fn-invoice-list-bulk-delete');
    const clearBtn = document.getElementById('fn-invoice-list-bulk-clear');
    const selectAll = document.getElementById('fn-invoice-list-select-all');
    if (!bar) return;

    const visible = filteredInvoices();
    const selected = visible.filter((inv) => selectedInvoiceIds.has(inv.id));
    const deletable = selected.filter((inv) => parseFloat(inv.amount_paid || 0) <= 0.001);
    const n = selected.length;

    bar.hidden = n === 0;
    if (countEl) {
        const blocked = n - deletable.length;
        countEl.textContent = blocked
            ? `${n} selected · ${deletable.length} deletable · ${blocked} with payments`
            : (n ? `${n} selected` : '0 selected');
    }
    if (deleteBtn) {
        const allowDelete = canDeleteAccounts();
        deleteBtn.hidden = !allowDelete;
        deleteBtn.disabled = !allowDelete || deletable.length === 0;
        deleteBtn.innerHTML = `<i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete selected${deletable.length ? ` (${deletable.length})` : ''}`;
    }
    if (clearBtn) clearBtn.disabled = n === 0;

    if (selectAll) {
        const visibleIds = visible.map((inv) => inv.id);
        const allSelected = visibleIds.length > 0
            && visibleIds.every((id) => selectedInvoiceIds.has(id));
        const someSelected = visibleIds.some((id) => selectedInvoiceIds.has(id));
        selectAll.checked = allSelected;
        selectAll.indeterminate = someSelected && !allSelected;
    }
};

const deleteSelectedInvoices = async () => {
    if (!canDeleteAccounts()) {
        alert('You do not have permission to delete invoices.');
        return;
    }
        const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) return;

    const selected = filteredInvoices().filter((inv) => selectedInvoiceIds.has(inv.id));
    const deletable = selected.filter((inv) => parseFloat(inv.amount_paid || 0) <= 0.001);
    const blocked = selected.length - deletable.length;
    if (!deletable.length) {
        alert(blocked
            ? 'None of the selected invoices can be deleted — they have payments applied.'
            : 'Select at least one invoice.');
        return;
    }
    const msg = blocked
        ? `Delete ${deletable.length} invoice(s)? ${blocked} with payments will be skipped.`
        : `Delete ${deletable.length} invoice(s)? This cannot be undone.`;
    if (!confirm(msg)) return;

    const ids = deletable.map((inv) => inv.id);
    const snapshots = deletable.map((inv) => ({
        id: inv.id,
        period_label: inv.period_label,
        unit_id: inv.unit_id,
        billing_group_id: inv.billing_group_id,
        amount: inv.amount,
        label: getInvoiceDisplayLabel(inv),
    }));

    const btn = document.getElementById('fn-invoice-list-bulk-delete');
    await withButtonBusy(btn, 'Deleting…', async () => {
        for (const id of ids) {
            await mongoDelete('maintenance_invoices', { id }, { rehydrate: false });
        }
        await pullState({ packs: ['billing', 'ledger'] });

        await logActivity({
            entityType: 'INVOICE',
            entityId: ids[0],
            action: 'DELETE',
            summary: `Bulk deleted ${ids.length} invoice(s)`,
            oldData: { count: ids.length, invoices: snapshots },
        });

        ids.forEach((id) => selectedInvoiceIds.delete(id));
        await pullState({ packs: ['billing', 'ledger'] });
        renderInvoicesPage();
    }).catch((err) => alert(err?.message || 'Bulk delete failed.'));
};

const filteredInvoices = () => {
    const filterQ = (document.getElementById('fn-invoice-list-filter')?.value || '').trim().toUpperCase();
    const statusFilter = document.getElementById('fn-invoice-status-filter')?.value || 'all';
    let invoices = [...(fnFinances().maintenanceInvoices || [])];

    if (filterQ) {
        invoices = invoices.filter((inv) => {
            const flat = getInvoiceDisplayLabel(inv).toUpperCase();
            return flat.includes(filterQ) || (inv.period_label || '').toUpperCase().includes(filterQ);
        });
    }

    if (statusFilter === 'open') {
        invoices = invoices.filter((inv) => invoiceStatus(inv) !== 'PAID');
    } else     if (statusFilter === 'paid') {
        invoices = invoices.filter((inv) => invoiceStatus(inv) === 'PAID');
    }

    invoices = invoices.filter((inv) => invoiceMatchesBlock(inv));

    invoices.sort((a, b) => {
        const fa = getUnitLabel(a.unit_id);
        const fb = getUnitLabel(b.unit_id);
        if (fa !== fb) return fa.localeCompare(fb, undefined, { numeric: true });
        return (a.due_date || '').localeCompare(b.due_date || '');
    });

    return invoices;
};

const getPendingDuesRows = ({ ignoreFilter = false } = {}) => {
    const filterQ = ignoreFilter
        ? ''
        : (document.getElementById('fn-pending-dues-filter')?.value || '').trim().toUpperCase();
    let rows = [];

    portalState.units
        .filter((u) => u.is_community !== true)
        .filter((u) => unitMatchesBlock(u.id))
        .forEach((unit) => {
            const openInvs = getOpenInvoicesForUnit(unit.id).filter((inv) => invoiceMatchesBlock(inv));
            if (!openInvs.length) return;

            let directOutstanding = 0;
            const shared = [];
            openInvs.forEach((inv) => {
                const bal = invoiceBalance(inv);
                if (inv.billing_group_id && inv.unit_id !== unit.id) {
                    shared.push({ inv, bal });
                } else {
                    directOutstanding += bal;
                }
            });

            const displayOutstanding = directOutstanding > 0.001
                ? directOutstanding
                : shared.reduce((s, x) => s + x.bal, 0);
            if (displayOutstanding <= 0.001) return;

            const oldestDue = openInvs.reduce((min, inv) => {
                if (!inv.due_date) return min;
                return !min || inv.due_date < min ? inv.due_date : min;
            }, null);

            rows.push({
                unit,
                block: unit.block || deriveBlockFromFlat(unit.number) || '—',
                displayOutstanding,
                isSharedOnly: directOutstanding <= 0.001 && shared.length > 0,
                shared,
                openCount: openInvs.length,
                oldestDue,
                periods: [...new Set(openInvs.map((i) => i.period_label).filter(Boolean))],
            });
        });

    if (filterQ) {
        rows = rows.filter((r) =>
            String(r.unit.number || '').toUpperCase().includes(filterQ)
            || String(r.block || '').toUpperCase().includes(filterQ));
    }

    rows.sort((a, b) => {
        if (b.displayOutstanding !== a.displayOutstanding) return b.displayOutstanding - a.displayOutstanding;
        return String(a.unit.number).localeCompare(String(b.unit.number), undefined, { numeric: true });
    });

    return rows;
};

export const renderPendingDues = () => {
    const list = document.getElementById('fn-pending-dues-items');
    if (!list) return;

    const rows = getPendingDuesRows();
    list.innerHTML = '';

    if (!rows.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No pending dues — all flats are clear for the selected block.</p>';
        syncPendingDuesBulkBar();
        return;
    }

    rows.forEach((row) => {
        const { unit, block, displayOutstanding, isSharedOnly, shared, openCount, oldestDue, periods } = row;
        const dueLabel = oldestDue
            ? new Date(`${oldestDue}T12:00:00`).toLocaleDateString('en-GB')
            : '—';
        const periodLabel = periods.slice(0, 3).join(', ') + (periods.length > 3 ? ` +${periods.length - 3}` : '');
        const sharedNote = isSharedOnly && shared.length
            ? `<span class="invoice-combined-badge">Combined</span> ${getInvoiceDisplayLabel(shared[0].inv)}`
            : '';
        const checked = selectedPendingUnitIds.has(unit.id) ? 'checked' : '';
        const flatEsc = escAttr(unit.number);

        const el = document.createElement('div');
        el.className = 'apt-row pending-dues-row';
        el.dataset.unitId = unit.id;
        el.innerHTML = `
          <div class="pending-dues-check-col">
            <input type="checkbox" class="pending-dues-row-check" value="${escAttr(unit.id)}"
              aria-label="Select flat ${flatEsc}" ${checked} />
          </div>
          <div class="maintenance-dues-flat inv-col-flat">${unit.number}</div>
          <div class="inv-col-block">${block}</div>
          <div class="inv-col-money inv-col-balance" style="color:var(--danger);">
            ${formatMoney(displayOutstanding)}${isSharedOnly ? ' <span class="pending-dues-shared-hint">shared</span>' : ''}
          </div>
          <div class="inv-col-open">${openCount}</div>
          <div class="inv-col-due">${dueLabel}</div>
          <div class="inv-col-periods">${periodLabel || '—'}${sharedNote ? `<div class="pending-dues-combined">${sharedNote}</div>` : ''}</div>
          <div class="inv-col-actions">
            <button type="button" class="btn btn-primary btn--small" data-pd-action="pay" data-flat="${flatEsc}">Record payment</button>
            <button type="button" class="btn btn-outline btn--small" data-pd-action="invoices" data-flat="${flatEsc}">Invoices</button>
          </div>`;
        list.appendChild(el);
    });

    syncPendingDuesBulkBar();
};

export const renderInvoiceMetrics = () => {
    const invoices = fnFinances().maintenanceInvoices || [];
    const now = new Date();
    let outstanding = 0;
    let openCount = 0;
    const flatsWithDues = new Set();

    invoices.forEach((inv) => {
        if (!invoiceMatchesBlock(inv)) return;
        const bal = invoiceBalance(inv);
        const status = invoiceStatus(inv);
        if (bal > 0.001) {
            outstanding += bal;
            if (inv.billing_group_id) {
                getUnitIdsForGroup(inv.billing_group_id).forEach((uid) => flatsWithDues.add(uid));
            } else if (inv.unit_id) {
                flatsWithDues.add(inv.unit_id);
            }
        }
        if (status !== 'PAID') openCount += 1;
    });

    let collectedMonth = 0;
    (fnFinances().maintenanceAllocations || []).forEach((a) => {
        const txn = fnFinances().txns.find((t) => t.id === a.transaction_id);
        if (!txn) return;
        const d = new Date(txn.date);
        if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
            collectedMonth += parseFloat(a.amount || 0);
        }
    });

    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('invoice-kpi-outstanding', formatMoney(outstanding));
    set('invoice-kpi-collected', formatMoney(collectedMonth));
    set('invoice-kpi-open', String(openCount));
    set('invoice-kpi-flats', String(flatsWithDues.size));
};

export const renderInvoiceList = () => {
    const list = document.getElementById('fn-invoice-list-items');
    if (!list) return;

    const invoices = filteredInvoices();
    const visibleIds = new Set(invoices.map((inv) => inv.id));
    [...selectedInvoiceIds].forEach((id) => {
        if (!visibleIds.has(id)
            && !(fnFinances().maintenanceInvoices || []).some((inv) => inv.id === id)) {
            selectedInvoiceIds.delete(id);
        }
    });

    list.innerHTML = '';

    if (!invoices.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No invoices match your filters. Raise one to start tracking flat dues.</p>';
        syncInvoiceListBulkBar();
        return;
    }

    invoices.forEach((inv) => {
        const bal = invoiceBalance(inv);
        const hasPayments = parseFloat(inv.amount_paid || 0) > 0.001;
        const checked = selectedInvoiceIds.has(inv.id) ? 'checked' : '';
        const flatLabel = getUnitLabel(inv.unit_id);
        const row = document.createElement('div');
        row.className = 'apt-row maintenance-dues-row';
        row.dataset.invoiceId = inv.id;
        row.innerHTML = `
          <div class="invoice-list-check-col">
            <input type="checkbox" class="invoice-list-row-check" value="${escAttr(inv.id)}"
              aria-label="Select invoice ${escAttr(getInvoiceDisplayLabel(inv))} ${escAttr(inv.period_label)}" ${checked} />
          </div>
          <div class="maintenance-dues-flat inv-col-flat">${inv.billing_group_id
            ? `<span class="invoice-combined-badge">Combined</span> ${getInvoiceDisplayLabel(inv)}`
            : getInvoiceDisplayLabel(inv)}</div>
          <div class="inv-col-period">${inv.period_label}</div>
          <div class="inv-col-due">${inv.due_date ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-GB') : '—'}</div>
          <div class="inv-col-money">${formatMoney(inv.amount)}</div>
          <div class="inv-col-money">${formatMoney(inv.amount_paid)}</div>
          <div class="inv-col-money inv-col-balance" style="color:${bal > 0 ? 'var(--danger)' : 'var(--success)'};">${formatMoney(bal)}</div>
          <div class="inv-col-status">${statusBadge(inv)}</div>
          <div class="inv-col-actions">
            ${bal > 0.001 ? `<button type="button" class="btn btn-primary btn--small" title="Record payment"
              data-inv-action="pay" data-flat="${escAttr(flatLabel)}" data-id="${escAttr(inv.id)}" data-bal="${bal}">
              <i class="fa-solid fa-indian-rupee-sign"></i></button>` : ''}
            <button type="button" class="btn btn-outline btn--small" title="Download PDF"
              data-inv-action="pdf" data-id="${escAttr(inv.id)}"><i class="fa-solid fa-file-pdf"></i></button>
            <button type="button" class="btn btn-outline btn--small" title="View details"
              data-inv-action="view" data-id="${escAttr(inv.id)}"><i class="fa-solid fa-eye"></i></button>
            ${canDeleteAccounts() ? `<button type="button" class="btn btn-outline btn--small btn--danger" title="${hasPayments ? 'Has payments applied' : 'Delete'}"
              data-inv-action="delete" data-id="${escAttr(inv.id)}" ${hasPayments ? 'disabled' : ''}>
              <i class="fa-solid fa-trash-can"></i>
            </button>` : ''}
          </div>`;
        list.appendChild(row);
    });

    syncInvoiceListBulkBar();
};

export const renderInvoiceCollections = () => {
    const list = document.getElementById('fn-invoice-collections-items');
    if (!list) return;

    const collections = (fnFinances().txns || [])
        .filter((t) => t.type === 'IN' && t.cat === 'Maintenance Collection')
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    list.innerHTML = '';
    if (!collections.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No maintenance collections recorded yet. Use Record payment to log payments against flat invoices.</p>';
        return;
    }

    collections.forEach((t) => {
        const allocs = getAllocationsForTxn(t.id);
        const flat = allocs.length
            ? getInvoiceDisplayLabel(fnFinances().maintenanceInvoices.find((i) => i.id === allocs[0].invoice_id))
            : '—';
        const applied = formatAllocationSummary(t.id) || (t.description || 'Unallocated advance');
        const row = document.createElement('div');
        row.className = 'apt-row invoice-collections-row';
        row.innerHTML = `
          <div style="font-size:0.75rem; color:var(--text-dim);">${new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>
          <div class="maintenance-dues-flat">${flat}</div>
          <div style="font-size:0.82rem; font-weight:600;">${applied}</div>
          <div><span style="font-size:0.6rem; font-weight:900; background:#f1f5f9; padding:0.2rem 0.5rem; border-radius:4px;">${t.wallet || 'CASH'}</span></div>
          <div style="text-align:right; font-weight:900; color:var(--success);">+ ${formatMoney(t.amount)}</div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline" style="padding:0.2rem 0.4rem;" onclick="window.editTxn('${t.id}')"><i class="fa-solid fa-pen"></i></button>
          </div>`;
        list.appendChild(row);
    });
};

export const renderInvoicesPage = () => {
    renderBlockKpiStrip('billing-block-kpi');
    renderInvoiceMetrics();
    if (activeInvoiceSubView === 'pending-dues') renderPendingDues();
    else if (activeInvoiceSubView === 'list') renderInvoiceList();
    else if (activeInvoiceSubView === 'batches') renderBillingRunsList();
    else if (activeInvoiceSubView === 'aging') void renderAgingPage();
    else renderInvoiceCollections();
};

const INVOICE_SUBVIEW_LABELS = {
    'pending-dues': 'Flats with an outstanding balance — use this to collect payments and follow up.',
    list: 'Every invoice record raised (individual, combined group, corrections) — the billing ledger.',
    collections: 'Maintenance payments recorded and how they were applied. Bulk-import from bank or NoBroker statements.',
    batches: 'Bulk raise-invoice runs and what was created or skipped.',
    aging: 'Overdue balances by age bucket for reminders.',
};

export const switchInvoiceSubView = (sv) => {
    activeInvoiceSubView = sv;
    const views = {
        'pending-dues': 'fn-invoice-subview-pending',
        list: 'fn-invoice-subview-list',
        collections: 'fn-invoice-subview-collections',
        batches: 'fn-invoice-subview-batches',
        aging: 'fn-invoice-subview-aging',
    };
    Object.entries(views).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = key === sv ? 'block' : 'none';
    });

    document.querySelectorAll('#view-finance-new-invoices [data-invoice-subview]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.invoiceSubview === sv);
    });

    const help = INVOICE_PAGE_HELP[sv];
    applyFinancePageHeader({
        titleId: 'fn-invoices-page-title',
        descId: 'fn-invoices-page-desc',
        help: help || {
            title: 'Maintenance Billing',
            blurb: INVOICE_SUBVIEW_LABELS[sv] || '',
            steps: [],
        },
    });
    const helpPop = document.getElementById('fn-invoices-page-help');
    const helpBtn = document.getElementById('fn-invoices-page-help-btn');
    if (helpPop && !helpPop.hidden) {
        helpPop.hidden = true;
        helpBtn?.setAttribute('aria-expanded', 'false');
    }

    renderInvoicesPage();
};

export const viewPendingDuesInvoices = (flatNumber) => {
    switchInvoiceSubView('list');
    const input = document.getElementById('fn-invoice-list-filter');
    const status = document.getElementById('fn-invoice-status-filter');
    if (input) input.value = flatNumber;
    if (status) status.value = 'open';
    renderInvoiceList();
};

export const filterInvoicesByFlat = (flatNumber) => {
    switchInvoiceSubView('list');
    const input = document.getElementById('fn-invoice-list-filter');
    if (input) {
        input.value = flatNumber;
        renderInvoiceList();
    }
};

export const openRaiseInvoiceModal = async (prefillUnit = '') => {
    const form = document.getElementById('raise-invoice-form');
    form?.reset();
    pendingLineOverrides = {};
    pendingPenaltyOverrides = {};

    if (!getChargeHeads().length) {
        await seedDefaultChargeHeads().catch(() => {});
    }
    if (!(fnFinances().maintenancePenaltyRules || []).length) {
        await seedDefaultPenaltyRules().catch(() => {});
    }

    renderBulkUnitPicker(prefillUnit);
    refreshBulkInvoiceHeads();
    refreshBulkPenaltyRules();
    setDefaultBulkPeriod();
    refreshBulkInvoicePreview();
    syncBulkPreviewEmptyState();

    document.getElementById('raise-invoice-modal')?.classList.add('active');
};

const setDefaultBulkPeriod = () => {
    const periodEl = document.getElementById('raise-invoice-period');
    if (periodEl && !periodEl.value) {
        const now = new Date();
        periodEl.value = now.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    }
    const dueEl = document.getElementById('raise-invoice-due');
    if (dueEl && !dueEl.value) {
        const d = new Date();
        d.setDate(10);
        if (d < new Date()) d.setMonth(d.getMonth() + 1);
        dueEl.value = d.toISOString().slice(0, 10);
    }
};

const getBulkUnitScope = () =>
    document.querySelector('input[name="bulk-unit-scope"]:checked')?.value || 'all';

const getSelectedBulkUnitIds = () => {
    if (getBulkUnitScope() === 'all') {
        return portalState.units.map((u) => u.id);
    }
    return [...document.querySelectorAll('.bulk-unit-checkbox:checked')].map((el) => el.value);
};

export const renderBulkUnitPicker = (prefillUnit = '') => {
    const grid = document.getElementById('bulk-unit-grid');
    const search = document.getElementById('bulk-unit-search');
    if (!grid) return;

    const prefill = getUnitByNumber(prefillUnit);
    const q = (search?.value || '').trim().toUpperCase();

    grid.innerHTML = portalState.units
        .filter((u) => !q || String(u.number).toUpperCase().includes(q))
        .map((u) => `<label class="bulk-unit-check">
          <input type="checkbox" class="bulk-unit-checkbox" value="${u.id}"
            ${prefill?.id === u.id || getBulkUnitScope() === 'all' ? 'checked' : ''} />
          <span>${u.number}</span>
          ${u.area_sqft ? `<span class="bulk-unit-check__meta">${u.area_sqft} sqft</span>` : ''}
        </label>`).join('');

    grid.querySelectorAll('.bulk-unit-checkbox').forEach((el) => {
        el.addEventListener('change', refreshBulkInvoicePreview);
    });

    if (prefill) {
        const selected = document.querySelector('input[name="bulk-unit-scope"][value="selected"]');
        if (selected) selected.checked = true;
    }
    syncBulkUnitScopeUi();
};

const syncBulkUnitScopeUi = () => {
    const scope = getBulkUnitScope();
    const gridWrap = document.getElementById('bulk-unit-grid-wrap');
    if (gridWrap) gridWrap.hidden = scope !== 'selected';
    document.querySelectorAll('.bulk-unit-checkbox').forEach((el) => {
        el.disabled = scope === 'all';
        if (scope === 'all') el.checked = true;
    });
};

const flattenLineOverrides = () => {
    const flat = {};
    Object.entries(pendingLineOverrides).forEach(([unitId, heads]) => {
        Object.entries(heads).forEach(([headId, amt]) => {
            if (amt != null && !isNaN(parseFloat(amt))) {
                flat[`${unitId}:${headId}`] = parseFloat(amt);
            }
        });
    });
    return flat;
};

/** Imported overrides + only user-edited manual inputs (not stale zeros from DOM) */
const buildEffectiveManualAmounts = () => {
    const merged = flattenLineOverrides();
    document.querySelectorAll('.bulk-manual-amt[data-dirty="1"]').forEach((el) => {
        const val = el.value;
        if (val !== '' && !isNaN(parseFloat(val))) {
            merged[el.dataset.manualKey] = parseFloat(val);
        }
    });
    return merged;
};

const manualCellValue = (key, line, effectiveManual) => {
    if (effectiveManual[key] != null && !isNaN(parseFloat(effectiveManual[key]))) {
        return effectiveManual[key];
    }
    if (line.amount != null && !isNaN(parseFloat(line.amount))) return line.amount;
    return '';
};

const sumPreviewLinesByHead = (rows, headIndex) =>
    roundMoney(rows.reduce((s, row) => s + (row.lines[headIndex]?.amount || 0), 0));

const sumPreviewPenaltiesByRule = (penRows, ruleIndex) =>
    roundMoney((penRows || []).reduce((s, pr) => s + (pr?.penalties?.[ruleIndex]?.amount || 0), 0));

const buildBulkPreviewEntries = (preview, penaltyByUnit, combineGroups) => {
    if (!combineGroups) {
        return preview.rows.map((row) => ({
            kind: 'unit',
            row,
            penRow: penaltyByUnit.get(row.unit.id),
        }));
    }

    const unitToGroup = buildUnitToGroupMap();
    const groupMap = new Map();
    const entries = [];

    preview.rows.forEach((row) => {
        const group = unitToGroup.get(row.unit.id);
        if (group) {
            if (!groupMap.has(group.id)) groupMap.set(group.id, { group, rows: [], penRows: [] });
            const bucket = groupMap.get(group.id);
            bucket.rows.push(row);
            bucket.penRows.push(penaltyByUnit.get(row.unit.id));
        } else {
            entries.push({ kind: 'unit', row, penRow: penaltyByUnit.get(row.unit.id) });
        }
    });

    groupMap.forEach((bucket) => {
        entries.push({ kind: 'group', ...bucket });
    });

    entries.sort((a, b) => {
        const labelA = a.kind === 'group' ? a.group.name : a.row.unit.number;
        const labelB = b.kind === 'group' ? b.group.name : b.row.unit.number;
        return String(labelA).localeCompare(String(labelB), undefined, { numeric: true });
    });

    return entries;
};

export const refreshBulkInvoicePreview = () => {
    const wrap = document.getElementById('bulk-invoice-preview-wrap');
    const table = document.getElementById('bulk-invoice-preview');
    const summary = document.getElementById('bulk-invoice-preview-summary');
    const btn = document.getElementById('raise-invoice-btn');
    if (!table) return;

    const unitIds = getSelectedBulkUnitIds();
    const headIds = getSelectedBulkHeadIds();

    if (!unitIds.length || !headIds.length) {
        if (wrap) wrap.hidden = true;
        syncBulkPreviewEmptyState();
        if (btn) btn.textContent = 'Raise invoices';
        return;
    }

    const effectiveManual = buildEffectiveManualAmounts();
    let preview = buildBillingPreview({ unitIds, headIds, manualAmounts: effectiveManual });
    preview = applyLineOverrides(preview, pendingLineOverrides);

    if (wrap) wrap.hidden = false;
    syncBulkPreviewEmptyState();

    const penaltyRuleIds = getSelectedBulkPenaltyRuleIds();
    const periodLabel = document.getElementById('raise-invoice-period')?.value || null;
    const currentSubtotals = Object.fromEntries(preview.rows.map((r) => [r.unit.id, r.total]));
    const penaltyPreview = penaltyRuleIds.length
        ? buildPenaltyPreview({
            unitIds,
            ruleIds: penaltyRuleIds,
            overrides: pendingPenaltyOverrides,
            periodLabel,
            currentSubtotalsByUnit: currentSubtotals,
        })
        : null;
    const penaltyByUnit = new Map((penaltyPreview?.rows || []).map((r) => [r.unit.id, r]));

    if (wrap) wrap.hidden = false;
    syncBulkPreviewEmptyState();

    const headCols = preview.heads.map((h) =>
        `<th>${h.name}<span class="bulk-preview-head-type">${calcTypeLabel(h.calc_type)}</span></th>`,
    ).join('');
    const penaltyCols = (penaltyPreview?.rules || []).map((r) =>
        `<th class="bulk-preview-penalty-col">${r.name}<span class="bulk-preview-head-type penalty-col">${ruleTypeLabel(r.rule_type)}</span></th>`,
    ).join('');

    let grandTotal = preview.grandTotal;
    if (penaltyPreview) grandTotal += penaltyPreview.grandPenalty;

    const combineGroups = isCombineGroupsEnabled();
    const entries = buildBulkPreviewEntries(preview, penaltyByUnit, combineGroups);
    let invoiceCount = entries.length;

    const renderUnitCells = (row) => row.lines.map((line) => {
        if (line.head.calc_type === 'MANUAL') {
            const key = `${row.unit.id}:${line.head.id}`;
            const val = manualCellValue(key, line, effectiveManual);
            const dirty = effectiveManual[key] != null ? ' data-dirty="1"' : '';
            return `<td><input type="number" class="bulk-manual-amt expense-combobox" data-manual-key="${key}"${dirty}
              min="0" step="0.01" placeholder="0" value="${val !== '' ? val : ''}" inputmode="decimal" /></td>`;
        }
        if (line.head.calc_type === 'PER_EXTRA_CAR_ALLOCATION' || line.head.calc_type === 'PER_EXTRA_BIKE_ALLOCATION') {
            const detail = line.detail || '0';
            const title = line.detail ? ` title="${line.detail}"` : '';
            return `<td${title}><span>₹${line.amount.toLocaleString('en-IN')}</span>
              <span class="bulk-preview-qty">${line.amount > 0 ? detail : '—'}</span></td>`;
        }
        const warn = line.warning ? ` title="${line.warning}"` : '';
        return `<td${warn}${line.warning ? ' class="bulk-preview-warn"' : ''}>₹${line.amount.toLocaleString('en-IN')}</td>`;
    }).join('');

    const renderPenaltyCells = (row, penRow) => (penRow?.penalties || []).map((p) => {
        const key = `${row.unit.id}:${p.rule.id}`;
        const val = pendingPenaltyOverrides[key] ?? p.amount;
        const title = p.detail ? ` title="${p.detail}"` : '';
        return `<td class="bulk-preview-penalty-col"${title}>
          <input type="number" class="bulk-penalty-amt expense-combobox" data-penalty-key="${key}"
            min="0" step="0.01" value="${val > 0 || pendingPenaltyOverrides[key] != null ? val : ''}" inputmode="decimal" />
        </td>`;
    }).join('');

    table.innerHTML = `<thead><tr>
      <th>${combineGroups ? 'Flat / group' : 'Flat'}</th>${headCols}${penaltyCols}<th>Total</th>
    </tr></thead><tbody>${entries.map((entry) => {
        if (entry.kind === 'group') {
            const { group, rows, penRows } = entry;
            const flats = formatGroupUnitLabels(group.id, null);
            const rowTotal = roundMoney(rows.reduce((s, row, i) => {
                const pen = penRows[i];
                return s + row.total + (pen?.penaltyTotal || 0);
            }, 0));
            const headCells = preview.heads.map((h, hi) => {
                const sum = sumPreviewLinesByHead(rows, hi);
                if (h.calc_type === 'MANUAL') {
                    return `<td class="bulk-preview-group-sum" title="Sum of ${rows.length} flats">₹${sum.toLocaleString('en-IN')}</td>`;
                }
                return `<td class="bulk-preview-group-sum">₹${sum.toLocaleString('en-IN')}</td>`;
            }).join('');
            const penaltyCells = (penaltyPreview?.rules || []).map((r, ri) => {
                const sum = sumPreviewPenaltiesByRule(penRows, ri);
                return `<td class="bulk-preview-penalty-col bulk-preview-group-sum">₹${sum.toLocaleString('en-IN')}</td>`;
            }).join('');
            return `<tr class="bulk-preview-group-row">
              <td><span class="invoice-combined-badge">Group</span> <strong>${group.name}</strong>
                <span class="bulk-preview-group-flats">${flats}</span></td>
              ${headCells}${penaltyCells}
              <td><strong>₹${rowTotal.toLocaleString('en-IN')}</strong></td>
            </tr>`;
        }

        const { row, penRow } = entry;
        const rowTotal = row.total + (penRow?.penaltyTotal || 0);
        const overdueHint = penRow?.daysOverdue > 0
            ? ` title="${penRow.daysOverdue}d overdue · bal ${formatMoney(penRow.overdueBalance)}"`
            : '';
        return `<tr>
          <td${overdueHint}><strong>${row.unit.number}</strong>${row.warnings.length ? `<span class="bulk-preview-warn-icon" title="${row.warnings.join('; ')}">!</span>` : ''}</td>
          ${renderUnitCells(row)}${renderPenaltyCells(row, penRow)}
          <td><strong>₹${rowTotal.toLocaleString('en-IN')}</strong></td>
        </tr>`;
    }).join('')}</tbody>`;

    table.querySelectorAll('.bulk-manual-amt').forEach((el) => {
        el.addEventListener('input', (ev) => {
            ev.target.dataset.dirty = '1';
            refreshBulkInvoicePreview();
        });
    });
    table.querySelectorAll('.bulk-penalty-amt').forEach((el) => {
        el.addEventListener('input', (ev) => {
            const key = ev.target.dataset.penaltyKey;
            const v = ev.target.value;
            if (v === '' || isNaN(parseFloat(v))) {
                delete pendingPenaltyOverrides[key];
            } else {
                pendingPenaltyOverrides[key] = parseFloat(v);
            }
            refreshBulkInvoicePreview();
        });
    });

    const penNote = penaltyPreview?.grandPenalty > 0
        ? ` · Penalties ₹${penaltyPreview.grandPenalty.toLocaleString('en-IN')}`
        : '';
    const combineNote = combineGroups && entries.some((e) => e.kind === 'group')
        ? ` · ${invoiceCount} invoice(s) with groups`
        : '';
    if (summary) {
        summary.textContent = `${preview.rows.length} flats · Grand total ₹${grandTotal.toLocaleString('en-IN')}${penNote}${combineNote}`;
    }
    if (btn) btn.textContent = combineGroups ? `Raise ${invoiceCount} invoice(s)` : `Raise ${preview.rows.length} invoices`;
};

const syncBulkPreviewEmptyState = () => {
    const empty = document.getElementById('bulk-invoice-preview-empty');
    const wrap = document.getElementById('bulk-invoice-preview-wrap');
    const showPreview = wrap && !wrap.hidden;
    if (empty) {
        empty.hidden = showPreview;
        empty.classList.toggle('is-hidden', showPreview);
    }
    if (wrap) wrap.classList.toggle('is-visible', showPreview);
};

export const closeRaiseInvoiceModal = () => {
    pendingLineOverrides = {};
    pendingPenaltyOverrides = {};
    document.getElementById('raise-invoice-modal')?.classList.remove('active');
};

export const openMaintenanceCollection = (wallet = 'BANK') => {
    if (typeof window.openIncome === 'function') window.openIncome(wallet, { asBill: false });
};

export const openMaintenanceCollectionForFlat = (flatNumber, wallet = 'BANK', options = {}) => {
    openMaintenanceCollection(wallet);
    const titleEl = document.getElementById('cash-modal-title');
    const descEl = document.getElementById('cash-modal-desc');
    if (options.context === 'move-out') {
        if (titleEl) titleEl.textContent = 'Clear dues for move-out';
        if (descEl) descEl.textContent = `Record payment for ${flatNumber} and apply to outstanding invoices.`;
    } else {
        if (titleEl) titleEl.textContent = 'Record payment';
        if (descEl) {
            descEl.textContent = `How much did ${flatNumber} pay? Invoices on the right update as you type. Add bank details and notes below if needed.`;
        }
    }
    const unitInput = document.getElementById('maintenance-unit-input');
    if (unitInput) unitInput.value = flatNumber;
    const amtInput = document.getElementById('income-amt');
    if (options.amount != null && amtInput) {
        amtInput.value = typeof options.amount === 'number'
            ? options.amount.toFixed(2)
            : String(options.amount);
    }
    const descInput = document.getElementById('income-desc');
    if (options.description && descInput) descInput.value = options.description;

    syncMaintenanceIncomeSection('Maintenance Collection', null, null);
    setTimeout(() => {
        const amt = document.getElementById('income-amt');
        if (options.amount == null) amt?.focus();
        else amt?.select();
    }, 50);
};

export const closeInvoiceDetailModal = () => {
    document.getElementById('invoice-detail-modal')?.classList.remove('active');
};

export const viewInvoiceDetail = (invoiceId) => {
    const inv = fnFinances().maintenanceInvoices.find((i) => i.id === invoiceId);
    if (!inv) return;

    detailInvoiceId = invoiceId;
    const bal = invoiceBalance(inv);
    const title = document.getElementById('invoice-detail-title');
    const subtitle = document.getElementById('invoice-detail-subtitle');
    const body = document.getElementById('invoice-detail-body');
    const collectBtn = document.getElementById('invoice-detail-collect-btn');

    if (title) title.textContent = inv.billing_group_id
        ? `${getInvoiceDisplayLabel(inv)} · ${inv.period_label}`
        : `${getUnitLabel(inv.unit_id)} · ${inv.period_label}`;
    if (subtitle) subtitle.textContent = inv.billing_group_id
        ? `Combined invoice · Billed ${formatMoney(inv.amount)} · Balance ${formatMoney(bal)}`
        : `Billed ${formatMoney(inv.amount)} · Balance ${formatMoney(bal)}`;

    const allocs = getAllocationsForInvoice(invoiceId);
    const lines = getInvoiceLines(invoiceId);
    let paymentsHtml = '';
    if (allocs.length) {
        paymentsHtml = `<ul class="invoice-detail-payments">${allocs.map((a) => {
            const txn = fnFinances().txns.find((t) => t.id === a.transaction_id);
            const date = txn?.date
                ? new Date(txn.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                : '—';
            return `<li><span>${date}</span><strong>${formatMoney(a.amount)}</strong><span>${txn?.wallet || ''}</span></li>`;
        }).join('')}</ul>`;
    } else {
        paymentsHtml = '<p class="maintenance-alloc-hint">No payments applied to this invoice yet.</p>';
    }

    if (body) {
        const groupMeta = inv.billing_group_id
            ? `<p class="invoice-detail-group-meta"><span class="invoice-combined-badge">Combined</span> Covers: ${formatGroupUnitLabels(inv.billing_group_id, getUnitLabel)}</p>`
            : '';

        const renderLineRow = (l) => {
            const typeLabel = String(l.calc_type || '').startsWith('PENALTY_')
                ? `Penalty · ${ruleTypeLabel(l.calc_type.replace('PENALTY_', ''))}`
                : calcTypeLabel(l.calc_type);
            const nameClass = l.penalty_rule_id ? 'invoice-line--penalty' : '';
            const flatCol = inv.billing_group_id && l.unit_id
                ? `<td>${getUnitLabel(l.unit_id)}</td>` : '';
            return `<tr class="${nameClass}">
              ${flatCol}
              <td>${l.head_name}</td>
              <td>${typeLabel}</td>
              <td>${l.quantity != null ? l.quantity : '—'}</td>
              <td style="text-align:right;">${formatMoney(l.amount)}</td>
            </tr>`;
        };

        const flatHeader = inv.billing_group_id ? '<th>Flat</th>' : '';
        const linesHtml = lines.length
            ? `<table class="invoice-lines-table">
                <thead><tr>${flatHeader}<th>Head</th><th>Type</th><th>Qty</th><th style="text-align:right;">Amount</th></tr></thead>
                <tbody>${lines.map(renderLineRow).join('')}</tbody>
              </table>`
            : '';

        body.innerHTML = `
          ${groupMeta}
          <div class="invoice-detail-grid">
            <div><span>Status</span>${statusBadge(inv)}</div>
            <div><span>Due date</span><strong>${inv.due_date ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-GB') : '—'}</strong></div>
            <div><span>Paid</span><strong>${formatMoney(inv.amount_paid)}</strong></div>
            <div><span>Balance</span><strong style="color:${bal > 0 ? 'var(--danger)' : 'var(--success)'}">${formatMoney(bal)}</strong></div>
          </div>
          ${linesHtml ? `<h4 class="invoice-detail-section-title">Charge breakdown</h4>${linesHtml}` : ''}
          ${inv.notes ? `<p class="invoice-detail-notes">${inv.notes}</p>` : ''}
          <h4 class="invoice-detail-section-title">Payments applied</h4>
          ${paymentsHtml}
          <details class="invoice-detail-history-wrap">
            <summary class="invoice-detail-section-title invoice-detail-history-summary">History</summary>
            <div id="invoice-detail-history"></div>
          </details>`;
    }

    void renderInvoiceActivityHistory(invoiceId);

    if (collectBtn) {
        collectBtn.style.display = bal > 0.001 ? 'inline-flex' : 'none';
        collectBtn.onclick = () => {
            closeInvoiceDetailModal();
            const flatLabel = inv.billing_group_id
                ? getUnitLabel(inv.unit_id || getUnitIdsForGroup(inv.billing_group_id)[0])
                : getUnitLabel(inv.unit_id);
            openMaintenanceCollectionForFlat(flatLabel, 'BANK', {
                invoiceId: inv.id,
                amount: bal,
                allocationAmount: bal,
            });
        };
    }

    document.getElementById('invoice-detail-modal')?.classList.add('active');
};

bindFinanceNewWindow('openPenaltyRulesModal', openPenaltyRulesModal);
bindFinanceNewWindow('openSendInvoicesModal', openSendInvoicesModal);
bindFinanceNewWindow('openChargeHeadsModal', openChargeHeadsModal);
bindFinanceNewWindow('closeInvoiceDetailModal', closeInvoiceDetailModal);

bindFinanceNewWindow('autoApplyMaintenance', autoApplyOldestFirst);
bindFinanceNewWindow('deleteMaintenanceInvoice', deleteMaintenanceInvoice);
bindFinanceNewWindow('renderInvoicesPage', renderInvoicesPage);
bindFinanceNewWindow('renderMaintenanceDues', renderInvoicesPage);
bindFinanceNewWindow('switchInvoiceSubView', switchInvoiceSubView);
bindFinanceNewWindow('openRaiseInvoiceModal', openRaiseInvoiceModal);
bindFinanceNewWindow('closeRaiseInvoiceModal', closeRaiseInvoiceModal);
bindFinanceNewWindow('openMaintenanceCollection', openMaintenanceCollection);
bindFinanceNewWindow('openMaintenanceCollectionForFlat', openMaintenanceCollectionForFlat);
bindFinanceNewWindow('filterInvoicesByFlat', filterInvoicesByFlat);
bindFinanceNewWindow('viewPendingDuesInvoices', viewPendingDuesInvoices);
bindFinanceNewWindow('viewInvoiceDetail', viewInvoiceDetail);

export const initMaintenanceBilling = () => {
    wireMaintenanceIncomeForm();
    populateUnitDatalist();
    initChargeHeadsUi();
    initPenaltyRulesUi();
    initBillingGroupsUi();
    initInvoicePdfUi();
    initBillingBatchesUi();
    initDuesAgingUi();
    renderBlockFilterSelect('fn-billing-block-filter', () => renderInvoicesPage());
    initBlockFilterListener(() => renderInvoicesPage());
    wireFinancePageHelp({
        btnId: 'fn-invoices-page-help-btn',
        popoverId: 'fn-invoices-page-help',
        getHelp: () => INVOICE_PAGE_HELP[activeInvoiceSubView] || INVOICE_PAGE_HELP['pending-dues'],
    });

    document.getElementById('fn-pending-dues-filter')?.addEventListener('input', renderPendingDues);
    document.getElementById('fn-invoice-list-filter')?.addEventListener('input', renderInvoiceList);
    document.getElementById('fn-invoice-status-filter')?.addEventListener('change', renderInvoiceList);
    document.querySelectorAll('#view-finance-new-invoices [data-invoice-subview]').forEach((btn) => {
        btn.addEventListener('click', () => switchInvoiceSubView(btn.dataset.invoiceSubview));
    });

    const pendingItems = document.getElementById('fn-pending-dues-items');
    pendingItems?.addEventListener('change', (e) => {
        const check = e.target.closest('.pending-dues-row-check');
        if (!check) return;
        if (check.checked) selectedPendingUnitIds.add(check.value);
        else selectedPendingUnitIds.delete(check.value);
        syncPendingDuesBulkBar();
    });
    pendingItems?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pd-action]');
        if (!btn) return;
        const flat = btn.dataset.flat || '';
        if (btn.dataset.pdAction === 'pay') openMaintenanceCollectionForFlat(flat);
        else if (btn.dataset.pdAction === 'invoices') viewPendingDuesInvoices(flat);
    });
    document.getElementById('fn-pending-dues-select-all')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        getPendingDuesRows().forEach((r) => {
            if (on) selectedPendingUnitIds.add(r.unit.id);
            else selectedPendingUnitIds.delete(r.unit.id);
        });
        renderPendingDues();
    });
    document.getElementById('fn-pending-dues-bulk-clear')?.addEventListener('click', () => {
        selectedPendingUnitIds.clear();
        renderPendingDues();
    });
    document.getElementById('fn-pending-dues-bulk-export')?.addEventListener('click', () => {
        exportSelectedPendingDues().catch((err) => alert(err?.message || 'Export failed.'));
    });
    document.getElementById('fn-pending-dues-bulk-remind')?.addEventListener('click', () => {
        sendRemindersForSelectedPending().catch((err) => alert(err?.message || 'Could not send reminders.'));
    });

    const invoiceItems = document.getElementById('fn-invoice-list-items');
    invoiceItems?.addEventListener('change', (e) => {
        const check = e.target.closest('.invoice-list-row-check');
        if (!check) return;
        if (check.checked) selectedInvoiceIds.add(check.value);
        else selectedInvoiceIds.delete(check.value);
        syncInvoiceListBulkBar();
    });
    invoiceItems?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-inv-action]');
        if (!btn) return;
        const id = btn.dataset.id;
        const action = btn.dataset.invAction;
        if (action === 'pay') {
            const bal = parseFloat(btn.dataset.bal || 0);
            openMaintenanceCollectionForFlat(btn.dataset.flat || '', 'BANK', {
                invoiceId: id,
                amount: bal,
                allocationAmount: bal,
            });
        } else if (action === 'pdf') {
            window.downloadInvoicePdf?.(id);
        } else if (action === 'view') {
            viewInvoiceDetail(id);
        } else if (action === 'delete') {
            if (!canDeleteAccounts()) {
                alert('You do not have permission to delete invoices.');
                return;
            }
            deleteMaintenanceInvoice(id).catch((err) => alert(err?.message || 'Delete failed.'));
        }
    });
    document.getElementById('fn-invoice-list-select-all')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        filteredInvoices().forEach((inv) => {
            if (on) selectedInvoiceIds.add(inv.id);
            else selectedInvoiceIds.delete(inv.id);
        });
        renderInvoiceList();
    });
    document.getElementById('fn-invoice-list-bulk-clear')?.addEventListener('click', () => {
        selectedInvoiceIds.clear();
        renderInvoiceList();
    });
    document.getElementById('fn-invoice-list-bulk-delete')?.addEventListener('click', () => {
        deleteSelectedInvoices().catch((err) => alert(err?.message || 'Bulk delete failed.'));
    });

    switchInvoiceSubView(activeInvoiceSubView);

    document.querySelectorAll('input[name="bulk-unit-scope"]').forEach((el) => {
        el.addEventListener('change', () => {
            syncBulkUnitScopeUi();
            refreshBulkInvoicePreview();
        });
    });
    document.getElementById('bulk-unit-search')?.addEventListener('input', () => renderBulkUnitPicker());
    document.getElementById('bulk-open-heads-btn')?.addEventListener('click', openChargeHeadsModal);
    document.getElementById('bulk-open-penalties-btn')?.addEventListener('click', openPenaltyRulesModal);
    document.getElementById('bulk-open-billing-groups-btn')?.addEventListener('click', openBillingGroupsModal);
    bindFinanceNewWindow('refreshBulkInvoicePreview', refreshBulkInvoicePreview);

    document.getElementById('raise-invoice-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('raise-invoice-btn');
        await withButtonBusy(btn, 'Saving…', async () => {
            const result = await createBulkMaintenanceInvoices({
                periodLabel: document.getElementById('raise-invoice-period')?.value,
                dueDate: document.getElementById('raise-invoice-due')?.value || null,
                notes: document.getElementById('raise-invoice-notes')?.value,
                unitIds: getSelectedBulkUnitIds(),
                headIds: getSelectedBulkHeadIds(),
                manualAmounts: buildEffectiveManualAmounts(),
                lineOverrides: pendingLineOverrides,
                penaltyRuleIds: getSelectedBulkPenaltyRuleIds(),
                penaltyOverrides: pendingPenaltyOverrides,
                combineGroups: isCombineGroupsEnabled(),
            });
            closeRaiseInvoiceModal();
            if (result.skipped > 0) {
                alert(`Created ${result.created} invoice(s). Skipped ${result.skipped} flat(s) that already had this period.`);
            }
        }).catch((err) => alert(err?.message || 'Could not create invoices.'))
            .finally(() => refreshBulkInvoicePreview());
    });

    document.getElementById('raise-invoice-period')?.addEventListener('input', refreshBulkInvoicePreview);
    document.getElementById('raise-invoice-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'raise-invoice-modal') closeRaiseInvoiceModal();
    });

    document.getElementById('invoice-detail-close')?.addEventListener('click', closeInvoiceDetailModal);
    document.getElementById('invoice-detail-cancel')?.addEventListener('click', closeInvoiceDetailModal);
    document.getElementById('invoice-detail-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'invoice-detail-modal') closeInvoiceDetailModal();
    });

    document.getElementById('invoice-detail-pdf-btn')?.addEventListener('click', async () => {
        if (!detailInvoiceId) return;
        const btn = document.getElementById('invoice-detail-pdf-btn');
        await withButtonBusy(btn, 'Generating PDF…', () => downloadInvoicePdf(detailInvoiceId))
            .catch((err) => alert(err?.message || 'Could not generate PDF.'));
    });
    document.getElementById('invoice-detail-email-btn')?.addEventListener('click', async () => {
        if (!detailInvoiceId) return;
        const btn = document.getElementById('invoice-detail-email-btn');
        await withButtonBusy(btn, 'Preparing email…', async () => {
            const result = await emailInvoicePdf(detailInvoiceId);
            if (result.method === 'mailto' && !result.email) {
                alert('No email on file for this flat — add owner/tenant email in Residents, or enter the address manually.');
            }
        }).catch((err) => alert(err?.message || 'Could not prepare email.'));
    });

    document.getElementById('apply-penalty-asof')?.addEventListener('change', refreshApplyPenaltyPreview);
    document.getElementById('apply-penalties-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'apply-penalties-modal') closeApplyPenaltiesModal();
    });
    document.getElementById('apply-penalties-submit')?.addEventListener('click', async () => {
        const btn = document.getElementById('apply-penalties-submit');
        const ruleIds = [...document.querySelectorAll('.apply-penalty-checkbox:checked')].map((el) => el.value);
        if (!ruleIds.length) {
            alert('Select at least one penalty rule.');
            return;
        }
        if (!confirm('Add penalty lines to overdue open invoices? Existing penalty rules on an invoice are skipped.')) return;
        await withButtonBusy(btn, 'Applying…', async () => {
            const result = await applyPenaltiesToOverdue({
                ruleIds,
                overrides: applyPenaltyOverrides,
                asOfDate: document.getElementById('apply-penalty-asof')?.value,
            });
            closeApplyPenaltiesModal();
            alert(`Applied penalties to ${result.applied} invoice(s) · ${result.linesAdded} line(s) added.`);
        }).catch((err) => alert(err?.message || 'Could not apply penalties.'));
    });

    document.getElementById('bulk-invoice-download')?.addEventListener('click', () => {
        downloadBulkInvoiceTemplate({
            unitIds: getSelectedBulkUnitIds(),
            headIds: getSelectedBulkHeadIds(),
            periodLabel: document.getElementById('raise-invoice-period')?.value,
            dueDate: document.getElementById('raise-invoice-due')?.value,
            notes: document.getElementById('raise-invoice-notes')?.value,
            manualAmounts: buildEffectiveManualAmounts(),
        }).catch((err) => alert(err?.message || 'Download failed.'));
    });

    const bulkFileInput = document.getElementById('bulk-invoice-xlsx');
    document.getElementById('bulk-invoice-import-btn')?.addEventListener('click', () => bulkFileInput?.click());

    bulkFileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        try {
            const parsed = await parseBulkInvoiceExcel(file);
            if (parsed.periodLabel) {
                document.getElementById('raise-invoice-period').value = parsed.periodLabel;
            }
            if (parsed.dueDate) {
                document.getElementById('raise-invoice-due').value = formatDateForInput(parsed.dueDate) || parsed.dueDate;
            }
            if (parsed.notes) {
                document.getElementById('raise-invoice-notes').value = parsed.notes;
            }

            const { headIds, headByName } = await resolveImportHeads(parsed.headColumns);
            refreshBulkInvoiceHeads();
            setBulkHeadCheckboxes(headIds);

            const { unitIds, lineOverrides, errors } = buildLineOverridesFromImport(parsed, headByName);
            pendingLineOverrides = lineOverrides;

            if (unitIds.length) {
                const selected = document.querySelector('input[name="bulk-unit-scope"][value="selected"]');
                if (selected) selected.checked = true;
                syncBulkUnitScopeUi();
                renderBulkUnitPicker();
                document.querySelectorAll('.bulk-unit-checkbox').forEach((el) => {
                    el.checked = unitIds.includes(el.value);
                });
            }

            refreshBulkInvoicePreview();
            const errNote = errors.length ? `\n\nSkipped ${errors.length} row(s):\n${errors.slice(0, 5).join('\n')}` : '';
            alert(`Imported ${parsed.rows.length} flat row(s) · ${headIds.length} charge head(s). Review preview, then raise invoices.${errNote}`);
        } catch (err) {
            alert(err?.message || 'Could not read Excel file.');
        }
    });
};
