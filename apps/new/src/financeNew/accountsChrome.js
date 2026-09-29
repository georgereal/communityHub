/**
 * Slim Finance MPA chrome helpers — header actions + page help.
 * Do NOT import finances.js from page entries just for chrome; that pulls ledger/docs/recon.
 * Modal openers live in finances.js and are loaded on demand via ensureFinanceModals().
 */
import { can } from '../capabilities.js';
import { refreshCapabilityGates } from '../capUi.js';
import { ACCOUNTS_PAGE_HELP, applyFinancePageHeader, wireFinancePageHelp } from '../financePageHelp.js';

/** @type {Promise<typeof import('./finances.js')>|null} */
let financeModalsPromise = null;

/** Lazy-load finances.js (cash/ledger-line modals + window openers). */
export function ensureFinanceModals() {
    if (!financeModalsPromise) {
        financeModalsPromise = import('./finances.js').then((m) => {
            m.initExpenseModal?.();
            return m;
        });
    }
    return financeModalsPromise;
}

/** Open bill/receipt modal after ensuring finances.js is loaded. */
export async function openFinanceDocumentModal(doc, { readOnly = false } = {}) {
    if (!doc) return;
    await ensureFinanceModals();
    if (readOnly) window.openFinanceDocumentView?.(doc);
    else window.openFinanceDocumentEdit?.(doc, { readOnly: false });
}

/**
 * Show/hide header action groups and apply page title/help for the active subview.
 * @param {string} sv — accounts subview key (ledger, expense-plan, …)
 */
export function syncAccountsHeaderActions(sv) {
    const bills = sv === 'finance-docs';
    const ledger = sv === 'ledger' || sv === 'bank-recon';
    const standalone = sv === 'activity';
    document.querySelectorAll('[data-accounts-actions]').forEach((el) => {
        const kind = el.dataset.accountsActions;
        if (kind === 'bills') el.hidden = !bills;
        else if (kind === 'ledger') el.hidden = !ledger;
    });

    const canUseBankSync = can('accounts.bank_sync');
    const bankSync = document.getElementById('fn-btn-accounts-bank-sync')
        || document.querySelector('#accounts-header-actions [onclick*="openBankSnapshot"]');
    if (bankSync) bankSync.hidden = !ledger || standalone || !canUseBankSync;

    refreshCapabilityGates(document.getElementById('fn-accounts-header-actions') || document);

    const help = ACCOUNTS_PAGE_HELP[sv] || ACCOUNTS_PAGE_HELP.ledger;
    applyFinancePageHeader({
        titleId: 'fn-accounts-page-title',
        descId: 'fn-accounts-page-desc',
        help: standalone ? ACCOUNTS_PAGE_HELP.activity : help,
    });

    const helpPop = document.getElementById('fn-accounts-page-help');
    const helpBtn = document.getElementById('fn-accounts-page-help-btn');
    if (helpPop && !helpPop.hidden) {
        helpPop.hidden = true;
        helpBtn?.setAttribute('aria-expanded', 'false');
    }
}

/** Wire header Add buttons to lazy-loaded finances modal openers (once). */
export function wireAccountsHeaderActionButtons() {
    const root = document.getElementById('fn-accounts-header-actions');
    if (!root || root.dataset.chromeWired === '1') return;
    root.dataset.chromeWired = '1';

    const run = (fnName) => async () => {
        await ensureFinanceModals();
        const fn = window[fnName];
        if (typeof fn === 'function') fn();
    };

    document.getElementById('fn-btn-ledger-add-expense')?.addEventListener('click', run('openLedgerExpense'));
    document.getElementById('fn-btn-ledger-add-income')?.addEventListener('click', run('openLedgerIncome'));
    document.getElementById('fn-btn-bill-add-expense')?.addEventListener('click', run('openBillExpense'));
    document.getElementById('fn-btn-bill-add-income')?.addEventListener('click', run('openBillIncome'));
}

/**
 * MPA chrome: header sync + optional action wiring (no ledger table / bulk bar).
 * @param {string} [sv]
 * @param {{ wireActions?: boolean }} [opts] — set wireActions false when finances.js wires buttons itself (ledger).
 */
export function initAccountsPageChrome(sv = 'ledger', { wireActions = true } = {}) {
    syncAccountsHeaderActions(sv);
    if (wireActions) wireAccountsHeaderActionButtons();
    wireFinancePageHelp({
        btnId: 'fn-accounts-page-help-btn',
        popoverId: 'fn-accounts-page-help',
        getHelp: () => ACCOUNTS_PAGE_HELP[sv] || ACCOUNTS_PAGE_HELP.ledger,
    });
}

/** @deprecated Prefer initAccountsPageChrome(sv) */
export function initAccountsSubViewTabs(sv = 'ledger') {
    if (document.documentElement.dataset.financeApp === '1') {
        initAccountsPageChrome(sv);
        return;
    }
    void import('./finances.js').then((m) => {
        m.initAccountsSubViewTabs?.();
        if (sv) m.syncAccountsHeaderActions?.(sv);
    });
}
