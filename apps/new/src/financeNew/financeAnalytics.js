/** Finance-New clone of classic module (financeAnalytics.js) — Mongo-backed, isolated DOM (fn-*). */
import { fnFinances, ensureFnClassicShape } from './classicState.js';
/**
 * Financial Reports — balance reconciliation, raised/income/expense pivots,
 * and income/expense trend projections.
 *
 * Heavy siblings (bank recon / docs / ledger filter / nobroker) are lazy-loaded
 * so the reports MPA does not pull those graphs on first paint.
 */
import { portalState } from '../store.js';
import { normalizeCategoryKey, categoryDisplayLabel } from '../expenseCategories.js';
import {
    getCashExpenseReportingMode,
    setCashExpenseReportingMode,
    isBankPettyFunding,
    isCashDeskSpend,
} from './cashFloat.js';
import { fetchFinanceNewReport } from './api.js';
import { getFinanceNew } from './state.js';
import { navigateFinance } from '../financeApp/session.js';
import { getLedgerBankBalance } from './ledgerBalance.js';
import { getBankOpeningConfig } from './bankStatementQueries.js';

/** @type {typeof import('./bankReconciliation.js')|null} */
let bankReconApi = null;
/** @type {typeof import('./financeDocuments.js')|null} */
let financeDocsApi = null;
/** @type {typeof import('./nobrokerInvoicesRaised.js')|null} */
let nobrokerApi = null;

async function ensureBankReconApi() {
    if (!bankReconApi) bankReconApi = await import('./bankReconciliation.js');
    return bankReconApi;
}
async function ensureFinanceDocsApi() {
    if (!financeDocsApi) financeDocsApi = await import('./financeDocuments.js');
    return financeDocsApi;
}
async function ensureNobrokerApi() {
    if (!nobrokerApi) nobrokerApi = await import('./nobrokerInvoicesRaised.js');
    return nobrokerApi;
}

/** Ensure bank recon + bills helpers for book-balance KPIs (expense plan, etc.). */
export async function ensureBookBalanceClients() {
    await Promise.all([ensureBankReconApi(), ensureFinanceDocsApi()]);
}

const isTransactionReconciled = (id) => bankReconApi?.isTransactionReconciled?.(id) || false;
const getMatchedTransactionIds = () => bankReconApi?.getMatchedTransactionIds?.() || new Set();
const getUnmatchedBankLines = () => bankReconApi?.getUnmatchedBankLines?.() || [];
const getUnmatchedLedgerTxns = (type) => bankReconApi?.getUnmatchedLedgerTxns?.(type) || [];
const getBankBalanceReconciliation = () => bankReconApi?.getBankBalanceReconciliation?.() || {
    diff: null,
    passbook: { balance: null, asOf: null },
    calculated: { balance: null, asOf: null },
};
const getCashWalletLeft = () => financeDocsApi?.getCashWalletLeft?.() ?? (analyticsPack?.bookBalance?.cash ?? 0);
const getOpenExpenseDocuments = () => financeDocsApi?.getOpenExpenseDocuments?.() || [];
const getChequeReadyExpenseDocuments = () => financeDocsApi?.getChequeReadyExpenseDocuments?.() || [];
const getOpenChequeExpenseDocuments = () => financeDocsApi?.getOpenChequeExpenseDocuments?.() || [];
const isChequeFinanceDocument = (d) => financeDocsApi?.isChequeFinanceDocument?.(d) || false;
const cashBillsAsReportExpenses = () => financeDocsApi?.cashBillsAsReportExpenses?.() || [];
const getNoBrokerInvoicesRaised = () => nobrokerApi?.getNoBrokerInvoicesRaised?.() || [];
const buildRaisedInvoicesStack = (months, invoices) => {
    if (nobrokerApi?.buildRaisedInvoicesStack) return nobrokerApi.buildRaisedInvoicesStack(months, invoices);
    return { heads: [], series: {}, monthTotals: months.map(() => 0) };
};

const formatMoney = (n) => {
    const v = parseFloat(n || 0);
    const abs = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    if (v < -0.009) return `−₹${abs}`;
    return `₹${abs}`;
};

/** Latest Mongo analytics pack for #fn-reports (server pivots). */
let analyticsPack = null;

export const getReportsAnalyticsPack = () => analyticsPack;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const labelForCat = (cat) => categoryDisplayLabel(cat);

/** Expenses synced from the expense spreadsheet (ledger sync). */
export const isExpenseFromSheet = (txn) =>
    txn?.type === 'OUT' && Boolean(txn.external_sync_key || txn.sync_hash);

/** OUT transactions linked to a matched bank statement line (same as ledger “Reconciled” badge). */
export const isExpenseFromBankRecon = (txn) =>
    txn?.type === 'OUT' && isTransactionReconciled(txn.id);

export const isStructuredExpense = (txn) =>
    isExpenseFromSheet(txn) || isExpenseFromBankRecon(txn);

/** Bank OUT that looks like a cheque (type CHEQUE, or CHQ/CHEQUE in narration/ref). */
export const isLedgerChequePayment = (t) => {
    if (!t || t.type !== 'OUT' || (t.wallet || 'CASH') !== 'BANK') return false;
    if (t.excluded_from_ledger) return false;
    const typ = String(t.bank_payment_type || '').toUpperCase();
    if (typ === 'CHEQUE') return true;
    if (typ === 'UPI' || typ === 'NEFT' || typ === 'IMPS' || typ === 'RTGS') return false;
    const hay = `${t.description || ''} ${t.bank_reference || ''} ${t.vendor_name || ''}`.toUpperCase();
    return /\bCHQ\b|CHEQUE/.test(hay);
};

/**
 * Pending commitments for book balance:
 * - unpaid expense bills
 * - cheque-ready bills (cheque given, not linked)
 * - unmatched bank ledger cheque OUTs (posted, not yet on statement)
 */
export const getPendingChequesSummary = () => {
    const openBills = getOpenChequeExpenseDocuments();
    const openAmt = round2(openBills.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
    const uncleared = getUnmatchedLedgerTxns('OUT').filter(isLedgerChequePayment);
    const unclearedAmt = round2(uncleared.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0));
    return {
        openBills,
        uncleared,
        openAmt,
        unclearedAmt,
        openCount: openBills.length,
        unclearedCount: uncleared.length,
        total: round2(openAmt + unclearedAmt),
        count: openBills.length + uncleared.length,
    };
};

