/**
 * Financial Reports — balance reconciliation, raised/income/expense pivots,
 * and income/expense trend projections.
 */
import { portalState } from './store.js';
import { navigateToLedgerFromPivot } from './ledgerFilter.js';
import {
    getMatchedTransactionIds,
    getUnmatchedBankLines,
    getUnmatchedLedgerTxns,
    isTransactionReconciled,
    getBankBalanceReconciliation,
} from './bankReconciliation.js';
import { normalizeCategoryKey, categoryDisplayLabel } from './expenseCategories.js';
import {
    getNoBrokerInvoicesRaised,
    buildRaisedInvoicesStack,
} from './nobrokerInvoicesRaised.js';
import {
    getCashExpenseReportingMode,
    setCashExpenseReportingMode,
    isBankPettyFunding,
    isCashDeskSpend,
} from './cashFloat.js';
import { cashBillsAsReportExpenses, getOpenExpenseDocuments, getCashWalletLeft } from './financeDocuments.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const labelForCat = (cat) => categoryDisplayLabel(cat);

/** Expenses synced from the expense spreadsheet (ledger sync). */
export const isExpenseFromSheet = (txn) =>
    txn?.type === 'OUT' && Boolean(txn.external_sync_key || txn.sync_hash);

/** OUT transactions linked to a matched bank statement line (same as ledger “Reconciled” badge). */
export const isExpenseFromBankRecon = (txn) =>
    txn?.type === 'OUT' && isTransactionReconciled(txn.id);

export const isStructuredExpense = (txn) =>
    isExpenseFromSheet(txn) || isExpenseFromBankRecon(txn);

const monthLabel = (y, m) =>
    new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

const buildMonthRange = (count, endDate = new Date()) => {
    const months = [];
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(endDate.getFullYear(), endDate.getMonth() - i, 1);
        months.push({ y: d.getFullYear(), m: d.getMonth(), label: monthLabel(d.getFullYear(), d.getMonth()) });
    }
    return months;
};

const txnInMonths = (txn, months) => {
    const d = new Date(txn.date);
    const y = d.getFullYear();
    const m = d.getMonth();
    return months.some((mo) => mo.y === y && mo.m === m);
};

const filterTxnsInMonthRange = (txns, months) => txns.filter((t) => txnInMonths(t, months));

const sumUnmatchedStatementNet = () => {
    let net = 0;
    getUnmatchedBankLines().forEach((line) => {
        net += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
    });
    return net;
};

const sumUnreconciledLedgerNet = () => {
    let net = 0;
    getUnmatchedLedgerTxns().forEach((t) => {
        const amt = parseFloat(t.amount) || 0;
        net += t.type === 'IN' ? amt : -amt;
    });
    return net;
};

export const isReportableTxn = (txn) => !txn?.exclude_from_reports;

/** Snapshot of report pivots/stacks using the same filters as the on-screen reports. */
export const getFinanceReportsExportSnapshot = () => {
  const settings = getSettings();
  const months = buildMonthRange(settings.monthCount);

  const invoices = getNoBrokerInvoicesRaised();
  const { heads, series, monthTotals: raisedMonthTotals } = buildRaisedInvoicesStack(months, invoices);
  const raisedRows = heads.map((head) => {
    const cells = (series[head] || months.map(() => 0)).map((v) => Math.round((v || 0) * 100) / 100);
    const total = cells.reduce((a, b) => a + b, 0);
    return { key: head, label: head, cells, total };
  }).filter((r) => r.total > 0.001);

  const incomeTxns = filterTxnsInMonthRange(filterIncome(), months);
  const incomePivot = buildIncomePivot(months, 'cat', incomeTxns);

  const expenseTxns = filterTxnsInMonthRange(
    filterExpenses(settings.sheetOnly, settings.cashExpenseReporting),
    months,
  );
  const expensePivot = buildExpensePivot(expenseTxns, months, settings.pivotDimension);

  const incomeMonthTotals = monthlyTotals(incomeTxns, months).map((v) => Math.round(v * 100) / 100);
  const expenseMonthTotals = monthlyTotals(expenseTxns, months).map((v) => Math.round(v * 100) / 100);
  const raisedTotals = (raisedMonthTotals || months.map(() => 0)).map((v) => Math.round((v || 0) * 100) / 100);

  return {
    months,
    settings,
    raised: {
      rows: raisedRows,
      invoiceCount: invoices.length,
    },
    income: {
      rows: incomePivot.rows,
      entryCount: incomeTxns.length,
    },
    expense: {
      rows: expensePivot.rows,
      entryCount: expenseTxns.length,
    },
    monthly: {
      raised: raisedTotals,
      income: incomeMonthTotals,
      expense: expenseMonthTotals,
      net: incomeMonthTotals.map((v, i) => Math.round((v - expenseMonthTotals[i]) * 100) / 100),
    },
  };
};

const filterExpenses = (structuredOnly, cashExpenseReporting = 'petty_bank') => {
    const txns = portalState.finances.txns || [];

    if (cashExpenseReporting === 'cash_detail') {
        // Bank Petty Cash = float transfer (not an expense). Cash desk ledger spends are
        // replaced by Bills & receipts categories for reporting.
        const ledger = txns.filter((t) => {
            if (t.type !== 'OUT' || !isReportableTxn(t)) return false;
            if (isBankPettyFunding(t)) return false;
            if (isCashDeskSpend(t)) return false;
            if (structuredOnly && !isStructuredExpense(t)) return false;
            return true;
        });
        const bills = cashBillsAsReportExpenses().filter(isReportableTxn);
        return [...ledger, ...bills];
    }

    // Default: bank Petty Cash stays in expense reports (lump-sum behaviour).
    return txns.filter((t) => {
        if (t.type !== 'OUT' || !isReportableTxn(t)) return false;
        if (structuredOnly && !isStructuredExpense(t)) return false;
        return true;
    });
};

