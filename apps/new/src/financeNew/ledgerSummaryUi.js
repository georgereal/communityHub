/**
 * Apply server ledger summary pack to Finance-New KPI strip (fn-* ids).
 */
const money = (n) => {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return `₹ ${Number(n).toLocaleString('en-IN')}`;
};

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

/**
 * @param {object|null} summary — from GET /api/finance/ledger/summary
 */
export function applyLedgerSummaryKpis(summary) {
    if (!summary?.totals) return false;
    const { cash, bank, combined } = summary.totals;
    setText('fn-total-wealth', money(combined));
    setText('fn-cash-balance', money(cash));
    const cashEl = document.getElementById('fn-cash-balance');
    if (cashEl) cashEl.title = 'Wallet Left from Bills & receipts (Petty Cash float)';
    setText('fn-bank-balance', bank != null ? money(bank) : '—');
    setText('fn-cash-today-out', money(summary.todayOut));

    const bankEl = document.getElementById('fn-bank-balance');
    const hintEl = document.getElementById('fn-ledger-bank-hint');
    if (bankEl) {
        if (summary.needsOpening) {
            bankEl.title = 'Set opening balance via the Opening control in the ledger toolbar';
        } else if (summary.counts?.bankTxns != null) {
            bankEl.title = `Opening + ${summary.counts.bankTxns} bank ledger entries`;
        } else {
            bankEl.title = '';
        }
    }
    if (hintEl) {
        if (summary.needsOpening) {
            hintEl.hidden = false;
            hintEl.innerHTML = '<button type="button" class="ledger-kpi__hint-btn" id="ledger-bank-hint-open">Set opening balance</button>';
        } else {
            hintEl.hidden = true;
            hintEl.textContent = '';
        }
    }
    return true;
}
