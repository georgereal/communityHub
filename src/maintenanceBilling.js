/**
 * Maintenance billing: flat invoices + payment allocation against collections
 */
import { portalState, supabase, pullState } from './store.js';
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
} from './bulkInvoiceImport.js';
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
} from './penaltyRules.js';
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
} from './invoicePdf.js';

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
    return (portalState.finances.maintenanceInvoices || [])
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
    (portalState.finances.maintenanceAllocations || []).filter((a) => a.transaction_id === txnId);

export const getAllocationsForInvoice = (invoiceId) =>
    (portalState.finances.maintenanceAllocations || []).filter((a) => a.invoice_id === invoiceId);

export const formatAllocationSummary = (txnId) => {
    const allocs = getAllocationsForTxn(txnId);
    if (!allocs.length) return '';
    const parts = allocs.map((a) => {
        const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === a.invoice_id);
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

const renderAllocationRows = (unitId, paymentAmount, existingAllocs = []) => {
    const container = document.getElementById('maintenance-allocation-rows');
    const summary = document.getElementById('maintenance-allocation-summary');
    if (!container) return;

    if (!unitId) {
        container.innerHTML = '<p class="maintenance-alloc-hint">Select a flat to see outstanding invoices.</p>';
        if (summary) summary.textContent = '';
        return;
    }

    const open = getOpenInvoicesForUnit(unitId);
    if (!open.length) {
        container.innerHTML = '<p class="maintenance-alloc-hint">No outstanding invoices for this flat. Payment can be saved as unallocated advance.</p>';
        if (summary) summary.textContent = '';
        return;
    }

    const existingByInvoice = new Map(existingAllocs.map((a) => [a.invoice_id, parseFloat(a.amount)]));
    container.innerHTML = open.map((inv) => {
        const bal = invoiceBalance(inv);
        const prefill = existingByInvoice.get(inv.id) ?? '';
        const due = inv.due_date
            ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
            : '—';
        return `<label class="maintenance-alloc-row">
          <input type="checkbox" class="maintenance-alloc-check" data-invoice-id="${inv.id}" ${prefill ? 'checked' : ''} />
          <span class="maintenance-alloc-row__meta">
            <strong>${inv.period_label}${inv.billing_group_id ? ` · ${getInvoiceDisplayLabel(inv)}` : ''}</strong>
            <span>Due ${due} · Balance ${formatMoney(bal)}</span>
          </span>
          <input type="number" class="maintenance-alloc-amt expense-combobox" data-invoice-id="${inv.id}"
            min="0" max="${bal}" step="0.01" placeholder="0" value="${prefill || ''}" inputmode="decimal" />
        </label>`;
    }).join('');

    container.querySelectorAll('.maintenance-alloc-check, .maintenance-alloc-amt').forEach((el) => {
        el.addEventListener('change', () => updateAllocationSummary(paymentAmount));
        el.addEventListener('input', () => updateAllocationSummary(paymentAmount));
    });
    updateAllocationSummary(paymentAmount);
};

export const updateAllocationSummary = (paymentAmount) => {
    const summary = document.getElementById('maintenance-allocation-summary');
    if (!summary) return;
    const { total } = collectAllocationDraft();
    const pay = parseFloat(paymentAmount) || 0;
    const unallocated = Math.max(0, pay - total);
    summary.innerHTML = pay > 0
        ? `Allocated <strong>${formatMoney(total)}</strong> of ${formatMoney(pay)}`
            + (unallocated > 0.001 ? ` · <span class="maintenance-alloc-unalloc">${formatMoney(unallocated)} unallocated</span>` : '')
        : `Allocated ${formatMoney(total)}`;
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

export const syncMaintenanceIncomeSection = (catKey, txnId = null) => {
    const section = document.getElementById('income-maintenance-section');
    if (!section) return;
    const isMaintenance = catKey === 'Maintenance Collection';
    section.hidden = !isMaintenance;
    if (!isMaintenance) return;

    populateUnitDatalist();
    const unitInput = document.getElementById('maintenance-unit-input');
    const existing = txnId ? getAllocationsForTxn(txnId) : [];
    let unitId = null;
    if (existing.length) {
        const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === existing[0].invoice_id);
        unitId = inv?.unit_id;
        if (unitInput && inv) unitInput.value = getUnitLabel(inv.unit_id);
    } else if (unitInput?.value) {
        unitId = getUnitByNumber(unitInput.value)?.id;
    }

    const payAmt = parseFloat(document.getElementById('income-amt')?.value) || 0;
    renderAllocationRows(unitId, payAmt, existing);
};

export const wireMaintenanceIncomeForm = () => {
    const unitInput = document.getElementById('maintenance-unit-input');
    const amtInput = document.getElementById('income-amt');

    unitInput?.addEventListener('change', () => {
        const unit = getUnitByNumber(unitInput.value);
        renderAllocationRows(unit?.id, parseFloat(amtInput?.value) || 0);
    });
    unitInput?.addEventListener('blur', () => {
        const unit = getUnitByNumber(unitInput.value);
        renderAllocationRows(unit?.id, parseFloat(amtInput?.value) || 0);
    });
    amtInput?.addEventListener('input', () => updateAllocationSummary(parseFloat(amtInput.value) || 0));

    document.getElementById('maintenance-auto-apply-btn')?.addEventListener('click', autoApplyOldestFirst);
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
        const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === row.invoice_id);
        if (!inv) return 'One of the selected invoices is no longer available.';
        if (row.amount > invoiceBalance(inv) + 0.001) {
            return `Allocation for ${inv.period_label} exceeds the outstanding balance.`;
        }
        if (unit && inv.unit_id !== unit.id) {
            return 'All selected invoices must belong to the chosen flat.';
        }
    }
    return true;
};