const filterIncome = () =>
    (portalState.finances.txns || []).filter((t) => t.type === 'IN' && isReportableTxn(t));

const monthlyTotals = (txns, months) =>
    months.map(({ y, m }) =>
        txns
            .filter((t) => {
                const d = new Date(t.date);
                return d.getFullYear() === y && d.getMonth() === m;
            })
            .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0),
    );

const pivotKey = (txn, dimension) => {
    if (dimension === 'sub_category') return txn.sub_category?.trim() || '(none)';
    if (dimension === 'vendor') return txn.vendor_name?.trim() || '(none)';
    return normalizeCategoryKey(txn.cat || 'Other');
};

const buildCategoryPivot = (txns, months, dimension) => {
    const rowKeys = [...new Set(txns.map((t) => pivotKey(t, dimension)))].sort((a, b) =>
        a.localeCompare(b),
    );
    const rows = rowKeys.map((key) => {
        const cells = months.map(({ y, m }) =>
            txns
                .filter((t) => pivotKey(t, dimension) === key)
                .filter((t) => {
                    const d = new Date(t.date);
                    return d.getFullYear() === y && d.getMonth() === m;
                })
                .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0),
        );
        const total = cells.reduce((a, b) => a + b, 0);
        return {
            key,
            label: dimension === 'cat' || dimension === 'category' ? labelForCat(key) : key,
            cells,
            total,
        };
    });
    const colTotals = months.map((_, i) => rows.reduce((s, r) => s + r.cells[i], 0));
    const grandTotal = colTotals.reduce((a, b) => a + b, 0);
    return { rows: rows.filter((r) => r.total > 0.001), colTotals, grandTotal };
};

const buildIncomePivot = (months, dimension = 'cat', incomeTxns = filterIncome()) =>
    buildCategoryPivot(incomeTxns, months, dimension);

const buildExpensePivot = (expenses, months, dimension) =>
    buildCategoryPivot(expenses, months, dimension);

/** Keep top N categories by total; roll the rest into "Other". */
const topCategoryRows = (rows, limit = 8) => {
    if (rows.length <= limit) return rows;
    const sorted = [...rows].sort((a, b) => b.total - a.total);
    const top = sorted.slice(0, limit);
    const rest = sorted.slice(limit);
    const otherCells = monthsCellsFromRows(rest, top[0]?.cells.length || 0);
    const otherTotal = otherCells.reduce((a, b) => a + b, 0);
    if (otherTotal <= 0.001) return top;
    return [...top, { key: '__other__', label: 'Other', cells: otherCells, total: otherTotal }];
};

const monthsCellsFromRows = (rows, len) =>
    Array.from({ length: len }, (_, i) => rows.reduce((s, r) => s + (r.cells[i] || 0), 0));

const averageProject = (values, futureCount) => {
    const avg = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    const rounded = Math.round(avg);
    return Array(futureCount).fill(rounded);
};

let combinedChartInstance = null;
let stackInteractionRegistered = false;

/** Hover one bar → tooltip lists only that stack (raised / income / expense). */
const ensureStackInteractionMode = () => {
  if (stackInteractionRegistered || typeof Chart === 'undefined') return;
  const modes = Chart.Interaction?.modes;
  if (!modes || modes.sameStack) {
    stackInteractionRegistered = true;
    return;
  }
  modes.sameStack = function sameStack(chart, e, options, useFinalPosition) {
    const nearest = modes.nearest(chart, e, { ...options, intersect: true }, useFinalPosition);
    if (!nearest.length) {
      // Fall back to nearest without intersect so empty gaps still pick a bar
      const loose = modes.nearest(chart, e, { ...options, intersect: false }, useFinalPosition);
      if (!loose.length) return [];
      nearest.push(...loose.slice(0, 1));
    }
    const hit = nearest[0];
    const stack = chart.data.datasets[hit.datasetIndex]?.stack;
    const index = hit.index;
    if (stack == null) return nearest;

    const items = [];
    chart.data.datasets.forEach((ds, datasetIndex) => {
      if (ds.stack !== stack) return;
      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden || ds.hidden) return;
      const el = meta.data[index];
      if (el && !el.skip) items.push({ datasetIndex, index, element: el });
    });
    return items.length ? items : nearest;
  };
  stackInteractionRegistered = true;
};

const STACK_FOOTER_LABEL = {
  raised: 'Raised',
  income: 'Income',
  expense: 'Expenses',
};

const INCOME_COLOR_OVERRIDES = {
    'Maintenance Collection': '#16a34a',
    'Other Income': '#22c55e',
    Interest: '#4ade80',
    'Petty Inflow': '#86efac',
    Reconcile: '#94a3b8',
};

const CATEGORY_COLORS = {
    Security: '#6366f1',
    Maintenance: '#8b5cf6',
    Plumbing: '#06b6d4',
    Electrical: '#3b82f6',
    Stationery: '#a855f7',
    Marketing: '#ec4899',
    Promotion: '#f472b6',
    Other: '#64748b',
    Audit: '#7c3aed',
    'Bank Charges': '#ef4444',
    'Petty Cash': '#0d9488',
    __other__: '#cbd5e1',
};

const STACK_PALETTE = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#ef4444',
    '#f97316', '#eab308', '#14b8a6', '#06b6d4', '#3b82f6',
];

const colorForKey = (key, side = 'expense') => {
    if (side === 'income' && INCOME_COLOR_OVERRIDES[key]) return INCOME_COLOR_OVERRIDES[key];
    if (CATEGORY_COLORS[key]) return CATEGORY_COLORS[key];
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash) + key.charCodeAt(i);
    return STACK_PALETTE[Math.abs(hash) % STACK_PALETTE.length];
};

