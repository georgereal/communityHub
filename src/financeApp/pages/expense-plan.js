/**
 * Finance MPA — Expense plan
 */
import fragmentHtml from '../html/expense-plan.html?raw';

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
        const ctx = await mountFinancePage({ page: 'expense-plan', fragmentHtml });
        if (!ctx) return;

        setStatus('Loading expense plan…');
        const { loadAccountsExpensePlan } = await import('../../financeNew/load.js');
        await loadAccountsExpensePlan();

        const {
            initAccountsSubViewTabs,
            syncAccountsHeaderActions,
        } = await import('../../financeNew/finances.js');
        initAccountsSubViewTabs?.();
        syncAccountsHeaderActions?.('expense-plan');

        const { initExpensePlanPage, renderExpensePlanPage } = await import('../../financeNew/expensePlan.js');
        initExpensePlanPage();
        renderExpensePlanPage();

        document.querySelector('.finance-mpa-status')?.remove();
    } catch (err) {
        console.error('[finance/expense-plan]', err);
        const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
        if (host) {
            host.innerHTML = `<p class="finance-mpa-status" role="alert">${esc(err.message || 'Failed to load expense plan.')}</p>`;
        }
    }
}

void main();
