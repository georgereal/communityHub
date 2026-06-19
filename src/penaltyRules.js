/**
 * Late payment & penalty rules — definitions, calculation, CRUD
 */
import { portalState, supabase, pullState } from './store.js';
import { withButtonBusy } from './buttonBusy.js';

const invoiceBalance = (inv) =>
    Math.max(0, parseFloat(inv.amount || 0) - parseFloat(inv.amount_paid || 0));

export const RULE_TYPES = {
    FLAT: {
        label: 'Flat fee',
        hint: 'Fixed penalty amount when the rule applies',
        showRate: false,
        showFlat: true,
        showGrace: false,
    },
    PERCENT_OF_DUE: {
        label: '% of amount due',
        hint: 'Percentage of the overdue balance (one-time)',
        showRate: true,
        rateLabel: 'Percent (%)',
        showFlat: false,
        showGrace: true,
    },
    PERCENT_PER_DAY: {
        label: '% per day overdue',
        hint: 'Daily rate × days overdue × balance (after grace)',
        showRate: true,
        rateLabel: 'Daily rate (%)',
        showFlat: false,
        showGrace: true,
    },
    PERCENT_PER_MONTH: {
        label: '% per month overdue',
        hint: 'Monthly rate × months overdue (partial months counted)',
        showRate: true,
        rateLabel: 'Monthly rate (%)',
        showFlat: false,
        showGrace: true,
    },
    FLAT_AFTER_GRACE: {
        label: 'Flat fee after grace',
        hint: 'Fixed amount once grace period is exceeded',
        showRate: false,
        showFlat: true,
        showGrace: true,
    },
};

export const TARGETS = {
    PRIOR_OVERDUE: 'Prior overdue invoices',
    CURRENT_INVOICE: 'Current invoice amount',
};

const roundMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const clampAmount = (amount, rule) => {
    let a = Math.max(0, amount);
    if (rule.min_amount != null && rule.min_amount > 0) a = Math.max(a, parseFloat(rule.min_amount));
    if (rule.max_amount != null && rule.max_amount > 0) a = Math.min(a, parseFloat(rule.max_amount));
    return roundMoney(a);
};

const daysBetween = (fromDate, toDate) => {
    if (!fromDate || !toDate) return 0;
    const a = new Date(`${fromDate}T12:00:00`);
    const b = new Date(`${toDate}T12:00:00`);
    const ms = b - a;
    if (ms <= 0) return 0;
    return Math.floor(ms / 86400000);
};

const monthsOverdue = (days) => (days <= 0 ? 0 : days / 30);

export const getPenaltyRules = () =>
    (portalState.finances.maintenancePenaltyRules || [])
        .filter((r) => r.is_active !== false)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''));

export const getAllPenaltyRules = () =>
    [...(portalState.finances.maintenancePenaltyRules || [])]
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || (a.name || '').localeCompare(b.name || ''));

export const ruleTypeLabel = (type) => RULE_TYPES[type]?.label || type;

export const getOpenOverdueInvoicesForUnit = (unitId, asOfDate, excludePeriod = null) => {
    const asOf = asOfDate || new Date().toISOString().slice(0, 10);
    return (portalState.finances.maintenanceInvoices || [])
        .filter((inv) => {
            if (inv.unit_id !== unitId) return false;
            if (excludePeriod && inv.period_label === excludePeriod) return false;
            if (invoiceBalance(inv) <= 0.001) return false;
            const due = inv.due_date;
            if (!due) return true;
            return due < asOf;
        })
        .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
};

export const getOverdueBalanceForUnit = (unitId, asOfDate, excludePeriod = null) =>
    getOpenOverdueInvoicesForUnit(unitId, asOfDate, excludePeriod)
        .reduce((s, inv) => s + invoiceBalance(inv), 0);

export const getMaxDaysOverdueForUnit = (unitId, asOfDate, excludePeriod = null) => {
    const asOf = asOfDate || new Date().toISOString().slice(0, 10);
    const overdue = getOpenOverdueInvoicesForUnit(unitId, asOfDate, excludePeriod);
    if (!overdue.length) return 0;
    return Math.max(...overdue.map((inv) => daysBetween(inv.due_date, asOf)));
};

