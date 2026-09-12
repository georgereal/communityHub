/**
 * Finance MPA — Reports
 * Order: HTML shell → auth boot → analytics API → reports UI only.
 */
import fragmentHtml from '../html/reports.html?raw';

function setStatus(msg) {
    const el = document.querySelector('#app-shell-page .finance-mpa-status, #app-shell-root .finance-mpa-status');
    if (el) el.textContent = msg;
}

function showError(err) {
    console.error('[finance/reports]', err);
    const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
    if (host) {
        host.innerHTML = `<p class="finance-mpa-status" role="alert">${esc(err.message || 'Failed to load reports.')}</p>`;
    }
}

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
    try {
        setStatus('Loading…');
        const { mountFinancePage } = await import('../mount.js');
        const ctx = await mountFinancePage({ page: 'reports', fragmentHtml });
        if (!ctx) return;

        setStatus('Loading report data…');
        const { loadAccountsReports } = await import('../../financeNew/loadReports.js');
        await loadAccountsReports();

        const { renderFinanceAnalytics, initFinanceAnalyticsUi } = await import('../../financeNew/financeAnalytics.js');
        initFinanceAnalyticsUi?.();
        renderFinanceAnalytics();
    } catch (err) {
        showError(err);
    }
}

void main();
