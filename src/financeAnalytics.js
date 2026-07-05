/**
 * Financial Reports — balance reconciliation, NoBroker alignment,
 * expense-sheet pivot, and income/expense trend projections.
 */
import { portalState } from './store.js';
import { navigateToLedgerFromPivot } from './ledgerFilter.js';
import {
    getMatchedTransactionIds,
    getUnmatchedBankLines,
    getUnmatchedLedgerTxns,
    getNoBrokerDump,
    loadNoBrokerDumpFile,
    clearNoBrokerDump,
    autoMatchByDateAndAmount,
    autoCreateFromUnmatchedLines,
    reconcileBankWithNoBroker,
    getDateTolerance,
    isTransactionReconciled,
} from './bankReconciliation.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const CAT_LABELS = {
    Security: 'Security / Guards',
    Maintenance: 'General Maintenance',
    Plumbing: 'Plumbing / Water',
    Electrical: 'Electrical / Diesel',
    Stationery: 'Office / Stationery',
    'Maintenance Collection': 'Maintenance Collection',
    Marketing: 'Marketing / Events',
    Promotion: 'Promotion / Sponsorship',
    Interest: 'Bank Interest',
    'Petty Inflow': 'Petty Cash Top-up',
    'Bank Reject': 'Bank Reject',
    Reconcile: 'Bank Reconciliation',
    'Other Income': 'Other Income',
    Other: 'Miscellaneous',
};

const labelForCat = (cat) => CAT_LABELS[cat] || cat || 'Uncategorised';

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

const computeWalletBalances = () => {
    let cash = 0;
    let bank = 0;
    (portalState.finances.txns || []).forEach((t) => {
        const amt = parseFloat(t.amount) || 0;
        const wallet = (t.wallet || 'CASH').toUpperCase();
        const delta = t.type === 'IN' ? amt : -amt;
        if (wallet === 'BANK') bank += delta;
        else cash += delta;
    });
    return { cash, bank, total: cash + bank };
};

const latestStatementClosingBalance = () => {
    const lines = portalState.finances.bankStatementLines || [];
    if (!lines.length) return null;
    const sorted = [...lines].sort((a, b) => {
        const da = `${a.line_date || ''}T12:00:00`;
        const db = `${b.line_date || ''}T12:00:00`;
        return da.localeCompare(db);
    });
    for (let i = sorted.length - 1; i >= 0; i--) {
        const bal = parseFloat(sorted[i].balance);
        if (Number.isFinite(bal)) return bal;
    }
    return null;
};

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

const filterExpenses = (structuredOnly) => {
    const txns = portalState.finances.txns || [];
    return txns.filter((t) =>
        t.type === 'OUT'
        && isReportableTxn(t)
        && (!structuredOnly || isStructuredExpense(t)),
    );
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
    return txn.cat || 'Other';
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

const buildIncomePivot = (months, dimension = 'cat') =>
    buildCategoryPivot(filterIncome(), months, dimension);

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

const linearProject = (values, futureCount) => {
    const n = values.length;
    if (!n) return Array(futureCount).fill(0);
    if (n === 1) return Array(futureCount).fill(Math.max(0, values[0]));
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += values[i];
        sumXY += i * values[i];
        sumX2 += i * i;
    }
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    return Array.from({ length: futureCount }, (_, i) =>
        Math.max(0, Math.round(intercept + slope * (n + i))),
    );
};

let combinedChartInstance = null;

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

const renderCombinedCategoryChart = (months, sheetOnly, pivotDimension) => {
    const canvas = document.getElementById('fa-combined-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    if (combinedChartInstance) {
        combinedChartInstance.destroy();
        combinedChartInstance = null;
    }

    const incomeRows = topCategoryRows(buildIncomePivot(months, 'cat').rows, 6);
    const expenseRows = topCategoryRows(
        buildExpensePivot(filterExpenses(sheetOnly), months, pivotDimension).rows,
        6,
    );

    const labels = months.map((m) => m.label);
    const datasets = [
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

    combinedChartInstance = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 10, font: { size: 10 }, padding: 6 },
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const v = ctx.parsed.y;
                            return v > 0 ? `${ctx.dataset.label}: ${formatMoney(v)}` : '';
                        },
                        footer: (items) => {
                            const incomeTotal = items
                                .filter((i) => i.dataset.stack === 'income')
                                .reduce((s, i) => s + (i.parsed.y || 0), 0);
                            const expenseTotal = items
                                .filter((i) => i.dataset.stack === 'expense')
                                .reduce((s, i) => s + (i.parsed.y || 0), 0);
                            const parts = [];
                            if (incomeTotal > 0) parts.push(`Income: ${formatMoney(incomeTotal)}`);
                            if (expenseTotal > 0) parts.push(`Expenses: ${formatMoney(expenseTotal)}`);
                            return parts.join(' · ');
                        },
                    },
                },
            },
            scales: {
                x: { stacked: true, grid: { display: false } },
                y: {
                    stacked: true,
                    ticks: {
                        callback: (v) => `₹${Number(v).toLocaleString('en-IN')}`,
                    },
                },
            },
        },
    });
};

