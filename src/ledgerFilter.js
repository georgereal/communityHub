/**
 * Drill-down filter from Financial Reports pivot → Financial Ledger.
 * Sort state and context bar for the Financial Ledger table.
 */
import { normalizeCategoryKey, categoryDisplayLabel } from './expenseCategories.js';
import { getActiveLedgerTxns } from './ledgerBalance.js';

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
    renderLedgerContextBar();
};

export const clearAllLedgerFilters = () => {
    ledgerPivotFilter = null;
    ledgerCategoryFilter = null;
    const searchEl = document.getElementById('cash-search');
    if (searchEl) searchEl.value = '';
    const catSel = document.getElementById('ledger-cat-filter');
    if (catSel) catSel.value = '';
    renderLedgerContextBar();
};

export const setLedgerSearchBusy = (busy) => {
    const wrap = document.getElementById('cash-search')?.closest('.ledger-ledger-toolbar__search');
    wrap?.classList.toggle('ledger-search--busy', busy);
    const icon = wrap?.querySelector('.ledger-search-icon');
    const spinner = wrap?.querySelector('.ledger-search-spinner');
    if (icon) icon.hidden = busy;
    if (spinner) spinner.hidden = !busy;
};

export const setLedgerActivity = (message, { busy = false, flashMs = 0 } = {}) => {
    const el = document.getElementById('ledger-activity');
    if (!el) return;
    clearTimeout(activityTimer);
    if (!message) {
        el.hidden = true;
        el.innerHTML = '';
        el.classList.remove('ledger-activity--busy');
        return;
    }
    el.hidden = false;
    el.classList.toggle('ledger-activity--busy', busy);
    el.innerHTML = busy
        ? `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i><span>${message}</span>`
        : `<span>${message}</span>`;
    if (flashMs > 0) {
        activityTimer = setTimeout(() => setLedgerActivity(null), flashMs);
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
    renderLedgerContextBar();
};

export const clearLedgerFilters = () => {
    clearAllLedgerFilters();
};

export const applyLedgerPivotFilter = (filter) => {
    ledgerPivotFilter = filter ? { ...filter } : null;
    renderLedgerContextBar();
};

export const navigateToLedgerFromPivot = (filter) => {
    applyLedgerPivotFilter(filter);
    window.switchView?.('finance-ledger');
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

const sortLabels = {
    date: 'Date',
    wallet: 'Ledger',
    cat: 'Category',
    dr: 'Debit',
    cr: 'Credit',
    reports: 'Reports',
    computedBalance: 'Calculated',
};

const describeLedgerSort = () => {
    const label = sortLabels[ledgerSort.field] || ledgerSort.field;
    const dirLabel =
        ledgerSort.field === 'date'
            ? (ledgerSort.dir === 'desc' ? 'newest first' : 'oldest first')
            : (ledgerSort.dir === 'asc' ? 'A → Z' : 'Z → A');
    return `${label} (${dirLabel})`;
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

export const renderLedgerContextBar = () => {
    const el = document.getElementById('ledger-context-bar');
    if (!el) return;

    const search = (document.getElementById('cash-search')?.value || '').trim();
    const chips = [];

    if (ledgerPivotFilter) {
        chips.push(`<span class="ledger-context-chip ledger-context-chip--filter"><i class="fa-solid fa-filter" aria-hidden="true"></i> ${describeLedgerPivotFilter(ledgerPivotFilter)}</span>`);
    }
    if (ledgerCategoryFilter) {
        chips.push(`<span class="ledger-context-chip ledger-context-chip--filter"><i class="fa-solid fa-tag" aria-hidden="true"></i> Category: ${categoryDisplayLabel(ledgerCategoryFilter)}</span>`);
    }
    if (search) {
        chips.push(`<span class="ledger-context-chip ledger-context-chip--search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> “${search.replace(/</g, '&lt;')}”</span>`);
    }
    chips.push(`<span class="ledger-context-chip ledger-context-chip--sort"><i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i> ${describeLedgerSort()}</span>`);

    const hasClearable = ledgerPivotFilter || search || ledgerCategoryFilter;
    el.hidden = false;
    el.innerHTML = `
      <div class="ledger-context-bar__chips">${chips.join('')}</div>
      ${hasClearable ? '<button type="button" class="btn btn-outline btn--small" id="ledger-context-clear">Clear filters</button>' : ''}`;

    el.querySelector('#ledger-context-clear')?.addEventListener('click', () => {
        clearAllLedgerFilters();
        window.renderCashLedger?.();
    }, { once: true });

    updateLedgerSortIndicators();
};

/** @deprecated use renderLedgerContextBar */
export const renderLedgerFilterBanner = () => renderLedgerContextBar();
