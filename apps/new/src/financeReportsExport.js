/**
 * Export Financial Reports (current toolbar filters) to Excel:
 * monthly stacks chart image + summary + raised / income / expense breakdowns.
 */
import ExcelJS from 'exceljs';
import { withButtonBusy } from './buttonBusy.js';

const NUM_FMT = '#,##0.00';
const CHART_ROW_SPAN = 26;

const styleHeaderRow = (row) => {
  row.font = { bold: true };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF1F5F9' },
  };
};

const appendStackBlock = (ws, title, rowHeader, months, rows) => {
  ws.addRow([]);
  const titleRow = ws.addRow([title]);
  titleRow.font = { bold: true, size: 12 };
  styleHeaderRow(ws.addRow([rowHeader, ...months.map((m) => m.label), 'Total']));
  rows.forEach((r) => {
    const row = ws.addRow([
      r.label,
      ...r.cells.map((v) => Math.round((v || 0) * 100) / 100),
      Math.round((r.total || 0) * 100) / 100,
    ]);
    if (r.rowKind === 'wallet-group') row.font = { bold: true };
  });
  if (rows.length) {
    // Group headers mirror nested category totals — don't double-count.
    const sumRows = rows.some((r) => r.rowKind === 'wallet-group')
      ? rows.filter((r) => r.rowKind !== 'wallet-group')
      : rows;
    const colTotals = months.map((_, i) =>
      Math.round(sumRows.reduce((s, r) => s + (r.cells[i] || 0), 0) * 100) / 100,
    );
    const grand = Math.round(colTotals.reduce((a, b) => a + b, 0) * 100) / 100;
    const totalRow = ws.addRow(['Monthly total', ...colTotals, grand]);
    totalRow.font = { bold: true };
  } else {
    ws.addRow(['(no rows)']);
  }
};

const downloadBlob = (buf, filename) => {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

async function loadAnalyticsApi() {
  return import('./financeNew/financeAnalytics.js');
}

export async function exportFinanceReportsExcel() {
  const api = await loadAnalyticsApi();
  const snap = api.getFinanceReportsExportSnapshot();
  const { months, settings, raised, income, expense, monthly } = snap;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CommunityHub';
  wb.created = new Date();

  const ws = wb.addWorksheet('Monthly stacks');

  const heading = ws.addRow(['Monthly stacks: raised, income & expenses']);
  heading.font = { bold: true, size: 14 };

  const chartPng = await api.captureFinanceReportsChartPng();
  if (chartPng) {
    for (let i = 0; i < CHART_ROW_SPAN; i++) ws.addRow([]);
    const imageId = wb.addImage({
      base64: chartPng.base64,
      extension: 'png',
    });
    ws.addImage(imageId, {
      tl: { col: 0, row: 1 },
      ext: { width: chartPng.width, height: chartPng.height },
    });
  } else {
    ws.addRow(['(Chart could not be rendered — open Financial Reports and try again.)']);
  }

  styleHeaderRow(ws.addRow([
    'Month',
    'Raised (invoices)',
    'Income (ledger)',
    'Expenses (ledger)',
    'Net (income − expenses)',
  ]));
  months.forEach((mo, i) => {
    ws.addRow([
      mo.label,
      monthly.raised[i],
      monthly.income[i],
      monthly.expense[i],
      monthly.net[i],
    ]);
  });
  const sumRaised = monthly.raised.reduce((a, b) => a + b, 0);
  const sumIncome = monthly.income.reduce((a, b) => a + b, 0);
  const sumExpense = monthly.expense.reduce((a, b) => a + b, 0);
  const totalRow = ws.addRow([
    'Range total',
    Math.round(sumRaised * 100) / 100,
    Math.round(sumIncome * 100) / 100,
    Math.round(sumExpense * 100) / 100,
    Math.round((sumIncome - sumExpense) * 100) / 100,
  ]);
  totalRow.font = { bold: true };

  const expenseDimLabel =
    settings.pivotDimension === 'sub_category' ? 'Sub-category'
      : settings.pivotDimension === 'vendor' ? 'Vendor'
        : settings.pivotDimension === 'wallet_cat' ? 'Cash / Bank → Category'
          : 'Category';

  appendStackBlock(ws, 'Invoices (by charge head)', 'Charge head', months, raised.rows);
  appendStackBlock(ws, 'Income by category', 'Category', months, income.rows);
  appendStackBlock(
    ws,
    settings.pivotDimension === 'wallet_cat'
      ? 'Expenses by Cash / Bank → category'
      : `Expenses by ${expenseDimLabel.toLowerCase()}`,
    expenseDimLabel,
    months,
    expense.rows.map((r) => (
      r.rowKind === 'wallet-cat'
        ? { ...r, label: `  ${r.label}` }
        : r
    )),
  );

  ws.getColumn(1).width = 28;
  for (let c = 2; c <= Math.max(5, months.length + 2); c++) {
    ws.getColumn(c).width = 14;
    ws.getColumn(c).numFmt = NUM_FMT;
  }

  const buf = await wb.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(buf, `Financial_Reports_${stamp}_${settings.monthCount}m.xlsx`);
}

export const initFinanceReportsExport = () => {
  const btn = document.getElementById('fn-fa-download-xlsx')
    || document.getElementById('fa-download-xlsx');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    void withButtonBusy(btn, 'Exporting…', async () => {
      try {
        await exportFinanceReportsExcel();
      } catch (err) {
        alert(err?.message || 'Could not export financial reports.');
      }
    });
  });
};
