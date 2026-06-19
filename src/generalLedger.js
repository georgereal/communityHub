/**
 * Phase 6.2 — General ledger (chart of accounts + journal entries)
 */
import { portalState, supabase, pullState } from './store.js';
import { bindBusyClick } from './buttonBusy.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;
const todayISO = () => new Date().toISOString().slice(0, 10);

const DEFAULT_ACCOUNTS = [
    { code: '1000', name: 'Cash & Bank', account_type: 'ASSET' },
    { code: '1100', name: 'Maintenance Receivable', account_type: 'ASSET' },
    { code: '2000', name: 'Vendor Payables', account_type: 'LIABILITY' },
    { code: '3000', name: 'Society Corpus', account_type: 'EQUITY' },
    { code: '4000', name: 'Maintenance Income', account_type: 'INCOME' },
    { code: '5000', name: 'Operating Expenses', account_type: 'EXPENSE' },
];

export async function seedDefaultAccounts() {
    const apartment_id = portalState.access?.activeApartmentId;
    const existing = portalState.ledger?.accounts || [];
    if (existing.length) return;
    for (const ac of DEFAULT_ACCOUNTS) {
        await supabase.from('chart_of_accounts').insert({
            id: crypto.randomUUID(),
            apartment_id,
            ...ac,
        });
    }
    await pullState();
}

export const renderGeneralLedger = () => {
    const coaEl = document.getElementById('gl-accounts-list');
    const journalEl = document.getElementById('gl-journal-list');
    const accounts = portalState.ledger?.accounts || [];
    const entries = portalState.ledger?.entries || [];
    const lines = portalState.ledger?.lines || [];

    if (coaEl) {
        coaEl.innerHTML = accounts.length
            ? accounts.map((a) => `<div class="gl-account-row">
              <code>${a.code}</code> <strong>${a.name}</strong>
              <span class="gl-account-type">${a.account_type}</span>
            </div>`).join('')
            : '<p class="ops-empty">No accounts — click Seed default chart.</p>';
    }
    if (journalEl) {
        journalEl.innerHTML = entries.length
            ? entries.slice(0, 40).map((e) => {
                const entryLines = lines.filter((l) => l.entry_id === e.id);
                const total = entryLines.reduce((s, l) => s + parseFloat(l.debit || 0), 0);
                return `<div class="gl-entry-row">
                  <div><strong>${e.entry_date}</strong> ${e.description}</div>
                  <div>${formatMoney(total)} · ${entryLines.length} lines</div>
                </div>`;
            }).join('')
            : '<p class="ops-empty">No journal entries yet.</p>';
    }
};

export async function postJournalEntry({ entry_date, description, debit_account_id, credit_account_id, amount }) {
    const apartment_id = portalState.access?.activeApartmentId;
    const amt = parseFloat(amount);
    if (!debit_account_id || !credit_account_id || amt <= 0) throw new Error('Select accounts and amount.');
    const { data: { user } } = await supabase.auth.getUser();
    const entryId = crypto.randomUUID();

    const { error: eErr } = await supabase.from('journal_entries').insert({
        id: entryId,
        apartment_id,
        entry_date: entry_date || todayISO(),
        description,
        source_type: 'MANUAL',
        created_by: user?.id,
    });
    if (eErr) throw new Error(eErr.message);

    const { error: lErr } = await supabase.from('journal_lines').insert([
        { id: crypto.randomUUID(), apartment_id, entry_id: entryId, account_id: debit_account_id, debit: amt, credit: 0 },
        { id: crypto.randomUUID(), apartment_id, entry_id: entryId, account_id: credit_account_id, debit: 0, credit: amt },
    ]);
    if (lErr) throw new Error(lErr.message);
    await pullState();
    renderGeneralLedger();
}

window.renderGeneralLedger = renderGeneralLedger;

export const initGeneralLedger = () => {
    bindBusyClick(document.getElementById('gl-seed-accounts'), 'Seeding…', async () => {
        await seedDefaultAccounts();
        renderGeneralLedger();
    });
    bindBusyClick(document.getElementById('gl-post-entry'), 'Posting…', async () => {
        try {
            await postJournalEntry({
                entry_date: document.getElementById('gl-entry-date')?.value,
                description: document.getElementById('gl-entry-desc')?.value?.trim() || 'Manual entry',
                debit_account_id: document.getElementById('gl-debit-account')?.value,
                credit_account_id: document.getElementById('gl-credit-account')?.value,
                amount: document.getElementById('gl-entry-amount')?.value,
            });
        } catch (e) { alert(e.message); }
    });
    document.addEventListener('apartment-data-loaded', () => {
        const accounts = portalState.ledger?.accounts || [];
        const opts = accounts.map((a) => `<option value="${a.id}">${a.code} — ${a.name}</option>`).join('');
        ['gl-debit-account', 'gl-credit-account'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<option value="">Select account</option>${opts}`;
        });
    });
};
