/**
 * Move-in / move-out transition charges — invoice + optional payment
 */
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';
import { getUnitLabel, applyFlatCreditToOpenInvoices } from './maintenanceBilling.js';

const FEE_DEFAULTS = {
    'owner-move-in': 0,
    'tenant-move-in': 5000,
    'owner-move-out': 3000,
    'tenant-move-out': 3000,
};

const FEE_LABELS = {
    'owner-move-in': 'Owner move-in charges',
    'tenant-move-in': 'Tenant move-in charges',
    'owner-move-out': 'Owner move-out charges',
    'tenant-move-out': 'Tenant move-out charges',
};

const storageKey = () => `transition_fees_${portalState.access?.activeApartmentId || ''}`;

export const getTransitionFeeDefault = (actionKey) => {
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey()) || '{}');
        if (stored[actionKey] != null) return Math.max(0, parseFloat(stored[actionKey]) || 0);
    } catch { /* ignore */ }
    return FEE_DEFAULTS[actionKey] ?? 0;
};

export const saveTransitionFeeDefault = (actionKey, amount) => {
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey()) || '{}');
        stored[actionKey] = Math.max(0, parseFloat(amount) || 0);
        localStorage.setItem(storageKey(), JSON.stringify(stored));
    } catch { /* ignore */ }
};

export const getTransitionFeeLabel = (actionKey) => FEE_LABELS[actionKey] || 'Transition charges';

export function renderTransitionChargesSection(actionKey) {
    const defaultAmt = getTransitionFeeDefault(actionKey);
    const label = getTransitionFeeLabel(actionKey);
    const checked = defaultAmt > 0 ? 'checked' : '';

    return `
      <div class="occ-charges-inner">
        <div class="occ-charges-inner__head">
          <span class="occ-finances-block__title">Move charges</span>
          <label class="occ-charges-apply">
            <input type="checkbox" id="transition-fee-apply" ${checked} />
            <span>Apply ${label.toLowerCase()}</span>
          </label>
        </div>
        <div id="transition-fee-fields" class="occ-charges-fields">
          <div class="occ-charges-amount-row">
            <label class="resident-link-label" for="transition-fee-amount">Amount (₹)</label>
            <input type="number" id="transition-fee-amount" class="resident-link-field occ-charges-amount" min="0" step="0.01"
              value="${defaultAmt > 0 ? defaultAmt.toFixed(2) : ''}" placeholder="0" inputmode="decimal" />
          </div>
          <fieldset class="occ-charges-settle">
            <legend class="resident-link-label">How to bill</legend>
            <label class="occ-charges-radio">
              <input type="radio" name="transition-fee-settle" value="paid" checked />
              <span>Record payment now</span>
            </label>
            <label class="occ-charges-radio">
              <input type="radio" name="transition-fee-settle" value="invoice" />
              <span>Raise invoice only — collect later</span>
            </label>
          </fieldset>
          <div id="transition-fee-payment-panel" class="occ-charges-payment">
            <label class="resident-link-label">Payment via</label>
            <div class="occ-charges-wallets">
              <button type="button" class="occ-charges-wallet active" data-wallet="CASH">Cash</button>
              <button type="button" class="occ-charges-wallet" data-wallet="BANK">Bank</button>
            </div>
            <input type="text" id="transition-fee-bank-ref" class="resident-link-field" placeholder="Reference (cheque / UPI / NEFT)" />
          </div>
        </div>
      </div>`;
}

