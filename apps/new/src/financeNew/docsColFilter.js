/**
 * Excel-style column filter / sort state + popover for the Bills & receipts table.
 * All filters and sorts run server-side in listVouchers (col_* + sort params).
 */
import { createExcelColFilter } from './excelColMenu.js';

/** @type {Record<string, string|object>} column filter key → text or number spec */
let fdocColumnFilters = {};
let fdocSort = { field: 'doc_date', dir: 'desc' };

const isNumberSpecActive = (spec) => {
    if (!spec || typeof spec !== 'object') return false;
    const has = (x) => x != null && String(x).trim() !== '' && Number.isFinite(parseFloat(x));
    return spec.op === 'between' ? (has(spec.value) || has(spec.value2)) : has(spec.value);
};

export const isFdocColumnFilterActive = (value) => {
    if (value == null) return false;
    if (typeof value === 'string') return Boolean(value.trim());
    if (typeof value === 'object' && value.kind === 'number') return isNumberSpecActive(value);
    return false;
};

export const getFdocColumnFilters = () => ({ ...fdocColumnFilters });
export const getFdocSort = () => ({ ...fdocSort });

export const setFdocColumnFilter = (key, value) => {
    if (value == null || value === '') {
        delete fdocColumnFilters[key];
        return;
    }
    if (typeof value === 'object') {
        if (!isFdocColumnFilterActive(value)) delete fdocColumnFilters[key];
        else fdocColumnFilters[key] = value;
        return;
    }
    const q = String(value).trim();
    if (!q) delete fdocColumnFilters[key];
    else fdocColumnFilters[key] = q;
};

export const clearFdocColumnFilter = (key) => {
    delete fdocColumnFilters[key];
};

export const clearAllFdocColumnFilters = () => {
    fdocColumnFilters = {};
    fdocSort = { field: 'doc_date', dir: 'desc' };
};

export const setFdocSort = (field, dir = 'asc') => {
    if (!field) return;
    fdocSort = { field, dir: dir === 'desc' ? 'desc' : 'asc' };
};

/** Params merged into every listVouchers page fetch. */
export const fdocServerListParams = () => {
    const params = { sort: fdocSort.field, sort_dir: fdocSort.dir };
    for (const [key, val] of Object.entries(fdocColumnFilters)) {
        if (!isFdocColumnFilterActive(val)) continue;
        params[`col_${key}`] = typeof val === 'object' ? JSON.stringify(val) : val;
    }
    return params;
};

const impl = createExcelColFilter({
    menuId: 'fdoc-excel-col-menu',
    sortableKeys: new Set(['date', 'kind', 'cat', 'particulars', 'amount', 'status', 'wallet']),
    numberKeys: new Set(['amount']),
    getFilters: getFdocColumnFilters,
    isFilterActive: isFdocColumnFilterActive,
    setFilter: setFdocColumnFilter,
    clearFilter: clearFdocColumnFilter,
    getSort: getFdocSort,
    setSort: setFdocSort,
    defaultSort: { field: 'doc_date', dir: 'desc' },
    onServerRefresh: () => {
        void import('./financeDocuments.js').then((m) => m.refetchFinanceDocsFromFilters?.());
    },
    onLocalRefresh: () => {
        void import('./financeDocuments.js').then((m) => m.refetchFinanceDocsFromFilters?.());
    },
});

/** Header cell: label + filter icon (Excel-style). */
export const renderFdocColHeader = impl.renderExcelColHeader;

/** Wire once on the docs table host (click filter buttons). */
export const wireFdocExcelColFilters = impl.wireExcelColFilters;
