/**
 * Phase 3.2 — Payment intents (test-mode pay without Edge Functions)
 */
import { portalState, supabase, pullState } from './store.js';
import { invoiceBalance, getUnitLabel } from './maintenanceBilling.js';
import { logActivity } from './activityAudit.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

export const isTestPaymentMode = () =>
    !portalState.portal?.paymentConfig || portalState.portal.paymentConfig.test_mode !== false;

export async function createPaymentIntent(invoiceId) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error('Invoice not found.');
    const amount = invoiceBalance(inv);
    if (amount <= 0.001) throw new Error('Invoice is already paid.');

    const gateway = portalState.portal?.paymentConfig?.gateway || 'TEST';
    const intentId = crypto.randomUUID();
    const { error } = await supabase.from('payment_intents').insert({
        id: intentId,
        apartment_id,
        invoice_id: invoiceId,
        gateway: gateway === 'RAZORPAY' || gateway === 'CASHFREE' ? gateway : 'TEST',
        gateway_order_id: `test_${intentId.slice(0, 8)}`,
        amount,
        status: 'PENDING',
        metadata: { mode: 'test' },
    });
    if (error) throw new Error(error.message);
    await pullState();
    return intentId;
}

export async function completeTestPayment(intentId) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    const intent = (portalState.portal?.paymentIntents || []).find((p) => p.id === intentId);
    if (!intent) throw new Error('Payment intent not found.');
    if (intent.status === 'PAID') return { ok: true, duplicate: true };

    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === intent.invoice_id);
    if (!inv) throw new Error('Invoice not found.');
    const amount = parseFloat(intent.amount);
    const txnId = crypto.randomUUID();
    const date = new Date().toISOString();

    const { error: txnErr } = await supabase.from('transactions').insert({
        id: txnId,
        apartment_id,
        amount,
        cat: 'Maintenance Collection',
        description: `Online payment — ${inv.period_label || 'invoice'} (${getUnitLabel(inv.unit_id)})`,
        wallet: 'BANK',
        type: 'IN',
        date,
        bank_payment_type: 'UPI',
        bank_reference: intent.gateway_order_id || intentId,
    });
    if (txnErr) throw new Error(txnErr.message);

    const { error: allocErr } = await supabase.from('maintenance_payment_allocations').insert({
        id: crypto.randomUUID(),
        apartment_id,
        transaction_id: txnId,
        invoice_id: intent.invoice_id,
        amount,
    });
    if (allocErr && !/maintenance_payment_allocations/i.test(allocErr.message)) {
        throw new Error(allocErr.message);
    }

    const { error: intentErr } = await supabase.from('payment_intents').update({
        status: 'PAID',
        paid_at: date,
    }).eq('id', intentId);
    if (intentErr) throw new Error(intentErr.message);

    await logActivity({
        entityType: 'PAYMENT_INTENT',
        entityId: intentId,
        action: 'PAID',
        summary: `Test payment ${formatMoney(amount)} for ${inv.period_label}`,
        newData: { intent_id: intentId, transaction_id: txnId, invoice_id: intent.invoice_id },
    });

    await pullState();
    return { ok: true };
}

export async function portalPayInvoice(invoiceId) {
    if (!isTestPaymentMode()) {
        return alert('Live gateway checkout requires Edge Functions (Phase 3.2 backend). Use test mode for now.');
    }
    try {
        const intentId = await createPaymentIntent(invoiceId);
        if (!confirm('Complete test payment? This will record a bank receipt and mark the invoice paid.')) return;
        await completeTestPayment(intentId);
        alert('Payment recorded successfully.');
        const { renderPortalHome, renderPortalInvoices } = await import('./residentPortal.js');
        const active = document.querySelector('.portal-subview:not([hidden])')?.id?.replace('portal-subview-', '');
        if (active === 'invoices') await renderPortalInvoices();
        else if (active === 'payments') await renderPortalPayments();
        else await renderPortalHome();
        if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();
    } catch (err) {
        alert(err?.message || 'Payment failed.');
    }
}

export const renderPortalPayments = async () => {
    const el = document.getElementById('portal-subview-payments');
    if (!el) return;
    const uid = portalState.auth?.id;
    const myUnitIds = new Set();
    const links = (portalState.portal?.residentLinks || []).filter((l) => l.user_id === uid);
    const { loadResidents } = await import('./residents.js');
    const residents = await loadResidents();
    links.forEach((link) => {
        const r = residents.find((x) => x.id === link.resident_id);
        const unit = portalState.units.find((u) => u.number === r?.unit_number);
        if (unit) myUnitIds.add(unit.id);
    });

    const intents = (portalState.portal?.paymentIntents || []).filter((p) => {
        const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === p.invoice_id);
        return inv && myUnitIds.has(inv.unit_id);
    });

    if (!intents.length) {
        el.innerHTML = '<p class="portal-empty">No payment history yet.</p>';
        return;
    }

    el.innerHTML = `<div class="portal-payment-list">
      ${intents.map((p) => {
        const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === p.invoice_id);
        return `<div class="portal-payment-row">
          <div><strong>${formatMoney(p.amount)}</strong> — ${inv?.period_label || 'Invoice'}</div>
          <div class="portal-payment-row__meta">
            <span class="portal-status portal-status--${p.status.toLowerCase()}">${p.status}</span>
            <span>${p.paid_at ? new Date(p.paid_at).toLocaleDateString('en-IN') : new Date(p.created_at).toLocaleDateString('en-IN')}</span>
            <span>${p.gateway}</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;
};

window.portalPayInvoice = portalPayInvoice;

export const initPayments = () => {};
