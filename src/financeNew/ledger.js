/**
 * Finance-New ledger page (Mongo ledger_entries) — isolated from classic finances.js.
 */
import { getFinanceNew } from './state.js';
import { loadFinanceNewLedger } from './api.js';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function summarize(entries) {
    let cash = 0;
    let bank = 0;
    let todayOut = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const t of entries) {
        if (t.excluded_from_ledger) continue;
        const amt = Math.abs(Number(t.amount) || 0);
        const signed = t.type === 'IN' ? amt : -amt;
        const wallet = (t.wallet || 'CASH').toUpperCase();
        if (wallet === 'BANK') bank += signed;
        else cash += signed;
        if (t.type === 'OUT' && String(t.date || '').slice(0, 10) === today) todayOut += amt;
    }
    return { cash, bank, total: cash + bank, todayOut };
}

export async function renderFinanceNewLedger() {
    const root = document.getElementById('fn-subview-ledger');
    const statusEl = document.getElementById('fn-ledger-status');
    const bodyEl = document.getElementById('fn-ledger-tbody');
    if (!root || !bodyEl) return;

    if (statusEl) statusEl.textContent = 'Loading ledger from Mongo…';
    try {
        await loadFinanceNewLedger();
    } catch (err) {
        if (statusEl) statusEl.textContent = err.message || 'Failed to load ledger.';
        bodyEl.innerHTML = `<tr><td colspan="6" class="muted">${esc(err.message || 'Error')}</td></tr>`;
        return;
    }

    const { ledgerEntries, counts } = getFinanceNew();
    const sum = summarize(ledgerEntries);
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    set('fn-total-wealth', money(sum.total));
    set('fn-cash-balance', money(sum.cash));
    set('fn-bank-balance', money(sum.bank));
    set('fn-cash-today-out', money(sum.todayOut));

    if (statusEl) {
        statusEl.textContent = `${ledgerEntries.length} entries`
            + (counts?.ledgerEntries != null ? ` (boot count ${counts.ledgerEntries})` : '')
            + ' · Mongo ledger_entries';
    }

    if (!ledgerEntries.length) {
        bodyEl.innerHTML = '<tr><td colspan="6" class="muted">No ledger entries in Mongo yet.</td></tr>';
        return;
    }

    bodyEl.innerHTML = ledgerEntries.slice(0, 500).map((t) => {
        const amt = Number(t.amount) || 0;
        const cls = t.type === 'IN' ? 'pos' : 'neg';
        const sign = t.type === 'IN' ? '+' : '−';
        return `<tr>
          <td>${esc(String(t.date || '').slice(0, 10))}</td>
          <td><span class="badge">${esc(t.type || '')}</span> <span class="muted">${esc(t.wallet || 'CASH')}</span></td>
          <td>${esc(t.cat || '—')}</td>
          <td>${esc(t.vendor_name || t.description || '—')}</td>
          <td class="${cls}">${sign}${money(amt)}</td>
          <td class="muted">${(t.voucherIds || []).length} vouchers · ${(t.bankLineRefs || []).length} bank</td>
        </tr>`;
    }).join('');
}

export function initFinanceNewLedger() {
    document.getElementById('fn-btn-ledger-refresh')?.addEventListener('click', () => {
        void loadFinanceNewLedger({ force: true }).then(() => renderFinanceNewLedger());
    });
}
