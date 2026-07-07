import { initExpenseModal, initAccountsSubViewTabs, saveCashData, renderCashLedger } from '../../finances.js';
import { initFinanceAnalyticsUi, renderFinanceAnalytics } from '../../financeAnalytics.js';
import { initBankReconciliationUi } from '../../bankReconciliation.js';
import { initActivityAuditUi } from '../../activityAudit.js';
import { initGeneralLedger } from '../../generalLedger.js';
import { initBulkCollectionImport } from '../../bulkCollectionImport.js';
import { renderLedgerSyncPanel } from '../../ledgerSpreadsheetSync.js';
import { processFinances } from '../../finances.js';
import { withButtonBusy } from '../../buttonBusy.js';

let wired = false;

export default async function initAccountsView() {
    if (wired) return;
    wired = true;

    document.getElementById('save-cash-btn')?.addEventListener('click', () => {
        void withButtonBusy(document.getElementById('save-cash-btn'), 'Saving…', saveCashData);
    });

    initExpenseModal();
    initAccountsSubViewTabs();
    initBulkCollectionImport();
    initActivityAuditUi();
    initBankReconciliationUi();
    initFinanceAnalyticsUi();
    initGeneralLedger();

    window.renderLedgerSyncPanel = renderLedgerSyncPanel;
    window.renderFinanceAnalytics = renderFinanceAnalytics;
    window.renderCashLedger = renderCashLedger;
    window.processFinances = processFinances;
}
