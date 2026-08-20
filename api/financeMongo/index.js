/**
 * Finance Mongo domain facade — authoritative entry for /api/finance/* router.
 * Persistence still lives in finance-mongo*.js until further extraction.
 */
import { runFinanceMongoReport } from '../finance-mongo-reports.js';
import { runFinanceMongoMutation } from '../finance-mongo-mutations.js';
import {
    executeLedgerMutation,
    isLedgerMutationAction,
} from './services/ledgerMutations.js';
import { executeLedgerRead } from './services/ledgerReads.js';

export async function executeRead(action, ctx) {
    return executeLedgerRead(action, ctx);
}

export async function executeMutation(action, ctx) {
    if (isLedgerMutationAction(action)) {
        return executeLedgerMutation(action, ctx);
    }
    return runFinanceMongoMutation(action, ctx);
}

export async function executeReport(report, ctx) {
    return runFinanceMongoReport(report, ctx);
}

export { VIEW_PERMS, authorizeFinanceMongoMutation } from './permissions.js';
export { FinanceHttpError } from './errors.js';
