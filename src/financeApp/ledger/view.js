/**
 * Ledger MPA — KPIs, filters, selectable table.
 */

const money = (n) => {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return `₹ ${Number(n).toLocaleString('en-IN')}`;
};

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

export function renderLedgerKpis(summary) {
    if (!summary?.totals) {
        setText('fn-total-wealth', '—');
        setText('fn-cash-balance', '—');
        setText('fn-bank-balance', '—');
        setText('fn-cash-today-out', '—');
        return;
    }
    const { cash, bank, combined } = summary.totals;
    setText('fn-total-wealth', money(combined));
    setText('fn-cash-balance', money(cash));
    setText('fn-bank-balance', bank != null ? money(bank) : '—');
    setText('fn-cash-today-out', money(summary.todayOut));

    const bankEl = document.getElementById('fn-bank-balance');
    if (bankEl) {
        bankEl.title = summary.needsOpening
            ? 'Bank opening balance not set — use Opening in the toolbar'
            : (summary.counts?.bankTxns != null
                ? `Opening + ${summary.counts.bankTxns} bank ledger entries`
                : '');
    }

    const stale = document.getElementById('ledger-recalc-stale');
    if (stale) {
        const needs = summary.ledgerBalance?.needsRecalc === true;
        stale.hidden = !needs;
    }
}

function entryHaystack(t) {
    return [
        t.date,
        t.type,
        t.wallet,
        t.cat,
        t.vendor_name,
        t.description,
        t.sub_category,
    ].map((x) => String(x || '').toLowerCase()).join(' ');
}

export function filterLedgerEntries(entries, { query = '', category = '' } = {}) {
    let list = entries || [];
    const cat = String(category || '').trim();
    if (cat) {
        list = list.filter((t) => String(t.cat || '') === cat);
    }
    const q = String(query || '').trim().toLowerCase();
    if (q) {
        list = list.filter((t) => entryHaystack(t).includes(q));
    }
    return list;
}

export function collectCategories(entries) {
    const set = new Set();
    for (const t of entries || []) {
        if (t.excluded_from_ledger) continue;
        const c = String(t.cat || '').trim();
        if (c) set.add(c);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
}

export function fillCategoryFilter(entries, selected = '') {
    const sel = document.getElementById('ledger-cat-filter');
    if (!sel) return;
    const cats = collectCategories(entries);
    const cur = selected || sel.value || '';
    sel.innerHTML = `<option value="">All categories</option>${
        cats.map((c) => `<option value="${esc(c)}" ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')
    }`;
}

export function syncOpeningFields(summary) {
    const dateEl = document.getElementById('ledger-opening-date');
    const amtEl = document.getElementById('ledger-opening-amount');
    const bank = summary?.bankAccount;
    if (dateEl && bank?.opening_balance_date) {
        dateEl.value = String(bank.opening_balance_date).slice(0, 10);
    }
    if (amtEl && bank?.opening_balance != null && bank.opening_balance !== '') {
        amtEl.value = String(bank.opening_balance);
    }
}

/**
 * @param {object[]} entries
 * @param {{
 *   query?: string,
 *   category?: string,
 *   selectedIds?: Set<string>,
 *   limit?: number,
 * }} [opts]
 */
export function renderLedgerTable(entries, opts = {}) {
    const tbody = document.getElementById('ledger-tbody');
    const countEl = document.getElementById('ledger-count');
    if (!tbody) return;

    const selectedIds = opts.selectedIds || new Set();
    const active = (entries || []).filter((t) => !t.excluded_from_ledger);
    const filtered = filterLedgerEntries(active, {
        query: opts.query,
        category: opts.category,
    });
    const limit = opts.limit ?? 500;
    const rows = filtered.slice(0, limit);

    if (countEl) {
        countEl.textContent = filtered.length === active.length
            ? `${active.length} entries`
            : `${filtered.length} of ${active.length}`;
    }

    syncBulkBar(selectedIds);

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted">${
            active.length ? 'No matches.' : 'No ledger entries yet.'
        }</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map((t) => {
        const id = String(t.id || t._id || '');
        const amt = Math.abs(Number(t.amount) || 0);
        const isIn = t.type === 'IN';
        const cls = isIn ? 'pos' : 'neg';
        const sign = isIn ? '+' : '−';
        const desc = t.vendor_name || t.description || '—';
        const checked = selectedIds.has(id) ? 'checked' : '';
        return `<tr data-ledger-id="${esc(id)}" class="ledger-row" style="cursor:pointer">
          <td onclick="event.stopPropagation()">
            <input type="checkbox" class="ledger-row-check" data-id="${esc(id)}" ${checked} aria-label="Select row" />
          </td>
          <td>${esc(String(t.date || '').slice(0, 10))}</td>
          <td>${esc(t.type || '')}</td>
          <td>${esc(t.wallet || 'CASH')}</td>
          <td>${esc(t.cat || '—')}</td>
          <td>${esc(desc)}</td>
          <td class="${cls}" style="text-align:right">${sign}${money(amt)}</td>
        </tr>`;
    }).join('');
}

export function syncBulkBar(selectedIds) {
    const bar = document.getElementById('ledger-bulk-bar');
    const countEl = document.getElementById('ledger-bulk-count');
    if (!bar) return;
    const n = selectedIds?.size || 0;
    bar.hidden = n === 0;
    if (countEl) countEl.textContent = n ? `${n} selected` : '';
    ['ledger-bulk-apply', 'ledger-bulk-delete'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = n === 0;
    });
}

export { money, esc };