const isoDay = (v) => {
    const s = String(v || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
};

/** Book balance = ledger running balance + Wallet Left − pending cheques. */
export const getBookBalanceSummary = () => {
    const ledgerBank = getLedgerBankBalance();
    const ledgerReady = !!getFinanceNew().ledgerLoaded && (ledgerBank.txnCount || 0) > 0;
    const packBb = analyticsPack?.bookBalance;
    const packAsOf = isoDay(packBb?.asOf);
    const openingDay = isoDay(getBankOpeningConfig().date);
    const ledgerAsOf = isoDay(ledgerBank.asOf);

    let bankBalance = ledgerBank.balance ?? null;
    let asOf = ledgerAsOf || packAsOf || openingDay || null;
    if (!ledgerReady && packBb?.bankBalance != null) {
        bankBalance = packBb.bankBalance;
        asOf = packAsOf || asOf;
    } else if (
        ledgerAsOf
        && openingDay
        && ledgerAsOf === openingDay
        && packAsOf
        && packAsOf > openingDay
        && packBb?.bankBalance != null
    ) {
        bankBalance = packBb.bankBalance;
        asOf = packAsOf;
    }

    const hasBank = bankBalance != null;

    if (analyticsPack?.bookBalance) {
        const bb = analyticsPack.bookBalance;
        const packRecon = analyticsPack.recon || {};
        const cash = bb.cash ?? 0;
        const pendingTotal = bb.pending?.total ?? 0;
        const book = hasBank ? round2(bankBalance + cash - pendingTotal) : round2(cash);
        const passbookBalance = packRecon.passbook?.balance ?? null;
        const reconDiff = hasBank && passbookBalance != null
            ? round2(bankBalance - passbookBalance)
            : null;

        return {
            cash,
            bankBalance,
            hasBank,
            pending: {
                openBills: [],
                uncleared: [],
                openAmt: bb.pending?.openAmt || 0,
                unclearedAmt: bb.pending?.unclearedAmt || 0,
                openCount: bb.pending?.openCount || 0,
                unclearedCount: bb.pending?.unclearedCount || 0,
                total: pendingTotal,
                count: bb.pending?.count || 0,
            },
            book,
            asOf,
            recon: {
                diff: reconDiff,
                passbook: { balance: passbookBalance, asOf: packRecon.passbook?.asOf || asOf },
                calculated: { balance: bankBalance, asOf },
            },
        };
    }

    const cash = getCashWalletLeft();
    const recon = getBankBalanceReconciliation();
    const pending = getPendingChequesSummary();
    const book = hasBank
        ? round2(bankBalance + cash - pending.total)
        : round2(cash);
    return {
        cash,
        bankBalance,
        hasBank,
        pending,
        book,
        asOf: asOf || recon.calculated?.asOf,
        recon,
    };
};

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
  if (analyticsPack) {
    return {
      months: analyticsPack.months,
      settings: analyticsPack.settings,
      raised: analyticsPack.raised,
      income: analyticsPack.income,
      expense: analyticsPack.expense,
      monthly: analyticsPack.monthly,
    };
  }
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
    const txns = fnFinances().txns || [];

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
    (fnFinances().txns || []).filter((t) => t.type === 'IN' && isReportableTxn(t));

const monthlyTotals = (txns, months) =>
    months.map(({ y, m }) =>
        txns
            .filter((t) => {
                const d = new Date(t.date);
                return d.getFullYear() === y && d.getMonth() === m;
            })
            .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0),
    );

/** Ledger / bill wallet for Cash vs Bank reporting (anything not BANK → CASH). */
const reportWallet = (txn) =>
    String(txn?.wallet || '').toUpperCase() === 'BANK' ? 'BANK' : 'CASH';

const walletGroupLabel = (wallet) => (wallet === 'BANK' ? 'Bank' : 'Cash');

const WALLET_CAT_SEP = '|';

