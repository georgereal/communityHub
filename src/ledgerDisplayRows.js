/**
 * Financial ledger row shape — shared by on-screen table, download export, and spreadsheet sync.
 */
import { annotateLedgerRunningBalances, getActiveLedgerTxns } from './ledgerBalance.js';
import { categoryDisplayLabel } from './expenseCategories.js';
import { formatTxnDetailPlain } from './finances.js';
import { getDefaultImportExpr, getDefaultExportExpr } from './ledgerTransform.js';
import { normalizeMapping } from './ledgerColumnMapping.js';

/** Ledger UI column headers (matches export + recommended sync sheet). */
export const LEDGER_UI_HEADERS = [
    'Date',
    'Description',
    'Debit (₹)',
    'Credit (₹)',
    'Calculated (₹)',
    'Type',
    'Category',
    'Sub-category',
    'Vendor',
    'Exclude from reports',
    'Wallet',
    'Reconciled',
    'Sync ID',
];

export const LEDGER_UI_COL = Object.freeze({
    date: 0,
    description: 1,
    debit_dr: 2,
    credit_cr: 3,
    calculated: 4,
    type: 5,
    cat: 6,
    sub_category: 7,
    vendor_name: 8,
    exclude_from_reports: 9,
    wallet: 10,
    reconciled: 11,
    external_sync_key: 12,
});

export const formatLedgerDisplayDate = (isoDate) => {
    if (!isoDate) return '';
    const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return String(isoDate || '');
    const [, year, month, day] = match;
    return `${day}-${month}-${year.slice(-2)}`;
};

const ledgerUiHeaderNorm = (h) => String(h || '').trim().toLowerCase().replace(/[₹()]/g, '');

/** Score how closely headers match the ledger UI layout (≥ 6 → treat as ledger UI sheet). */
export function detectLedgerUiHeaderScore(headersRaw = []) {
    const headers = (headersRaw || []).map(ledgerUiHeaderNorm);
    if (!headers.length) return 0;
    let score = 0;
    const has = (re) => headers.some((h) => re.test(h));
    if (has(/^date$/)) score += 2;
    if (has(/description|narration|particular/)) score += 2;
    if (has(/debit|dr/)) score += 2;
    if (has(/credit|cr/)) score += 2;
    if (has(/calculated|running|balance/)) score += 1;
    if (has(/^type$|income|expense/)) score += 1;
    if (has(/categor/)) score += 1;
    if (has(/sub.?categor/)) score += 1;
    if (has(/vendor|payee/)) score += 1;
    if (has(/exclude/)) score += 1;
    if (has(/wallet|ledger/)) score += 1;
    if (has(/reconcil/)) score += 1;
    if (has(/sync.?id|sync_id/)) score += 1;
    return score;
}

export function isLedgerUiMapping(mapping) {
    if (!mapping) return false;
    if (mapping.ledgerUiFormat) return true;
    const fields = mapping.fields;
    if (!fields) return false;
    return colMatches(fields, 'debit_dr', LEDGER_UI_COL.debit_dr)
        && colMatches(fields, 'credit_cr', LEDGER_UI_COL.credit_cr)
        && colMatches(fields, 'date', LEDGER_UI_COL.date);
}

function colMatches(fields, field, expected) {
    const cfg = fields[field];
    return cfg && cfg.excelCol === expected;
}

/** Column mapping for bidirectional sync using the ledger UI layout. */
export function buildLedgerUiSyncMapping() {
    const syncField = (key, excelCol, { importExpr, exportExpr, mode = 'sync' } = {}) => ({
        mode,
        excelCol,
        importExpr: importExpr ?? getDefaultImportExpr(key),
        exportExpr: exportExpr ?? getDefaultExportExpr(key),
    });

    const fields = {
        date: syncField('date', LEDGER_UI_COL.date, {
            importExpr: 'FORMAT_LEDGER_DATE({value})',
            exportExpr: 'FORMAT_LEDGER_DATE({value})',
        }),
        description: syncField('description', LEDGER_UI_COL.description),
        debit_dr: syncField('debit_dr', LEDGER_UI_COL.debit_dr, { mode: 'excel_import' }),
        credit_cr: syncField('credit_cr', LEDGER_UI_COL.credit_cr, { mode: 'excel_import' }),
        type: syncField('type', LEDGER_UI_COL.type, {
            importExpr: 'NORM_LEDGER_TYPE({value})',
            exportExpr: 'LEDGER_TYPE_LABEL({value})',
        }),
        cat: syncField('cat', LEDGER_UI_COL.cat, {
            importExpr: '{value}',
            exportExpr: 'LEDGER_CAT_LABEL({value})',
        }),
        sub_category: syncField('sub_category', LEDGER_UI_COL.sub_category),
        vendor_name: syncField('vendor_name', LEDGER_UI_COL.vendor_name),
        exclude_from_reports: syncField('exclude_from_reports', LEDGER_UI_COL.exclude_from_reports, {
            importExpr: 'YES_NO_BOOL({value})',
            exportExpr: 'YES_NO_LABEL({value})',
        }),
        wallet: syncField('wallet', LEDGER_UI_COL.wallet),
        external_sync_key: syncField('external_sync_key', LEDGER_UI_COL.external_sync_key),
        amount: syncField('amount', null, { mode: 'db_only' }),
    };

    return {
        v: 3,
        ledgerUiFormat: true,
        excelHeaders: [...LEDGER_UI_HEADERS],
        syncAnchorFields: ['date', 'type', 'amount', 'wallet'],
        fields,
    };
}

