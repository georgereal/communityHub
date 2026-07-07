/**
 * Export Financial Ledger table rows (current filters + sort) to Excel.
 */
import ExcelJS from 'exceljs';
import { portalState } from './store.js';
import { getActiveLedgerTxns } from './ledgerBalance.js';
import {
    applyLedgerTableFilters,
    sortLedgerTxns,
    ledgerHasActiveFilters,
    getLedgerPivotFilter,
    getLedgerCategoryFilter,
} from './ledgerFilter.js';
import { isTransactionReconciled } from './bankReconciliation.js';
import {
    formatLedgerDisplayDate,
    getLedgerSyncExportRows,
    LEDGER_UI_HEADERS,
    LEDGER_UI_COL,
    txnToLedgerUiCells,
} from './ledgerDisplayRows.js';

const LEDGER_COLUMNS_KEY = 'ledgerTableColumns_v1';

const loadLedgerColumns = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(LEDGER_COLUMNS_KEY) || 'null');
        return { calculatedBalance: saved?.calculatedBalance !== false };
    } catch {
        return { calculatedBalance: true };
    }
};

/** Same filtered + sorted rows as the on-screen ledger table. */
export function getLedgerDisplayRows() {
    const reconciledIds = new Set(
        (portalState.finances.txns || [])
            .filter((t) => isTransactionReconciled(t.id))
            .map((t) => t.id),
    );
    const enriched = getLedgerSyncExportRows(portalState.finances.txns, { reconciledIds });
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
    const visibleColumns = loadLedgerColumns();
    const headers = LEDGER_UI_HEADERS.filter((h) => {
        if (h === 'Sync ID') return false;
        if (h === 'Calculated (₹)') return visibleColumns.calculatedBalance;
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
        if (visibleColumns.calculatedBalance) {
            line.push(cells[LEDGER_UI_COL.calculated]);
        }
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
    const calcCol = visibleColumns.calculatedBalance ? 5 : null;
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
    meta.addRow(['Search', (document.getElementById('cash-search')?.value || '').trim() || '—']);
    meta.addRow(['Category filter', getLedgerCategoryFilter() || '—']);
    meta.addRow(['Pivot filter', getLedgerPivotFilter() ? JSON.stringify(getLedgerPivotFilter()) : '—']);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Financial_Ledger_${exportFileSuffix(rows.length)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
}

export const initLedgerExport = () => {
    const btn = document.getElementById('ledger-download-xlsx');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
        exportLedgerExcel().catch((err) => alert(err?.message || 'Could not export ledger.'));
    });
};