const pivotKey = (txn, dimension) => {
    if (dimension === 'sub_category') return txn.sub_category?.trim() || '(none)';
    if (dimension === 'vendor') return txn.vendor_name?.trim() || '(none)';
    if (dimension === 'wallet_cat') {
        const cat = normalizeCategoryKey(txn.cat || 'Other');
        return `${reportWallet(txn)}${WALLET_CAT_SEP}${cat}`;
    }
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

/** Cash / Bank as parent rows, categories nested underneath (expense pivot only). */
const buildWalletCategoryPivot = (txns, months) => {
    const rows = [];
    for (const wallet of ['CASH', 'BANK']) {
        const walletTxns = txns.filter((t) => reportWallet(t) === wallet);
        const { rows: catRows } = buildCategoryPivot(walletTxns, months, 'cat');
        if (!catRows.length) continue;

        const groupCells = months.map((_, i) => catRows.reduce((s, r) => s + r.cells[i], 0));
        const groupTotal = groupCells.reduce((a, b) => a + b, 0);
        rows.push({
            key: wallet,
            label: walletGroupLabel(wallet),
            cells: groupCells,
            total: groupTotal,
            rowKind: 'wallet-group',
            wallet,
        });
        catRows.forEach((r) => {
            rows.push({
                key: `${wallet}${WALLET_CAT_SEP}${r.key}`,
                label: r.label,
                cells: r.cells,
                total: r.total,
                rowKind: 'wallet-cat',
                wallet,
                categoryKey: r.key,
            });
        });
    }

    const leafRows = rows.filter((r) => r.rowKind === 'wallet-cat');
    const colTotals = months.map((_, i) => leafRows.reduce((s, r) => s + r.cells[i], 0));
    const grandTotal = colTotals.reduce((a, b) => a + b, 0);
    return { rows, colTotals, grandTotal };
};

const buildIncomePivot = (months, dimension = 'cat', incomeTxns = filterIncome()) =>
    buildCategoryPivot(incomeTxns, months, dimension);

const buildExpensePivot = (expenses, months, dimension) =>
    (dimension === 'wallet_cat'
        ? buildWalletCategoryPivot(expenses, months)
        : buildCategoryPivot(expenses, months, dimension));

/** Leaf rows for charts / top-N (skip Cash/Bank group headers). */
const expenseRowsForChart = (rows) =>
    rows
        .filter((r) => r.rowKind !== 'wallet-group')
        .map((r) => (r.rowKind === 'wallet-cat'
            ? { ...r, label: `${walletGroupLabel(r.wallet)} · ${r.label}` }
            : r));

/** Keep top N categories by total; roll the rest into "Other" (preserves month totals). */
const topCategoryRows = (rows, limit = 8) => {
    if (!rows?.length) return [];
    if (rows.length <= limit) return rows.map((r) => ({
        ...r,
        cells: (r.cells || []).map((v) => Number(v) || 0),
    }));
    const sorted = [...rows].sort((a, b) => (b.total || 0) - (a.total || 0));
    const top = sorted.slice(0, limit).map((r) => ({
        ...r,
        cells: (r.cells || []).map((v) => Number(v) || 0),
    }));
    const rest = sorted.slice(limit);
    const cellLen = Math.max(top[0]?.cells?.length || 0, ...rest.map((r) => r.cells?.length || 0));
    const otherCells = monthsCellsFromRows(rest, cellLen);
    const otherTotal = otherCells.reduce((a, b) => a + b, 0);
    if (otherTotal <= 0.001) return top;
    return [...top, { key: '__other__', label: 'Other', cells: otherCells, total: otherTotal }];
};

const monthsCellsFromRows = (rows, len) =>
    Array.from({ length: len }, (_, i) =>
        round2(rows.reduce((s, r) => s + (Number(r.cells?.[i]) || 0), 0)));

/**
 * Ensure stacked bar height matches known monthly totals (pivot / summary).
 * Any shortfall is added to Other so the chart cannot under-represent the tables.
 */
const reconcileStackRowsToMonthly = (rows, monthlyTotals, monthCount) => {
    const list = (rows || []).map((r) => ({
        ...r,
        cells: Array.from({ length: monthCount }, (_, i) => Number(r.cells?.[i]) || 0),
        total: Number(r.total) || 0,
    }));
    const targets = Array.from({ length: monthCount }, (_, i) => Number(monthlyTotals?.[i]) || 0);
    const sums = monthsCellsFromRows(list, monthCount);
    let other = list.find((r) => r.key === '__other__' || String(r.label || '').toLowerCase() === 'other');
    let createdOther = false;
    if (!other) {
        other = { key: '__other__', label: 'Other', cells: Array(monthCount).fill(0), total: 0 };
        list.push(other);
        createdOther = true;
    }
    let touched = false;
    for (let i = 0; i < monthCount; i += 1) {
        const gap = round2(targets[i] - sums[i]);
        if (gap > 0.009) {
            other.cells[i] = round2((other.cells[i] || 0) + gap);
            touched = true;
        }
    }
    if (touched) {
        other.total = round2(other.cells.reduce((a, b) => a + b, 0));
    } else if (createdOther) {
        list.pop();
    }
    return list.filter((r) => (r.total > 0.001) || (r.cells || []).some((v) => v > 0.001));
};

const seriesCellsOrZero = (cells, monthCount) =>
    Array.from({ length: monthCount }, (_, i) => Number(cells?.[i]) || 0);

/** Classic raised chart prefers known charge heads, then rolls the rest into Other. */
const RAISED_CHART_PREFERRED = [
    'Maintenance charges',
    'Common water consumption charges',
    'Water Meter Rent',
    'Car Parking',
    'Home water consumption charges',
    'Non Occupancy Charges',
];

const orderRaisedRowsForChart = (rows) => {
    const list = [...(rows || [])];
    const preferred = RAISED_CHART_PREFERRED
        .map((h) => list.find((r) => r.key === h || r.label === h))
        .filter(Boolean);
    const preferredKeys = new Set(preferred.map((r) => r.key));
    const extras = list
        .filter((r) => !preferredKeys.has(r.key))
        .sort((a, b) => (b.total || 0) - (a.total || 0));
    return [...preferred, ...extras];
};

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

const renderRaisedInvoicesPivot = (months, pack = analyticsPack) => {
  const el = document.getElementById('fn-fa-raised-pivot');
  const metaEl = document.getElementById('fn-fa-raised-pivot-meta');
  if (!el) return;

  if (pack?.raised) {
    if (metaEl) {
      metaEl.innerHTML = pack.raised.invoiceCount
        ? `<span class="fa-meta-chip">${pack.raised.invoiceCount} invoice row(s)</span>`
        : '';
    }
    renderPivotTable({
      el,
      metaEl: null,
      rows: pack.raised.rows || [],
      months: pack.months || months,
      dimension: 'charge',
      type: 'IN',
      clickable: false,
      emptyMessage: pack.raised.invoiceCount
        ? 'No raised amounts in this month range.'
        : 'No raised-invoice data yet. Open the Invoices Raised tab to upload the monthly Excel export.',
    });
    return;
  }

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
    metaEl: null,
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
    const monthCount = months?.length || 0;

    if (analyticsPack?.income && analyticsPack?.expense && analyticsPack?.raised) {
        // Prefer pack.monthly totals so bar heights always match Monthly summary / pivots.
        const monthly = analyticsPack.monthly || {};
        const incomeRows = reconcileStackRowsToMonthly(
            topCategoryRows(analyticsPack.income.rows || [], 6),
            monthly.income,
            monthCount,
        );
        const expenseRows = reconcileStackRowsToMonthly(
            topCategoryRows(expenseRowsForChart(analyticsPack.expense.rows || []), 6),
            monthly.expense,
            monthCount,
        );
        // Classic used preferred-head order then sliced — that dropped amount. Roll into Other.
        const raisedOrdered = orderRaisedRowsForChart(analyticsPack.raised.rows || []);
        const raisedRows = reconcileStackRowsToMonthly(
            topCategoryRows(raisedOrdered, 8),
            monthly.raised,
            monthCount,
        );

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
    }

    const incomeRows = topCategoryRows(buildIncomePivot(months, 'cat', filterTxnsInMonthRange(filterIncome(), months)).rows, 6);
    const expenseRows = topCategoryRows(
        expenseRowsForChart(
            buildExpensePivot(
                filterTxnsInMonthRange(filterExpenses(sheetOnly, cashExpenseReporting), months),
                months,
                pivotDimension,
            ).rows,
        ),
        6,
    );
    const { heads: raisedHeads, series: raisedSeries, monthTotals: raisedMonthTotals } = buildRaisedInvoicesStack(months);
    const raisedSource = raisedHeads.map((head) => ({
        key: head,
        label: head,
        cells: seriesCellsOrZero(raisedSeries[head], monthCount),
        total: (raisedSeries[head] || []).reduce((a, b) => a + (b || 0), 0),
    }));
    const raisedRows = reconcileStackRowsToMonthly(
        topCategoryRows(raisedSource, 8),
        raisedMonthTotals,
        monthCount,
    );

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

const renderCombinedCategoryChart = async (months, sheetOnly, pivotDimension, cashExpenseReporting = 'petty_bank') => {
    const canvas = document.getElementById('fn-fa-combined-chart');
    if (!canvas) return;

    try {
        const { ensureChartJs } = await import('../appShell/ensureChartJs.js');
        await ensureChartJs();
    } catch (err) {
        console.warn('[financeAnalytics] Chart.js:', err?.message || err);
        return;
    }
    if (typeof Chart === 'undefined') return;

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
export const captureFinanceReportsChartPng = async (width = 1100, height = 480) => {
    if (typeof document === 'undefined') return null;
    try {
        const { ensureChartJs } = await import('../appShell/ensureChartJs.js');
        await ensureChartJs();
    } catch {
        return null;
    }
    if (typeof Chart === 'undefined') return null;

    const settings = getSettings();
    const months = analyticsPack?.months || buildMonthRange(settings.monthCount);
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
    const summaryEl = document.getElementById('fn-fa-projection-summary');
    const badgeEl = document.getElementById('fn-fa-projection-badge');
    if (!summaryEl) return;

    let expenseTotals;
    let incomeTotals;
    if (analyticsPack?.monthly) {
        incomeTotals = analyticsPack.monthly.income || [];
        expenseTotals = analyticsPack.monthly.expense || [];
    } else {
        const expenses = filterTxnsInMonthRange(filterExpenses(sheetOnly, cashExpenseReporting), months);
        const income = filterTxnsInMonthRange(filterIncome(), months);
        expenseTotals = monthlyTotals(expenses, months);
        incomeTotals = monthlyTotals(income, months);
    }

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
    monthCount: parseInt(document.getElementById('fn-fa-month-range')?.value || '6', 10),
    pivotDimension: document.getElementById('fn-fa-pivot-dimension')?.value || 'cat',
    sheetOnly: document.getElementById('fn-fa-sheet-only')?.checked !== false,
    projectMonths: parseInt(document.getElementById('fn-fa-project-months')?.value || '3', 10),
    cashExpenseReporting: getCashExpenseReportingMode(),
});

const renderBalanceMetrics = () => {
    const el = document.getElementById('fn-fa-balance-metrics');
    if (!el) return;

    const { cash, bankBalance, hasBank, pending, book, asOf, recon } = getBookBalanceSummary();
    const passbookVariance = recon.diff;
    const packRecon = analyticsPack?.recon;
    const unmatchedLines = packRecon?.unmatchedLines ?? getUnmatchedBankLines().length;
    const unreconciledTxns = packRecon?.unreconciledTxns ?? getUnmatchedLedgerTxns().length;
    const unmatchedNet = packRecon?.unmatchedNet ?? sumUnmatchedStatementNet();
    const unreconciledNet = packRecon?.unreconciledNet ?? sumUnreconciledLedgerNet();
    const matchedCount = packRecon?.matchedCount ?? getMatchedTransactionIds().size;

    const passbookVarClass = passbookVariance != null && Math.abs(passbookVariance) < 1
        ? 'fa-metric--ok'
        : 'fa-metric--warn';

    const bankSub = hasBank
        ? (asOf ? `As of ${new Date(`${asOf}T12:00:00`).toLocaleDateString('en-GB')}` : 'From bank reconciliation')
        : 'Import a statement in Bank Reconciliation';

    const pendingSub = [
        pending.openCount ? `${pending.openCount} unlinked bill${pending.openCount === 1 ? '' : 's'}` : null,
        pending.unclearedCount ? `${pending.unclearedCount} uncleared ledger` : null,
    ].filter(Boolean).join(' · ') || 'None outstanding';

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
        <span class="value">${hasBank ? formatMoney(bankBalance) : '—'}</span>
        <span class="fa-metric__sub">${bankSub}</span>
      </div>
      ${varianceCard}
      <div class="metric-card fa-metric metric-card--clickable" data-goto-bills-wallet title="Open Bills & receipts cash float">
        <span class="label">Petty cash</span>
        <span class="value">${formatMoney(cash)}</span>
        <span class="fa-metric__sub">Wallet Left (Bills &amp; receipts)</span>
      </div>
      <div class="metric-card fa-metric metric-card--clickable" data-goto-pending-cheques title="Open cheque-ready and unpaid bills">
        <span class="label">Open commitments</span>
        <span class="value">${formatMoney(pending.total)}</span>
        <span class="fa-metric__sub">${pendingSub}</span>
      </div>
      <div class="metric-card fa-metric fa-metric--total">
        <span class="label">
          Total balance
          <button type="button" class="fa-metric__info-btn" data-book-balance-info aria-expanded="false" aria-controls="fa-book-balance-tip" title="How Total is calculated">
            <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
          </button>
        </span>
        <span class="value">${formatMoney(book)}</span>
        <span class="fa-metric__sub">${hasBank
          ? `${formatMoney(bankBalance)} − ${formatMoney(pending.total)} + ${formatMoney(cash)}`
          : formatMoney(cash)}</span>
        <div class="fa-metric__tip" id="fa-book-balance-tip" hidden role="tooltip">
          <strong>Book balance</strong> = bank statement
          − open commitments (unpaid bills + cheque ready / unlinked + uncleared ledger cheques)
          + petty cash (Wallet Left).
          Bank stays the passbook figure; Total is what you have after those commitments.
        </div>
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

const monthKeyFromDate = (iso) => {
    const s = String(iso || '').slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}` : '';
};

const CASH_POS_SCENARIO_KEY = 'fa-cash-position-scenario';

const defaultCashPosScenario = () => ({
    includePlanned: true,
    includeManualIncome: true,
    manualIncome: 0,
    plannedMonths: 6,
});

const loadCashPosScenario = () => {
    try {
        const raw = sessionStorage.getItem(CASH_POS_SCENARIO_KEY);
        if (!raw) return defaultCashPosScenario();
        const parsed = JSON.parse(raw);
        return {
            includePlanned: parsed.includePlanned !== false,
            includeManualIncome: parsed.includeManualIncome !== false,
            manualIncome: Math.max(0, round2(parseFloat(parsed.manualIncome) || 0)),
            plannedMonths: [3, 6, 12].includes(Number(parsed.plannedMonths))
                ? Number(parsed.plannedMonths)
                : 6,
        };
    } catch {
        return defaultCashPosScenario();
    }
};

const saveCashPosScenario = (scenario) => {
    try {
        sessionStorage.setItem(CASH_POS_SCENARIO_KEY, JSON.stringify(scenario));
    } catch {
        /* ignore quota */
    }
};

/**
 * Split commitments so each rupee is counted once:
 * - Cheque ready: cheque given / noted, not yet linked (+ uncleared ledger cheque OUTs)
 * - Unpaid: unpaid open bills (no cheque yet)
 * Scenario rows (optional): planned expense-plan spend, manual expected income/savings.
 */
const getCashCommitmentBreakdown = (scenario = loadCashPosScenario(), planned = null) => {
    const { cash, bankBalance, hasBank, pending } = getBookBalanceSummary();

    const chequeBills = getChequeReadyExpenseDocuments();
    const unpaidBills = getOpenExpenseDocuments().filter((d) => !isChequeFinanceDocument(d));
    const chequeBillsAmt = round2(chequeBills.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
    const unpaidAmt = round2(unpaidBills.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
    const chequesAmt = round2(chequeBillsAmt + pending.unclearedAmt);

    const plannedAmt = round2(planned?.total || 0);
    const plannedCount = planned?.count || 0;
    const manualIncome = Math.max(0, round2(scenario.manualIncome || 0));

    const funds = hasBank ? round2((bankBalance || 0) + cash) : cash;
    const hardCommitments = round2(chequesAmt + unpaidAmt);
    const plannedInCalc = scenario.includePlanned ? plannedAmt : 0;
    const incomeInCalc = scenario.includeManualIncome ? manualIncome : 0;
    const commitments = round2(hardCommitments + plannedInCalc);
    const available = round2(funds + incomeInCalc - commitments);

    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 10);
    const thisMonthKey = monthKeyFromDate(todayIso);
    let overdue = 0;
    let thisMonth = 0;
    let later = 0;
    const byCat = new Map();
    unpaidBills.forEach((d) => {
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
        cash,
        bankBalance,
        hasBank,
        chequeBills,
        unpaidBills,
        uncleared: pending.uncleared,
        chequeBillsAmt,
        unclearedAmt: pending.unclearedAmt,
        chequesAmt,
        chequesCount: chequeBills.length + pending.unclearedCount,
        unpaidAmt,
        unpaidCount: unpaidBills.length,
        plannedAmt,
        plannedCount,
        plannedMonths: scenario.plannedMonths,
        manualIncome,
        includePlanned: !!scenario.includePlanned,
        includeManualIncome: !!scenario.includeManualIncome,
        funds,
        hardCommitments,
        commitments,
        available,
        overdue: round2(overdue),
        thisMonth: round2(thisMonth),
        later: round2(later),
        topCats,
    };
};

const buildCashFormula = (s) => {
    const add = ['A', 'B'];
    if (s.includeManualIncome) add.push('F');
    const sub = ['C', 'D'];
    if (s.includePlanned) sub.push('E');
    const left = add.join(' + ');
    const right = sub.length === 1 ? sub[0] : `(${sub.join(' + ')})`;
    return `${left} − ${right}`;
};

const fmtCashPosDate = (iso) => {
    if (!iso) return '—';
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: '2-digit',
    });
};

const closeCashPositionListModal = () => {
    document.getElementById('fn-fa-cash-list-modal')?.remove();
};

const openCashPositionListModal = ({ title, hint, rows }) => {
    closeCashPositionListModal();
    const total = round2(rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0));
    const body = rows.length
        ? rows.map((r) => `
            <tr>
              <td>${escAttr(fmtCashPosDate(r.date))}</td>
              <td>${escAttr(r.title || '—')}</td>
              <td>${escAttr(categoryDisplayLabel(r.cat) || r.cat || '—')}</td>
              <td class="fa-cash-sheet__amt">${formatMoney(r.amount)}</td>
            </tr>`).join('')
        : `<tr><td colspan="4" class="fa-panel__hint">Nothing in this list.</td></tr>`;
    const modal = document.createElement('div');
    modal.id = 'fn-fa-cash-list-modal';
    modal.className = 'fdoc-link-modal';
    modal.innerHTML = `
      <div class="fdoc-link-modal__backdrop" data-fa-cash-list-close="1"></div>
      <div class="fdoc-link-modal__panel fdoc-link-modal__panel--wide" role="dialog" aria-labelledby="fn-fa-cash-list-title">
        <div class="fdoc-link-modal__head">
          <div>
            <h3 id="fn-fa-cash-list-title">${escAttr(title)}</h3>
            ${hint ? `<p class="fa-panel__hint" style="margin:0.25rem 0 0;">${escAttr(hint)}</p>` : ''}
          </div>
          <button type="button" class="btn btn-outline btn--small btn--icon" data-fa-cash-list-close="1" title="Close" aria-label="Close">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
        <div class="fa-table-wrap" style="max-height:min(70vh, 28rem); overflow:auto;">
          <table class="fa-pivot-table cash-float-table">
            <thead>
              <tr><th>Date</th><th>Detail</th><th>Category</th><th class="fa-cash-sheet__amt">Amount</th></tr>
            </thead>
            <tbody>${body}</tbody>
            <tfoot>
              <tr class="fdoc-funding-totals">
                <td colspan="3">${rows.length} item${rows.length === 1 ? '' : 's'}</td>
                <td class="fa-cash-sheet__amt"><strong>${formatMoney(total)}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-fa-cash-list-close]')) closeCashPositionListModal();
    });
};