const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const RAISED_HEAD_COLORS = {
  'Maintenance charges': '#2563eb',
  'Common water consumption charges': '#0ea5e9',
  'Water Meter Rent': '#06b6d4',
  'Car Parking': '#8b5cf6',
  'Home water consumption charges': '#14b8a6',
  'Non Occupancy Charges': '#f59e0b',
};

const colorForRaisedHead = (head) => {
  if (RAISED_HEAD_COLORS[head]) return RAISED_HEAD_COLORS[head];
  return colorForKey(head, 'expense');
};

const renderRaisedInvoicesPivot = (months) => {
  const el = document.getElementById('fa-raised-pivot');
  const metaEl = document.getElementById('fa-raised-pivot-meta');
  if (!el) return;

  const invoices = getNoBrokerInvoicesRaised();
  const { heads, series } = buildRaisedInvoicesStack(months, invoices);
  const files = [...new Set(invoices.map((r) => r.source_file).filter(Boolean))];

  if (metaEl) {
    if (!invoices.length) {
      metaEl.innerHTML = '';
    } else {
      metaEl.innerHTML = [
        `<span class="fa-meta-chip">${invoices.length} invoice row(s)</span>`,
        files[0] ? `<span class="fa-meta-chip" title="${escAttr(files[0])}">${escAttr(files[0])}</span>` : '',
      ].filter(Boolean).join('');
    }
  }

  const rows = heads.map((head) => {
    const cells = series[head] || months.map(() => 0);
    const total = cells.reduce((a, b) => a + b, 0);
    return { key: head, label: head, cells, total };
  }).filter((r) => r.total > 0.001);

  renderPivotTable({
    el,
    metaEl: null, // already filled above
    rows,
    months,
    dimension: 'charge',
    type: 'IN',
    clickable: false,
    emptyMessage: invoices.length
      ? 'No raised amounts in this month range.'
      : 'No raised-invoice data yet. Open the Invoices Raised tab to upload the monthly Excel export.',
  });
};

const buildCombinedChartDatasets = (months, sheetOnly, pivotDimension, cashExpenseReporting = 'petty_bank') => {
    const incomeRows = topCategoryRows(buildIncomePivot(months, 'cat', filterTxnsInMonthRange(filterIncome(), months)).rows, 6);
    const expenseRows = topCategoryRows(
        buildExpensePivot(
            filterTxnsInMonthRange(filterExpenses(sheetOnly, cashExpenseReporting), months),
            months,
            pivotDimension,
        ).rows,
        6,
    );
    const { heads: raisedHeads, series: raisedSeries } = buildRaisedInvoicesStack(months);
    const raisedRows = raisedHeads.slice(0, 8).map((head) => ({
        key: head,
        label: head,
        cells: raisedSeries[head] || months.map(() => 0),
    }));

    return [
        ...raisedRows.map((row) => ({
            label: `Raised: ${row.label}`,
            data: row.cells,
            stack: 'raised',
            backgroundColor: colorForRaisedHead(row.key),
            borderWidth: 0,
            borderRadius: 2,
        })),
        ...incomeRows.map((row) => ({
            label: `In: ${row.label}`,
            data: row.cells,
            stack: 'income',
            backgroundColor: colorForKey(row.key, 'income'),
            borderWidth: 0,
            borderRadius: 2,
        })),
        ...expenseRows.map((row) => ({
            label: `Out: ${row.label}`,
            data: row.cells,
            stack: 'expense',
            backgroundColor: colorForKey(row.key, 'expense'),
            borderWidth: 0,
            borderRadius: 2,
        })),
    ];
};

