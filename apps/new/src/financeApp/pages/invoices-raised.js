/**
 * Finance MPA — Invoices raised
 */
import fragmentHtml from '../html/invoices-raised.html?raw';

function setStatus(msg) {
    const el = document.querySelector('#app-shell-page .finance-mpa-status, #app-shell-root .finance-mpa-status');
    if (el) el.textContent = msg;
}

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
    try {
        setStatus('Signing in…');
        const { mountFinancePage } = await import('../mount.js');
        const ctx = await mountFinancePage({ page: 'invoices-raised', fragmentHtml });
        if (!ctx) return;

        setStatus('Loading invoices…');
        const { loadAccountsInvoicesRaised } = await import('../../financeNew/load.js');
        await loadAccountsInvoicesRaised();

        const {
            initAccountsSubViewTabs,
            syncAccountsHeaderActions,
        } = await import('../../financeNew/finances.js');
        initAccountsSubViewTabs?.();
        syncAccountsHeaderActions?.('invoices-raised');

        const { initInvoicesRaisedPage, renderInvoicesRaisedPage } = await import('../../financeNew/invoicesRaisedPage.js');
        initInvoicesRaisedPage();
        renderInvoicesRaisedPage();

        document.querySelector('.finance-mpa-status')?.remove();
    } catch (err) {
        console.error('[finance/invoices-raised]', err);
        const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
        if (host) {
            host.innerHTML = `<p class="finance-mpa-status" role="alert">${esc(err.message || 'Failed to load invoices.')}</p>`;
        }
    }
}

void main();
