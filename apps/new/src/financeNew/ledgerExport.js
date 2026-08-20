/**
 * Finance-New — export filtered ledger rows to Excel (Mongo / fn-* DOM).
 */
import ExcelJS from 'exceljs';
import { fnFinances } from './classicState.js';
import { getActiveLedgerTxns } from './ledgerBalance.js';
import {
    applyLedgerTableFilters,
    sortLedgerTxns,
    ledgerHasActiveFilters,
    getLedgerPivotFilter,
    getLedgerCategoryFilter,
} from './ledgerFilter.js';
import { isTransactionReconciled } from './bankStatementQueries.js';
import {
    getLedgerSyncExportRows,
    LEDGER_UI_HEADERS,
    LEDGER_UI_COL,
    txnToLedgerUiCells,
} from './ledgerDisplayRows.js';

const LEDGER_COLUMNS_KEY = 'ledgerTableColumns_v3';

const loadShowCalculated = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(LEDGER_COLUMNS_KEY) || 'null');
        if (saved && typeof saved === 'object') {
            // v3: Passbook / calculated is one column
            if ('passbookBalance' in saved) return saved.passbookBalance !== false;
            if ('calculatedBalance' in saved) return saved.calculatedBalance !== false;
        }
        const v2 = JSON.parse(localStorage.getItem('ledgerTableColumns_v2') || 'null');
        if (v2) return v2.passbookBalance === true || v2.calculatedBalance !== false;
    } catch { /* ignore */ }
    return true;
};

/** Same filtered + sorted rows as the on-screen Finance-New ledger table. */
export function getLedgerDisplayRows() {
    const txns = fnFinances().txns || [];
    const reconciledIds = new Set(
        txns.filter((t) => isTransactionReconciled(t.id)).map((t) => t.id),
    );
    const enriched = getLedgerSyncExportRows(txns, { reconciledIds });
    return sortLedgerTxns(applyLedgerTableFilters(enriched));
}

const exportFileSuffix = (rowCount) => {
    const total = getActiveLedgerTxns().length;
    const parts = [new Date().toISOString().slice(0, 10)];
    if (rowCount !== total) parts.push(`${rowCount}-of-${total}`);
    if (ledgerHasActiveFilters()) parts.push('filtered');
    return parts.join('_');
};

export async function exportLedgerExcel() {
    const rows = getLedgerDisplayRows();
    const showCalculated = loadShowCalculated();
    const headers = LEDGER_UI_HEADERS.filter((h) => {
        if (h === 'Sync ID') return false;
        if (h === 'Calculated (₹)') return showCalculated;
        return true;
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ledger');
    ws.addRow(headers);

    const numFmt = '#,##0.00';
    rows.forEach((t) => {
        const cells = txnToLedgerUiCells(t);
        const line = [
            cells[LEDGER_UI_COL.date],
            cells[LEDGER_UI_COL.description],
            cells[LEDGER_UI_COL.debit_dr],
            cells[LEDGER_UI_COL.credit_cr],
        ];
        if (showCalculated) line.push(cells[LEDGER_UI_COL.calculated]);
        line.push(
            cells[LEDGER_UI_COL.type],
            cells[LEDGER_UI_COL.cat],
            cells[LEDGER_UI_COL.sub_category],
            cells[LEDGER_UI_COL.vendor_name],
            cells[LEDGER_UI_COL.exclude_from_reports],
            cells[LEDGER_UI_COL.wallet],
            cells[LEDGER_UI_COL.reconciled],
        );
        ws.addRow(line);
    });

    const debitCol = 3;
    const creditCol = 4;
    const calcCol = showCalculated ? 5 : null;
    ws.getColumn(debitCol).numFmt = numFmt;
    ws.getColumn(creditCol).numFmt = numFmt;
    if (calcCol) ws.getColumn(calcCol).numFmt = numFmt;
    ws.getColumn(1).width = 11;
    ws.getColumn(2).width = 48;
    ws.getColumn(debitCol).width = 14;
    ws.getColumn(creditCol).width = 14;
    if (calcCol) ws.getColumn(calcCol).width = 16;

    const meta = wb.addWorksheet('Export info');
    meta.addRow(['Exported at', new Date().toISOString()]);
    meta.addRow(['Rows exported', rows.length]);
    meta.addRow(['Active ledger total', getActiveLedgerTxns().length]);
    meta.addRow([
        'Search',
        (document.getElementById('fn-cash-search')?.value || '').trim() || '—',
    ]);
    meta.addRow(['Category filter', getLedgerCategoryFilter() || '—']);
    meta.addRow(['Pivot filter', getLedgerPivotFilter() ? JSON.stringify(getLedgerPivotFilter()) : '—']);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Financial_Ledger_${exportFileSuffix(rows.length)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
}

export const initLedgerExport = () => {
    const btn = document.getElementById('fn-ledger-download-xlsx')
        || document.getElementById('ledger-download-xlsx');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
        exportLedgerExcel().catch((err) => alert(err?.message || 'Could not export ledger.'));
    });
};