const combinedChartOptions = (interactive) => ({
    responsive: interactive,
    maintainAspectRatio: false,
    animation: interactive,
    interaction: interactive
        ? { mode: 'sameStack', intersect: true, axis: 'xy' }
        : { mode: 'nearest', intersect: false },
    plugins: {
        legend: {
            position: 'bottom',
            labels: { boxWidth: 10, font: { size: 10 }, padding: 6 },
        },
        tooltip: interactive
            ? {
                filter: (item) => (item.parsed?.y || 0) > 0,
                callbacks: {
                    title: (items) => {
                        const month = items[0]?.label || '';
                        const stack = items[0]?.dataset?.stack;
                        const kind = STACK_FOOTER_LABEL[stack] || stack || '';
                        return kind ? `${month} · ${kind}` : month;
                    },
                    label: (ctx) => {
                        const v = ctx.parsed.y;
                        return v > 0 ? `${ctx.dataset.label}: ${formatMoney(v)}` : null;
                    },
                    footer: (items) => {
                        if (!items.length) return '';
                        const stack = items[0].dataset.stack;
                        const total = items.reduce((s, it) => s + (it.parsed.y || 0), 0);
                        const kind = STACK_FOOTER_LABEL[stack] || 'Total';
                        return `${kind}: ${formatMoney(total)}`;
                    },
                },
            }
            : { enabled: false },
    },
    scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
            stacked: true,
            ticks: {
                callback: (v) => (v >= 1000 ? `₹${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `₹${v}`),
            },
        },
    },
});

const renderCombinedCategoryChart = (months, sheetOnly, pivotDimension, cashExpenseReporting = 'petty_bank') => {
    const canvas = document.getElementById('fa-combined-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    if (combinedChartInstance) {
        combinedChartInstance.destroy();
        combinedChartInstance = null;
    }

    ensureStackInteractionMode();

    combinedChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: months.map((m) => m.label),
            datasets: buildCombinedChartDatasets(months, sheetOnly, pivotDimension, cashExpenseReporting),
        },
        options: combinedChartOptions(true),
    });
};

/** PNG of the on-screen monthly stacks chart for Excel embed (ExcelJS has no native charts). */
export const captureFinanceReportsChartPng = (width = 1100, height = 480) => {
    if (typeof Chart === 'undefined' || typeof document === 'undefined') return null;

    const settings = getSettings();
    const months = buildMonthRange(settings.monthCount);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const chart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: months.map((m) => m.label),
            datasets: buildCombinedChartDatasets(
                months,
                settings.sheetOnly,
                settings.pivotDimension,
                settings.cashExpenseReporting,
            ),
        },
        options: {
            ...combinedChartOptions(false),
            responsive: false,
            devicePixelRatio: 2,
        },
    });

    const dataUrl = chart.toBase64Image('image/png', 1);
    chart.destroy();
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    return base64 ? { base64, width, height } : null;
};

const renderProjectionSummary = (months, sheetOnly, projectCount, cashExpenseReporting = 'petty_bank') => {
    const summaryEl = document.getElementById('fa-projection-summary');
    const badgeEl = document.getElementById('fa-projection-badge');
    if (!summaryEl) return;

    const expenses = filterTxnsInMonthRange(filterExpenses(sheetOnly, cashExpenseReporting), months);
    const income = filterTxnsInMonthRange(filterIncome(), months);
    const expenseTotals = monthlyTotals(expenses, months);
    const incomeTotals = monthlyTotals(income, months);

    const projIncome = averageProject(incomeTotals, projectCount);
    const projExpense = averageProject(expenseTotals, projectCount);
    const projNet = projIncome.map((v, i) => v - projExpense[i]);

    const projLabels = Array.from({ length: projectCount }, (_, i) => {
        const d = new Date();
        d.setMonth(d.getMonth() + i + 1);
        return monthLabel(d.getFullYear(), d.getMonth());
    });

    const avgIncome = incomeTotals.reduce((a, b) => a + b, 0) / Math.max(1, incomeTotals.length);
    const avgExpense = expenseTotals.reduce((a, b) => a + b, 0) / Math.max(1, expenseTotals.length);
    const nextNet = projNet.reduce((a, b) => a + b, 0);

    if (badgeEl) {
        badgeEl.hidden = false;
        badgeEl.textContent = nextNet >= 0 ? '+' : '−';
        badgeEl.classList.toggle('fa-projection-icon-btn__badge--pos', nextNet >= 0);
        badgeEl.classList.toggle('fa-projection-icon-btn__badge--neg', nextNet < 0);
    }

    summaryEl.innerHTML = `
      <h3 class="fa-panel__title">Trend projection</h3>
      <p class="fa-projection-note">Avg monthly totals over the selected history · ${projectCount}-month forecast</p>
      <dl class="fa-projection-stats">
        <div><dt>Avg monthly income</dt><dd>${formatMoney(avgIncome)}</dd></div>
        <div><dt>Avg monthly expenses</dt><dd>${formatMoney(avgExpense)}</dd></div>
        <div><dt>Projected net (${projectCount} mo)</dt><dd class="${nextNet >= 0 ? 'fa-positive' : 'fa-negative'}">${formatMoney(nextNet)}</dd></div>
      </dl>
      <ul class="fa-projection-list">
        ${projLabels.map((lbl, i) =>
            `<li><span>${lbl}</span><span>In ${formatMoney(projIncome[i])} · Out ${formatMoney(projExpense[i])} · Net ${formatMoney(projNet[i])}</span></li>`,
        ).join('')}
      </ul>`;
};

const getSettings = () => ({
    monthCount: parseInt(document.getElementById('fa-month-range')?.value || '6', 10),
    pivotDimension: document.getElementById('fa-pivot-dimension')?.value || 'cat',
    sheetOnly: document.getElementById('fa-sheet-only')?.checked !== false,
    projectMonths: parseInt(document.getElementById('fa-project-months')?.value || '3', 10),
    cashExpenseReporting: getCashExpenseReportingMode(),
});

const renderBalanceMetrics = () => {
    const el = document.getElementById('fa-balance-metrics');
    if (!el) return;

    const cash = getCashWalletLeft();
    const recon = getBankBalanceReconciliation();
    const bankBalance = recon.passbook?.balance ?? recon.calculated.balance ?? null;
    const passbookVariance = recon.diff;
    const asOf = recon.passbook?.asOf || recon.calculated.asOf;
    const unmatchedLines = getUnmatchedBankLines().length;
    const unreconciledTxns = getUnmatchedLedgerTxns().length;
    const unmatchedNet = sumUnmatchedStatementNet();
    const unreconciledNet = sumUnreconciledLedgerNet();
    const matchedCount = getMatchedTransactionIds().size;

    const passbookVarClass = passbookVariance != null && Math.abs(passbookVariance) < 1
        ? 'fa-metric--ok'
        : 'fa-metric--warn';

    const bankSub = bankBalance != null
        ? (asOf ? `As of ${new Date(`${asOf}T12:00:00`).toLocaleDateString('en-GB')}` : 'From bank reconciliation')
        : 'Import a statement in Bank Reconciliation';

    const varianceCard = passbookVariance != null && Math.abs(passbookVariance) >= 1
        ? `<div class="metric-card fa-metric ${passbookVarClass} metric-card--clickable" data-goto-bank-recon title="Review in Bank Reconciliation">
        <span class="label">Reconciliation gap</span>
        <span class="value">${formatMoney(passbookVariance)}</span>
        <span class="fa-metric__sub">Passbook does not match calculated — click to review</span>
      </div>`
        : '';

    el.innerHTML = `
      <div class="metric-card fa-metric metric-card--clickable" data-goto-bank-recon title="Open Bank Reconciliation">
        <span class="label">Bank balance</span>
        <span class="value">${bankBalance != null ? formatMoney(bankBalance) : '—'}</span>
        <span class="fa-metric__sub">${bankSub}</span>
      </div>
      ${varianceCard}
      <div class="metric-card fa-metric metric-card--clickable" data-goto-bills-wallet title="Open Bills & receipts cash float">
        <span class="label">Petty cash</span>
        <span class="value">${formatMoney(cash)}</span>
        <span class="fa-metric__sub">Wallet Left (Bills &amp; receipts)</span>
      </div>
      <div class="metric-card fa-metric">
        <span class="label">Total balance</span>
        <span class="value">${bankBalance != null ? formatMoney(cash + bankBalance) : formatMoney(cash)}</span>
        <span class="fa-metric__sub">Wallet Left + bank</span>
      </div>
      <div class="metric-card fa-metric metric-card--clickable" data-goto-bank-recon title="Review unmatched statement lines">
        <span class="label">Unmatched statement</span>
        <span class="value" style="color:var(--danger);">${unmatchedLines}</span>
        <span class="fa-metric__sub">Net ${formatMoney(unmatchedNet)} · click to reconcile</span>
      </div>
      <div class="metric-card fa-metric metric-card--clickable" data-goto-bank-recon data-focus-unmatched-ledger title="Match unreconciled ledger entries">
        <span class="label">Unreconciled ledger</span>
        <span class="value" style="color:var(--warning, #d97706);">${unreconciledTxns}</span>
        <span class="fa-metric__sub">Net ${formatMoney(unreconciledNet)} · ${matchedCount} matched · click to act</span>
      </div>`;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const monthKeyFromDate = (iso) => {
    const s = String(iso || '').slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}` : '';
};

const summarizePlannedExpenses = () => {
    const docs = getOpenExpenseDocuments();
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 10);
    const thisMonthKey = monthKeyFromDate(todayIso);

    let overdue = 0;
    let thisMonth = 0;
    let later = 0;
    const byCat = new Map();

    docs.forEach((d) => {
        const amt = round2(parseFloat(d.amount) || 0);
        const dateStr = String(d.doc_date || '').slice(0, 10);
        if (dateStr && dateStr < todayIso) overdue += amt;
        else if (monthKeyFromDate(dateStr) === thisMonthKey) thisMonth += amt;
        else later += amt;

        const key = normalizeCategoryKey(d.cat || 'Other') || 'Other';
        byCat.set(key, round2((byCat.get(key) || 0) + amt));
    });

    const topCats = [...byCat.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, amount]) => ({ key, label: categoryDisplayLabel(key), amount }));

    return {
        docs,
        count: docs.length,
        total: round2(overdue + thisMonth + later),
        overdue: round2(overdue),
        thisMonth: round2(thisMonth),
        later: round2(later),
        topCats,
    };
};

