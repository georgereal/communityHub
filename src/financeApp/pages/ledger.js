/**
 * Finance MPA — Ledger (full UI)
 * Shell + Mongo packs + classic financeNew ledger (editable table, attachments, allocations).
 */
import fragmentHtml from '../html/ledger.html?raw';

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
        const ctx = await mountFinancePage({
            page: 'ledger',
            fragmentHtml,
            withModals: true,
        });
        if (!ctx) return;

        setStatus('Loading ledger…');
        const { loadAccountsLedger, reloadFinancePacks } = await import('../../financeNew/load.js');
        await loadAccountsLedger();
        // Maintenance collection allocations need billing invoices in classic state.
        await reloadFinancePacks(['billing'], { force: false });

        const {
            initExpenseModal,
            processFinances,
            renderCashLedger,
            syncAccountsHeaderActions,
            initAccountsSubViewTabs,
        } = await import('../../financeNew/finances.js');

        try {
            const { loadFinanceNewLedgerSummary } = await import('../../financeNew/api.js');
            const { applyLedgerSummaryKpis } = await import('../../financeNew/ledgerSummaryUi.js');
            const summary = await loadFinanceNewLedgerSummary();
            applyLedgerSummaryKpis(summary);
        } catch { /* processFinances still fills KPIs */ }

        initAccountsSubViewTabs?.();
        initExpenseModal?.();
        syncAccountsHeaderActions?.('ledger');
        processFinances();
        renderCashLedger();

        document.querySelector('.finance-mpa-status')?.remove();
    } catch (err) {
        console.error('[finance/ledger]', err);
        const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
        if (host) {
            host.innerHTML = `<p class="finance-mpa-status" role="alert">${esc(err.message || 'Failed to load ledger.')}</p>`;
        }
    }
}

void main();
