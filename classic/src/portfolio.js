/**
 * Phase 6.1 — Multi-society portfolio rollup (client-side aggregation)
 */
import { portalState, supabase, pullState } from './store.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const invoiceBalance = (inv) =>
    Math.max(0, parseFloat(inv.amount || 0) - parseFloat(inv.amount_paid || 0));

async function fetchApartmentSnapshot(apartmentId) {
    if (!supabase) return null;
    const [units, invoices, txns, tickets] = await Promise.all([
        supabase.from('units').select('id', { count: 'exact', head: true }).eq('apartment_id', apartmentId),
        supabase.from('maintenance_invoices').select('amount, amount_paid, apartment_id').eq('apartment_id', apartmentId),
        supabase.from('transactions').select('amount, type, apartment_id').eq('apartment_id', apartmentId),
        supabase.from('helpdesk_tickets').select('status, apartment_id').eq('apartment_id', apartmentId),
    ]);
    const invs = invoices.data || [];
    const outstanding = invs.reduce((s, inv) => s + invoiceBalance(inv), 0);
    const openTickets = (tickets.data || []).filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length;
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStr = monthStart.toISOString().slice(0, 10);
    let monthIn = 0;
    let monthOut = 0;
    (txns.data || []).forEach((t) => {
        const d = (t.date || '').slice(0, 10);
        if (d < monthStr) return;
        const amt = parseFloat(t.amount || 0);
        if (t.type === 'IN') monthIn += amt;
        else monthOut += amt;
    });
    const apt = portalState.access.apartments.find((a) => a.id === apartmentId);
    return {
        id: apartmentId,
        name: apt?.name || apartmentId.slice(0, 8),
        units: units.count || 0,
        outstanding,
        openTickets,
        monthIn,
        monthOut,
    };
}

export const renderPortfolioRollup = async () => {
    const el = document.getElementById('portfolio-rollup-grid');
    if (!el) return;
    el.innerHTML = '<p class="ops-empty">Loading portfolio…</p>';
    const apartments = portalState.access?.apartments || [];
    if (apartments.length <= 1) {
        el.innerHTML = '<p class="ops-empty">Portfolio rollup shows when you manage multiple societies. Add apartments in Administration → Society Settings.</p>';
        return;
    }
    const rows = await Promise.all(apartments.map((a) => fetchApartmentSnapshot(a.id)));
    el.innerHTML = `<div class="portfolio-grid">
      ${rows.filter(Boolean).map((r) => `<div class="portfolio-card">
        <h3>${r.name}</h3>
        <div class="portfolio-card__stats">
          <div><span>Units</span><strong>${r.units}</strong></div>
          <div><span>Outstanding</span><strong>${formatMoney(r.outstanding)}</strong></div>
          <div><span>Open tickets</span><strong>${r.openTickets}</strong></div>
          <div><span>MTD in</span><strong>${formatMoney(r.monthIn)}</strong></div>
          <div><span>MTD out</span><strong>${formatMoney(r.monthOut)}</strong></div>
        </div>
        <button type="button" class="btn btn-outline btn--small" data-switch-apt="${r.id}">Open society</button>
      </div>`).join('')}
    </div>`;
    el.querySelectorAll('[data-switch-apt]').forEach((btn) => {
        btn.onclick = () => {
            const sel = document.getElementById('nav-apartment-switch');
            if (sel) {
                sel.value = btn.dataset.switchApt;
                sel.dispatchEvent(new Event('change'));
            }
        };
    });
};

export const initPortfolio = () => {};