/** Planned expenses vs balance — collapsed by default. */
const renderPlannedExpensesCard = () => {
    const el = document.getElementById('fa-planned-expenses');
    if (!el) return;
    const wasOpen = el.open;

    const planned = summarizePlannedExpenses();
    const cash = getCashWalletLeft();
    const recon = getBankBalanceReconciliation();
    const bankBalance = recon.passbook?.balance ?? recon.calculated.balance ?? null;
    const hasBank = bankBalance != null;
    const current = hasBank ? round2(cash + bankBalance) : round2(cash);
    const after = round2(current - planned.total);
    const afterClass = after < -0.009 ? 'fa-planned__after--short' : (after < current * 0.15 ? 'fa-planned__after--tight' : 'fa-planned__after--ok');

    const catChips = planned.topCats.length
        ? planned.topCats.map((c) =>
            `<span class="fa-planned__chip"><strong>${c.label}</strong> ${formatMoney(c.amount)}</span>`,
        ).join('')
        : '<span class="fa-planned__chip fa-planned__chip--muted">No open expense bills yet</span>';

    el.innerHTML = `
      <summary class="fa-collapsible-panel__summary">
        <span class="fa-collapsible-panel__title">Planned expenses vs balance</span>
        <span class="fa-collapsible-panel__meta">Planned ${formatMoney(planned.total)} · After ${formatMoney(after)} · ${planned.count} open</span>
      </summary>
      <div class="fa-collapsible-panel__body">
        <div class="fa-panel__head fa-panel__head--row">
          <p class="fa-panel__hint" style="margin:0;">
            Open (unlinked) bills from <strong>Bills &amp; receipts</strong> — proposed spend until you link them to the ledger.
          </p>
          <button type="button" class="btn btn-outline btn--small" id="fa-planned-open-bills">
            <i class="fa-solid fa-file-invoice" aria-hidden="true"></i> Review open bills
          </button>
        </div>
        <div class="fa-planned__metrics">
          <div class="fa-planned__metric">
            <span class="fa-planned__label">Current balance</span>
            <span class="fa-planned__value">${formatMoney(current)}</span>
            <span class="fa-planned__sub">${hasBank ? 'Wallet Left + bank' : 'Wallet Left only (set bank opening / passbook)'}</span>
          </div>
          <div class="fa-planned__metric">
            <span class="fa-planned__label">Planned spend</span>
            <span class="fa-planned__value fa-planned__value--out">${formatMoney(planned.total)}</span>
            <span class="fa-planned__sub">${planned.count} open bill${planned.count === 1 ? '' : 's'}</span>
          </div>
          <div class="fa-planned__metric ${afterClass}">
            <span class="fa-planned__label">After planned</span>
            <span class="fa-planned__value">${formatMoney(after)}</span>
            <span class="fa-planned__sub">${after < -0.009 ? 'Shortfall if all open bills clear' : 'Left if all open bills clear'}</span>
          </div>
        </div>
        <div class="fa-planned__buckets">
          <span><strong>Overdue</strong> ${formatMoney(planned.overdue)}</span>
          <span><strong>This month</strong> ${formatMoney(planned.thisMonth)}</span>
          <span><strong>Later</strong> ${formatMoney(planned.later)}</span>
        </div>
        <div class="fa-planned__cats" aria-label="Top planned categories">${catChips}</div>
      </div>`;

    el.open = wasOpen;

    el.querySelector('#fa-planned-open-bills')?.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { focusOpenExpenseBills } = await import('./financeDocuments.js');
        focusOpenExpenseBills();
    }, { once: true });
};

