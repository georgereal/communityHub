/**
 * Finance MPA — Ledger (full UI)
 * Data: ledger + bank (+ billing for allocations). KPIs from ledger/summary — not voucher aggregates.
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
        setStatus('Loading…');
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

        const { initAccountsPageChrome } = await import('../../financeNew/accountsChrome.js');
        // finances.js wires Add expense/income; avoid double-binding.
        initAccountsPageChrome('ledger', { wireActions: false });

        const {
            initExpenseModal,
            processFinances,
            renderCashLedger,
            initAccountsSubViewTabs,
        } = await import('../../financeNew/finances.js');

        let summaryOk = false;
        try {
            const { loadFinanceNewLedgerSummary } = await import('../../financeNew/api.js');
            const { applyLedgerSummaryKpis } = await import('../../financeNew/ledgerSummaryUi.js');
            const summary = await loadFinanceNewLedgerSummary();
            summaryOk = applyLedgerSummaryKpis(summary);
        } catch { /* processFinances fills KPIs */ }

        // Ledger table / bulk bar wiring (MPA chrome already applied above).
        initAccountsSubViewTabs?.();
        initExpenseModal?.();
        // Prefer server summary for Wallet Left — processFinances needs voucher aggregates we no longer load.
        if (!summaryOk) processFinances();

        // Reports pivot drill-down: restore filter stashed before MPA hard-nav, then server-fetch.
        const {
            consumeLedgerPivotFilter,
            applyLedgerPivotFilter,
        } = await import('../../financeNew/ledgerFilter.js');
        const pendingPivot = consumeLedgerPivotFilter();
        if (pendingPivot) {
            // Cash-detail pivots merge cash bills into the ledger view.
            if (pendingPivot.cashExpenseReporting === 'cash_detail') {
                await reloadFinancePacks(['vouchers'], { force: false });
            }
            applyLedgerPivotFilter(pendingPivot);
            const { reloadLedgerFiltered } = await import('../../financeNew/load.js');
            await reloadLedgerFiltered({ force: true });
        }

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
