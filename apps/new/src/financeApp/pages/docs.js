/**
 * Finance MPA — Bills & receipts
 * Chrome is slim; finances.js (cash modal openers) loads on first Add/Edit.
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
        setStatus('Loading…');
        const { mountFinancePage } = await import('../mount.js');
        const ctx = await mountFinancePage({ page: 'docs', fragmentHtml, withModals: true });
        if (!ctx) return;

        setStatus('Loading documents…');
        const { loadAccountsFinanceDocs } = await import('../../financeNew/load.js');
        await loadAccountsFinanceDocs();

        const { initAccountsPageChrome } = await import('../../financeNew/accountsChrome.js');
        initAccountsPageChrome('finance-docs');

        const { initFinanceDocumentsPage, renderFinanceDocumentsPage, applyFinanceDocsReportFilter } = await import('../../financeNew/financeDocuments.js');
        initFinanceDocumentsPage();

        // Reports → Bills drill-down (stashed before MPA hard-nav).
        try {
            const { consumeDocsReportFilter } = await import('../../financeNew/ledgerFilter.js');
            const pendingDocs = consumeDocsReportFilter();
            if (pendingDocs) applyFinanceDocsReportFilter(pendingDocs);
        } catch { /* ignore */ }

        renderFinanceDocumentsPage();

        const { initQuickCapture } = await import('../../financeNew/quickCapture.js');
        initQuickCapture();

        document.querySelector('.finance-mpa-status')?.remove();
    } catch (err) {
        console.error('[finance/docs]', err);
        const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
        if (host) {
            host.innerHTML = `<p class="finance-mpa-status" role="alert">${esc(err.message || 'Failed to load documents.')}</p>`;
        }
    }
}

void main();
