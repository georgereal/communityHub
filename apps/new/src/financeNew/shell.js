/**
 * Finance-New activation — Accounts tabs redirect to MPA; invoices stay SPA for now.
 */
import { loadInvoicesShell } from './load.js';
import { financePathForRoute, writeFinanceCtxFromPortal } from '../financeApp/session.js';
import { portalState } from '../store.js';

const FN_ACCOUNTS_ROUTES = {
    reports: 'fn-reports',
    ledger: 'fn-ledger',
    'finance-docs': 'fn-docs',
    'expense-plan': 'fn-expense-plan',
    'invoices-raised': 'fn-invoices-raised',
    'bank-recon': 'fn-bank-recon',
};

/** @deprecated SPA accounts shell — redirects to /finance/*.html */
export async function activateFinanceNewAccounts(subview) {
    const sub = subview || 'ledger';
    const route = FN_ACCOUNTS_ROUTES[sub] || 'fn-ledger';
    const path = financePathForRoute(route);
    if (path) {
        try {
            writeFinanceCtxFromPortal(portalState);
        } catch (err) {
            console.warn('[fn] writeFinanceCtx:', err?.message || err);
        }
        window.location.assign(path);
        return;
    }

    // Fallback (should not run): old SPA shell
    const {
        syncAccountsSubViewTabs,
        syncAccountsHeaderActions,
        initAccountsSubViewTabs,
        initExpenseModal,
    } = await import('./finances.js');

    initAccountsSubViewTabs();
    initExpenseModal?.();
    syncAccountsSubViewTabs(route);
    syncAccountsHeaderActions(sub);

    const syncPanel = document.getElementById('fn-ledger-sync-panel');
    if (syncPanel) syncPanel.innerHTML = '';
    const bankSyncBtn = document.getElementById('fn-btn-accounts-bank-sync');
    if (bankSyncBtn) bankSyncBtn.hidden = true;

    if (typeof window.switchSubView === 'function') {
        await window.switchSubView(sub);
    }
}

export async function activateFinanceNewInvoices(subview) {
    const sub = subview || 'pending-dues';
    await loadInvoicesShell({ withLedger: sub === 'collections' || sub === 'list' });

    const { renderInvoicesPage, initMaintenanceBilling } = await import('./maintenanceBilling.js');
    initMaintenanceBilling?.();
    try {
        const { initPayments } = await import('./payments.js');
        initPayments?.();
    } catch { /* optional */ }

    if (typeof window.switchInvoiceSubView === 'function') {
        window.switchInvoiceSubView(sub);
    } else {
        document.querySelectorAll('#view-finance-new-invoices [data-invoice-subview]').forEach((el) => {
            el.hidden = el.dataset.invoiceSubview !== sub;
            el.style.display = el.dataset.invoiceSubview === sub ? '' : 'none';
        });
    }
    renderInvoicesPage();
}

export function initFinanceNewAccountsShell() {
    // Deprecated — Accounts live under /finance/*.html
}

export function initFinanceNewInvoicesShell() {
    // Initialized on activate.
}