const cashAmtButton = (id, html, extraClass = '') =>
    `<button type="button" class="fa-cash-sheet__amt-btn ${extraClass}" id="${id}">${html}</button>`;
const renderPlannedExpensesCard = async () => {
    const el = document.getElementById('fn-fa-planned-expenses');
    if (!el) return;
    const wasOpen = el.open;
    const scenario = loadCashPosScenario();

    let planned = { total: 0, count: 0, months: scenario.plannedMonths };
    try {
        const { getExpensePlanHorizonSummary } = await import('./expensePlan.js');
        planned = getExpensePlanHorizonSummary(scenario.plannedMonths);
    } catch (err) {
        console.warn('[financeAnalytics] expense plan summary:', err?.message || err);
    }

    const s = getCashCommitmentBreakdown(scenario, planned);
    const afterClass = s.available < -0.009
        ? 'fa-cash-sheet__total--short'
        : (s.hasBank && s.available < s.funds * 0.15 ? 'fa-cash-sheet__total--tight' : 'fa-cash-sheet__total--ok');

    const catChips = s.topCats.length
        ? s.topCats.map((c) =>
            `<span class="fa-planned__chip"><strong>${c.label}</strong> ${formatMoney(c.amount)}</span>`,
        ).join('')
        : '<span class="fa-planned__chip fa-planned__chip--muted">No unpaid open bills</span>';

    const chequeSub = [
        s.chequeBills.length ? `${s.chequeBills.length} cheque ready` : null,
        s.uncleared.length ? `${s.uncleared.length} uncleared ledger` : null,
    ].filter(Boolean).join(' · ') || 'None';

    const bankCell = s.hasBank ? formatMoney(s.bankBalance) : '—';
    const formula = buildCashFormula(s);
    const plannedOut = s.includePlanned && s.plannedAmt > 0.009;
    const incomeIn = s.includeManualIncome && s.manualIncome > 0.009;

    el.innerHTML = `
      <summary class="fa-collapsible-panel__summary">
        <span class="fa-collapsible-panel__title">Cash position</span>
        <span class="fa-collapsible-panel__meta">Available ${formatMoney(s.available)} · Hard ${formatMoney(s.hardCommitments)}</span>
      </summary>
      <div class="fa-collapsible-panel__body">
        <div class="fa-panel__head fa-panel__head--row">
          <p class="fa-panel__hint" style="margin:0;">
            Play with the scenario: toggle planned spend and expected income. Hard commitments (C–D) always count.
          </p>
          <div class="fa-cash-sheet__actions">
            <button type="button" class="btn btn-outline btn--small" id="fn-fa-planned-open-plan">
              <i class="fa-solid fa-calendar-days" aria-hidden="true"></i> Expense plan
            </button>
            <button type="button" class="btn btn-outline btn--small" id="fn-fa-planned-open-bills">
              <i class="fa-solid fa-file-invoice" aria-hidden="true"></i> Open bills
            </button>
          </div>
        </div>
        <table class="fa-cash-sheet" aria-label="Cash position worksheet">
          <tbody>
            <tr>
              <td class="fa-cash-sheet__ref">A</td>
              <td class="fa-cash-sheet__label">Bank account balance</td>
              <td class="fa-cash-sheet__amt">${bankCell}</td>
            </tr>
            <tr>
              <td class="fa-cash-sheet__ref">B</td>
              <td class="fa-cash-sheet__label">Petty cash <span class="fa-cash-sheet__hint">Wallet Left</span></td>
              <td class="fa-cash-sheet__amt">${formatMoney(s.cash)}</td>
            </tr>
            <tr class="fa-cash-sheet__row--deduct">
              <td class="fa-cash-sheet__ref">C</td>
              <td class="fa-cash-sheet__label">Cheque ready (unlinked) <span class="fa-cash-sheet__hint">${chequeSub}</span></td>
              <td class="fa-cash-sheet__amt fa-cash-sheet__amt--out">${s.chequesAmt > 0.009
                ? cashAmtButton('fn-fa-cash-amt-cheques', formatMoney(-s.chequesAmt), 'fa-cash-sheet__amt-btn--out')
                : formatMoney(0)}</td>
            </tr>
            <tr class="fa-cash-sheet__row--deduct">
              <td class="fa-cash-sheet__ref">D</td>
              <td class="fa-cash-sheet__label">Unpaid bills <span class="fa-cash-sheet__hint">${s.unpaidCount} open</span></td>
              <td class="fa-cash-sheet__amt fa-cash-sheet__amt--out">${s.unpaidAmt > 0.009
                ? cashAmtButton('fn-fa-cash-amt-unpaid', formatMoney(-s.unpaidAmt), 'fa-cash-sheet__amt-btn--out')
                : formatMoney(0)}</td>
            </tr>
            <tr class="fa-cash-sheet__row--scenario${s.includePlanned ? ' fa-cash-sheet__row--deduct' : ' fa-cash-sheet__row--off'}">
              <td class="fa-cash-sheet__ref">E</td>
              <td class="fa-cash-sheet__label">
                <label class="fa-cash-sheet__check">
                  <input type="checkbox" id="fn-fa-cash-include-planned" ${s.includePlanned ? 'checked' : ''} />
                  <span>Planned expenditures</span>
                </label>
                <span class="fa-cash-sheet__hint">
                  Expense plan ·
                  <select id="fn-fa-cash-planned-months" class="fa-cash-sheet__select" title="Horizon for planned spend">
                    <option value="3" ${s.plannedMonths === 3 ? 'selected' : ''}>3 mo</option>
                    <option value="6" ${s.plannedMonths === 6 ? 'selected' : ''}>6 mo</option>
                    <option value="12" ${s.plannedMonths === 12 ? 'selected' : ''}>12 mo</option>
                  </select>
                  · ${s.plannedCount} item${s.plannedCount === 1 ? '' : 's'}
                </span>
              </td>
              <td class="fa-cash-sheet__amt ${plannedOut ? 'fa-cash-sheet__amt--out' : ''}">${
                cashAmtButton(
                    'fn-fa-cash-amt-planned',
                    plannedOut ? formatMoney(-s.plannedAmt) : formatMoney(s.plannedAmt),
                    plannedOut ? 'fa-cash-sheet__amt-btn--out' : '',
                )
              }</td>
            </tr>
            <tr class="fa-cash-sheet__row--scenario${s.includeManualIncome ? ' fa-cash-sheet__row--add' : ' fa-cash-sheet__row--off'}">
              <td class="fa-cash-sheet__ref">F</td>
              <td class="fa-cash-sheet__label">
                <label class="fa-cash-sheet__check">
                  <input type="checkbox" id="fn-fa-cash-include-income" ${s.includeManualIncome ? 'checked' : ''} />
                  <span>Expected income / savings</span>
                </label>
                <span class="fa-cash-sheet__hint">Manual — invoices due, deposits, etc.</span>
              </td>
              <td class="fa-cash-sheet__amt fa-cash-sheet__amt--input">
                <span class="fa-cash-sheet__prefix">+</span>
                <input type="number" id="fn-fa-cash-manual-income" class="fa-cash-sheet__income" min="0" step="1" value="${s.manualIncome || ''}" placeholder="0" ${s.includeManualIncome ? '' : 'disabled'} />
              </td>
            </tr>
            <tr class="fa-cash-sheet__row--total ${afterClass}">
              <td class="fa-cash-sheet__ref" aria-hidden="true"></td>
              <td class="fa-cash-sheet__label">
                Available
                <span class="fa-cash-sheet__formula">${formula}</span>
              </td>
              <td class="fa-cash-sheet__amt">${formatMoney(s.available)}</td>
            </tr>
          </tbody>
        </table>
        <div class="fa-planned__buckets">
          <span><strong>Overdue bills</strong> ${formatMoney(s.overdue)}</span>
          <span><strong>This month</strong> ${formatMoney(s.thisMonth)}</span>
          <span><strong>Later</strong> ${formatMoney(s.later)}</span>
          ${incomeIn ? `<span><strong>Income in play</strong> ${formatMoney(s.manualIncome)}</span>` : ''}
        </div>
        <div class="fa-planned__cats" aria-label="Top unpaid bill categories">${catChips}</div>
      </div>`;

    el.open = wasOpen;

    const persistAndRefresh = () => {
        const next = {
            includePlanned: !!el.querySelector('#fn-fa-cash-include-planned')?.checked,
            includeManualIncome: !!el.querySelector('#fn-fa-cash-include-income')?.checked,
            manualIncome: Math.max(0, round2(parseFloat(el.querySelector('#fn-fa-cash-manual-income')?.value || '0') || 0)),
            plannedMonths: parseInt(el.querySelector('#fn-fa-cash-planned-months')?.value || '6', 10) || 6,
        };
        saveCashPosScenario(next);
        void renderPlannedExpensesCard();
    };

    el.querySelector('#fn-fa-cash-include-planned')?.addEventListener('change', persistAndRefresh);
    el.querySelector('#fn-fa-cash-include-income')?.addEventListener('change', persistAndRefresh);
    el.querySelector('#fn-fa-cash-planned-months')?.addEventListener('change', persistAndRefresh);
    const incomeEl = el.querySelector('#fn-fa-cash-manual-income');
    const applyIncomeLive = () => {
        const next = {
            includePlanned: !!el.querySelector('#fn-fa-cash-include-planned')?.checked,
            includeManualIncome: !!el.querySelector('#fn-fa-cash-include-income')?.checked,
            manualIncome: Math.max(0, round2(parseFloat(incomeEl?.value || '0') || 0)),
            plannedMonths: parseInt(el.querySelector('#fn-fa-cash-planned-months')?.value || '6', 10) || 6,
        };
        saveCashPosScenario(next);
        const live = getCashCommitmentBreakdown(next, planned);
        const totalCell = el.querySelector('.fa-cash-sheet__row--total .fa-cash-sheet__amt');
        if (totalCell) totalCell.textContent = formatMoney(live.available);
        const formulaEl = el.querySelector('.fa-cash-sheet__formula');
        if (formulaEl) formulaEl.textContent = buildCashFormula(live);
        const metaEl = el.querySelector('.fa-collapsible-panel__meta');
        if (metaEl) metaEl.textContent = `Available ${formatMoney(live.available)} · Hard ${formatMoney(live.hardCommitments)}`;
        const totalRow = el.querySelector('.fa-cash-sheet__row--total');
        if (totalRow) {
            totalRow.classList.remove('fa-cash-sheet__total--short', 'fa-cash-sheet__total--tight', 'fa-cash-sheet__total--ok');
            totalRow.classList.add(live.available < -0.009
                ? 'fa-cash-sheet__total--short'
                : (live.hasBank && live.available < live.funds * 0.15 ? 'fa-cash-sheet__total--tight' : 'fa-cash-sheet__total--ok'));
        }
    };
    incomeEl?.addEventListener('input', applyIncomeLive);
    incomeEl?.addEventListener('change', applyIncomeLive);
    incomeEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            persistAndRefresh();
        }
    });
    ['fn-fa-cash-include-planned', 'fn-fa-cash-include-income', 'fn-fa-cash-planned-months'].forEach((id) => {
        el.querySelector(`#${id}`)?.addEventListener('click', (e) => e.stopPropagation());
    });

    const billRows = (docs) => (docs || []).map((d) => ({
        date: d.doc_date,
        title: d.vendor_name || d.description || 'Bill',
        cat: d.cat,
        amount: parseFloat(d.amount) || 0,
    }));
    el.querySelector('#fn-fa-cash-amt-cheques')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCashPositionListModal({
            title: 'Cheque ready (unlinked)',
            hint: 'Cheque noted on the bill, not yet linked to a ledger line.',
            rows: billRows(s.chequeBills),
        });
    });
    el.querySelector('#fn-fa-cash-amt-unpaid')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCashPositionListModal({
            title: 'Unpaid bills',
            hint: 'Open expense bills with no payment yet.',
            rows: billRows(s.unpaidBills),
        });
    });
    el.querySelector('#fn-fa-cash-amt-planned')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCashPositionListModal({
            title: `Planned expenditures (${s.plannedMonths} mo)`,
            hint: s.includePlanned
                ? 'These items are included in Available.'
                : 'Unchecked — not included in Available.',
            rows: (planned.items || []).map((r) => ({
                date: r.date,
                title: r.title || r.vendor_name || 'Planned',
                cat: r.cat,
                amount: r.amount,
            })),
        });
    });

    el.querySelector('#fn-fa-planned-open-bills')?.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { focusOpenExpenseBills } = await import('./financeDocuments.js');
        focusOpenExpenseBills();
    }, { once: true });

    el.querySelector('#fn-fa-planned-open-plan')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigateFinance('expense-plan');
    }, { once: true });
};