/** Monthly raised / income / expenses / net — same rows as the Excel export summary. */
const renderMonthlySummaryCard = () => {
    const el = document.getElementById('fa-monthly-summary');
    if (!el) return;
    const wasOpen = el.open;

    const snap = getFinanceReportsExportSnapshot();
    const { months, monthly } = snap;
    const sumRaised = monthly.raised.reduce((a, b) => a + b, 0);
    const sumIncome = monthly.income.reduce((a, b) => a + b, 0);
    const sumExpense = monthly.expense.reduce((a, b) => a + b, 0);
    const sumNet = round2(sumIncome - sumExpense);
    const netClass = (v) => (v < -0.009 ? 'fa-monthly-summary__neg' : (v > 0.009 ? 'fa-monthly-summary__pos' : ''));

    const rows = months.map((mo, i) => {
        const net = monthly.net[i] || 0;
        return `<tr>
          <td>${mo.label}</td>
          <td class="fa-num">${formatMoney(monthly.raised[i])}</td>
          <td class="fa-num">${formatMoney(monthly.income[i])}</td>
          <td class="fa-num">${formatMoney(monthly.expense[i])}</td>
          <td class="fa-num ${netClass(net)}">${formatMoney(net)}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
      <summary class="fa-collapsible-panel__summary">
        <span class="fa-collapsible-panel__title">Monthly summary</span>
        <span class="fa-collapsible-panel__meta">Net ${formatMoney(sumNet)}</span>
      </summary>
      <div class="fa-collapsible-panel__body">
        <div class="fa-table-wrap">
          <table class="fa-pivot-table fa-monthly-summary-table">
            <thead>
              <tr>
                <th></th>
                <th class="fa-num" title="Raised invoices">Raised</th>
                <th class="fa-num" title="Ledger income">Income</th>
                <th class="fa-num" title="Ledger expenses">Expense</th>
                <th class="fa-num" title="Income − expenses">Net</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr class="fa-monthly-summary-table__total">
                <td>Total</td>
                <td class="fa-num">${formatMoney(sumRaised)}</td>
                <td class="fa-num">${formatMoney(sumIncome)}</td>
                <td class="fa-num">${formatMoney(sumExpense)}</td>
                <td class="fa-num ${netClass(sumNet)}">${formatMoney(sumNet)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>`;

    el.open = wasOpen;
};

const renderPivotTable = ({
    el,
    metaEl,
    rows,
    months,
    dimension,
    type,
    emptyMessage,
    clickable = false,
}) => {
    if (!el) return;

    const dimLabel =
        dimension === 'sub_category' ? 'Sub-category'
            : dimension === 'vendor' ? 'Vendor'
                : dimension === 'charge' ? 'Charge head'
                    : 'Category';
    const amountClass = type === 'IN' ? 'fa-income' : 'fa-expense';

    if (!rows.length) {
        if (metaEl) metaEl.innerHTML = '';
        el.innerHTML = `<p class="maintenance-dues-empty">${emptyMessage}</p>`;
        return;
    }

    const colTotals = months.map((_, i) => rows.reduce((s, r) => s + r.cells[i], 0));
    const grandTotal = colTotals.reduce((a, b) => a + b, 0);
    const rangeStart = months[0];
    const rangeEnd = months[months.length - 1];
    const monthRangeAttrs = rangeStart && rangeEnd
        ? `data-pivot-range-start="${rangeStart.y}-${rangeStart.m}" data-pivot-range-end="${rangeEnd.y}-${rangeEnd.m}"`
        : '';

    const renderAmountCell = ({
        value,
        scope = 'cell',
        row = null,
        monthIndex = null,
        extraClass = '',
        strong = false,
    }) => {
        const content = strong ? `<strong>${formatMoney(value)}</strong>` : formatMoney(value);
        if (value <= 0.001) return `<td class="fa-num ${extraClass}">—</td>`;

        const month = monthIndex != null ? months[monthIndex] : null;
        const rowBlocked = row?.key === '__other__';
        if (!clickable || rowBlocked) {
            return `<td class="fa-num ${amountClass} ${extraClass}">${content}</td>`;
        }

        const attrs = [
            `class="fa-num fa-pivot-cell fa-pivot-cell--clickable ${amountClass} ${extraClass}"`,
            'role="button" tabindex="0"',
            `data-pivot-type="${type}"`,
            `data-pivot-dimension="${dimension}"`,
            `data-pivot-scope="${scope}"`,
            row?.key != null ? `data-pivot-key="${escAttr(row.key)}"` : '',
            row?.label != null ? `data-pivot-label="${escAttr(row.label)}"` : '',
            month ? `data-pivot-year="${month.y}" data-pivot-month="${month.m}"` : '',
            (scope === 'row-total' || scope === 'grand-total') ? monthRangeAttrs : '',
            `title="View matching ledger entries"`,
        ].filter(Boolean).join(' ');
        return `<td ${attrs}>${content}</td>`;
    };

    el.innerHTML = `
      <table class="fa-pivot-table">
        <thead>
          <tr>
            <th>${dimLabel}</th>
            ${months.map((m) => `<th class="fa-num">${m.label}</th>`).join('')}
            <th class="fa-num fa-col-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${r.label}</td>
              ${r.cells.map((v, i) => renderAmountCell({ value: v, scope: 'cell', row: r, monthIndex: i })).join('')}
              ${renderAmountCell({ value: r.total, scope: 'row-total', row: r, extraClass: 'fa-col-total', strong: true })}
            </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Monthly total</strong></td>
            ${colTotals.map((v, i) => renderAmountCell({ value: v, scope: 'col-total', monthIndex: i, strong: true })).join('')}
            ${renderAmountCell({ value: grandTotal, scope: 'grand-total', extraClass: 'fa-col-total', strong: true })}
          </tr>
        </tfoot>
      </table>`;
};

const expenseSourceCounts = (months, sheetOnly) => {
    const inRangeOut = (portalState.finances.txns || []).filter(
        (t) => t.type === 'OUT' && txnInMonths(t, months),
    );
    const reportable = inRangeOut.filter(isReportableTxn);
    const inPivot = sheetOnly ? reportable.filter(isStructuredExpense) : reportable;
    const fromSheet = inPivot.filter(isExpenseFromSheet).length;
    const fromBank = inPivot.filter((t) => isExpenseFromBankRecon(t) && !isExpenseFromSheet(t)).length;
    const excludedFromReports = inRangeOut.filter((t) => t.exclude_from_reports).length;
    const manualOmitted = sheetOnly ? reportable.filter((t) => !isStructuredExpense(t)).length : 0;
    return { fromSheet, fromBank, excludedFromReports, manualOmitted, inPivot: inPivot.length };
};

const pivotRangeFromMonths = (months) => {
    if (!months.length) return {};
    const start = months[0];
    const end = months[months.length - 1];
    return {
        rangeStart: new Date(start.y, start.m, 1),
        rangeEnd: new Date(end.y, end.m + 1, 0, 23, 59, 59, 999),
    };
};

const expenseMetaChip = (count, label, sourceScope, extraClass = '') => {
    if (!count) return '';
    return `<button type="button" class="fa-meta-chip fa-meta-chip--clickable ${extraClass}" data-fa-expense-source="${sourceScope}" title="View matching ledger entries">${count} ${label}</button>`;
};

const renderOmittedMetaChip = (manualOmitted, excludedFromReports) => {
    if (!manualOmitted && !excludedFromReports) return '';
    const parts = [];
    if (manualOmitted) parts.push(`${manualOmitted} manual`);
    if (excludedFromReports) parts.push(`${excludedFromReports} excluded from reports`);
    const scope = manualOmitted && excludedFromReports
        ? 'omitted'
        : (manualOmitted ? 'manual' : 'excluded-reports');
    return `<button type="button" class="fa-meta-chip fa-meta-chip--clickable" data-fa-expense-source="${scope}" title="View matching ledger entries">${parts.join(' · ')} omitted</button>`;
};

const renderIncomePivot = (months) => {
    const el = document.getElementById('fa-income-pivot');
    const metaEl = document.getElementById('fa-income-pivot-meta');
    const income = filterTxnsInMonthRange(filterIncome(), months);
    const excludedCount = (portalState.finances.txns || []).filter(
        (t) => t.type === 'IN' && t.exclude_from_reports && txnInMonths(t, months),
    ).length;

    if (metaEl) {
        metaEl.innerHTML = excludedCount
            ? `<span class="fa-meta-chip">${income.length} in reports</span>
               <span class="fa-meta-chip">${excludedCount} excluded from reports</span>`
            : `<span class="fa-meta-chip">${income.length} income entries</span>`;
    }

    const { rows } = buildIncomePivot(months, 'cat', income);
    renderPivotTable({
        el,
        metaEl,
        rows,
        months,
        dimension: 'cat',
        type: 'IN',
        clickable: true,
        emptyMessage: 'No income in this range.',
    });
};

const renderExpensePivot = (months, dimension, sheetOnly, cashExpenseReporting = 'petty_bank') => {
    const el = document.getElementById('fa-expense-pivot');
    const metaEl = document.getElementById('fa-expense-pivot-meta');

    const expenses = filterTxnsInMonthRange(filterExpenses(sheetOnly, cashExpenseReporting), months);
    const { fromSheet, fromBank, excludedFromReports, manualOmitted } = expenseSourceCounts(months, sheetOnly);

    if (metaEl) {
        if (sheetOnly) {
            metaEl.innerHTML = `${expenseMetaChip(fromSheet, 'from expense sheets', 'sheet', 'fa-meta-chip--sheet')}
               ${expenseMetaChip(fromBank, 'from bank reconciliation', 'bank')}
               ${renderOmittedMetaChip(manualOmitted, excludedFromReports)}`;
        } else {
            metaEl.innerHTML = `<span class="fa-meta-chip">${expenses.length} in period (${fromSheet} sheets, ${fromBank} bank)</span>
               ${expenseMetaChip(excludedFromReports, 'excluded from reports', 'excluded-reports')}`;
        }
    }

    const { rows } = buildExpensePivot(expenses, months, dimension);
    renderPivotTable({
        el,
        metaEl,
        rows,
        months,
        dimension,
        type: 'OUT',
        clickable: true,
        emptyMessage: `No expenses in this range${sheetOnly ? ' from expense sheets or bank reconciliation' : ''}. Post debits from Bank reconciliation or sync your expense spreadsheet from Admin → Spreadsheet Sync.`,
    });
};

const wirePivotContainer = (containerId) => {
    const el = document.getElementById(containerId);
    if (!el || el.dataset.pivotWired) return;
    el.dataset.pivotWired = '1';

    const openFromCell = (cell) => {
        if (!cell?.classList.contains('fa-pivot-cell--clickable')) return;

        const filter = {
            type: cell.dataset.pivotType || 'OUT',
            dimension: cell.dataset.pivotDimension || 'cat',
            scope: cell.dataset.pivotScope || 'cell',
        };

        if (cell.dataset.pivotKey) {
            filter.key = cell.dataset.pivotKey;
            filter.label = cell.dataset.pivotLabel;
        }

        if (cell.dataset.pivotYear) {
            filter.year = parseInt(cell.dataset.pivotYear, 10);
            filter.month = parseInt(cell.dataset.pivotMonth, 10);
        }

        if (cell.dataset.pivotRangeStart) {
            const [sy, sm] = cell.dataset.pivotRangeStart.split('-').map(Number);
            const [ey, em] = cell.dataset.pivotRangeEnd.split('-').map(Number);
            filter.rangeStart = new Date(sy, sm, 1);
            filter.rangeEnd = new Date(ey, em + 1, 0, 23, 59, 59, 999);
        }

        navigateToLedgerFromPivot(filter);
    };

    el.addEventListener('click', (e) => {
        const cell = e.target.closest('.fa-pivot-cell--clickable');
        if (cell) openFromCell(cell);
    });
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const cell = e.target.closest('.fa-pivot-cell--clickable');
        if (!cell) return;
        e.preventDefault();
        openFromCell(cell);
    });
};