export async function saveMaintenanceAllocations(apartment_id, txnId, catKey) {
    if (!supabase || catKey !== 'Maintenance Collection') return { ok: true };

    const { rows } = collectAllocationDraft();

    const { error: delErr } = await supabase
        .from('maintenance_payment_allocations')
        .delete()
        .eq('transaction_id', txnId);
    if (delErr && !/maintenance_payment_allocations/i.test(delErr.message)) {
        return { ok: false, error: delErr.message };
    }
    if (delErr) return { ok: true, skipped: true };

    if (!rows.length) return { ok: true };

    const payload = rows.map((r) => ({
        id: crypto.randomUUID(),
        apartment_id,
        transaction_id: txnId,
        invoice_id: r.invoice_id,
        amount: r.amount,
    }));

    const { error } = await supabase.from('maintenance_payment_allocations').insert(payload);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
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
    if (!supabase) throw new Error('Supabase is not configured.');
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

    const allInvoices = portalState.finances.maintenanceInvoices || [];
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

    const { error: batchErr } = await supabase.from('maintenance_billing_batches').insert({
        id: batch_id,
        apartment_id,
        period_label,
        due_date: dueDate || null,
        notes: notes?.trim() || null,
        unit_count: toCreateIndividual.length + groupsToCreate.reduce((s, g) => s + g.rows.length, 0),
    });
    if (batchErr && !/maintenance_billing_batches/i.test(batchErr.message)) {
        throw new Error(batchErr.message);
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

        const { error: invErr } = await supabase.from('maintenance_invoices').insert({
            id: invoice_id,
            apartment_id,
            unit_id: unit_id || null,
            billing_group_id: billing_group_id || null,
            period_label,
            due_date: dueDate || null,
            amount: invoiceTotal,
            notes: notes?.trim() || null,
            batch_id: batchErr ? null : batch_id,
        });
        if (invErr) throw new Error(invErr.message);

        if (linePayload.length) {
            const { error: lineErr } = await supabase.from('maintenance_invoice_lines').insert(linePayload);
            if (lineErr && !/maintenance_invoice_lines|unit_id|billing_group/i.test(lineErr.message)) {
                throw new Error(lineErr.message);
            }
        }
    };

    for (const row of toCreateIndividual) {
        const penRow = penaltyByUnit.get(row.unit.id);
        const invoiceTotal = roundMoney(row.total + (penRow?.penaltyTotal || 0));
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
        const primaryUnit = rows[0]?.unit?.id || null;
        await insertInvoiceWithLines({
            unit_id: primaryUnit,
            billing_group_id: group.id,
            lineRows: rows,
            penRows: penaltyByUnit,
            invoiceTotal,
        });
    }

    await pullState();
    renderInvoicesPage();

    return { created: invoiceCount, skipped };
}

