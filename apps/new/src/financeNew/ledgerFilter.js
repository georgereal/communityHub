/** Finance-New clone (ledgerFilter.js) */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
/**
 * Drill-down filter from Financial Reports pivot → Financial Ledger.
 * Sort state and context bar for the Financial Ledger table.
 *
 * In “Cash bills by category” report mode, matching cash bills are merged into
 * the filtered ledger so drill-down matches the pivot (bank + Bills & receipts).
 */
import { normalizeCategoryKey, categoryDisplayLabel } from '../expenseCategories.js';
import { getActiveLedgerTxns, ledgerTxnDayKey, ledgerCalculatedBalanceById, PASSBOOK_CALC_EPS } from './ledgerBalance.js';
import { isTransactionReconciled } from './bankStatementQueries.js';
import {
    buildLedgerStatementContext,
    compareLedgerTxnStatementOrder,
    enrichTxnWithStatementLine,
} from './ledgerStatementContext.js';
import {
    getCashExpenseReportingMode,
    isBankPettyFunding,
    isCashDeskSpend,
} from './cashFloatPredicates.js';
import { navigateFinance } from '../financeApp/session.js';

const isCashBillDoc = (doc) => {
    const notes = String(doc?.notes || '').trim();
    return /Payment:\s*Cash/i.test(notes) || notes.toLowerCase() === 'cash';
};

/** Cash bills as pseudo-ledger rows for report drill-down (avoids financeDocuments.js on ledger load). */
const cashBillsAsReportExpenses = () =>
    (fnFinances().financeDocuments || [])
        .filter((d) => d.kind === 'OUT' && isCashBillDoc(d))
        .map((d) => ({
            id: `fdoc:${d.id}`,
            type: 'OUT',
            date: String(d.doc_date || '').slice(0, 10),
            amount: parseFloat(d.amount) || 0,
            cat: d.cat || 'Other',
            sub_category: d.sub_category || null,
            vendor_name: d.vendor_name || null,
            description: d.description || null,
            wallet: 'CASH',
            _fromFinanceDocument: true,
            finance_document_id: d.id,
        }));

const isExpenseFromSheet = (txn) =>
    txn?.type === 'OUT' && Boolean(txn.external_sync_key || txn.sync_hash);

const isExpenseFromBankRecon = (txn) =>
    txn?.type === 'OUT' && isTransactionReconciled(txn.id);

const isStructuredExpense = (txn) =>
    isExpenseFromSheet(txn) || isExpenseFromBankRecon(txn);

const txnMatchesExpenseSourceScope = (txn, scope) => {
    if (txn?.type !== 'OUT') return false;
    if (scope === 'sheet') return !txn.exclude_from_reports && isExpenseFromSheet(txn);
    if (scope === 'bank') {
        return !txn.exclude_from_reports && isExpenseFromBankRecon(txn) && !isExpenseFromSheet(txn);
    }
    if (scope === 'manual') return !txn.exclude_from_reports && !isStructuredExpense(txn);
    if (scope === 'excluded-reports') return !!txn.exclude_from_reports;
    if (scope === 'omitted') {
        if (txn.exclude_from_reports) return true;
        return !isStructuredExpense(txn);
    }
    return true;
};

const reportWallet = (txn) =>
    String(txn?.wallet || '').toUpperCase() === 'BANK' ? 'BANK' : 'CASH';

const pivotKeyOnTxn = (txn, dimension) => {
    if (dimension === 'sub_category') return txn.sub_category?.trim() || '(none)';
    if (dimension === 'vendor') return txn.vendor_name?.trim() || '(none)';
    if (dimension === 'wallet_cat') {
        const cat = normalizeCategoryKey(txn.cat || 'Other');
        return `${reportWallet(txn)}|${cat}`;
    }
    return normalizeCategoryKey(txn.cat || 'Other');
};

let ledgerPivotFilter = null;
let ledgerCategoryFilter = null;
let ledgerSort = { field: 'date', dir: 'desc' };
/** @type {Record<string, string|object>} Excel-style per-column filters (text string or structured) */
let ledgerColumnFilters = {};
let activityTimer = null;

const PASSBOOK_MISMATCH_EPS = PASSBOOK_CALC_EPS;