const renderProjectionSummary = (months, sheetOnly, projectCount) => {
    const summaryEl = document.getElementById('fa-projection-summary');
    if (!summaryEl) return;

    const expenses = filterExpenses(sheetOnly);
    const income = filterIncome();
    const expenseTotals = monthlyTotals(expenses, months);
    const incomeTotals = monthlyTotals(income, months);

    const projIncome = linearProject(incomeTotals, projectCount);
    const projExpense = linearProject(expenseTotals, projectCount);
    const projNet = projIncome.map((v, i) => v - projExpense[i]);

    const projLabels = Array.from({ length: projectCount }, (_, i) => {
        const d = new Date();
        d.setMonth(d.getMonth() + i + 1);
        return monthLabel(d.getFullYear(), d.getMonth());
    });

    const avgIncome = incomeTotals.reduce((a, b) => a + b, 0) / Math.max(1, incomeTotals.length);
    const avgExpense = expenseTotals.reduce((a, b) => a + b, 0) / Math.max(1, expenseTotals.length);
    const nextNet = projNet.reduce((a, b) => a + b, 0);

    summaryEl.innerHTML = `
      <h3 class="fa-panel__title">Trend projection</h3>
      <p class="fa-projection-note">Linear trend forecast for the next ${projectCount} month(s) from recent aggregate totals.</p>
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

const getNobrokerState = () => getNoBrokerDump();

const getSettings = () => ({
    monthCount: parseInt(document.getElementById('fa-month-range')?.value || '12', 10),
    pivotDimension: document.getElementById('fa-pivot-dimension')?.value || 'cat',
    sheetOnly: document.getElementById('fa-sheet-only')?.checked !== false,
    projectMonths: parseInt(document.getElementById('fa-project-months')?.value || '3', 10),
});

const renderBalanceMetrics = () => {
    const el = document.getElementById('fa-balance-metrics');
    if (!el) return;

    const { cash, bank, total } = computeWalletBalances();
    const stmtBal = latestStatementClosingBalance();
    const variance = stmtBal != null ? bank - stmtBal : null;
    const unmatchedLines = getUnmatchedBankLines().length;
    const unreconciledTxns = getUnmatchedLedgerTxns().length;
    const unmatchedNet = sumUnmatchedStatementNet();
    const unreconciledNet = sumUnreconciledLedgerNet();
    const matchedCount = getMatchedTransactionIds().size;

    const varianceClass =
        variance == null ? '' : Math.abs(variance) < 1 ? 'fa-metric--ok' : 'fa-metric--warn';

    el.innerHTML = `
      <div class="metric-card fa-metric">
        <span class="label">Ledger bank balance</span>
        <span class="value">${formatMoney(bank)}</span>
        <span class="fa-metric__sub">Computed from income & expense ledger</span>
      </div>
      <div class="metric-card fa-metric">
        <span class="label">Statement closing balance</span>
        <span class="value">${stmtBal != null ? formatMoney(stmtBal) : '—'}</span>
        <span class="fa-metric__sub">${stmtBal != null ? 'Latest imported statement' : 'Import via Bank Reconciliation'}</span>
      </div>
      <div class="metric-card fa-metric ${varianceClass}">
        <span class="label">Bank variance</span>
        <span class="value">${variance != null ? formatMoney(variance) : '—'}</span>
        <span class="fa-metric__sub">${variance != null && Math.abs(variance) < 1 ? 'Aligned' : 'Ledger minus statement balance'}</span>
      </div>
      <div class="metric-card fa-metric">
        <span class="label">Petty cash</span>
        <span class="value">${formatMoney(cash)}</span>
        <span class="fa-metric__sub">Total wealth ${formatMoney(total)}</span>
      </div>
      <div class="metric-card fa-metric">
        <span class="label">Unmatched statement</span>
        <span class="value" style="color:var(--danger);">${unmatchedLines}</span>
        <span class="fa-metric__sub">Net ${formatMoney(unmatchedNet)}</span>
      </div>
      <div class="metric-card fa-metric">
        <span class="label">Unreconciled ledger</span>
        <span class="value" style="color:var(--warning, #d97706);">${unreconciledTxns}</span>
        <span class="fa-metric__sub">Net ${formatMoney(unreconciledNet)} · ${matchedCount} matched</span>
      </div>`;
};

const ledgerMaintenanceByMonth = (months) => {
    const income = filterIncome().filter((t) => t.cat === 'Maintenance Collection');
    return monthlyTotals(income, months);
};

const nobrokerByMonth = (lines, months) =>
    months.map(({ y, m }) =>
        lines
            .filter((l) => {
                const d = new Date(`${l.date}T12:00:00`);
                return d.getFullYear() === y && d.getMonth() === m;
            })
            .reduce((s, l) => s + (parseFloat(l.amount) || 0), 0),
    );

const renderNoBrokerPanel = (months) => {
    const el = document.getElementById('fa-nobroker-panel');
    if (!el) return;

    const { lines: nobrokerDumpLines, fileName: nobrokerFileName } = getNobrokerState();

    if (!nobrokerDumpLines.length) {
        el.innerHTML = `
          <div class="fa-panel__head">
            <h3><i class="fa-solid fa-building"></i> NoBroker collections alignment</h3>
            <p>Upload a NoBroker payment export to compare against maintenance collections recorded in the ledger.</p>
          </div>
          <p class="maintenance-dues-empty">No NoBroker dump loaded. Use <strong>Upload NoBroker dump</strong> above.</p>`;
        return;
    }

    const ledgerTotals = ledgerMaintenanceByMonth(months);
    const nbTotals = nobrokerByMonth(nobrokerDumpLines, months);
    let totalLedger = 0;
    let totalNb = 0;
    let totalGap = 0;

    const rows = months
        .map((mo, i) => {
            const ledger = ledgerTotals[i];
            const nb = nbTotals[i];
            const gap = ledger - nb;
            if (ledger < 0.001 && nb < 0.001) return '';
            totalLedger += ledger;
            totalNb += nb;
            totalGap += gap;
            const gapClass = Math.abs(gap) < 1 ? 'fa-gap--ok' : 'fa-gap--warn';
            return `<tr>
              <td>${mo.label}</td>
              <td class="fa-num">${formatMoney(nb)}</td>
              <td class="fa-num">${formatMoney(ledger)}</td>
              <td class="fa-num ${gapClass}">${formatMoney(gap)}</td>
            </tr>`;
        })
        .filter(Boolean)
        .join('');

    el.innerHTML = `
      <div class="fa-panel__head fa-panel__head--row">
        <div>
          <h3><i class="fa-solid fa-building"></i> NoBroker collections alignment</h3>
          <p>Comparing <strong>${nobrokerFileName}</strong> (${nobrokerDumpLines.length} rows) to ledger maintenance collections.</p>
        </div>
        <div class="fa-toolbar__actions">
          <button type="button" class="btn btn-outline btn--small" id="fa-auto-match-btn"><i class="fa-solid fa-link"></i> Auto-match by date</button>
          <button type="button" class="btn btn-primary btn--small" id="fa-nobroker-reconcile-btn"><i class="fa-solid fa-building-circle-check"></i> Reconcile bank + NoBroker</button>
          <button type="button" class="btn btn-outline btn--small" id="fa-auto-create-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Create ledger entries</button>
        </div>
      </div>
      <div class="fa-table-wrap">
        <table class="fa-pivot-table">
          <thead>
            <tr>
              <th>Month</th>
              <th class="fa-num">NoBroker dump</th>
              <th class="fa-num">Ledger collections</th>
              <th class="fa-num">Gap (ledger − dump)</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="4" class="maintenance-dues-empty">No overlapping months in range</td></tr>'}</tbody>
          <tfoot>
            <tr>
              <td><strong>Total</strong></td>
              <td class="fa-num"><strong>${formatMoney(totalNb)}</strong></td>
              <td class="fa-num"><strong>${formatMoney(totalLedger)}</strong></td>
              <td class="fa-num"><strong>${formatMoney(totalGap)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
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
        dimension === 'sub_category' ? 'Sub-category' : dimension === 'vendor' ? 'Vendor' : 'Category';
    const amountClass = type === 'IN' ? 'fa-income' : 'fa-expense';

    if (!rows.length) {
        if (metaEl) metaEl.innerHTML = '';
        el.innerHTML = `<p class="maintenance-dues-empty">${emptyMessage}</p>`;
        return;
    }

    const colTotals = months.map((_, i) => rows.reduce((s, r) => s + r.cells[i], 0));
    const grandTotal = colTotals.reduce((a, b) => a + b, 0);

    const pivotCell = (value, row, monthIndex) => {
        if (value <= 0.001) return '<td class="fa-num">—</td>';
        const month = monthIndex != null ? months[monthIndex] : null;
        if (!clickable || row.key === '__other__') {
            return `<td class="fa-num ${amountClass}">${formatMoney(value)}</td>`;
        }
        const attrs = [
            `class="fa-num fa-pivot-cell fa-pivot-cell--clickable ${amountClass}"`,
            'role="button" tabindex="0"',
            `data-pivot-type="${type}"`,
            `data-pivot-dimension="${dimension}"`,
            `data-pivot-key="${escAttr(row.key)}"`,
            `data-pivot-label="${escAttr(row.label)}"`,
            month ? `data-pivot-year="${month.y}" data-pivot-month="${month.m}"` : '',
            `title="View matching ledger entries"`,
        ].filter(Boolean).join(' ');
        return `<td ${attrs}>${formatMoney(value)}</td>`;
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
              ${r.cells.map((v, i) => pivotCell(v, r, i)).join('')}
              <td class="fa-num fa-col-total"><strong>${formatMoney(r.total)}</strong></td>
            </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Monthly total</strong></td>
            ${colTotals.map((v) => `<td class="fa-num"><strong>${formatMoney(v)}</strong></td>`).join('')}
            <td class="fa-num fa-col-total"><strong>${formatMoney(grandTotal)}</strong></td>
          </tr>
        </tfoot>
      </table>`;
};

const renderIncomePivot = (months) => {
    const el = document.getElementById('fa-income-pivot');
    const metaEl = document.getElementById('fa-income-pivot-meta');
    const income = filterIncome();
    const excludedCount = (portalState.finances.txns || []).filter(
        (t) => t.type === 'IN' && t.exclude_from_reports,
    ).length;

    if (metaEl) {
        metaEl.innerHTML = excludedCount
            ? `<span class="fa-meta-chip">${income.length} in reports</span>
               <span class="fa-meta-chip">${excludedCount} excluded from reports</span>`
            : `<span class="fa-meta-chip">${income.length} income entries</span>`;
    }

    const { rows } = buildIncomePivot(months, 'cat');
    renderPivotTable({
        el,
        metaEl,
        rows,
        months,
        dimension: 'cat',
        type: 'IN',
        emptyMessage: 'No income in this range.',
    });
};

const renderExpensePivot = (months, dimension, sheetOnly) => {
    const el = document.getElementById('fa-expense-pivot');
    const metaEl = document.getElementById('fa-expense-pivot-meta');

    const allOut = (portalState.finances.txns || []).filter((t) => t.type === 'OUT');
    const expenses = filterExpenses(sheetOnly);
    const sheetCount = allOut.filter(isExpenseFromSheet).length;
    const bankCount = allOut.filter(isExpenseFromBankRecon).length;
    const excludedCount = allOut.length - expenses.length;

    if (metaEl) {
        metaEl.innerHTML = sheetOnly
            ? `<span class="fa-meta-chip fa-meta-chip--sheet">${sheetCount} from expense sheets</span>
               <span class="fa-meta-chip">${bankCount} from bank reconciliation</span>
               <span class="fa-meta-chip">${excludedCount} manual entries excluded</span>`
            : `<span class="fa-meta-chip">${expenses.length} total expenses (${sheetCount} sheets, ${bankCount} bank)</span>`;
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

const wirePivotDrilldown = () => {
    const el = document.getElementById('fa-expense-pivot');
    if (!el || el.dataset.pivotWired) return;
    el.dataset.pivotWired = '1';

    const openFromCell = (cell) => {
        if (!cell?.classList.contains('fa-pivot-cell--clickable')) return;
        navigateToLedgerFromPivot({
            type: cell.dataset.pivotType || 'OUT',
            dimension: cell.dataset.pivotDimension || 'cat',
            key: cell.dataset.pivotKey,
            label: cell.dataset.pivotLabel,
            year: cell.dataset.pivotYear ? parseInt(cell.dataset.pivotYear, 10) : null,
            month: cell.dataset.pivotMonth ? parseInt(cell.dataset.pivotMonth, 10) : null,
        });
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

export const renderFinanceAnalytics = () => {
    const settings = getSettings();
    const months = buildMonthRange(settings.monthCount);

    renderBalanceMetrics();
    renderNoBrokerPanel(months);
    wireNoBrokerActions();
    renderCombinedCategoryChart(months, settings.sheetOnly, settings.pivotDimension);
    renderProjectionSummary(months, settings.sheetOnly, settings.projectMonths);
    renderIncomePivot(months);
    renderExpensePivot(months, settings.pivotDimension, settings.sheetOnly);
    wirePivotDrilldown();
};

const handleNoBrokerUpload = async (file) => {
    if (!file) return;
    try {
        const count = await loadNoBrokerDumpFile(file);
        alert(`Loaded ${count} NoBroker payment row(s).`);
        renderFinanceAnalytics();
        window.renderBankReconciliation?.();
    } catch (err) {
        alert(err.message || 'Could not parse NoBroker file.');
    }
};

const wireNoBrokerActions = () => {
    document.getElementById('fa-auto-match-btn')?.addEventListener('click', async () => {
        const tol = getDateTolerance();
        if (!confirm(`Auto-match bank statement lines to ledger entries (${tol === 0 ? 'exact date' : `±${tol} days`}, same amount)?`)) return;
        try {
            const { matched, errors } = await autoMatchByDateAndAmount();
            renderFinanceAnalytics();
            window.renderBankReconciliation?.();
            window.renderCashLedger?.();
            alert(`Matched ${matched.length} line(s).${errors.length ? `\n\n${errors.slice(0, 6).join('\n')}` : ''}`);
        } catch (err) {
            alert(err?.message || 'Auto-match failed.');
        }
    }, { once: true });

    document.getElementById('fa-nobroker-reconcile-btn')?.addEventListener('click', async () => {
        const tol = getDateTolerance();
        if (!confirm(`Reconcile bank credits with NoBroker dump (${tol === 0 ? 'exact date' : `±${tol} days`}) and create missing collections?`)) return;
        try {
            const { matchedLedger, created, unmatched, errors } = await reconcileBankWithNoBroker({ createMissing: true });
            renderFinanceAnalytics();
            window.renderBankReconciliation?.();
            window.renderCashLedger?.();
            window.processFinances?.();
            alert([
                `Matched ${matchedLedger} to existing ledger.`,
                created ? `Created ${created} collection(s).` : '',
                unmatched.length ? `${unmatched.length} bank line(s) without NoBroker match.` : '',
                errors.length ? `\n${errors.slice(0, 6).join('\n')}` : '',
            ].filter(Boolean).join('\n'));
        } catch (err) {
            alert(err?.message || 'Reconcile failed.');
        }
    }, { once: true });

    document.getElementById('fa-auto-create-btn')?.addEventListener('click', async () => {
        if (!confirm('Create ledger entries for unmatched bank lines (matching existing entries by date/amount first)?')) return;
        try {
            const { created, matchedExisting, errors } = await autoCreateFromUnmatchedLines({ includeDebits: true });
            renderFinanceAnalytics();
            window.renderBankReconciliation?.();
            window.renderCashLedger?.();
            window.processFinances?.();
            alert(`Created ${created}, linked ${matchedExisting}.${errors.length ? `\n\n${errors.slice(0, 6).join('\n')}` : ''}`);
        } catch (err) {
            alert(err?.message || 'Auto-create failed.');
        }
    }, { once: true });
};

export const initFinanceAnalyticsUi = () => {
    const rerender = () => renderFinanceAnalytics();

    ['fa-month-range', 'fa-pivot-dimension', 'fa-sheet-only', 'fa-project-months', 'fa-date-tolerance'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', rerender);
    });

    document.getElementById('fa-nobroker-upload-btn')?.addEventListener('click', () => {
        document.getElementById('fa-nobroker-file')?.click();
    });

    document.getElementById('fa-nobroker-file')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) void handleNoBrokerUpload(file);
        e.target.value = '';
    });

    document.getElementById('fa-clear-nobroker-btn')?.addEventListener('click', () => {
        clearNoBrokerDump();
        renderFinanceAnalytics();
        window.renderBankReconciliation?.();
    });

    document.getElementById('fa-goto-bank-recon')?.addEventListener('click', () => {
        window.location.hash = '#finance-bank-recon';
    });
};
