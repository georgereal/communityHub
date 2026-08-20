/**
 * Ledger mutations — validate then delegate to existing Mongo runners.
 */
import { runFinanceMongoMutation } from '../../finance-mongo-mutations.js';
import {
    normalizeLedgerBulkDeleteBody,
    normalizeLedgerDeleteBody,
    normalizeLedgerSaveBody,
} from '../validation/ledger.js';

const SAVE_ACTIONS = new Set(['saveTransaction', 'saveLedgerEntry']);
const DELETE_ACTIONS = new Set(['deleteTransaction', 'deleteLedgerEntry']);
const BULK_DELETE_ACTIONS = new Set(['deleteTransactions']);

export function isLedgerMutationAction(action) {
    return SAVE_ACTIONS.has(action)
        || DELETE_ACTIONS.has(action)
        || BULK_DELETE_ACTIONS.has(action);
}

export async function executeLedgerMutation(action, ctx) {
    let body = ctx.body || {};
    if (SAVE_ACTIONS.has(action)) {
        body = normalizeLedgerSaveBody(body);
    } else if (DELETE_ACTIONS.has(action)) {
        body = normalizeLedgerDeleteBody(body);
    } else if (BULK_DELETE_ACTIONS.has(action)) {
        body = normalizeLedgerBulkDeleteBody(body);
    }
    return runFinanceMongoMutation(action, { ...ctx, body });
}