const wireExpensePivotMeta = () => {
    const metaEl = document.getElementById('fa-expense-pivot-meta');
    if (!metaEl || metaEl.dataset.metaWired) return;
    metaEl.dataset.metaWired = '1';

    metaEl.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-fa-expense-source]');
        if (!chip?.dataset.faExpenseSource) return;
        const settings = getSettings();
        const months = buildMonthRange(settings.monthCount);
        navigateToLedgerFromPivot({
            type: 'OUT',
            sourceScope: chip.dataset.faExpenseSource,
            ...pivotRangeFromMonths(months),
        });
    });
};

const wirePivotDrilldown = () => {
    wirePivotContainer('fa-income-pivot');
    wirePivotContainer('fa-expense-pivot');
    wireExpensePivotMeta();
};

export const renderFinanceAnalytics = () => {
    const settings = getSettings();
    const months = buildMonthRange(settings.monthCount);

    renderBalanceMetrics();
    renderPlannedExpensesCard();
    renderMonthlySummaryCard();
    wireBalanceMetricClicks();
    renderCombinedCategoryChart(
        months,
        settings.sheetOnly,
        settings.pivotDimension,
        settings.cashExpenseReporting,
    );
    renderProjectionSummary(
        months,
        settings.sheetOnly,
        settings.projectMonths,
        settings.cashExpenseReporting,
    );
    renderRaisedInvoicesPivot(months);
    renderIncomePivot(months);
    renderExpensePivot(
        months,
        settings.pivotDimension,
        settings.sheetOnly,
        settings.cashExpenseReporting,
    );
    wirePivotDrilldown();
};

