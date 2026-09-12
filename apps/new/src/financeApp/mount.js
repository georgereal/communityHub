/**
 * Shared mount helpers for Finance MPA — shell first, optional assets lazy.
 */
import { bootFinanceApp, switchFinanceApartment } from './boot.js';
import { mountAppShell, setAppShellPageContent } from '../appShell/mount.js';
import './finance-app.css';

const PAGE_META = {
    reports: {
        route: 'fn-reports',
        title: 'Financial reports',
        subtitle: 'Income, expenses, and cash position for this society.',
        actions: null,
    },
    ledger: {
        route: 'fn-ledger',
        title: 'Ledger',
        subtitle: 'Cash and bank passbook for this society.',
        actions: 'ledger',
    },
    docs: {
        route: 'fn-docs',
        title: 'Bills & receipts',
        subtitle: 'Invoices and payment documents linked to the ledger.',
        actions: 'bills',
    },
    'expense-plan': {
        route: 'fn-expense-plan',
        title: 'Expense plan',
        subtitle: 'Planned and recurring expenses.',
        actions: null,
    },
    'invoices-raised': {
        route: 'fn-invoices-raised',
        title: 'Invoices Raised',
        subtitle: 'NoBroker / raised invoice imports.',
        actions: null,
    },
    'bank-recon': {
        route: 'fn-bank-recon',
        title: 'Bank Reconciliation',
        subtitle: 'Match bank statement lines to the ledger.',
        actions: 'ledger',
    },
};

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildPageChrome(page, meta) {
    return `
      <div class="app-shell-page-chrome">
        <header class="ledger-page-header ledger-page-header--compact">
          <div class="header-title ledger-page-header__title">
            <div class="page-heading">
              <h2 id="fn-accounts-page-title">${esc(meta.title || 'Finance')}</h2>
            </div>
            <p id="fn-accounts-page-desc" class="ledger-page-header__subtitle">${esc(meta.subtitle || '')}</p>
          </div>
          <div class="ledger-page-header__actions" id="fn-accounts-header-actions"></div>
        </header>
      </div>`;
}

function placeReportsSettingsInHeader() {
    const tools = document.getElementById('fn-reports-header-tools');
    const actionsHost = document.getElementById('fn-accounts-header-actions');
    if (!tools || !actionsHost) return;
    actionsHost.appendChild(tools);
}

async function injectHeaderActions(meta) {
    if (!meta.actions) {
        const bankSync = document.getElementById('fn-btn-accounts-bank-sync');
        if (bankSync) bankSync.hidden = true;
        return;
    }
    const actionsHost = document.getElementById('fn-accounts-header-actions');
    if (!actionsHost) return;
    const { default: headerActionsHtml } = await import('./html/_header-actions.html?raw');
    const wrap = document.createElement('div');
    wrap.innerHTML = headerActionsHtml.trim();
    const inner = wrap.firstElementChild;
    if (!inner) return;
    actionsHost.replaceWith(inner);
    document.querySelectorAll('[data-accounts-actions]').forEach((el) => {
        const key = el.getAttribute('data-accounts-actions');
        el.hidden = key !== meta.actions;
    });
    const bankSync = document.getElementById('fn-btn-accounts-bank-sync');
    if (bankSync) bankSync.hidden = meta.actions !== 'ledger';

    const { applyCapabilityGates } = await import('../capUi.js');
    applyCapabilityGates(document.getElementById('fn-accounts-header-actions') || document);
}

async function injectModals({ ledgerOnly = false, bankRecon = false } = {}) {
    let host = document.getElementById('finance-app-modals');
    if (!host) {
        host = document.createElement('div');
        host.id = 'finance-app-modals';
        document.body.appendChild(host);
    }
    const parts = [];
    if (ledgerOnly) {
        const { default: ledgerLineModalHtml } = await import('./html/_ledger-line-modal.html?raw');
        parts.push(ledgerLineModalHtml);
    } else {
        const [
            { default: cashModalHtml },
            { default: ledgerLineModalHtml },
            { default: quickCaptureHtml },
        ] = await Promise.all([
            import('./html/_cash-modal.html?raw'),
            import('./html/_ledger-line-modal.html?raw'),
            import('./html/_quick-capture.html?raw'),
        ]);
        parts.push(cashModalHtml, ledgerLineModalHtml, quickCaptureHtml);
    }
    if (bankRecon) {
        const { default: bankReconModalsHtml } = await import('./html/_bank-recon-modals.html?raw');
        parts.push(bankReconModalsHtml);
    }
    host.innerHTML = parts.join('\n');
}

/**
 * Boot auth → paint shell + page HTML → optional modals.
 * Does not load feature modules or page data APIs.
 */
export async function mountFinancePage({
    page,
    fragmentHtml,
    withModals = false,
    withBankReconModals = false,
} = {}) {
    const status = document.querySelector('#app-shell-page .finance-mpa-status, #app-shell-root .finance-mpa-status');
    if (status) status.textContent = 'Loading…';

    const ctx = await bootFinanceApp({ page });
    if (!ctx) return null;

    const meta = PAGE_META[page] || { title: 'Finance', subtitle: '', route: 'fn-ledger' };

    mountAppShell({
        activeRoute: meta.route,
        moduleLabel: 'Finance-New',
        pageLabel: meta.title,
        onApartmentChange: (id) => switchFinanceApartment(id),
    });

    const pageHtml = `${buildPageChrome(page, meta)}\n<div class="app-shell-page-body">${fragmentHtml}</div>`;
    setAppShellPageContent(pageHtml);

    document.querySelectorAll('#app-shell-page [id^="fn-subview-"]').forEach((el) => {
        el.style.display = 'block';
    });

    await injectHeaderActions(meta);
    placeReportsSettingsInHeader();

    if (withModals || withBankReconModals) {
        await injectModals({
            ledgerOnly: withBankReconModals && !withModals,
            bankRecon: withBankReconModals,
        });
    }

    return ctx;
}

export { PAGE_META };
