/**
 * Sentry Finance Engine (Audit Relational)
 */
import { portalState, persist, supabase, pullState } from './store.js';

const CAT_LABELS = { 'Security': 'Security / Guards', 'Maintenance': 'General Maintenance', 'Plumbing': 'Plumbing / Water', 'Electrical': 'Electrical / Diesel', 'Stationery': 'Office / Stationery', 'Petty Inflow': 'Petty Cash Top-up', 'Reconcile': 'Audit Reconciliation', 'Other': 'Miscellaneous' };
const getLabel = (cat) => CAT_LABELS[cat] || cat;

export const processFinances = () => {
    let cash = 0, bank = 0, outToday = 0, outMonth = 0; const now = new Date();
    portalState.finances.txns.forEach(t => {
        const amt = parseFloat(t.amount); const d = new Date(t.date); const wallet = t.wallet || 'CASH';
        if (t.type === 'IN') { if (wallet === 'CASH') cash += amt; else bank += amt; }
        else {
            if (wallet === 'CASH') cash -= amt; else bank -= amt;
            if (d.toDateString() === now.toDateString()) outToday += amt;
            if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) outMonth += amt;
        }
    });
    const k = (id) => document.getElementById(id);
    if (k('cash-balance')) {
        k('cash-balance').textContent = `₹ ${cash.toLocaleString('en-IN')}`;
        k('bank-balance').textContent = `₹ ${bank.toLocaleString('en-IN')}`;
        k('total-wealth').textContent = `₹ ${(cash + bank).toLocaleString('en-IN')}`;
        k('cash-today-out').textContent = `₹ ${outToday.toLocaleString('en-IN')}`;
        k('cash-month-out').textContent = `₹ ${outMonth.toLocaleString('en-IN')}`;
    }
};

export const renderCashLedger = () => {
    const list = document.getElementById('cash-ledger-items'); if (!list) return; list.innerHTML = '';
    const sorted = [...portalState.finances.txns].sort((a, b) => new Date(b.date) - new Date(a.date));
    sorted.forEach(t => {
        const row = document.createElement('div'); row.className = 'apt-row';
        row.style = "grid-template-columns: 100px 100px 140px 1fr 120px 110px; padding: 0.85rem 1rem; align-items: center; border-bottom: 1px solid var(--border);";
        row.innerHTML = `<div style="font-size:0.75rem; color:var(--text-dim);">${new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>
           <div><span style="font-size:0.6rem; font-weight:900; background:#f1f5f9; padding:0.2rem 0.5rem; border-radius:4px;">${t.wallet}</span></div>
           <div><span style="font-size:0.6rem; font-weight:800; background:#f1f5f9; padding:0.2rem 0.5rem; border-radius:100px;">${getLabel(t.cat)}</span></div>
           <div style="font-size:0.85rem; font-weight:700;">${t.description || ''}</div>
           <div style="text-align:right; font-weight:900; color:${t.type === 'IN' ? 'var(--success)' : 'var(--danger)'};">${t.type === 'IN' ? '+' : '-'} ₹${parseFloat(t.amount).toLocaleString('en-IN')}</div>
           <div style="text-align:right; display:flex; gap:0.4rem; justify-content:flex-end;"><button class="btn btn-outline" style="padding:0.2rem 0.4rem;" onclick="window.editTxn('${t.id}')"><i class="fa-solid fa-pen"></i></button><button class="btn btn-outline" style="padding:0.2rem 0.4rem; color:var(--danger);" onclick="window.delTxn('${t.id}')"><i class="fa-solid fa-trash-can"></i></button></div>`;
        list.appendChild(row);
    });
};

let expenseChartInstance = null;
export const renderAuditReports = () => {
    const txns = portalState.finances.txns.filter(t => t.type === 'OUT'); const now = new Date(); const months = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(); d.setMonth(now.getMonth() - i); months.push({ label: d.toLocaleDateString('en-GB', { month: 'short' }), m: d.getMonth(), y: d.getFullYear() }); }
    const chartData = months.map(m => txns.filter(t => { const d = new Date(t.date); return d.getMonth() === m.m && d.getFullYear() === m.y; }).reduce((sum, t) => sum + parseFloat(t.amount), 0));
    const matrix = document.getElementById('audit-matrix'); const cats = [...new Set(txns.map(t => t.cat))];
    const monthTotals = months.map(m => txns.filter(t => new Date(t.date).getMonth() === m.m && new Date(t.date).getFullYear() === m.y).reduce((s, t) => s + parseFloat(t.amount), 0));

    let h = `<table style="width:100%; border-collapse:collapse;"><thead><tr style="background:#f8fafc;"><th style="padding:0.6rem; text-align:left;">Category</th>${months.map(m => `<th style="padding:0.6rem; text-align:right;">${m.label}</th>`).join('')}<th style="padding:0.6rem; text-align:right; border-left:1px solid var(--border); background:#f1f5f9;">TOTAL</th></tr></thead><tbody>`;
    cats.forEach(c => {
        let rowSum = 0; h += `<tr><td style="padding:0.6rem; font-weight:700; border-bottom:1px solid var(--border);">${getLabel(c)}</td>`;
        months.forEach(m => {
            const val = txns.filter(t => t.cat === c && new Date(t.date).getMonth() === m.m && new Date(t.date).getFullYear() === m.y).reduce((sum, t) => sum + parseFloat(t.amount), 0);
            rowSum += val; h += `<td style="padding:0.6rem; text-align:right; border-bottom:1px solid var(--border); color:${val > 0 ? '#ef4444' : '#94a3b8'};">₹${val.toLocaleString()}</td>`;
        });
        h += `<td style="padding:0.6rem; text-align:right; font-weight:800; border-bottom:1px solid var(--border); border-left:1px solid var(--border); background:#f8fafc;">₹${rowSum.toLocaleString()}</td></tr>`;
    });
    h += `<tr style="background:#f1f5f9; font-weight:900;"><td style="padding:0.6rem;">Monthly Total</td>`;
    monthTotals.forEach(v => h += `<td style="padding:0.6rem; text-align:right;">₹${v.toLocaleString()}</td>`);
    const grandTotal = monthTotals.reduce((a, b) => a + b, 0);
    h += `<td style="padding:0.6rem; text-align:right; color:var(--accent); border-left:1px solid var(--border);">₹${grandTotal.toLocaleString()}</td></tr></tbody></table>`;
    matrix.innerHTML = h;
};