/**
 * Compute penalty for one rule + unit context
 */
export const computePenaltyAmount = (rule, ctx) => {
    const {
        overdueBalance = 0,
        daysOverdue = 0,
        currentInvoiceSubtotal = 0,
        asOfDate,
    } = ctx;

    const grace = parseInt(rule.grace_days, 10) || 0;
    const effectiveDays = Math.max(0, daysOverdue - grace);
    const base = rule.target === 'CURRENT_INVOICE' ? currentInvoiceSubtotal : overdueBalance;

    if (base <= 0 && rule.rule_type !== 'FLAT') {
        return { amount: 0, quantity: 0, rate: null, detail: 'No balance', warning: null };
    }

    let amount = 0;
    let quantity = null;
    let rate = parseFloat(rule.rate) || 0;
    let detail = null;
    let warning = null;

    switch (rule.rule_type) {
        case 'FLAT':
            amount = parseFloat(rule.flat_amount) || 0;
            quantity = 1;
            detail = 'Flat penalty';
            break;
        case 'FLAT_AFTER_GRACE':
            if (daysOverdue <= grace) {
                return { amount: 0, quantity: 0, rate: null, detail: `Within ${grace}d grace`, warning: null };
            }
            amount = parseFloat(rule.flat_amount) || 0;
            quantity = 1;
            detail = `${daysOverdue}d overdue`;
            break;
        case 'PERCENT_OF_DUE':
            if (effectiveDays <= 0 && grace > 0) {
                return { amount: 0, quantity: 0, rate, detail: `Within ${grace}d grace`, warning: null };
            }
            quantity = base;
            amount = (rate / 100) * base;
            detail = `${rate}% of ₹${base.toLocaleString('en-IN')}`;
            break;
        case 'PERCENT_PER_DAY':
            if (effectiveDays <= 0) {
                return { amount: 0, quantity: 0, rate, detail: grace ? `Within ${grace}d grace` : 'Not overdue', warning: null };
            }
            quantity = effectiveDays;
            amount = (rate / 100) * base * effectiveDays;
            detail = `${rate}%/day × ${effectiveDays}d on ₹${base.toLocaleString('en-IN')}`;
            break;
        case 'PERCENT_PER_MONTH': {
            if (effectiveDays <= 0) {
                return { amount: 0, quantity: 0, rate, detail: grace ? `Within ${grace}d grace` : 'Not overdue', warning: null };
            }
            const months = monthsOverdue(effectiveDays);
            quantity = Math.round(months * 100) / 100;
            amount = (rate / 100) * base * months;
            detail = `${rate}%/mo × ${quantity} mo on ₹${base.toLocaleString('en-IN')}`;
            break;
        }
        default:
            warning = 'Unknown rule type';
            amount = 0;
    }

    amount = clampAmount(amount, rule);
    if (amount <= 0 && rule.rule_type !== 'FLAT' && base > 0 && !warning) {
        detail = detail || 'Zero after calculation';
    }

    return {
        amount,
        quantity,
        rate: rule.rule_type.startsWith('PERCENT') ? rate : null,
        detail,
        warning,
        rule_type: rule.rule_type,
        rule_name: rule.name,
        rule_id: rule.id,
    };
};

const penaltyOverrideKey = (unitId, ruleId) => `${unitId}:${ruleId}`;

