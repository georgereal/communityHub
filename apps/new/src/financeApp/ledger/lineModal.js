/**
 * Ledger line add/edit modal (thin — no finances.js).
 */
import { categoryDisplayLabel } from '../../expenseCategories.js';
import { buildCategoryOptions } from '../../classifyOptions.js';
import { saveLedgerEntry, deleteLedgerEntry } from './data.js';
import { esc } from './view.js';

function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

function getWallet() {
    const active = document.querySelector('#ledger-line-wallet-pills .ledger-line-wallet__btn.active');
    return (active?.dataset.wallet || 'BANK').toUpperCase() === 'CASH' ? 'CASH' : 'BANK';
}

function setWallet(wallet) {
    const w = wallet === 'CASH' ? 'CASH' : 'BANK';
    document.querySelectorAll('#ledger-line-wallet-pills .ledger-line-wallet__btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.wallet === w);
    });
    const refWrap = document.getElementById('ledger-line-bank-ref-wrap');
    if (refWrap) refWrap.hidden = w !== 'BANK';
}

function fillCatDatalist(type) {
    const list = document.getElementById('ledger-line-cat-datalist');
    if (!list) return;
    const cats = buildCategoryOptions(type === 'IN');
    list.innerHTML = cats.map((c) => {
        const label = categoryDisplayLabel(c) || c;
        return `<option value="${esc(c)}">${esc(label)}</option>`;
    }).join('');
}

/**
 * @param {{
 *   type: 'IN'|'OUT',
 *   entry?: object|null,
 *   onSaved: () => Promise<void>|void,
 * }} opts
 */
export function openLedgerLineModal(opts) {
    const modal = document.getElementById('ledger-line-modal');
    if (!modal) return;

    const type = opts.type === 'IN' ? 'IN' : 'OUT';
    const entry = opts.entry || null;
    const editing = Boolean(entry?.id || entry?._id);

    const title = document.getElementById('ledger-line-title');
    if (title) {
        title.textContent = editing
            ? (type === 'IN' ? 'Edit ledger income' : 'Edit ledger expense')
            : (type === 'IN' ? 'Record ledger income' : 'Add ledger expense');
    }

    fillCatDatalist(type);
    setWallet(entry?.wallet || 'BANK');

    const amt = document.getElementById('ledger-line-amt');
    const date = document.getElementById('ledger-line-date');
    const cat = document.getElementById('ledger-line-cat');
    const desc = document.getElementById('ledger-line-desc-input');
    const bankRef = document.getElementById('ledger-line-bank-ref');
    const exclude = document.getElementById('ledger-line-exclude-reports');

    if (amt) amt.value = entry?.amount != null ? String(entry.amount) : '';
    if (date) date.value = entry?.date ? String(entry.date).slice(0, 10) : todayISO();
    if (cat) cat.value = entry?.cat || '';
    if (desc) desc.value = entry?.description || '';
    if (bankRef) bankRef.value = entry?.bank_reference || '';
    if (exclude) exclude.checked = !!entry?.exclude_from_reports;

    modal.dataset.editId = editing ? String(entry.id || entry._id) : '';
    modal.dataset.lineType = type;
    const delBtn = document.getElementById('ledger-line-delete-btn');
    if (delBtn) delBtn.hidden = !editing;
    modal.classList.add('active');

    setTimeout(() => amt?.focus(), 30);
}

export function closeLedgerLineModal() {
    document.getElementById('ledger-line-modal')?.classList.remove('active');
}

export function initLedgerLineModal({ onSaved, getEntryById }) {
    const modal = document.getElementById('ledger-line-modal');
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = '1';

    document.getElementById('ledger-line-wallet-pills')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-wallet]');
        if (!btn) return;
        setWallet(btn.dataset.wallet);
    });

    document.getElementById('ledger-line-save-btn')?.addEventListener('click', async () => {
        const type = modal.dataset.lineType === 'IN' ? 'IN' : 'OUT';
        const amount = parseFloat(document.getElementById('ledger-line-amt')?.value);
        const date = document.getElementById('ledger-line-date')?.value;
        const cat = document.getElementById('ledger-line-cat')?.value?.trim();
        const description = document.getElementById('ledger-line-desc-input')?.value?.trim() || null;
        const wallet = getWallet();
        const bank_reference = wallet === 'BANK'
            ? (document.getElementById('ledger-line-bank-ref')?.value?.trim() || null)
            : null;
        const exclude_from_reports = document.getElementById('ledger-line-exclude-reports')?.checked === true;

        if (!(amount > 0)) return alert('Enter a valid amount.');
        if (!date) return alert('Date is required.');
        if (!cat) return alert('Category is required.');

        const btn = document.getElementById('ledger-line-save-btn');
        const prev = btn?.textContent;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving…';
        }
        try {
            await saveLedgerEntry({
                id: modal.dataset.editId || crypto.randomUUID(),
                type,
                wallet,
                amount,
                date,
                cat,
                description,
                bank_reference,
                exclude_from_reports,
            });
            closeLedgerLineModal();
            await onSaved?.();
        } catch (err) {
            alert(err.message || 'Could not save ledger line.');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = prev || 'Save ledger line';
            }
        }
    });

    document.getElementById('ledger-line-delete-btn')?.addEventListener('click', async () => {
        const id = modal.dataset.editId;
        if (!id) return;
        const entry = getEntryById?.(id) || { id };
        try {
            await confirmDeleteEntry(entry, { onSaved });
            closeLedgerLineModal();
        } catch (err) {
            alert(err.message || 'Delete failed.');
        }
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeLedgerLineModal();
    });
}

/**
 * @param {object} entry
 * @param {{ onSaved: () => Promise<void>|void }} opts
 */
export async function confirmDeleteEntry(entry, { onSaved }) {
    const id = entry?.id || entry?._id;
    if (!id) return;
    const label = entry.cat || entry.description || id;
    if (!confirm(`Delete ledger entry “${label}”?`)) return;
    await deleteLedgerEntry(id);
    await onSaved?.();
}

export { openLedgerLineModal as openLineModal };