/** Monthly raised / income / expenses / net — same rows as the Excel export summary. */
const renderMonthlySummaryCard = () => {
    const el = document.getElementById('fn-fa-monthly-summary');
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

const pivotDimensionLabel = (dimension) => {
    if (dimension === 'sub_category') return 'Sub-category';
    if (dimension === 'vendor') return 'Vendor';
    if (dimension === 'charge') return 'Charge head';
    if (dimension === 'wallet_cat') return 'Cash / Bank → Category';
    return 'Category';
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

    const dimLabel = pivotDimensionLabel(dimension);
    const amountClass = type === 'IN' ? 'fa-income' : 'fa-expense';

    if (!rows.length) {
        if (metaEl) metaEl.innerHTML = '';
        el.innerHTML = `<p class="maintenance-dues-empty">${emptyMessage}</p>`;
        return;
    }

    // Group header rows mirror child totals — exclude them from footers.
    const sumRows = rows.filter((r) => r.rowKind !== 'wallet-group');
    const colTotals = months.map((_, i) => sumRows.reduce((s, r) => s + r.cells[i], 0));
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

        const drillLabel = row?.rowKind === 'wallet-group'
            ? row.label
            : row?.rowKind === 'wallet-cat'
                ? `${walletGroupLabel(row.wallet)} · ${row.label}`
                : row?.label;

        const attrs = [
            `class="fa-num fa-pivot-cell fa-pivot-cell--clickable ${amountClass} ${extraClass}"`,
            'role="button" tabindex="0"',
            `data-pivot-type="${type}"`,
            `data-pivot-dimension="${dimension}"`,
            `data-pivot-scope="${scope}"`,
            row?.key != null ? `data-pivot-key="${escAttr(row.key)}"` : '',
            drillLabel != null ? `data-pivot-label="${escAttr(drillLabel)}"` : '',
            row?.wallet ? `data-pivot-wallet="${escAttr(row.wallet)}"` : '',
            month ? `data-pivot-year="${month.y}" data-pivot-month="${month.m}"` : '',
            (scope === 'row-total' || scope === 'grand-total') ? monthRangeAttrs : '',
            `title="View matching ledger entries"`,
        ].filter(Boolean).join(' ');
        return `<td ${attrs}>${content}</td>`;
    };

    const labelCell = (r) => {
        if (r.rowKind === 'wallet-group') {
            return `<td class="fa-pivot-group-label"><strong>${r.label}</strong></td>`;
        }
        if (r.rowKind === 'wallet-cat') {
            return `<td class="fa-pivot-nested-label">${r.label}</td>`;
        }
        return `<td>${r.label}</td>`;
    };

    el.innerHTML = `
      <table class="fa-pivot-table${dimension === 'wallet_cat' ? ' fa-pivot-table--wallet' : ''}">
        <thead>
          <tr>
            <th>${dimLabel}</th>
            ${months.map((m) => `<th class="fa-num">${m.label}</th>`).join('')}
            <th class="fa-num fa-col-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr class="${r.rowKind === 'wallet-group' ? 'fa-pivot-row--group' : r.rowKind === 'wallet-cat' ? 'fa-pivot-row--nested' : ''}">
              ${labelCell(r)}
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
    const inRangeOut = (fnFinances().txns || []).filter(
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
    const el = document.getElementById('fn-fa-income-pivot');
    const metaEl = document.getElementById('fn-fa-income-pivot-meta');

    if (analyticsPack?.income) {
        const rows = analyticsPack.income.rows || [];
        const entryCount = analyticsPack.income.entryCount ?? rows.length;
        if (metaEl) {
            metaEl.innerHTML = `<span class="fa-meta-chip">${entryCount} income entries</span>`;
        }
        renderPivotTable({
            el,
            metaEl,
            rows,
            months: analyticsPack.months || months,
            dimension: 'cat',
            type: 'IN',
            clickable: true,
            emptyMessage: 'No income in this range.',
        });
        return;
    }

    const income = filterTxnsInMonthRange(filterIncome(), months);
    const excludedCount = (fnFinances().txns || []).filter(
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
    const el = document.getElementById('fn-fa-expense-pivot');
    const metaEl = document.getElementById('fn-fa-expense-pivot-meta');

    if (analyticsPack?.expense) {
        const rows = analyticsPack.expense.rows || [];
        const sc = analyticsPack.expense.sourceCounts || {};
        const entryCount = analyticsPack.expense.entryCount ?? rows.length;
        if (metaEl) {
            const chips = [];
            if (sheetOnly) {
                chips.push(expenseMetaChip(sc.sheet, 'from expense sheets', 'sheet', 'fa-meta-chip--sheet'));
                chips.push(expenseMetaChip(sc.bank, 'from bank reconciliation', 'bank'));
                chips.push(renderOmittedMetaChip(sc.manual, sc.excluded));
            } else {
                chips.push(`<span class="fa-meta-chip">${entryCount} in period (${sc.sheet || 0} sheets, ${sc.bank || 0} bank)</span>`);
                chips.push(expenseMetaChip(sc.excluded, 'excluded from reports', 'excluded-reports'));
            }
            metaEl.innerHTML = chips.filter(Boolean).join('\n               ');
        }
        renderPivotTable({
            el,
            metaEl,
            rows,
            months: analyticsPack.months || months,
            dimension,
            type: 'OUT',
            clickable: true,
            emptyMessage: `No expenses in this range${sheetOnly ? ' from expense sheets or bank reconciliation' : ''}.`,
        });
        return;
    }

    const expenses = filterTxnsInMonthRange(filterExpenses(sheetOnly, cashExpenseReporting), months);
    const { fromSheet, fromBank, excludedFromReports, manualOmitted } = expenseSourceCounts(months, sheetOnly);

    if (metaEl) {
        const chips = [];
        if (sheetOnly) {
            chips.push(expenseMetaChip(fromSheet, 'from expense sheets', 'sheet', 'fa-meta-chip--sheet'));
            chips.push(expenseMetaChip(fromBank, 'from bank reconciliation', 'bank'));
            chips.push(renderOmittedMetaChip(manualOmitted, excludedFromReports));
        } else {
            chips.push(`<span class="fa-meta-chip">${expenses.length} in period (${fromSheet} sheets, ${fromBank} bank)</span>`);
            chips.push(expenseMetaChip(excludedFromReports, 'excluded from reports', 'excluded-reports'));
        }
        if (dimension === 'wallet_cat' && cashExpenseReporting !== 'cash_detail') {
            chips.push('<span class="fa-meta-chip fa-meta-chip--hint">Turn on Cash bills by category to put cash bills under Cash</span>');
        }
        metaEl.innerHTML = chips.filter(Boolean).join('\n               ');
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

        if (cell.dataset.pivotWallet) {
            filter.wallet = cell.dataset.pivotWallet;
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

        void import('./ledgerFilter.js').then((m) => m.navigateToLedgerFromPivot(filter));
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
    const metaEl = document.getElementById('fn-fa-expense-pivot-meta');
    if (!metaEl || metaEl.dataset.metaWired) return;
    metaEl.dataset.metaWired = '1';

    metaEl.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-fa-expense-source]');
        if (!chip?.dataset.faExpenseSource) return;
        const settings = getSettings();
        const months = buildMonthRange(settings.monthCount);
        void import('./ledgerFilter.js').then((m) => m.navigateToLedgerFromPivot({
            type: 'OUT',
            sourceScope: chip.dataset.faExpenseSource,
            ...pivotRangeFromMonths(months),
        }));
    });
};

const wirePivotDrilldown = () => {
    wirePivotContainer('fn-fa-income-pivot');
    wirePivotContainer('fn-fa-expense-pivot');
    wirePivotContainer('fa-income-pivot');
    wirePivotContainer('fa-expense-pivot');
    wireExpensePivotMeta();
};

export const renderFinanceAnalytics = () => {
    const run = async () => {
        const settings = getSettings();
        const metricsEl = document.getElementById('fn-fa-balance-metrics');
        if (metricsEl && !analyticsPack) {
            metricsEl.innerHTML = '<p class="muted">Loading report aggregates…</p>';
        }
        try {
            analyticsPack = await fetchFinanceNewReport('analytics', {
                months: settings.monthCount,
                monthCount: settings.monthCount,
                sheetOnly: settings.sheetOnly,
                cashExpenseReporting: settings.cashExpenseReporting,
                pivotDimension: settings.pivotDimension,
                force: !getFinanceNew().ledgerLoaded,
            });
            getFinanceNew().reportAnalytics = analyticsPack;
        } catch (err) {
            analyticsPack = null;
            if (metricsEl) {
                metricsEl.innerHTML = `<p class="muted">${err.message || 'Report failed'}</p>`;
            }
            console.error('[financeAnalytics] analytics pack:', err);
            return;
        }

        // Cash-position worksheet needs voucher commitment aggregates (Mongo).
        try {
            const docs = await ensureFinanceDocsApi();
            await docs.ensureFinanceDocumentsAggregates();
        } catch (err) {
            console.warn('[financeAnalytics] voucher aggregates:', err?.message || err);
        }

        const months = analyticsPack.months || buildMonthRange(settings.monthCount);

        renderBalanceMetrics();
        try {
            await renderPlannedExpensesCard();
        } catch (err) {
            console.warn('[financeAnalytics] planned expenses:', err?.message || err);
        }
        try {
            renderMonthlySummaryCard();
        } catch (err) {
            console.warn('[financeAnalytics] monthly summary:', err?.message || err);
        }
        wireBalanceMetricClicks();

        // Pivots first so a chart failure cannot leave tables blank
        try {
            renderRaisedInvoicesPivot(months);
            renderIncomePivot(months);
            renderExpensePivot(
                months,
                settings.pivotDimension,
                settings.sheetOnly,
                settings.cashExpenseReporting,
            );
            wirePivotDrilldown();
        } catch (err) {
            console.error('[financeAnalytics] pivots:', err);
        }

        try {
            await renderCombinedCategoryChart(
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
        } catch (err) {
            console.warn('[financeAnalytics] chart/projection:', err?.message || err);
        }
    };
    void run();
};

const wireBalanceMetricClicks = () => {
    const el = document.getElementById('fn-fa-balance-metrics');
    if (!el || el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('click', async (e) => {
        const infoBtn = e.target.closest('[data-book-balance-info]');
        if (infoBtn) {
            e.preventDefault();
            e.stopPropagation();
            const tip = document.getElementById('fn-fa-book-balance-tip');
            if (!tip) return;
            const open = tip.hidden;
            tip.hidden = !open;
            infoBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            return;
        }
        const billsCard = e.target.closest('[data-goto-bills-wallet]');
        if (billsCard) {
            navigateFinance('finance-docs');
            return;
        }
        const pendingCard = e.target.closest('[data-goto-pending-cheques]');
        if (pendingCard) {
            const pending = getPendingChequesSummary();
            if (pending.unclearedCount && !pending.openCount) {
                navigateFinance('finance-bank-recon');
                requestAnimationFrame(() => {
                    const panel = document.getElementById('fn-bank-recon-txns');
                    panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    panel?.classList.add('bank-recon-txns--highlight');
                    setTimeout(() => panel?.classList.remove('bank-recon-txns--highlight'), 2400);
                });
                return;
            }
            const { focusOpenChequeBills } = await import('./financeDocuments.js');
            focusOpenChequeBills();
            return;
        }
        const card = e.target.closest('[data-goto-bank-recon]');
        if (!card) return;
        const focusUnmatched = card.hasAttribute('data-focus-unmatched-ledger');
        navigateFinance('finance-bank-recon');
        if (focusUnmatched) {
            requestAnimationFrame(() => {
                const panel = document.getElementById('fn-bank-recon-txns');
                panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                panel?.classList.add('bank-recon-txns--highlight');
                setTimeout(() => panel?.classList.remove('bank-recon-txns--highlight'), 2400);
            });
        }
    });

    document.addEventListener('click', (e) => {
        const tip = document.getElementById('fn-fa-book-balance-tip');
        const btn = el.querySelector('[data-book-balance-info]');
        if (!tip || tip.hidden) return;
        if (e.target.closest('[data-book-balance-info]') || e.target.closest('#fa-book-balance-tip')) return;
        tip.hidden = true;
        btn?.setAttribute('aria-expanded', 'false');
    });
};

/** Sync the chip's visible label to the current select value. */
function syncChipLabel(selectEl) {
    const chip = selectEl?.closest('.fn-filter-chip');
    if (!chip) return;
    const opt = selectEl.options[selectEl.selectedIndex];
    chip.dataset.valueLabel = opt ? opt.text : '';
}

/** Wire all filter chips so their displayed value stays in sync. */
function initFilterChips() {
    ['fn-fa-month-range', 'fn-fa-pivot-dimension', 'fn-fa-project-months', 'fn-fa-date-tolerance'].forEach((id) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        syncChipLabel(sel);
        sel.addEventListener('change', () => syncChipLabel(sel));
    });
}

function initReportsSettings() {
    const btn = document.getElementById('fn-fa-settings-btn');
    const panel = document.getElementById('fn-fa-settings-panel');
    if (!btn || !panel || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    const setOpen = (open) => {
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(panel.hidden);
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setOpen(false);
    });
}

export const initFinanceAnalyticsUi = () => {
    const rerender = () => renderFinanceAnalytics();

    initFilterChips();
    initReportsSettings();

    // Support both prefixed (fn-fa-*) and unprefixed (fa-*) IDs for legacy compat.
    ['fa-month-range', 'fa-sheet-only', 'fa-project-months', 'fa-date-tolerance'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', rerender);
        document.getElementById(`fn-${id}`)?.addEventListener('change', rerender);
    });

    document.getElementById('fn-fa-pivot-dimension')?.addEventListener('change', (e) => {
        // Cash / Bank → Category is most useful with cash bills under Cash.
        if (e.target.value === 'wallet_cat' && getCashExpenseReportingMode() !== 'cash_detail') {
            setCashExpenseReportingMode('cash_detail');
        }
        rerender();
    });

    const cashModeEl = document.getElementById('fn-fa-cash-expense-reporting');
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

    void import('../financeReportsExport.js').then(({ initFinanceReportsExport }) => {
        initFinanceReportsExport();
    });

    const projectionToggle = document.getElementById('fn-fa-projection-toggle');
    const projectionPopover = document.getElementById('fn-fa-projection-popover');
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

    document.getElementById('fn-fa-goto-bank-recon')?.addEventListener('click', () => {
        navigateFinance('finance-bank-recon');
    });
};