export const buildPenaltyPreview = ({
    unitIds,
    ruleIds,
    overrides = {},
    asOfDate = null,
    periodLabel = null,
    currentSubtotalsByUnit = {},
}) => {
    const asOf = asOfDate || new Date().toISOString().slice(0, 10);
    const rules = getPenaltyRules().filter((r) => ruleIds.includes(r.id));
    const units = portalState.units
        .filter((u) => unitIds.includes(u.id))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

    const rows = units.map((unit) => {
        const overdueBalance = getOverdueBalanceForUnit(unit.id, asOf, periodLabel);
        const daysOverdue = getMaxDaysOverdueForUnit(unit.id, asOf, periodLabel);
        const currentInvoiceSubtotal = currentSubtotalsByUnit[unit.id] || 0;

        const ctx = { overdueBalance, daysOverdue, currentInvoiceSubtotal, asOfDate: asOf };
        const penalties = rules.map((rule) => {
            const computed = computePenaltyAmount(rule, ctx);
            const key = penaltyOverrideKey(unit.id, rule.id);
            const ov = overrides[key];
            if (ov != null && !isNaN(parseFloat(ov))) {
                computed.amount = roundMoney(Math.max(0, parseFloat(ov)));
                computed.warning = null;
            }
            return { rule, ...computed };
        });

        const penaltyTotal = roundMoney(penalties.reduce((s, p) => s + p.amount, 0));
        return {
            unit,
            penalties,
            penaltyTotal,
            overdueBalance,
            daysOverdue,
        };
    });

    const grandPenalty = roundMoney(rows.reduce((s, r) => s + r.penaltyTotal, 0));
    return { rows, rules, grandPenalty };
};

export async function savePenaltyRule(payload) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Rule name is required.');
    if (!RULE_TYPES[payload.rule_type]) throw new Error('Invalid rule type.');

    const row = {
        id: payload.id || crypto.randomUUID(),
        apartment_id,
        name,
        rule_type: payload.rule_type,
        rate: parseFloat(payload.rate) || 0,
        flat_amount: parseFloat(payload.flat_amount) || 0,
        grace_days: parseInt(payload.grace_days, 10) || 0,
        max_amount: payload.max_amount === '' || payload.max_amount == null ? null : parseFloat(payload.max_amount),
        min_amount: payload.min_amount === '' || payload.min_amount == null ? null : parseFloat(payload.min_amount),
        target: payload.target || 'PRIOR_OVERDUE',
        sort_order: parseInt(payload.sort_order, 10) || 0,
        is_active: payload.is_active !== false,
        notes: payload.notes?.trim() || null,
    };

    const { error } = await supabase.from('maintenance_penalty_rules').upsert(row);
    if (error) throw new Error(error.message);
    await pullState();
}

export async function deletePenaltyRule(id) {
    if (!supabase) return;
    if (!confirm('Delete this penalty rule?')) return;
    const { error } = await supabase.from('maintenance_penalty_rules').delete().eq('id', id);
    if (error) return alert(error.message);
    await pullState();
}

export async function seedDefaultPenaltyRules() {
    if (!supabase) return;
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return;
    if (getAllPenaltyRules().length) return;

    const defaults = [
        { name: 'Late payment fee', rule_type: 'FLAT_AFTER_GRACE', flat_amount: 500, grace_days: 15, sort_order: 1 },
        { name: 'Interest on overdue', rule_type: 'PERCENT_PER_MONTH', rate: 1.5, grace_days: 0, sort_order: 2 },
        { name: 'Daily late charge', rule_type: 'PERCENT_PER_DAY', rate: 0.05, grace_days: 7, sort_order: 3 },
        { name: 'Penalty (% of due)', rule_type: 'PERCENT_OF_DUE', rate: 2, grace_days: 0, sort_order: 4 },
    ];
    for (const d of defaults) {
        await savePenaltyRule({ ...d, target: 'PRIOR_OVERDUE' });
    }
}

