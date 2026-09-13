/**
 * Finance-New mutation client — REST via postFinanceMongoMutation, then scoped pack reload.
 */
import { portalState } from '../store.js';
import { applyMongoPacksToClassic, fnFinances } from './classicState.js';
import { postFinanceMongo, postFinanceMongoMutation } from './api.js';
import { getFinanceNew } from './state.js';
import { reloadFinancePacks } from './load.js';
import { mergeVoucherAggregatesIntoStore } from './voucherStore.js';

export { filesToBase64Payload, fileToBase64Payload } from '../financeApi.js';
export { postFinanceMongoMutation } from './api.js';

/** Which Mongo packs to reload after a successful mutation. */
const MUTATION_PACKS = {
    saveTransaction: ['ledger'],
    saveLedgerEntry: ['ledger'],
    deleteTransaction: ['ledger'],
    deleteLedgerEntry: ['ledger'],
    deleteTransactions: ['ledger'],
    bulkUpdateTransactions: ['ledger'],
    setLedgerExclusion: ['ledger'],
    returnLedgerTxnToStatement: ['ledger', 'bank'],
    recalculateLedgerBalances: ['ledger', 'boot'],

    saveFinanceDocument: ['vouchers', 'voucherAggregates'],
    saveVoucher: ['vouchers', 'voucherAggregates'],
    deleteFinanceDocument: ['vouchers', 'voucherAggregates'],
    deleteVoucher: ['vouchers', 'voucherAggregates'],
    importFinanceDocuments: ['vouchers', 'voucherAggregates'],
    linkFinanceDocuments: ['vouchers', 'voucherAggregates', 'ledger'],
    unlinkFinanceDocuments: ['vouchers', 'voucherAggregates', 'ledger'],
    syncFinanceDocumentCategories: ['vouchers', 'voucherAggregates'],

    setCashFloatFlag: ['ledger', 'voucherAggregates'],
    saveCashFloatOpening: ['boot'],

    importBankStatement: ['bank'],
    saveBankOpeningBalance: ['boot', 'bank'],
    clearBankStatementData: ['bank'],
    reorderBankStatementLines: ['bank'],
    recalculateBankStatementBalances: ['bank'],
    unmatchBankLines: ['bank', 'ledger'],
    deleteBankStatementLines: ['bank'],
    createTxnsFromBankLines: ['bank', 'ledger', 'boot'],
    matchBankLine: ['bank', 'ledger'],
    unmatchBankLine: ['bank', 'ledger'],
    ignoreBankLine: ['bank'],
    updateBankStatementLine: ['bank'],
    createTxnFromBankLine: ['bank', 'ledger', 'boot'],
    createLedgerFromBankLineAuto: ['bank', 'ledger', 'boot'],
    createTxnsFromBankLines: ['bank', 'ledger', 'boot'],

    saveBankClassificationRule: ['boot'],
    deleteBankClassificationRule: ['boot'],

    saveExpensePlanItem: ['boot'],
    deleteExpensePlanItem: ['boot'],
    completeExpensePlanItem: ['boot'],
    deferExpensePlanItems: ['boot'],
    saveExpensePlanRecurring: ['boot'],
    deleteExpensePlanRecurring: ['boot'],

    patchFinanceConfig: ['boot'],
    // tableWrite: caller (mongoWrite) reloads the specific table pack
};

const READ_ACTIONS = new Set([
    'listBankClassificationRules',
    'previewBankClassificationRules',
    'listFinanceDocuments',
    'financeDocumentsAggregates',
]);

export async function postFnMutation(action, payload = {}) {
    const apartment_id = payload.apartment_id || portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    if (action === 'listFinanceDocuments') {
        const json = await postFinanceMongo('listVouchers', {
            limit: payload.limit ?? 50,
            offset: payload.offset ?? 0,
            kind: payload.kind || 'all',
            status: payload.status || 'all',
            q: payload.q || '',
            pay: payload.pay || 'all',
            ids: payload.ids || payload.document_ids,
            transaction_ids: payload.transaction_ids || payload.transactionIds,
        });
        const rows = (json.rows || json.documents || []).map((v) => {
            const { ledgerEntryId, _schema, _remodeledAt, _id, ...rest } = v;
            return {
                ...rest,
                id: rest.id || _id,
                transaction_id: rest.transaction_id || ledgerEntryId || null,
            };
        });
        // Merge page into store — do not replace the full working set.
        const list = fnFinances().financeDocuments || (fnFinances().financeDocuments = []);
        for (const doc of rows) {
            if (!doc?.id) continue;
            const idx = list.findIndex((d) => String(d.id) === String(doc.id));
            if (idx >= 0) list[idx] = doc;
            else list.push(doc);
        }
        getFinanceNew().vouchersTotal = Number(json.total) || 0;
        return {
            ok: true,
            documents: rows,
            rows,
            total: json.total,
            offset: json.offset,
            limit: json.limit,
            hasMore: json.hasMore ?? (json.offset + rows.length < json.total),
        };
    }

    if (action === 'financeDocumentsAggregates') {
        const json = await postFinanceMongo('voucherAggregates');
        mergeVoucherAggregatesIntoStore(json);
        return { ok: true, ...json };
    }

    const json = await postFinanceMongoMutation(action, { ...payload, apartment_id });

    if (!READ_ACTIONS.has(action)) {
        const packs = MUTATION_PACKS[action];
        if (packs?.length) {
            await reloadFinancePacks(packs, { force: true });
        }
    }

    if (json.config) {
        getFinanceNew().config = json.config;
        applyMongoPacksToClassic({ config: json.config });
    }
    if (json.ledgerBalance) {
        const s = getFinanceNew();
        s.config = { ...(s.config || {}), ledgerBalance: json.ledgerBalance };
    }
    if (json.transaction && !fnFinances().txns.find((t) => String(t.id) === String(json.transaction.id))) {
        fnFinances().txns.unshift(json.transaction);
    }
    if (json.rules && action === 'listBankClassificationRules') {
        fnFinances().bankClassificationRules = json.rules;
    }
    return json;
}
