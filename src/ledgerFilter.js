/**
 * Drill-down filter from Financial Reports pivot → Financial Ledger.
 * Sort state and context bar for the Financial Ledger table.
 */
import { normalizeCategoryKey, categoryDisplayLabel } from './expenseCategories.js';
import { getActiveLedgerTxns } from './ledgerBalance.js';
import { isTransactionReconciled } from './bankReconciliation.js';

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

const pivotKeyOnTxn = (txn, dimension) => {
    if (dimension === 'sub_category') return txn.sub_category?.trim() || '(none)';
    if (dimension === 'vendor') return txn.vendor_name?.trim() || '(none)';
    return normalizeCategoryKey(txn.cat || 'Other');
};

let ledgerPivotFilter = null;
let ledgerCategoryFilter = null;
let ledgerSort = { field: 'date', dir: 'asc' };
let activityTimer = null;

export const getLedgerPivotFilter = () => ledgerPivotFilter;

export const getLedgerCategoryFilter = () => ledgerCategoryFilter;

export const setLedgerCategoryFilter = (cat) => {
    ledgerCategoryFilter = cat ? normalizeCategoryKey(cat) : null;
    const sel = document.getElementById('ledger-cat-filter');
    if (sel && sel.value !== (ledgerCategoryFilter || '')) sel.value = ledgerCategoryFilter || '';
    renderLedgerPivotBanner();
};

export const clearAllLedgerFilters = () => {
    ledgerPivotFilter = null;
    ledgerCategoryFilter = null;
    const searchEl = document.getElementById('cash-search');
    if (searchEl) searchEl.value = '';
    const catSel = document.getElementById('ledger-cat-filter');
    if (catSel) catSel.value = '';
    renderLedgerPivotBanner();
};

export const setLedgerSearchBusy = (busy) => {
    const wrap = document.getElementById('cash-search')?.closest('.ledger-toolbar__search');
    wrap?.classList.toggle('ledger-search--busy', busy);
    const icon = wrap?.querySelector('.ledger-search-icon');
    const spinner = wrap?.querySelector('.ledger-search-spinner');
    if (icon) icon.hidden = busy;
    if (spinner) spinner.hidden = !busy;
};

/** Brief status on the bulk bar or entry count — no separate activity row. */
export const setLedgerActivity = (message, { busy = false, flashMs = 0 } = {}) => {
    clearTimeout(activityTimer);
    const bulkEl = document.getElementById('ledger-bulk-count');
    const countEl = document.getElementById('cash-txn-count');
    const el = bulkEl && !bulkEl.closest('#ledger-bulk-bar')?.hidden ? bulkEl : countEl;
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

export const applyLedgerTableFilters = (txns) => {
    const q = (document.getElementById('cash-search')?.value || '').trim();
    return getActiveLedgerTxns(txns).filter((t) =>
        txnMatchesLedgerPivotFilter(t)
        && txnMatchesLedgerSearch(t, q)
        && (!ledgerCategoryFilter || normalizeCategoryKey(t.cat || '') === ledgerCategoryFilter),
    );
};

export const ledgerHasActiveFilters = () => {
    const q = (document.getElementById('cash-search')?.value || '').trim();
    return Boolean(q || ledgerCategoryFilter || ledgerPivotFilter);
};

export const getLedgerSort = () => ({ ...ledgerSort });

export const toggleLedgerSort = (field) => {
    if (ledgerSort.field === field) {
        ledgerSort = { field, dir: ledgerSort.dir === 'asc' ? 'desc' : 'asc' };
    } else {
        ledgerSort = { field, dir: field === 'date' ? 'asc' : 'asc' };
    }
};

export const sortLedgerTxns = (txns) => {
    const { field, dir } = ledgerSort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...txns].sort((a, b) => {
        if (field === 'date') {
            const cmp = new Date(a.date) - new Date(b.date);
            if (cmp) return mul * cmp;
            return mul * String(a.id || '').localeCompare(String(b.id || ''));
        }
        if (field === 'cat') return mul * String(a.cat || '').localeCompare(String(b.cat || ''));
        if (field === 'wallet') return mul * String(a.wallet || '').localeCompare(String(b.wallet || ''));
        if (field === 'dr') {
            const av = a.type === 'OUT' ? parseFloat(a.amount) || 0 : 0;
            const bv = b.type === 'OUT' ? parseFloat(b.amount) || 0 : 0;
            return mul * (av - bv);
        }
        if (field === 'cr') {
            const av = a.type === 'IN' ? parseFloat(a.amount) || 0 : 0;
            const bv = b.type === 'IN' ? parseFloat(b.amount) || 0 : 0;
            return mul * (av - bv);
        }
        if (field === 'reports') {
            const av = a.exclude_from_reports ? 1 : 0;
            const bv = b.exclude_from_reports ? 1 : 0;
            return mul * (av - bv);
        }
        if (field === 'computedBalance') {
            const av = a._ledgerComputedBalance ?? Number.NEGATIVE_INFINITY;
            const bv = b._ledgerComputedBalance ?? Number.NEGATIVE_INFINITY;
            return mul * (av - bv);
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
    applyLedgerPivotFilter(filter);
    window.switchView?.('finance-ledger');
    window.renderCashLedger?.();
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
    if (f.type && txn.type !== f.type) return false;
    if (f.sourceScope && !txnMatchesExpenseSourceScope(txn, f.sourceScope)) return false;
    if (f.key && f.key !== '__other__' && pivotKeyOnTxn(txn, f.dimension) !== f.key) return false;
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

    if (f.key && f.key !== '__other__') {
        const dim =
            f.dimension === 'sub_category' ? 'sub-category' : f.dimension === 'vendor' ? 'vendor' : 'category';
        parts.push(`${dim}: ${categoryDisplayLabel(f.key)}`);
    } else if (f.scope === 'col-total' || f.scope === 'grand-total') {
        parts.push('all categories');
    }

    if (f.year != null && f.month != null) {
        const mo = new Date(f.year, f.month, 1);
        parts.push(mo.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
    } else if (f.rangeStart != null && f.rangeEnd != null) {
        parts.push(formatMonthRangeLabel(f.rangeStart, f.rangeEnd));
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
};

/** Shown only when drilling down from Financial Reports pivot. */
export const renderLedgerPivotBanner = () => {
    const el = document.getElementById('ledger-pivot-banner');
    if (!el) return;

    if (!ledgerPivotFilter) {
        el.hidden = true;
        el.innerHTML = '';
        updateLedgerSortIndicators();
        return;
    }

    el.hidden = false;
    el.innerHTML = `
      <span class="ledger-pivot-banner__label"><i class="fa-solid fa-filter" aria-hidden="true"></i> ${describeLedgerPivotFilter(ledgerPivotFilter)}</span>
      <button type="button" class="btn btn-outline btn--small" id="ledger-pivot-clear">Clear report filter</button>`;

    el.querySelector('#ledger-pivot-clear')?.addEventListener('click', () => {
        clearLedgerPivotFilter();
        window.renderCashLedger?.();
    }, { once: true });

    updateLedgerSortIndicators();
};

/** @deprecated use renderLedgerPivotBanner */
export const renderLedgerContextBar = () => renderLedgerPivotBanner();
export const renderLedgerFilterBanner = () => renderLedgerPivotBanner();