export const renderPenaltyRulesList = () => {
    const container = document.getElementById('penalty-rules-list');
    if (!container) return;

    const rules = getAllPenaltyRules();
    if (!rules.length) {
        container.innerHTML = '<p class="maintenance-alloc-hint">No penalty rules yet. Add one or load suggested defaults.</p>';
        return;
    }

    container.innerHTML = rules.map((r) => {
        const meta = RULE_TYPES[r.rule_type] || {};
        let param = '';
        if (meta.showFlat) param = `₹${parseFloat(r.flat_amount || 0).toLocaleString('en-IN')}`;
        else if (meta.showRate) param = `${parseFloat(r.rate || 0)}%`;
        const grace = r.grace_days ? ` · ${r.grace_days}d grace` : '';
        return `<div class="charge-head-row ${r.is_active === false ? 'charge-head-row--inactive' : ''}">
          <div class="charge-head-row__main">
            <strong>${r.name}</strong>
            <span class="charge-head-row__meta">${ruleTypeLabel(r.rule_type)} · ${param}${grace} · ${TARGETS[r.target] || r.target}</span>
            ${r.notes ? `<span class="charge-head-row__notes">${r.notes}</span>` : ''}
          </div>
          <div class="charge-head-row__actions">
            <button type="button" class="btn btn-outline btn--small" data-edit-penalty="${r.id}"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="btn btn-outline btn--small" style="color:var(--danger);" data-del-penalty="${r.id}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-edit-penalty]').forEach((btn) => {
        btn.addEventListener('click', () => openPenaltyRuleEditor(btn.dataset.editPenalty));
    });
    container.querySelectorAll('[data-del-penalty]').forEach((btn) => {
        btn.addEventListener('click', () => deletePenaltyRule(btn.dataset.delPenalty).then(() => {
            renderPenaltyRulesList();
            refreshBulkPenaltyRules();
        }));
    });
};

const openPenaltyRuleEditor = (ruleId = null) => {
    const form = document.getElementById('penalty-rule-form');
    if (!form) return;
    form.reset();
    form.dataset.ruleId = ruleId || '';

    const rule = ruleId ? getAllPenaltyRules().find((r) => r.id === ruleId) : null;
    document.getElementById('penalty-rule-editor-title').textContent = rule ? `Edit — ${rule.name}` : 'Add penalty rule';

    if (rule) {
        document.getElementById('penalty-rule-name').value = rule.name;
        document.getElementById('penalty-rule-type').value = rule.rule_type;
        document.getElementById('penalty-rule-rate').value = rule.rate ?? '';
        document.getElementById('penalty-rule-flat').value = rule.flat_amount ?? '';
        document.getElementById('penalty-rule-grace').value = rule.grace_days ?? 0;
        document.getElementById('penalty-rule-max').value = rule.max_amount ?? '';
        document.getElementById('penalty-rule-min').value = rule.min_amount ?? '';
        document.getElementById('penalty-rule-target').value = rule.target || 'PRIOR_OVERDUE';
        document.getElementById('penalty-rule-sort').value = rule.sort_order || 0;
        document.getElementById('penalty-rule-notes').value = rule.notes || '';
        document.getElementById('penalty-rule-active').checked = rule.is_active !== false;
    }

    syncPenaltyRuleFormFields();
    document.getElementById('penalty-rule-editor-panel')?.removeAttribute('hidden');
};

export const closePenaltyRuleEditor = () => {
    document.getElementById('penalty-rule-editor-panel')?.setAttribute('hidden', '');
};

const syncPenaltyRuleFormFields = () => {
    const type = document.getElementById('penalty-rule-type')?.value || 'FLAT';
    const meta = RULE_TYPES[type] || RULE_TYPES.FLAT;
    const rateWrap = document.getElementById('penalty-rule-rate-wrap');
    const flatWrap = document.getElementById('penalty-rule-flat-wrap');
    const graceWrap = document.getElementById('penalty-rule-grace-wrap');
    const rateLabel = document.getElementById('penalty-rule-rate-label');
    if (rateWrap) rateWrap.hidden = !meta.showRate;
    if (flatWrap) flatWrap.hidden = !meta.showFlat;
    if (graceWrap) graceWrap.hidden = !meta.showGrace;
    if (rateLabel && meta.rateLabel) rateLabel.textContent = meta.rateLabel;
};

export const openPenaltyRulesModal = async () => {
    if (!getAllPenaltyRules().length) await seedDefaultPenaltyRules().catch(() => {});
    renderPenaltyRulesList();
    closePenaltyRuleEditor();
    document.getElementById('penalty-rules-modal')?.classList.add('active');
};

export const closePenaltyRulesModal = () => {
    document.getElementById('penalty-rules-modal')?.classList.remove('active');
    refreshBulkPenaltyRules();
};

export const refreshBulkPenaltyRules = () => {
    const container = document.getElementById('bulk-invoice-penalties');
    if (!container) return;

    const rules = getPenaltyRules();
    if (!rules.length) {
        container.innerHTML = `<p class="maintenance-alloc-hint">No penalty rules.
          <button type="button" class="btn btn-outline btn--small" id="bulk-open-penalties-inline">Set up rules</button></p>`;
        document.getElementById('bulk-open-penalties-inline')?.addEventListener('click', openPenaltyRulesModal);
        return;
    }

    container.innerHTML = rules.map((r) => {
        const meta = RULE_TYPES[r.rule_type] || {};
        const param = meta.showFlat
            ? `₹${parseFloat(r.flat_amount || 0).toLocaleString('en-IN')}`
            : `${parseFloat(r.rate || 0)}%`;
        return `<label class="bulk-head-check bulk-penalty-check">
          <input type="checkbox" class="bulk-penalty-checkbox" value="${r.id}" />
          <span class="bulk-head-check__body">
            <strong>${r.name}</strong>
            <span>${meta.label} · ${param}${r.grace_days ? ` · ${r.grace_days}d grace` : ''}</span>
          </span>
        </label>`;
    }).join('');

    container.querySelectorAll('.bulk-penalty-checkbox').forEach((el) => {
        el.addEventListener('change', () => window.refreshBulkInvoicePreview?.());
    });
};

export const getSelectedBulkPenaltyRuleIds = () =>
    [...document.querySelectorAll('.bulk-penalty-checkbox:checked')].map((el) => el.value);

export const setBulkPenaltyCheckboxes = (ruleIds) => {
    document.querySelectorAll('.bulk-penalty-checkbox').forEach((el) => {
        el.checked = ruleIds.includes(el.value);
    });
};

export const initPenaltyRulesUi = () => {
    document.getElementById('penalty-rule-type')?.addEventListener('change', syncPenaltyRuleFormFields);

    document.getElementById('penalty-rule-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('penalty-rule-save-btn');
        await withButtonBusy(btn, 'Saving…', async () => {
            await savePenaltyRule({
                id: document.getElementById('penalty-rule-form')?.dataset.ruleId || null,
                name: document.getElementById('penalty-rule-name')?.value,
                rule_type: document.getElementById('penalty-rule-type')?.value,
                rate: document.getElementById('penalty-rule-rate')?.value,
                flat_amount: document.getElementById('penalty-rule-flat')?.value,
                grace_days: document.getElementById('penalty-rule-grace')?.value,
                max_amount: document.getElementById('penalty-rule-max')?.value,
                min_amount: document.getElementById('penalty-rule-min')?.value,
                target: document.getElementById('penalty-rule-target')?.value,
                sort_order: document.getElementById('penalty-rule-sort')?.value,
                notes: document.getElementById('penalty-rule-notes')?.value,
                is_active: document.getElementById('penalty-rule-active')?.checked,
            });
            closePenaltyRuleEditor();
            renderPenaltyRulesList();
            refreshBulkPenaltyRules();
        }).catch((err) => alert(err?.message || 'Could not save rule.'));
    });

    document.getElementById('penalty-rule-add-btn')?.addEventListener('click', () => openPenaltyRuleEditor());
    document.getElementById('penalty-rule-seed-btn')?.addEventListener('click', async () => {
        try {
            await seedDefaultPenaltyRules();
            renderPenaltyRulesList();
            refreshBulkPenaltyRules();
        } catch (err) {
            alert(err?.message || 'Could not load defaults.');
        }
    });
    document.getElementById('penalty-rule-cancel-btn')?.addEventListener('click', closePenaltyRuleEditor);
    document.getElementById('penalty-rules-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'penalty-rules-modal') closePenaltyRulesModal();
    });
};

window.openPenaltyRulesModal = openPenaltyRulesModal;
window.closePenaltyRulesModal = closePenaltyRulesModal;
