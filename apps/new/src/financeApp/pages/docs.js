/**
 * Finance MPA — Bills & receipts
 */
import fragmentHtml from '../html/docs.html?raw';

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
        const ctx = await mountFinancePage({ page: 'docs', fragmentHtml, withModals: true });
        if (!ctx) return;

        setStatus('Loading documents…');
        const { loadAccountsFinanceDocs } = await import('../../financeNew/load.js');
        await loadAccountsFinanceDocs();

        const {
            initExpenseModal,
            initAccountsSubViewTabs,
            syncAccountsHeaderActions,
        } = await import('../../financeNew/finances.js');
        initAccountsSubViewTabs?.();
        initExpenseModal?.();
        syncAccountsHeaderActions?.('finance-docs');

        const { initFinanceDocumentsPage, renderFinanceDocumentsPage } = await import('../../financeNew/financeDocuments.js');
        initFinanceDocumentsPage();
        renderFinanceDocumentsPage();

        const { initQuickCapture } = await import('../../financeNew/quickCapture.js');
        initQuickCapture();
    } catch (err) {
        console.error('[finance/docs]', err);
        const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
        if (host) {
            host.innerHTML = `<p class="finance-mpa-status" role="alert">${esc(err.message || 'Failed to load documents.')}</p>`;
        }
    }
}

void main();
