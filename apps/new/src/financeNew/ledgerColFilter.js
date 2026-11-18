/**
 * Excel-style column filter / sort popover for the Finance-New ledger table.
 * Thin wrapper over the generic excelColMenu factory with ledger state wired in.
 * Amount → comparison ops; Passbook/calc → dual number filters + discrepancy.
 */
import { createExcelColFilter } from './excelColMenu.js';
import {
    clearLedgerColumnFilter,
    getLedgerColumnFilters,
    getLedgerSort,
    isLedgerColumnFilterActive,
    setLedgerColumnFilter,
    setLedgerSort,
} from './ledgerFilter.js';

const impl = createExcelColFilter({
    menuId: 'ledger-excel-col-menu',
    sortableKeys: new Set(['date', 'amount', 'cat', 'wallet', 'passbook', 'description', 'type', 'bills']),
    numberKeys: new Set(['amount']),
    passbookKeys: new Set(['passbook']),
    getFilters: getLedgerColumnFilters,
    isFilterActive: isLedgerColumnFilterActive,
    setFilter: setLedgerColumnFilter,
    clearFilter: clearLedgerColumnFilter,
    getSort: getLedgerSort,
    setSort: setLedgerSort,
    defaultSort: { field: 'date', dir: 'desc' },
    onServerRefresh: () => {
        void import('./finances.js').then((m) => {
            if (typeof m.refetchLedgerFromFilters === 'function') return m.refetchLedgerFromFilters();
            window.renderCashLedger?.();
        });
    },
    onLocalRefresh: () => window.renderCashLedger?.(),
    beforeApply: (filterKey, value, done) => {
        // Passbook discrepancy needs trusted stored balances — block until recalc.
        if (value?.kind === 'passbook' && value.discrepancy) {
            import('./ledgerBalance.js').then(({ getLedgerBalanceMeta }) => {
                if (getLedgerBalanceMeta().needsRecalc) {
                    alert('Recalculate stored balances before filtering by Passbook discrepancy.');
                    return;
                }
                setLedgerColumnFilter(filterKey, value);
                done(false);
            });
            return true;
        }
        return false;
    },
});

/** Header cell: label + filter icon (Excel-style). Click icon → sort + filter. */
export const renderExcelColHeader = impl.renderExcelColHeader;

/** Wire once on the ledger table host (click filter buttons). */
export const wireLedgerExcelColFilters = impl.wireExcelColFilters;