/** Apply selected penalty rules to all overdue open invoices */
export async function applyPenaltiesToOverdue({ ruleIds, overrides = {}, asOfDate = null }) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');
    if (!ruleIds?.length) throw new Error('Select at least one penalty rule.');

    const asOf = asOfDate || new Date().toISOString().slice(0, 10);
    const overdueInvoices = (portalState.finances.maintenanceInvoices || []).filter((inv) => {
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
            (portalState.finances.maintenanceInvoiceLines || [])
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

        const { error: lineErr } = await supabase.from('maintenance_invoice_lines').insert(newLines);
        if (lineErr && !/penalty_rule_id/i.test(lineErr.message)) throw new Error(lineErr.message);

        const { error: updErr } = await supabase.from('maintenance_invoices')
            .update({ amount: newAmount })
            .eq('id', inv.id);
        if (updErr) throw new Error(updErr.message);

        applied += 1;
        linesAdded += newLines.length;
    }

    if (!applied) throw new Error('No new penalty lines to apply (rules may already be on invoices or amounts are zero).');

    await pullState();
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

    const overdueInvoices = (portalState.finances.maintenanceInvoices || []).filter((inv) => {
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
    if (!(portalState.finances.maintenancePenaltyRules || []).length) {
        await seedDefaultPenaltyRules().catch(() => {});
    }
    const container = document.getElementById('apply-penalty-rules');
    const rules = (portalState.finances.maintenancePenaltyRules || []).filter((r) => r.is_active !== false);
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

window.openApplyPenaltiesModal = openApplyPenaltiesModal;
window.closeApplyPenaltiesModal = closeApplyPenaltiesModal;

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

export async function deleteMaintenanceInvoice(id) {
    if (!supabase) return;
    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === id);
    if (!inv) return;
    if (parseFloat(inv.amount_paid || 0) > 0.001) {
        alert('Cannot delete an invoice that has payments applied. Remove allocations first.');
        return;
    }
    if (!confirm(`Delete invoice ${inv.period_label} for ${getUnitLabel(inv.unit_id)}?`)) return;

    const { error } = await supabase.from('maintenance_invoices').delete().eq('id', id);
    if (error) return alert(error.message);
    await pullState();
    renderInvoicesPage();
}

let activeInvoiceSubView = 'list';
let detailInvoiceId = null;

const filteredInvoices = () => {
    const filterQ = (document.getElementById('invoice-list-filter')?.value || '').trim().toUpperCase();
    const statusFilter = document.getElementById('invoice-status-filter')?.value || 'all';
    let invoices = [...(portalState.finances.maintenanceInvoices || [])];

    if (filterQ) {
        invoices = invoices.filter((inv) => {
            const flat = getInvoiceDisplayLabel(inv).toUpperCase();
            return flat.includes(filterQ) || (inv.period_label || '').toUpperCase().includes(filterQ);
        });
    }

    if (statusFilter === 'open') {
        invoices = invoices.filter((inv) => invoiceStatus(inv) !== 'PAID');
    } else if (statusFilter === 'paid') {
        invoices = invoices.filter((inv) => invoiceStatus(inv) === 'PAID');
    }

    invoices.sort((a, b) => {
        const fa = getUnitLabel(a.unit_id);
        const fb = getUnitLabel(b.unit_id);
        if (fa !== fb) return fa.localeCompare(fb, undefined, { numeric: true });
        return (a.due_date || '').localeCompare(b.due_date || '');
    });

    return invoices;
};

export const renderInvoiceMetrics = () => {
    const invoices = portalState.finances.maintenanceInvoices || [];
    const now = new Date();
    let outstanding = 0;
    let openCount = 0;
    const flatsWithDues = new Set();

    invoices.forEach((inv) => {
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
    (portalState.finances.maintenanceAllocations || []).forEach((a) => {
        const txn = portalState.finances.txns.find((t) => t.id === a.transaction_id);
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
    const list = document.getElementById('invoice-list-items');
    if (!list) return;

    const invoices = filteredInvoices();
    list.innerHTML = '';

    if (!invoices.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No invoices match your filters. Raise one to start tracking flat dues.</p>';
        return;
    }

    invoices.forEach((inv) => {
        const bal = invoiceBalance(inv);
        const row = document.createElement('div');
        row.className = 'apt-row maintenance-dues-row';
        row.innerHTML = `
          <div class="maintenance-dues-flat">${inv.billing_group_id
            ? `<span class="invoice-combined-badge">Combined</span> ${getInvoiceDisplayLabel(inv)}`
            : getInvoiceDisplayLabel(inv)}</div>
          <div>${inv.period_label}</div>
          <div>${inv.due_date ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-GB') : '—'}</div>
          <div style="text-align:right;">${formatMoney(inv.amount)}</div>
          <div style="text-align:right;">${formatMoney(inv.amount_paid)}</div>
          <div style="text-align:right; font-weight:800; color:${bal > 0 ? 'var(--danger)' : 'var(--success)'};">${formatMoney(bal)}</div>
          <div>${statusBadge(inv)}</div>
          <div style="text-align:right; display:flex; gap:0.35rem; justify-content:flex-end;">
            <button type="button" class="btn btn-outline" style="padding:0.2rem 0.4rem;" title="Download PDF"
              onclick="window.downloadInvoicePdf('${inv.id}')"><i class="fa-solid fa-file-pdf"></i></button>
            <button type="button" class="btn btn-outline" style="padding:0.2rem 0.4rem;" title="View details"
              onclick="window.viewInvoiceDetail('${inv.id}')"><i class="fa-solid fa-eye"></i></button>
            <button type="button" class="btn btn-outline" style="padding:0.2rem 0.4rem; color:var(--danger);"
              onclick="window.deleteMaintenanceInvoice('${inv.id}')" ${parseFloat(inv.amount_paid || 0) > 0 ? 'disabled title="Has payments applied"' : ''}>
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>`;
        list.appendChild(row);
    });
};

export const renderInvoicesByFlat = () => {
    const container = document.getElementById('invoice-by-flat-items');
    if (!container) return;

    const filterQ = (document.getElementById('invoice-flat-filter')?.value || '').trim().toUpperCase();
    const byUnit = new Map();

    (portalState.finances.maintenanceInvoices || []).forEach((inv) => {
        if (!byUnit.has(inv.unit_id)) {
            byUnit.set(inv.unit_id, { invoices: [], outstanding: 0, collected: 0, openCount: 0 });
        }
        const bucket = byUnit.get(inv.unit_id);
        bucket.invoices.push(inv);
        const bal = invoiceBalance(inv);
        bucket.outstanding += bal;
        bucket.collected += parseFloat(inv.amount_paid || 0);
        if (invoiceStatus(inv) !== 'PAID') bucket.openCount += 1;
    });

    let units = portalState.units
        .filter((u) => byUnit.has(u.id))
        .map((u) => ({ unit: u, ...byUnit.get(u.id) }));

    if (filterQ) {
        units = units.filter(({ unit }) => String(unit.number || '').toUpperCase().includes(filterQ));
    }

    units.sort((a, b) => String(a.unit.number).localeCompare(String(b.unit.number), undefined, { numeric: true }));

    container.innerHTML = '';
    if (!units.length) {
        container.innerHTML = '<p class="maintenance-dues-empty">No invoice history yet. Raise invoices from the header or filter a different flat.</p>';
        return;
    }

    units.forEach(({ unit, outstanding, collected, openCount, invoices }) => {
        const combinedOpen = (portalState.finances.maintenanceInvoices || []).filter((inv) => {
            if (!inv.billing_group_id || invoiceStatus(inv) === 'PAID') return false;
            return getUnitIdsForGroup(inv.billing_group_id).includes(unit.id);
        });
        const combinedNote = combinedOpen.length
            ? `<p class="invoice-flat-combined-note"><span class="invoice-combined-badge">Combined</span> ${combinedOpen.map((inv) => `${getInvoiceDisplayLabel(inv)} · ${formatMoney(invoiceBalance(inv))}`).join('; ')}</p>`
            : '';

        const card = document.createElement('div');
        card.className = 'invoice-flat-card';
        card.innerHTML = `
          <div class="invoice-flat-card__head">
            <strong>${unit.number}</strong>
            ${openCount ? `<span class="maintenance-dues-badge dues-open">${openCount} open</span>` : '<span class="maintenance-dues-badge dues-paid">Clear</span>'}
          </div>
          <div class="invoice-flat-card__stats">
            <div><span>Outstanding</span><strong style="color:${outstanding > 0 ? 'var(--danger)' : 'var(--success)'}">${formatMoney(outstanding)}</strong></div>
            <div><span>Collected</span><strong>${formatMoney(collected)}</strong></div>
            <div><span>Invoices</span><strong>${invoices.length}</strong></div>
          </div>
          ${combinedNote}
          <div class="invoice-flat-card__actions">
            <button type="button" class="btn btn-outline" onclick="window.filterInvoicesByFlat('${unit.number}')">View invoices</button>
            <button type="button" class="btn btn-primary" onclick="window.openMaintenanceCollectionForFlat('${unit.number}')">Record payment</button>
          </div>`;
        container.appendChild(card);
    });
};

export const renderInvoiceCollections = () => {
    const list = document.getElementById('invoice-collections-items');
    if (!list) return;

    const collections = (portalState.finances.txns || [])
        .filter((t) => t.type === 'IN' && t.cat === 'Maintenance Collection')
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    list.innerHTML = '';
    if (!collections.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No maintenance collections recorded yet. Use Record Collection to log payments against flat invoices.</p>';
        return;
    }

    collections.forEach((t) => {
        const allocs = getAllocationsForTxn(t.id);
        const flat = allocs.length
            ? getInvoiceDisplayLabel(portalState.finances.maintenanceInvoices.find((i) => i.id === allocs[0].invoice_id))
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
    renderInvoiceMetrics();
    if (activeInvoiceSubView === 'list') renderInvoiceList();
    else if (activeInvoiceSubView === 'by-flat') renderInvoicesByFlat();
    else renderInvoiceCollections();
};

export const switchInvoiceSubView = (sv) => {
    activeInvoiceSubView = sv;
    const views = { list: 'invoice-subview-list', 'by-flat': 'invoice-subview-by-flat', collections: 'invoice-subview-collections' };
    Object.entries(views).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = key === sv ? 'block' : 'none';
    });

    const dim = 'var(--text-dim)';
    const active = '#111827';
    const tabs = { list: 'btn-invoice-list', 'by-flat': 'btn-invoice-by-flat', collections: 'btn-invoice-collections' };
    Object.entries(tabs).forEach(([key, id]) => {
        const btn = document.getElementById(id);
        if (btn) btn.style.color = key === sv ? active : dim;
    });

    renderInvoicesPage();
};

export const filterInvoicesByFlat = (flatNumber) => {
    switchInvoiceSubView('list');
    const input = document.getElementById('invoice-list-filter');
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
    if (!(portalState.finances.maintenancePenaltyRules || []).length) {
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
    if (typeof window.openIncome === 'function') window.openIncome(wallet);
};

export const openMaintenanceCollectionForFlat = (flatNumber, wallet = 'BANK') => {
    openMaintenanceCollection(wallet);
    const unitInput = document.getElementById('maintenance-unit-input');
    if (unitInput) unitInput.value = flatNumber;
    syncMaintenanceIncomeSection('Maintenance Collection');
};

export const closeInvoiceDetailModal = () => {
    document.getElementById('invoice-detail-modal')?.classList.remove('active');
};

export const viewInvoiceDetail = (invoiceId) => {
    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === invoiceId);
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
            const txn = portalState.finances.txns.find((t) => t.id === a.transaction_id);
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
          ${paymentsHtml}`;
    }

    if (collectBtn) {
        collectBtn.style.display = bal > 0.001 ? 'inline-flex' : 'none';
        collectBtn.onclick = () => {
            closeInvoiceDetailModal();
            const flatLabel = inv.billing_group_id
                ? getUnitLabel(getUnitIdsForGroup(inv.billing_group_id)[0])
                : getUnitLabel(inv.unit_id);
            openMaintenanceCollectionForFlat(flatLabel);
        };
    }

    document.getElementById('invoice-detail-modal')?.classList.add('active');
};

window.closeInvoiceDetailModal = closeInvoiceDetailModal;

window.autoApplyMaintenance = autoApplyOldestFirst;
window.deleteMaintenanceInvoice = deleteMaintenanceInvoice;
window.renderInvoicesPage = renderInvoicesPage;
window.renderMaintenanceDues = renderInvoicesPage;
window.switchInvoiceSubView = switchInvoiceSubView;
window.openRaiseInvoiceModal = openRaiseInvoiceModal;
window.closeRaiseInvoiceModal = closeRaiseInvoiceModal;
window.openMaintenanceCollection = openMaintenanceCollection;
window.openMaintenanceCollectionForFlat = openMaintenanceCollectionForFlat;
window.filterInvoicesByFlat = filterInvoicesByFlat;
window.viewInvoiceDetail = viewInvoiceDetail;

export const initMaintenanceBilling = () => {
    wireMaintenanceIncomeForm();
    populateUnitDatalist();
    initChargeHeadsUi();
    initPenaltyRulesUi();
    initBillingGroupsUi();
    initInvoicePdfUi();

    document.getElementById('invoice-list-filter')?.addEventListener('input', renderInvoiceList);
    document.getElementById('invoice-status-filter')?.addEventListener('change', renderInvoiceList);
    document.getElementById('invoice-flat-filter')?.addEventListener('input', renderInvoicesByFlat);

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

    window.refreshBulkInvoicePreview = refreshBulkInvoicePreview;

    document.getElementById('raise-invoice-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('raise-invoice-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
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
        } catch (err) {
            alert(err?.message || 'Could not create invoices.');
        } finally {
            if (btn) { btn.disabled = false; refreshBulkInvoicePreview(); }
        }
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
        if (btn) { btn.disabled = true; }
        try {
            await downloadInvoicePdf(detailInvoiceId);
        } catch (err) {
            alert(err?.message || 'Could not generate PDF.');
        } finally {
            if (btn) { btn.disabled = false; }
        }
    });
    document.getElementById('invoice-detail-email-btn')?.addEventListener('click', async () => {
        if (!detailInvoiceId) return;
        const btn = document.getElementById('invoice-detail-email-btn');
        if (btn) { btn.disabled = true; }
        try {
            const result = await emailInvoicePdf(detailInvoiceId);
            if (result.method === 'mailto' && !result.email) {
                alert('No email on file for this flat — add owner/tenant email in Residents, or enter the address manually.');
            }
        } catch (err) {
            alert(err?.message || 'Could not prepare email.');
        } finally {
            if (btn) { btn.disabled = false; }
        }
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
        if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
        try {
            const result = await applyPenaltiesToOverdue({
                ruleIds,
                overrides: applyPenaltyOverrides,
                asOfDate: document.getElementById('apply-penalty-asof')?.value,
            });
            closeApplyPenaltiesModal();
            alert(`Applied penalties to ${result.applied} invoice(s) · ${result.linesAdded} line(s) added.`);
        } catch (err) {
            alert(err?.message || 'Could not apply penalties.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Apply to overdue invoices'; }
        }
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