const parseFilterNumber = (raw) => {
    if (raw == null || raw === '') return null;
    const n = parseFloat(String(raw).replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
};

const isNumberSpecActive = (spec) => {
    if (!spec || typeof spec !== 'object') return false;
    if (spec.op === 'between') {
        return parseFilterNumber(spec.value) != null || parseFilterNumber(spec.value2) != null;
    }
    return parseFilterNumber(spec.value) != null;
};

/** Whether a stored column filter is active (text or structured). */
export const isLedgerColumnFilterActive = (value) => {
    if (value == null) return false;
    if (typeof value === 'string') return Boolean(value.trim());
    if (typeof value !== 'object') return false;
    if (value.kind === 'number') return isNumberSpecActive(value);
    if (value.kind === 'passbook') {
        if (value.discrepancy === 'mismatch' || value.discrepancy === 'match') return true;
        return isNumberSpecActive(value.passbook) || isNumberSpecActive(value.calc);
    }
    return false;
};

const matchesNumberOp = (actual, spec) => {
    if (!isNumberSpecActive(spec)) return true;
    if (actual == null || !Number.isFinite(Number(actual))) return false;
    const n = Number(actual);
    const v = parseFilterNumber(spec.value);
    const v2 = parseFilterNumber(spec.value2);
    switch (spec.op) {
        case 'eq':
            return v != null && Math.abs(n - v) < 0.005;
        case 'gt':
            return v != null && n > v;
        case 'gte':
            return v != null && n >= v;
        case 'lt':
            return v != null && n < v;
        case 'lte':
            return v != null && n <= v;
        case 'between': {
            if (v == null && v2 == null) return true;
            if (v == null) return n <= v2;
            if (v2 == null) return n >= v;
            const lo = Math.min(v, v2);
            const hi = Math.max(v, v2);
            return n >= lo && n <= hi;
        }
        default:
            return true;
    }
};

const signedTxnAmount = (txn) => {
    const amt = parseFloat(txn?.amount) || 0;
    return txn?.type === 'IN' ? amt : -amt;
};

const txnCalcBalance = (txn) => {
    // Prefer live map via caller; this fallback is only for non-filter text search.
    const c = txn?._ledgerComputedBalance;
    if (c != null && Number.isFinite(Number(c))) return Number(c);
    return null;
};

export const getLedgerPivotFilter = () => ledgerPivotFilter;

export const getLedgerCategoryFilter = () => ledgerCategoryFilter;

export const setLedgerCategoryFilter = (cat) => {
    ledgerCategoryFilter = cat ? normalizeCategoryKey(cat) : null;
    const sel = document.getElementById('fn-ledger-cat-filter');
    if (sel && sel.value !== (ledgerCategoryFilter || '')) sel.value = ledgerCategoryFilter || '';
    renderLedgerPivotBanner();
};

export const clearAllLedgerFilters = () => {
    ledgerPivotFilter = null;
    ledgerCategoryFilter = null;
    ledgerColumnFilters = {};
    const searchEl = document.getElementById('fn-cash-search');
    if (searchEl) searchEl.value = '';
    const catSel = document.getElementById('fn-ledger-cat-filter');
    if (catSel) catSel.value = '';
    renderLedgerPivotBanner();
};

export const getLedgerColumnFilters = () => ({ ...ledgerColumnFilters });

export const setLedgerColumnFilter = (key, value) => {
    if (value == null || value === '') {
        delete ledgerColumnFilters[key];
        return;
    }
    if (typeof value === 'object') {
        if (!isLedgerColumnFilterActive(value)) delete ledgerColumnFilters[key];
        else ledgerColumnFilters[key] = value;
        return;
    }
    const q = String(value).trim();
    if (!q) delete ledgerColumnFilters[key];
    else ledgerColumnFilters[key] = q;
};

export const clearLedgerColumnFilter = (key) => {
    delete ledgerColumnFilters[key];
};

/** Text used for Excel-style text column filters. */
export const ledgerTxnColumnText = (txn, key) => {
    if (!txn) return '';
    if (key === 'date') return String(txn.date || '').slice(0, 10);
    if (key === 'description') {
        return [txn.description, txn.bank_reference, txn.vendor_invoice].filter(Boolean).join(' ');
    }
    if (key === 'amount') {
        const amt = parseFloat(txn.amount) || 0;
        const signed = txn.type === 'IN' ? amt : -amt;
        return `${txn.type === 'IN' ? '+' : '−'}${amt} ${signed}`;
    }
    if (key === 'type') {
        const bits = [
            txn.type === 'IN' ? 'income' : 'expense',
            txn.exclude_from_reports ? 'no reports' : '',
            isTransactionReconciled(txn.id) ? 'reconciled' : '',
        ];
        return bits.filter(Boolean).join(' ');
    }
    if (key === 'cat') {
        return [
            categoryDisplayLabel(txn.cat),
            txn.sub_category,
            txn.vendor_name,
        ].filter(Boolean).join(' ');
    }
    if (key === 'wallet') return String(txn.wallet || '');
    if (key === 'passbook') {
        const calc = txnCalcBalance(txn);
        return calc != null ? String(calc) : '';
    }
    if (key === 'bills') {
        const id = txn.id;
        const n = (fnFinances().financeDocuments || []).filter(
            (d) => d.transaction_id === id || d.ledgerEntryId === id,
        ).length;
        return n ? `linked ${n}` : '';
    }
    return '';
};

const txnMatchesAmountFilter = (txn, spec) => {
    if (!isLedgerColumnFilterActive(spec)) return true;
    if (spec.kind === 'number') return matchesNumberOp(signedTxnAmount(txn), spec);
    // Legacy plain-text amount filter
    if (typeof spec === 'string') {
        return ledgerTxnColumnText(txn, 'amount').toLowerCase().includes(spec.trim().toLowerCase());
    }
    return true;
};

const txnMatchesPassbookFilter = (txn, spec, statementCtx, calcById) => {
    if (!isLedgerColumnFilterActive(spec)) return true;
    if (typeof spec === 'string') {
        const stmt = enrichTxnWithStatementLine(txn, statementCtx);
        const hay = [
            stmt.passbookBalance != null ? String(stmt.passbookBalance) : '',
            ledgerTxnColumnText(txn, 'passbook'),
        ].join(' ').toLowerCase();
        return hay.includes(spec.trim().toLowerCase());
    }
    if (spec.kind !== 'passbook') return true;

    const stmt = enrichTxnWithStatementLine(txn, statementCtx);
    const passbook = stmt.passbookBalance != null && Number.isFinite(Number(stmt.passbookBalance))
        ? Number(stmt.passbookBalance)
        : null;
    // Discrepancy = passbook (statement balance) <> live ledger calculated — never stored.
    const calc = (calcById?.has(txn.id) ? Number(calcById.get(txn.id)) : null);
    const hasBoth = passbook != null && calc != null && Number.isFinite(calc);
    const mismatch = hasBoth && Math.abs(calc - passbook) > PASSBOOK_MISMATCH_EPS;

    if (spec.discrepancy === 'mismatch' && !mismatch) return false;
    if (spec.discrepancy === 'match') {
        if (!hasBoth || mismatch) return false;
    }
    if (!matchesNumberOp(passbook, spec.passbook)) return false;
    if (!matchesNumberOp(calc, spec.calc)) return false;
    return true;
};

const txnMatchesColumnFilters = (txn, statementCtx, calcById) => {
    for (const [key, raw] of Object.entries(ledgerColumnFilters)) {
        if (!isLedgerColumnFilterActive(raw)) continue;
        if (key === 'amount') {
            if (!txnMatchesAmountFilter(txn, raw)) return false;
            continue;
        }
        if (key === 'passbook') {
            if (!txnMatchesPassbookFilter(txn, raw, statementCtx, calcById)) return false;
            continue;
        }
        const q = String(raw || '').trim().toLowerCase();
        if (!q) continue;
        const hay = ledgerTxnColumnText(txn, key).toLowerCase();
        if (!hay.includes(q)) return false;
    }
    return true;
};

export const setLedgerSearchBusy = (busy) => {
    const wrap = document.getElementById('fn-cash-search')?.closest('.ledger-toolbar__search');
    wrap?.classList.toggle('ledger-search--busy', busy);
    const icon = wrap?.querySelector('.ledger-search-icon');
    const spinner = wrap?.querySelector('.ledger-search-spinner');
    if (icon) icon.hidden = busy;
    if (spinner) spinner.hidden = !busy;
};

/** Brief status on the bulk bar or entry count — no separate activity row. */
export const setLedgerActivity = (message, { busy = false, flashMs = 0 } = {}) => {
    clearTimeout(activityTimer);
    const bulkEl = document.getElementById('fn-ledger-bulk-count');
    const countEl = document.getElementById('fn-cash-txn-count');
    const el = bulkEl && !bulkEl.closest('#fn-ledger-bulk-bar')?.hidden ? bulkEl : countEl;
    if (!el) return;
    if (!message) {
        el.classList.remove('ledger-bulk-bar__status--busy', 'ledger-bulk-bar__status--flash');
        return;
    }
    el.classList.toggle('ledger-bulk-bar__status--busy', busy);
    if (!busy) el.textContent = message;
    if (flashMs > 0) {
        el.classList.add('ledger-bulk-bar__status--flash');
        activityTimer = setTimeout(() => {
            el.classList.remove('ledger-bulk-bar__status--busy', 'ledger-bulk-bar__status--flash');
            window.renderCashLedger?.();
        }, flashMs);
    }
};

/** Cash bills that belong in the current report drill-down (cash_detail mode). */
export const pivotMatchingCashBills = () => {
    if (!ledgerPivotFilter) return [];
    if (ledgerPivotFilter.cashExpenseReporting !== 'cash_detail') return [];
    if (ledgerPivotFilter.type === 'IN') return [];
    if (ledgerPivotFilter.sourceScope) return [];
    const q = (document.getElementById('fn-cash-search')?.value || '').trim();
    return cashBillsAsReportExpenses().filter((t) =>
        txnMatchesLedgerPivotFilter(t)
        && txnMatchesLedgerSearch(t, q)
        && (!ledgerCategoryFilter || normalizeCategoryKey(t.cat || '') === ledgerCategoryFilter),
    );
};

export const applyLedgerTableFilters = (txns) => {
    const q = (document.getElementById('fn-cash-search')?.value || '').trim();
    const passbookFilterOn = isLedgerColumnFilterActive(ledgerColumnFilters.passbook);
    const statementCtx = passbookFilterOn ? buildLedgerStatementContext() : null;
    // Same full-ledger calc map the Passbook / calc cell uses — required for discrepancy.
    const calcById = passbookFilterOn ? ledgerCalculatedBalanceById(txns) : null;
    const ledgerRows = getActiveLedgerTxns(txns).filter((t) =>
        txnMatchesLedgerPivotFilter(t)
        && txnMatchesLedgerSearch(t, q)
        && txnMatchesColumnFilters(t, statementCtx, calcById)
        && (!ledgerCategoryFilter || normalizeCategoryKey(t.cat || '') === ledgerCategoryFilter),
    );
    const bills = pivotMatchingCashBills();
    if (!bills.length) return ledgerRows;
    const seen = new Set(ledgerRows.map((t) => t.id));
    return [...ledgerRows, ...bills.filter((b) => !seen.has(b.id) && txnMatchesColumnFilters(b, statementCtx, calcById))];
};

export const ledgerHasActiveFilters = () => {
    const q = (document.getElementById('fn-cash-search')?.value || '').trim();
    return Boolean(
        q
        || ledgerCategoryFilter
        || ledgerPivotFilter
        || Object.values(ledgerColumnFilters).some((v) => isLedgerColumnFilterActive(v)),
    );
};

export const getLedgerSort = () => ({ ...ledgerSort });

export const toggleLedgerSort = (field) => {
    if (ledgerSort.field === field) {
        ledgerSort = { field, dir: ledgerSort.dir === 'asc' ? 'desc' : 'asc' };
    } else {
        // Date defaults to newest-first; other columns start ascending
        ledgerSort = { field, dir: field === 'date' ? 'desc' : 'asc' };
    }
};

export const setLedgerSort = (field, dir = 'asc') => {
    if (!field) return;
    ledgerSort = { field, dir: dir === 'desc' ? 'desc' : 'asc' };
};

/** Oldest → newest (statement order) for running Calculated balances. */
export const sortLedgerTxnsChronological = (txns) => {
    const statementCtx = buildLedgerStatementContext();
    return [...txns].sort((a, b) => {
        const dayA = ledgerTxnDayKey(a, statementCtx);
        const dayB = ledgerTxnDayKey(b, statementCtx);
        const cmp = dayA.localeCompare(dayB);
        if (cmp) return cmp;
        return compareLedgerTxnStatementOrder(a, b, statementCtx);
    });
};

export const sortLedgerTxns = (txns) => {
    const { field, dir } = ledgerSort;
    const mul = dir === 'asc' ? 1 : -1;
    const statementCtx = field === 'date' ? buildLedgerStatementContext() : null;
    return [...txns].sort((a, b) => {
        if (field === 'date') {
            const dayA = ledgerTxnDayKey(a, statementCtx);
            const dayB = ledgerTxnDayKey(b, statementCtx);
            const cmp = dayA.localeCompare(dayB);
            if (cmp) return mul * cmp;
            return mul * compareLedgerTxnStatementOrder(a, b, statementCtx);
        }
        if (field === 'cat') return mul * String(a.cat || '').localeCompare(String(b.cat || ''));
        if (field === 'wallet') return mul * String(a.wallet || '').localeCompare(String(b.wallet || ''));
        if (field === 'description') {
            return mul * String(a.description || '').localeCompare(String(b.description || ''), undefined, {
                sensitivity: 'base',
                numeric: true,
            });
        }
        if (field === 'type') {
            const typeRank = (t) => (t.type === 'IN' ? 0 : 1);
            const cmp = typeRank(a) - typeRank(b);
            if (cmp) return mul * cmp;
            return mul * String(a.type || '').localeCompare(String(b.type || ''));
        }
        if (field === 'dr' || field === 'cr' || field === 'amount') {
            const signed = (t) => {
                const amt = parseFloat(t.amount) || 0;
                return t.type === 'IN' ? amt : -amt;
            };
            return mul * (signed(a) - signed(b));
        }
        if (field === 'reports') {
            const av = a.exclude_from_reports ? 1 : 0;
            const bv = b.exclude_from_reports ? 1 : 0;
            return mul * (av - bv);
        }
        if (field === 'passbook' || field === 'computedBalance') {
            const bal = (t) => {
                const c = t._ledgerComputedBalance;
                if (c != null && Number.isFinite(Number(c))) return Number(c);
                return Number.NEGATIVE_INFINITY;
            };
            return mul * (bal(a) - bal(b));
        }
        if (field === 'bills') {
            const count = (t) => (fnFinances().financeDocuments || []).filter(
                (d) => d.transaction_id === t.id || d.ledgerEntryId === t.id,
            ).length;
            return mul * (count(a) - count(b));
        }
        return 0;
    });
};

export const clearLedgerPivotFilter = () => {
    ledgerPivotFilter = null;
    renderLedgerPivotBanner();
};

export const clearLedgerFilters = () => {
    clearAllLedgerFilters();
};

export const applyLedgerPivotFilter = (filter) => {
    ledgerPivotFilter = filter ? { ...filter } : null;
    renderLedgerPivotBanner();
};

export const navigateToLedgerFromPivot = (filter) => {
    const stamped = {
        ...filter,
        cashExpenseReporting: filter?.cashExpenseReporting || getCashExpenseReportingMode(),
    };
    applyLedgerPivotFilter(stamped);
    navigateFinance('finance-ledger');
    window.renderCashLedger?.();
};

/** Jump to Bills & receipts with the same report drill-down (cash expenses). */
export const navigateToFinanceDocsFromPivot = async (filter = ledgerPivotFilter) => {
    if (!filter) return;
    const { applyFinanceDocsReportFilter } = await import('./financeDocuments.js');
    applyFinanceDocsReportFilter(filter);
    navigateFinance('finance-docs');
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match query as its own token (not a substring inside another word). */
const hasWordMatch = (haystack, needle) => {
    if (!needle) return false;
    const h = String(haystack || '');
    if (!h) return false;
    return new RegExp(`(?:^|[^a-z0-9])${escapeRe(needle)}(?:[^a-z0-9]|$)`, 'i').test(h);
};

const textIncludes = (haystack, needle) =>
    String(haystack || '').toLowerCase().includes(needle);

/** Free-text ledger search — description/vendor use substring; category uses word boundaries for short queries. */
export const txnMatchesLedgerSearch = (txn, rawQuery) => {
    const q = String(rawQuery || '').trim().toLowerCase();
    if (!q || !txn) return true;

    if (
        textIncludes(txn.description, q)
        || textIncludes(txn.vendor_name, q)
        || textIncludes(txn.vendor_invoice, q)
        || textIncludes(txn.bank_reference, q)
        || textIncludes(txn.sub_category, q)
    ) return true;

    const wallet = (txn.wallet || '').toLowerCase();
    if (wallet.includes(q)) return true;

    const label = categoryDisplayLabel(txn.cat);
    const catKey = normalizeCategoryKey(txn.cat || '');
    if (q.length < 4) {
        return hasWordMatch(label, q) || hasWordMatch(catKey, q);
    }
    return textIncludes(label, q) || textIncludes(catKey, q);
};

export const txnMatchesLedgerPivotFilter = (txn) => {
    if (!ledgerPivotFilter || !txn) return true;
    const f = ledgerPivotFilter;
    // Exact ledger row (e.g. Petty Cash funding cheque from buckets table).
    if (f.transactionId) return txn.id === f.transactionId;
    if (f.type && txn.type !== f.type) return false;
    if (f.sourceScope && !txnMatchesExpenseSourceScope(txn, f.sourceScope)) return false;
    // Match expense pivot in cash_detail: bank Petty funding + cash-desk ledger
    // spends are replaced by cash bills — hide those ledger rows from drill-down.
    if (f.cashExpenseReporting === 'cash_detail' && !txn._fromFinanceDocument) {
        if (isBankPettyFunding(txn) || isCashDeskSpend(txn)) return false;
    }
    if (f.wallet && reportWallet(txn) !== f.wallet) return false;
    if (f.key && f.key !== '__other__') {
        if (f.dimension === 'wallet_cat') {
            // Group row key is CASH/BANK; leaf is CASH|Category.
            if (f.key.includes('|')) {
                if (pivotKeyOnTxn(txn, 'wallet_cat') !== f.key) return false;
            } else if (reportWallet(txn) !== f.key) {
                return false;
            }
        } else if (pivotKeyOnTxn(txn, f.dimension) !== f.key) {
            return false;
        }
    }
    const d = new Date(txn.date);
    if (f.year != null && f.month != null) {
        if (d.getFullYear() !== f.year || d.getMonth() !== f.month) return false;
    } else if (f.rangeStart != null && f.rangeEnd != null) {
        if (d < f.rangeStart || d > f.rangeEnd) return false;
    }
    return true;
};

const formatMonthRangeLabel = (start, end) => {
    const fmt = (dt) => dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    return `${fmt(start)} – ${fmt(end)}`;
};

const describeLedgerPivotFilter = (f) => {
    if (!f) return '';
    const typeLabel = f.type === 'IN' ? 'Income' : 'Expense';
    const parts = [typeLabel];

    if (f.sourceScope === 'sheet') parts.push('from expense sheets');
    else if (f.sourceScope === 'bank') parts.push('from bank reconciliation');
    else if (f.sourceScope === 'manual') parts.push('manual entries');
    else if (f.sourceScope === 'excluded-reports') parts.push('excluded from reports');
    else if (f.sourceScope === 'omitted') parts.push('omitted from expense pivot');

    if (f.transactionId) {
        parts.push(f.label || 'Petty Cash funding cheque');
    } else if (f.key && f.key !== '__other__') {
        if (f.dimension === 'wallet_cat') {
            if (f.key.includes('|')) {
                const cat = f.key.split('|').slice(1).join('|');
                const wallet = f.wallet || f.key.split('|')[0];
                const wLabel = wallet === 'BANK' ? 'Bank' : 'Cash';
                parts.push(`${wLabel} · ${categoryDisplayLabel(cat)}`);
            } else {
                parts.push(f.key === 'BANK' ? 'Bank' : 'Cash');
            }
        } else {
            const dim =
                f.dimension === 'sub_category' ? 'sub-category' : f.dimension === 'vendor' ? 'vendor' : 'category';
            parts.push(`${dim}: ${categoryDisplayLabel(f.key)}`);
        }
    } else if (f.wallet) {
        parts.push(f.wallet === 'BANK' ? 'Bank' : 'Cash');
    } else if (f.scope === 'col-total' || f.scope === 'grand-total') {
        parts.push('all categories');
    }

    if (f.year != null && f.month != null) {
        const mo = new Date(f.year, f.month, 1);
        parts.push(mo.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
    } else if (f.rangeStart != null && f.rangeEnd != null) {
        parts.push(formatMonthRangeLabel(f.rangeStart, f.rangeEnd));
    }

    if (f.cashExpenseReporting === 'cash_detail' && f.type !== 'IN' && !f.sourceScope) {
        parts.push('bank + cash bills');
    }

    return parts.join(' · ');
};

export const updateLedgerSortIndicators = () => {
    document.querySelectorAll('.ledger-sort-btn').forEach((btn) => {
        const field = btn.dataset.sort;
        const active = ledgerSort.field === field;
        btn.classList.toggle('ledger-sort-btn--active', active);
        const icon = btn.querySelector('.ledger-sort-indicator');
        if (icon) {
            icon.textContent = active ? (ledgerSort.dir === 'asc' ? '↑' : '↓') : '';
        }
        btn.setAttribute('aria-sort', active ? (ledgerSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    document.querySelectorAll('.ledger-excel-col-btn').forEach((btn) => {
        const sortField = btn.dataset.ledgerSortField;
        const filterKey = btn.dataset.ledgerFilterKey;
        const sorted = sortField && ledgerSort.field === sortField;
        const filtered = isLedgerColumnFilterActive(ledgerColumnFilters[filterKey]);
        btn.classList.toggle('ledger-excel-col-btn--active', sorted || filtered);
        const icon = btn.querySelector('i');
        if (!icon) return;
        icon.className = 'fa-solid fa-filter';
        if (sorted && ledgerSort.dir === 'asc') icon.className = 'fa-solid fa-arrow-up-short-wide';
        else if (sorted && ledgerSort.dir === 'desc') icon.className = 'fa-solid fa-arrow-down-wide-short';
    });
};

/** Shown only when drilling down from Financial Reports pivot. */
export const renderLedgerPivotBanner = () => {
    const el = document.getElementById('fn-ledger-pivot-banner');
    if (!el) return;

    if (!ledgerPivotFilter) {
        el.hidden = true;
        el.innerHTML = '';
        updateLedgerSortIndicators();
        return;
    }

    const showBillsJump = ledgerPivotFilter.type !== 'IN'
        && !ledgerPivotFilter.sourceScope
        && (
            !!ledgerPivotFilter.transactionId
            || (
                ledgerPivotFilter.cashExpenseReporting === 'cash_detail'
                && ledgerPivotFilter.wallet !== 'BANK'
                && ledgerPivotFilter.key !== 'BANK'
            )
        );

    el.hidden = false;
    el.innerHTML = `
      <span class="ledger-pivot-banner__label"><i class="fa-solid fa-filter" aria-hidden="true"></i> ${describeLedgerPivotFilter(ledgerPivotFilter)}</span>
      <span class="ledger-pivot-banner__actions">
        ${showBillsJump ? '<button type="button" class="btn btn-outline btn--small" id="ledger-pivot-open-bills">Open matching bills</button>' : ''}
        <button type="button" class="btn btn-outline btn--small" id="ledger-pivot-clear">Clear report filter</button>
      </span>`;

    el.querySelector('#fn-ledger-pivot-clear')?.addEventListener('click', () => {
        clearLedgerPivotFilter();
        window.renderCashLedger?.();
    }, { once: true });

    el.querySelector('#fn-ledger-pivot-open-bills')?.addEventListener('click', () => {
        navigateToFinanceDocsFromPivot();
    }, { once: true });

    updateLedgerSortIndicators();
};

/** @deprecated use renderLedgerPivotBanner */
export const renderLedgerContextBar = () => renderLedgerPivotBanner();
export const renderLedgerFilterBanner = () => renderLedgerPivotBanner();
