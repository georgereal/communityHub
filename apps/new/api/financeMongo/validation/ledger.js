/**
 * Ledger mutation payload validation / normalization.
 */
import { badRequest } from '../errors.js';
import { dayKey, roundMoney } from '../money.js';

const LEDGER_TYPES = new Set(['IN', 'OUT']);
const LEDGER_WALLETS = new Set(['CASH', 'BANK']);

/**
 * Normalize + validate saveTransaction / saveLedgerEntry body.
 * Strips client attempts to set apartment_id / overwrite identity incorrectly.
 */
export function normalizeLedgerSaveBody(body = {}) {
    const raw = body.transaction && typeof body.transaction === 'object'
        ? body.transaction
        : {};
    const txn = { ...raw };

    delete txn.apartment_id;
    if (txn._id != null && txn.id != null && String(txn._id) !== String(txn.id)) {
        throw badRequest('transaction.id and transaction._id must match.', 'ledger_id_mismatch');
    }

    const type = String(txn.type || '').toUpperCase();
    if (!LEDGER_TYPES.has(type)) {
        throw badRequest('transaction.type must be IN or OUT.', 'ledger_type');
    }

    const walletRaw = txn.wallet == null || txn.wallet === ''
        ? 'CASH'
        : String(txn.wallet).toUpperCase();
    if (!LEDGER_WALLETS.has(walletRaw)) {
        throw badRequest('transaction.wallet must be CASH or BANK.', 'ledger_wallet');
    }

    const amount = roundMoney(txn.amount);
    if (!(amount > 0) || !Number.isFinite(amount)) {
        throw badRequest('Enter a valid amount greater than zero.', 'ledger_amount');
    }

    const date = dayKey(txn.date);
    if (!date) {
        throw badRequest('transaction.date is required (YYYY-MM-DD).', 'ledger_date');
    }

    const cat = String(txn.cat ?? '').trim();
    if (!cat) {
        throw badRequest('transaction.cat is required.', 'ledger_cat');
    }

    txn.type = type;
    txn.wallet = walletRaw;
    txn.amount = amount;
    txn.date = date;
    txn.cat = cat;

    return {
        ...body,
        transaction: txn,
    };
}

export function normalizeLedgerDeleteBody(body = {}) {
    const id = body.transaction_id || body.id;
    if (!id) {
        throw badRequest('transaction_id is required.', 'ledger_delete_id');
    }
    return {
        ...body,
        transaction_id: String(id),
        id: String(id),
    };
}

export function normalizeLedgerBulkDeleteBody(body = {}) {
    const ids = body.transaction_ids || body.ids || [];
    if (!Array.isArray(ids) || !ids.length) {
        throw badRequest('transaction_ids must be a non-empty array.', 'ledger_bulk_delete');
    }
    const cleaned = ids.map((id) => String(id)).filter(Boolean);
    if (!cleaned.length) {
        throw badRequest('transaction_ids must be a non-empty array.', 'ledger_bulk_delete');
    }
    return {
        ...body,
        transaction_ids: cleaned,
        ids: cleaned,
    };
}