export function bindTransitionChargesHandlers(formEl, actionKey) {
    if (!formEl) return;

    const applyCb = formEl.querySelector('#transition-fee-apply');
    const fields = formEl.querySelector('#transition-fee-fields');
    const amountEl = formEl.querySelector('#transition-fee-amount');
    const paymentPanel = formEl.querySelector('#transition-fee-payment-panel');

    const syncFields = () => {
        const on = applyCb?.checked;
        if (fields) fields.hidden = !on;
    };

    const syncPaymentPanel = () => {
        const settle = formEl.querySelector('input[name="transition-fee-settle"]:checked')?.value;
        if (paymentPanel) paymentPanel.hidden = settle !== 'paid';
    };

    applyCb?.addEventListener('change', syncFields);
    formEl.querySelectorAll('input[name="transition-fee-settle"]').forEach((el) => {
        el.addEventListener('change', syncPaymentPanel);
    });

    formEl.querySelectorAll('.occ-charges-wallet').forEach((btn) => {
        btn.addEventListener('click', () => {
            formEl.querySelectorAll('.occ-charges-wallet').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    amountEl?.addEventListener('blur', () => {
        if (applyCb?.checked) saveTransitionFeeDefault(actionKey, amountEl.value);
    });

    syncFields();
    syncPaymentPanel();
}

export function collectTransitionFeeFromForm() {
    const wrap = document.getElementById('transition-charges-wrap');
    if (!wrap || wrap.hidden) return { apply: false };

    const applyCb = document.getElementById('transition-fee-apply');
    const amount = parseFloat(document.getElementById('transition-fee-amount')?.value) || 0;
    const apply = applyCb?.checked && amount > 0.001;
    if (!apply) return { apply: false };

    const settle = document.querySelector('input[name="transition-fee-settle"]:checked')?.value || 'paid';
    const walletBtn = document.querySelector('.occ-charges-wallet.active');
    return {
        apply: true,
        amount,
        settle,
        wallet: walletBtn?.dataset.wallet || 'CASH',
        bank_reference: document.getElementById('transition-fee-bank-ref')?.value?.trim() || null,
    };
}

export async function createTransitionFeeInvoice({
    unitId,
    transitionType,
    partyKind,
    amount,
    transitionId,
    actionKey,
}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return null;

    const partyLabel = partyKind === 'OWNER' ? 'Owner' : 'Tenant';
    const typeLabel = transitionType === 'MOVE_IN' ? 'Move-in' : 'Move-out';
    const headName = getTransitionFeeLabel(actionKey);
    const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    let period_label = `${typeLabel} fee (${partyLabel}) — ${dateStr}`;

    const clash = (portalState.finances.maintenanceInvoices || []).some(
        (i) => i.unit_id === unitId && i.period_label === period_label,
    );
    if (clash) period_label += ` · ${String(transitionId).slice(0, 8)}`;

    const invoice_id = crypto.randomUUID();
    const lineId = crypto.randomUUID();
    const dueDate = new Date().toISOString().slice(0, 10);

    const { error: invErr } = await supabase.from('maintenance_invoices').insert({
        id: invoice_id,
        apartment_id,
        unit_id: unitId,
        period_label,
        due_date: dueDate,
        amount: amt,
        notes: `Transition ${transitionId}`,
    });
    if (invErr) throw new Error(invErr.message);

    const { error: lineErr } = await supabase.from('maintenance_invoice_lines').insert({
        id: lineId,
        apartment_id,
        invoice_id,
        head_id: null,
        head_name: headName,
        calc_type: 'TRANSITION_FEE',
        quantity: 1,
        rate: amt,
        amount: amt,
        sort_order: 1,
    });
    if (lineErr && !/maintenance_invoice_lines/i.test(lineErr.message)) {
        throw new Error(lineErr.message);
    }

    return { invoice_id, line_id: lineId, amount: amt, period_label };
}

export async function recordTransitionFeePayment({
    invoiceId,
    amount,
    unitId,
    periodLabel,
    wallet = 'CASH',
    bankReference = null,
}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    const amt = parseFloat(amount);
    const txnId = crypto.randomUUID();
    const date = new Date().toISOString();
    const flat = getUnitLabel(unitId);

    const { error: txnErr } = await supabase.from('transactions').insert({
        id: txnId,
        apartment_id,
        amount: amt,
        cat: 'Maintenance Collection',
        description: `Transition fee — ${periodLabel} (${flat})`,
        wallet,
        type: 'IN',
        date,
        bank_payment_type: wallet === 'BANK' ? 'UPI' : null,
        bank_reference: wallet === 'BANK' ? bankReference : null,
    });
    if (txnErr) throw new Error(txnErr.message);

    const { error: allocErr } = await supabase.from('maintenance_payment_allocations').insert({
        id: crypto.randomUUID(),
        apartment_id,
        transaction_id: txnId,
        invoice_id: invoiceId,
        amount: amt,
    });
    if (allocErr && !/maintenance_payment_allocations/i.test(allocErr.message)) {
        throw new Error(allocErr.message);
    }

    await logActivity({
        entityType: 'ALLOCATION',
        entityId: txnId,
        action: 'CREATE',
        summary: `Transition fee payment ${flat} — ${periodLabel}`,
        newData: { transaction_id: txnId, invoice_id: invoiceId, amount: amt },
    });

    return { transaction_id: txnId };
}

export async function applyTransitionFee({ unitId, transitionId, transitionType, partyKind, actionKey, fee }) {
    if (!fee?.apply || fee.amount <= 0.001) return null;

    const invoice = await createTransitionFeeInvoice({
        unitId,
        transitionType,
        partyKind,
        amount: fee.amount,
        transitionId,
        actionKey,
    });
    if (!invoice) return null;

    let payment = null;
    if (fee.settle === 'paid') {
        payment = await recordTransitionFeePayment({
            invoiceId: invoice.invoice_id,
            amount: fee.amount,
            unitId,
            periodLabel: invoice.period_label,
            wallet: fee.wallet || 'CASH',
            bankReference: fee.bank_reference,
        });
    }

    await pullState();

    if (fee.settle !== 'paid') {
        const apartment_id = portalState.access?.activeApartmentId;
        try {
            await applyFlatCreditToOpenInvoices(apartment_id, [unitId]);
            await pullState();
        } catch (err) {
            console.warn('Flat credit auto-apply failed:', err?.message || err);
        }
    }

    document.dispatchEvent(new CustomEvent('maintenance-payment-saved', {
        detail: { unitNumber: getUnitLabel(unitId), transitionFee: true },
    }));

    return {
        invoice_id: invoice.invoice_id,
        period_label: invoice.period_label,
        amount: invoice.amount,
        paid: fee.settle === 'paid',
        transaction_id: payment?.transaction_id || null,
    };
}
