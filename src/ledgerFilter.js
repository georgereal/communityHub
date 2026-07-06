/**
 * Drill-down filter from Financial Reports pivot → Financial Ledger.
 * Sort state and context bar for the Financial Ledger table.
 */
const pivotKeyOnTxn = (txn, dimension) => {
    if (dimension === 'sub_category') return txn.sub_category?.trim() || '(none)';
    if (dimension === 'vendor') return txn.vendor_name?.trim() || '(none)';
    return txn.cat || 'Other';
};

let ledgerPivotFilter = null;
let ledgerSort = { field: 'date', dir: 'desc' };

export const getLedgerPivotFilter = () => ledgerPivotFilter;

export const getLedgerSort = () => ({ ...ledgerSort });

export const toggleLedgerSort = (field) => {
    if (ledgerSort.field === field) {
        ledgerSort = { field, dir: ledgerSort.dir === 'asc' ? 'desc' : 'asc' };
    } else {
        ledgerSort = { field, dir: field === 'date' ? 'desc' : 'asc' };
    }
};

export const sortLedgerTxns = (txns) => {
    const { field, dir } = ledgerSort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...txns].sort((a, b) => {
        if (field === 'date') return mul * (new Date(a.date) - new Date(b.date));
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
        return 0;
    });
};

export const clearLedgerPivotFilter = () => {
    ledgerPivotFilter = null;
    renderLedgerContextBar();
};

export const applyLedgerPivotFilter = (filter) => {
    ledgerPivotFilter = filter ? { ...filter } : null;
    renderLedgerContextBar();
};

export const navigateToLedgerFromPivot = (filter) => {
    applyLedgerPivotFilter(filter);
    window.switchView?.('finance-ledger');
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
        parts.push(`${dim}: ${f.label || f.key}`);
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
    if (search) {
        chips.push(`<span class="ledger-context-chip ledger-context-chip--search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> “${search.replace(/</g, '&lt;')}”</span>`);
    }
    chips.push(`<span class="ledger-context-chip ledger-context-chip--sort"><i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i> ${describeLedgerSort()}</span>`);

    const hasClearable = ledgerPivotFilter || search;
    el.hidden = false;
    el.innerHTML = `
      <div class="ledger-context-bar__chips">${chips.join('')}</div>
      ${hasClearable ? '<button type="button" class="btn btn-outline btn--small" id="ledger-context-clear">Clear filters</button>' : ''}`;

    el.querySelector('#ledger-context-clear')?.addEventListener('click', () => {
        clearLedgerPivotFilter();
        const searchEl = document.getElementById('cash-search');
        if (searchEl) searchEl.value = '';
        window.renderCashLedger?.();
    }, { once: true });

    updateLedgerSortIndicators();
};

/** @deprecated use renderLedgerContextBar */
export const renderLedgerFilterBanner = () => renderLedgerContextBar();
