/**
 * Finance MPA — Bank reconciliation
 */
import fragmentHtml from '../html/bank-recon.html?raw';

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
            page: 'bank-recon',
            fragmentHtml,
            withModals: true,
            withBankReconModals: true,
        });
        if (!ctx) return;

        setStatus('Loading bank reconciliation…');
        const { loadAccountsBankRecon } = await import('../../financeNew/load.js');
        await loadAccountsBankRecon();

        const {
            initExpenseModal,
            initAccountsSubViewTabs,
            syncAccountsHeaderActions,
            processFinances,
        } = await import('../../financeNew/finances.js');
        initAccountsSubViewTabs?.();
        initExpenseModal?.();
        syncAccountsHeaderActions?.('bank-recon');
        processFinances?.();

        const m = await import('../../financeNew/bankReconciliation.js');
        m.initBankReconciliationUi?.();
        m.renderBankReconciliation?.();

        document.querySelector('.finance-mpa-status')?.remove();
    } catch (err) {
        console.error('[finance/bank-recon]', err);
        const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
        if (host) {
            host.innerHTML = `<p class="finance-mpa-status" role="alert">${esc(err.message || 'Failed to load bank reconciliation.')}</p>`;
        }
    }
}

void main();
