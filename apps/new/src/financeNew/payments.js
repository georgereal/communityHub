/** Finance-New clone (payments.js) — Mongo writes via mongoWrite. */
import { fnFinances, ensureFnClassicShape } from './classicState.js';
import { bindFinanceNewWindow } from './windowBridge.js';
import { portalState } from '../store.js';
import { pullState } from './pull.js';
import { mongoInsert, mongoUpdate } from './mongoWrite.js';
import { invoiceBalance, getUnitLabel } from './maintenanceBilling.js';
import { logActivity } from '../activityAudit.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

export const isTestPaymentMode = () =>
    !portalState.portal?.paymentConfig || portalState.portal.paymentConfig.test_mode !== false;

export async function createPaymentIntent(invoiceId) {
    const apartment_id = portalState.access?.activeApartmentId;
    const inv = fnFinances().maintenanceInvoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error('Invoice not found.');
    const amount = invoiceBalance(inv);
    if (amount <= 0.001) throw new Error('Invoice is already paid.');

    const gateway = portalState.portal?.paymentConfig?.gateway || 'TEST';
    const intentId = crypto.randomUUID();
    await mongoInsert('payment_intents', {
        id: intentId,
        apartment_id,
        invoice_id: invoiceId,
        gateway: gateway === 'RAZORPAY' || gateway === 'CASHFREE' ? gateway : 'TEST',
        gateway_order_id: `test_${intentId.slice(0, 8)}`,
        amount,
        status: 'PENDING',
        metadata: { mode: 'test' },
    });
    await pullState({ packs: ['billing', 'ledger'] });
    return intentId;
}

export async function completeTestPayment(intentId) {
    const apartment_id = portalState.access?.activeApartmentId;
    const intent = (portalState.portal?.paymentIntents || []).find((p) => p.id === intentId);
    if (!intent) throw new Error('Payment intent not found.');
    if (intent.status === 'PAID') return { ok: true, duplicate: true };

    const inv = fnFinances().maintenanceInvoices.find((i) => i.id === intent.invoice_id);
    if (!inv) throw new Error('Invoice not found.');
    const amount = parseFloat(intent.amount);
    const txnId = crypto.randomUUID();
    const date = new Date().toISOString();

    await mongoInsert('transactions', {
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
    }, { rehydrate: false });

    await mongoInsert('maintenance_payment_allocations', {
        id: crypto.randomUUID(),
        apartment_id,
        transaction_id: txnId,
        invoice_id: intent.invoice_id,
        amount,
    }, { rehydrate: false });

    await mongoUpdate('payment_intents', { id: intentId }, {
        status: 'PAID',
        paid_at: date,
    });

    await logActivity({
        entityType: 'PAYMENT_INTENT',
        entityId: intentId,
        action: 'PAID',
        summary: `Test payment ${formatMoney(amount)} for ${inv.period_label}`,
        newData: { intent_id: intentId, transaction_id: txnId, invoice_id: intent.invoice_id },
    });

    await pullState({ packs: ['billing', 'ledger'] });
    return { ok: true };
}

export async function portalPayInvoice(invoiceId) {
    if (!isTestPaymentMode()) {
        throw new Error('Live payment gateways are not configured for Finance-New yet.');
    }
    const intentId = await createPaymentIntent(invoiceId);
    return completeTestPayment(intentId);
}

export function initPayments() {
    ensureFnClassicShape();
    bindFinanceNewWindow('portalPayInvoice', portalPayInvoice);
    bindFinanceNewWindow('completeTestPayment', completeTestPayment);
}