const wireBalanceMetricClicks = () => {
    const el = document.getElementById('fa-balance-metrics');
    if (!el || el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => {
        const billsCard = e.target.closest('[data-goto-bills-wallet]');
        if (billsCard) {
            window.switchView?.('finance-docs');
            return;
        }
        const card = e.target.closest('[data-goto-bank-recon]');
        if (!card) return;
        const focusUnmatched = card.hasAttribute('data-focus-unmatched-ledger');
        window.switchView?.('finance-bank-recon');
        if (focusUnmatched) {
            requestAnimationFrame(() => {
                const panel = document.getElementById('bank-recon-txns');
                panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                panel?.classList.add('bank-recon-txns--highlight');
                setTimeout(() => panel?.classList.remove('bank-recon-txns--highlight'), 2400);
            });
        }
    });
};

export const initFinanceAnalyticsUi = () => {
    const rerender = () => renderFinanceAnalytics();

    ['fa-month-range', 'fa-pivot-dimension', 'fa-sheet-only', 'fa-project-months', 'fa-date-tolerance'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', rerender);
    });

    const cashModeEl = document.getElementById('fa-cash-expense-reporting');
    if (cashModeEl && !cashModeEl.dataset.wired) {
        cashModeEl.dataset.wired = '1';
        setCashExpenseReportingMode(getCashExpenseReportingMode());
        const applyMode = (mode) => {
            setCashExpenseReportingMode(mode);
            rerender();
        };
        cashModeEl.querySelector('.fa-cash-mode__toggle')?.addEventListener('click', () => {
            applyMode(getCashExpenseReportingMode() === 'cash_detail' ? 'petty_bank' : 'cash_detail');
        });
        cashModeEl.querySelectorAll('.fa-cash-mode__side').forEach((side) => {
            side.addEventListener('click', () => applyMode(side.dataset.side));
        });
    }

    void import('./financeReportsExport.js').then(({ initFinanceReportsExport }) => {
        initFinanceReportsExport();
    });

    const projectionToggle = document.getElementById('fa-projection-toggle');
    const projectionPopover = document.getElementById('fa-projection-popover');
    if (projectionToggle && projectionPopover && !projectionToggle.dataset.wired) {
        projectionToggle.dataset.wired = '1';
        const setOpen = (open) => {
            projectionPopover.hidden = !open;
            projectionToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            projectionToggle.classList.toggle('fa-projection-icon-btn--open', open);
        };
        projectionToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(projectionPopover.hidden);
        });
        document.addEventListener('click', (e) => {
            if (projectionPopover.hidden) return;
            if (e.target.closest('.fa-projection-anchor')) return;
            setOpen(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !projectionPopover.hidden) setOpen(false);
        });
    }

    document.getElementById('fa-goto-bank-recon')?.addEventListener('click', () => {
        window.location.hash = '#finance-bank-recon';
    });
};