/** Pick ledger UI mapping when the sheet or saved settings indicate that layout. */
export function resolveSyncColumnMapping(settings, headersRaw = []) {
    const stored = settings?.column_mapping ? normalizeMapping(settings.column_mapping) : null;
    if (stored?.ledgerUiFormat || isLedgerUiMapping(stored)) return stored?.ledgerUiFormat ? stored : buildLedgerUiSyncMapping();
    if (detectLedgerUiHeaderScore(headersRaw) >= 6) return buildLedgerUiSyncMapping();
    if (stored && Object.values(stored.fields || {}).some((f) => f.excelCol != null && f.excelCol >= 0)) {
        return stored;
    }
    return buildLedgerUiSyncMapping();
}

/**
 * Active ledger rows in chronological order (for running balance), optionally filtered.
 * @param {object[]} txns
 * @param {{ reconciledIds?: Set<string> }} opts
 */
export function getLedgerSyncExportRows(txns, { reconciledIds = new Set() } = {}) {
    const running = annotateLedgerRunningBalances(txns);
    const sorted = [...getActiveLedgerTxns(txns)].sort((a, b) => {
        const byDate = String(a.date || '').localeCompare(String(b.date || ''));
        if (byDate) return byDate;
        return String(a.id || '').localeCompare(String(b.id || ''));
    });
    return sorted.map((t) => ({
        ...t,
        _ledgerComputedBalance: running.byId.get(t.id) ?? null,
        _reconciled: reconciledIds.has(t.id),
    }));
}

/** One Excel row matching the on-screen ledger table (dense array, columns A–M). */
export function txnToLedgerUiCells(txn) {
    const amt = parseFloat(txn.amount) || 0;
    const isBank = (txn.wallet || '').toUpperCase() === 'BANK';
    const row = new Array(LEDGER_UI_HEADERS.length).fill('');
    row[LEDGER_UI_COL.date] = formatLedgerDisplayDate(txn.date);
    row[LEDGER_UI_COL.description] = formatTxnDetailPlain(txn);
    row[LEDGER_UI_COL.debit_dr] = txn.type === 'OUT' ? amt : '';
    row[LEDGER_UI_COL.credit_cr] = txn.type === 'IN' ? amt : '';
    row[LEDGER_UI_COL.calculated] = isBank && txn._ledgerComputedBalance != null
        ? txn._ledgerComputedBalance
        : '';
    row[LEDGER_UI_COL.type] = txn.type === 'IN' ? 'Income' : 'Expense';
    row[LEDGER_UI_COL.cat] = categoryDisplayLabel(txn.cat) || txn.cat || '';
    row[LEDGER_UI_COL.sub_category] = txn.sub_category || '';
    row[LEDGER_UI_COL.vendor_name] = txn.vendor_name || '';
    row[LEDGER_UI_COL.exclude_from_reports] = txn.exclude_from_reports ? 'Yes' : 'No';
    row[LEDGER_UI_COL.wallet] = txn.wallet || '';
    row[LEDGER_UI_COL.reconciled] = txn._reconciled ? 'Yes' : 'No';
    row[LEDGER_UI_COL.external_sync_key] = txn.external_sync_key || (txn.id ? `app:txn:${txn.id}` : '');
    return row;
}

export function ledgerUiMaxCol() {
    return LEDGER_UI_HEADERS.length - 1;
}
