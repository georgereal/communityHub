/**
 * Finance-New bills & receipts (Mongo vouchers) — isolated from financeDocuments.js.
 */
import { getFinanceNew } from './state.js';
import { loadFinanceNewVoucherAggregates, loadFinanceNewVouchers } from './api.js';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

let filter = { kind: 'all', status: 'all', q: '', offset: 0 };

export async function renderFinanceNewVouchers() {
    const bodyEl = document.getElementById('fn-vouchers-tbody');
    const statusEl = document.getElementById('fn-vouchers-status');
    const aggEl = document.getElementById('fn-vouchers-agg');
    if (!bodyEl) return;

    if (statusEl) statusEl.textContent = 'Loading vouchers from Mongo…';
    try {
        await Promise.all([
            loadFinanceNewVouchers({ ...filter, limit: 50 }),
            loadFinanceNewVoucherAggregates(),
        ]);
    } catch (err) {
        if (statusEl) statusEl.textContent = err.message || 'Failed to load vouchers.';
        bodyEl.innerHTML = `<tr><td colspan="6" class="muted">${esc(err.message || 'Error')}</td></tr>`;
        return;
    }

    const s = getFinanceNew();
    if (statusEl) {
        statusEl.textContent = `Showing ${s.vouchers.length} of ${s.vouchersTotal} · Mongo vouchers`;
    }
    if (aggEl && s.voucherAggregates) {
        const t = s.voucherAggregates.totals || {};
        aggEl.textContent = `Non-void total: ${money(t.amount)} across ${t.count || 0} vouchers`;
    }

    if (!s.vouchers.length) {
        bodyEl.innerHTML = '<tr><td colspan="6" class="muted">No vouchers match.</td></tr>';
        return;
    }

    bodyEl.innerHTML = s.vouchers.map((d) => {
        const label = d.kind === 'IN' ? 'Receipt' : 'Bill';
        return `<tr>
          <td>${esc(String(d.doc_date || '').slice(0, 10))}</td>
          <td>${esc(label)}</td>
          <td>${esc(d.status || '')}</td>
          <td>${esc(d.vendor_name || d.description || '—')}</td>
          <td>${esc(d.cat || '—')}</td>
          <td>${money(d.amount)}</td>
        </tr>`;
    }).join('');

    const prev = document.getElementById('fn-vouchers-prev');
    const next = document.getElementById('fn-vouchers-next');
    if (prev) prev.disabled = filter.offset <= 0;
    if (next) next.disabled = filter.offset + s.vouchersLimit >= s.vouchersTotal;
}

export function initFinanceNewVouchers() {
    const kindEl = document.getElementById('fn-vouchers-kind');
    const statusEl = document.getElementById('fn-vouchers-filter-status');
    const qEl = document.getElementById('fn-vouchers-q');
    kindEl?.addEventListener('change', () => {
        filter.kind = kindEl.value || 'all';
        filter.offset = 0;
        void renderFinanceNewVouchers();
    });
    statusEl?.addEventListener('change', () => {
        filter.status = statusEl.value || 'all';
        filter.offset = 0;
        void renderFinanceNewVouchers();
    });
    let qTimer;
    qEl?.addEventListener('input', () => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => {
            filter.q = qEl.value || '';
            filter.offset = 0;
            void renderFinanceNewVouchers();
        }, 300);
    });
    document.getElementById('fn-vouchers-prev')?.addEventListener('click', () => {
        filter.offset = Math.max(0, filter.offset - 50);
        void renderFinanceNewVouchers();
    });
    document.getElementById('fn-vouchers-next')?.addEventListener('click', () => {
        filter.offset += 50;
        void renderFinanceNewVouchers();
    });
    document.getElementById('fn-btn-vouchers-refresh')?.addEventListener('click', () => {
        void loadFinanceNewVoucherAggregates({ force: true }).then(() => renderFinanceNewVouchers());
    });
}