export const saveCashData = async () => {
    if (!supabase) return;
    const amt = parseFloat(document.getElementById('cash-amt').value), desc = document.getElementById('cash-desc').value.trim(), cat = document.getElementById('cash-cat-select').value, wallet = document.getElementById('cash-wallet-select').value;
    if (isNaN(amt) || !desc) return alert('Field required.');
    const type = (cat === 'Petty Inflow' || cat === 'Reconcile') ? 'IN' : 'OUT';

    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return alert('No active apartment selected.');
    const payload = { apartment_id, amount: amt, cat, description: desc, wallet, type, date: new Date().toISOString() };
    if (portalState.editingTxnId) payload.id = portalState.editingTxnId;

    const { error } = await supabase.from('transactions').upsert(payload);
    if (!error) { await pullState(); renderCashLedger(); portalState.editingTxnId = null; document.getElementById('cash-modal').classList.remove('active'); }
};
window.saveCashData = saveCashData;

// Quick actions from Accounts header
window.openCash = (direction = 'OUT', wallet = 'CASH') => {
    const modal = document.getElementById('cash-modal');
    if (!modal) return;

    portalState.editingTxnId = null;

    const title = document.getElementById('cash-modal-title');
    const desc = document.getElementById('cash-modal-desc');
    const amt = document.getElementById('cash-amt');
    const d = document.getElementById('cash-desc');
    const cat = document.getElementById('cash-cat-select');
    const w = document.getElementById('cash-wallet-select');

    const dir = (direction || 'OUT').toUpperCase();
    const wal = (wallet || 'CASH').toUpperCase();

    if (w) w.value = wal;
    if (amt) amt.value = '';
    if (d) d.value = '';

    // Category drives IN/OUT in saveCashData(). Pick sensible defaults.
    if (cat) {
        if (dir === 'IN') cat.value = 'Petty Inflow';
        else cat.value = 'Maintenance';
    }

    if (title) title.textContent = `${wal === 'BANK' ? 'Bank' : 'Cash'} ${dir === 'IN' ? 'In' : 'Out'}`;
    if (desc) desc.textContent = 'Unified Ledger Record';

    modal.classList.add('active');
};

window.openBankSnapshot = () => {
    // Treat as a reconciliation-style entry (IN) into BANK ledger.
    window.openCash('IN', 'BANK');
    const title = document.getElementById('cash-modal-title');
    const desc = document.getElementById('cash-modal-desc');
    const cat = document.getElementById('cash-cat-select');
    if (cat) cat.value = 'Reconcile';
    if (title) title.textContent = 'Bank Sync';
    if (desc) desc.textContent = 'Direct synchronization / reconciliation entry';
};

export const delTxn = async (id) => {
    if (confirm('Delete Record?') && supabase) {
        const { error } = await supabase.from('transactions').delete().eq('id', id);
        if (!error) { await pullState(); renderCashLedger(); }
    }
};
window.delTxn = delTxn;

window.editTxn = (id) => {
    const t = portalState.finances.txns.find(x => x.id == id);
    portalState.editingTxnId = id;
    document.getElementById('cash-amt').value = t.amount;
    document.getElementById('cash-desc').value = t.description;
    document.getElementById('cash-cat-select').value = t.cat;
    document.getElementById('cash-wallet-select').value = t.wallet;
    document.getElementById('cash-modal').classList.add('active');
};
window.switchSubView = (sv) => {
    const isLedger = sv === 'ledger';
    document.getElementById('subview-ledger').style.display = isLedger ? 'block' : 'none';
    document.getElementById('subview-reports').style.display = isLedger ? 'none' : 'block';
    if (sv === 'reports') renderAuditReports();
};
