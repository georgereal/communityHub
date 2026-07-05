/**
 * Editable Financial Ledger table — inline edits, selection, bulk update.
 */
import { portalState, pullState } from './store.js';
import { postFinanceMutation } from './financeApi.js';
import {
    categoryOptionsForType,
    INCOME_CATS,
    EXPENSE_CATS,
    BANK_REJECT_CAT,
    defaultExcludeFromReports,
} from './expenseCategories.js';
import { isTransactionReconciled } from './bankReconciliation.js';
import { withButtonBusy } from './buttonBusy.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** @type {Map<string, object>} pending field patches keyed by transaction id */
const pendingEdits = new Map();

export const getLedgerPendingEdits = () => pendingEdits;

export const clearLedgerPendingEdits = () => {
    pendingEdits.clear();
    syncLedgerBulkBar();
};

const mergedTxn = (txn) => ({ ...txn, ...(pendingEdits.get(txn.id) || {}) });

const isDirty = (txnId) => pendingEdits.has(txnId);

const markDirty = (txnId, patch) => {
    pendingEdits.set(txnId, { ...(pendingEdits.get(txnId) || {}), ...patch });
    syncLedgerBulkBar();
    const row = document.querySelector(`.ledger-txn-row[data-txn-id="${txnId}"]`);
    row?.classList.add('ledger-txn-row--dirty');
};

const catOptionsHtml = (txn) => {
    const cats = categoryOptionsForType(txn.type);
    const current = mergedTxn(txn).cat || '';
    return cats.map((c) =>
        `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`,
    ).join('');
};

export const renderEditableLedgerRows = (txns, { formatTxnDetail, getAllAttachmentPaths }) => {
    const list = document.getElementById('cash-ledger-items');
    if (!list) return;
    list.innerHTML = '';

    txns.forEach((raw) => {
        const t = mergedTxn(raw);
        const detail = formatTxnDetail(t);
        const attachmentPaths = getAllAttachmentPaths ? getAllAttachmentPaths(raw) : [];
        const receiptBtn = attachmentPaths.length
            ? `<button class="btn btn-outline btn--small" type="button" title="View attachment(s)" onclick="window.viewReceipts('${t.id}')"><i class="fa-solid fa-paperclip"></i></button>`
            : '';
        const reconciled = isTransactionReconciled(t.id);
        const reconBadge = reconciled
            ? '<span class="ledger-recon-badge" title="Reconciled to bank statement">Reconciled</span>'
            : ((t.wallet || '').toUpperCase() === 'BANK' ? '<span class="ledger-recon-badge ledger-recon-badge--open">Unreconciled</span>' : '');

        const amt = parseFloat(t.amount).toLocaleString('en-IN');
        const dr = t.type === 'OUT' ? `₹${amt}` : '';
        const cr = t.type === 'IN' ? `₹${amt}` : '';
        const amountClass = t.type === 'IN' ? 'ledger-txn-row__amount--in' : 'ledger-txn-row__amount--out';
        const amountText = t.type === 'IN' ? cr : dr;
        const excluded = !!t.exclude_from_reports;
        const subCatField = t.type === 'OUT'
            ? `<input type="text" class="ledger-txn-input ledger-txn-input--sub" data-field="sub_category" value="${esc(t.sub_category || '')}" placeholder="Sub-category" list="ledger-subcat-datalist" />`
            : '';

        const row = document.createElement('div');
        row.className = `apt-row ledger-txn-row${isDirty(t.id) ? ' ledger-txn-row--dirty' : ''}`;
        row.dataset.txnId = t.id;
        row.innerHTML = `
          <label class="ledger-txn-row__check">
            <input type="checkbox" class="ledger-row-check" data-txn="${t.id}" aria-label="Select row" />
          </label>
          <div class="ledger-txn-row__date">${new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</div>
          <div class="ledger-txn-row__wallet">
            <span class="ledger-txn-chip ledger-txn-chip--wallet">${esc(t.wallet)}</span> ${reconBadge}
          </div>
          <div class="ledger-txn-row__cat">
            <select class="ledger-txn-input ledger-txn-input--cat" data-field="cat" aria-label="Category">${catOptionsHtml(raw)}</select>
          </div>
          <label class="ledger-txn-row__exclude" title="Exclude from income/expense reports">
            <input type="checkbox" class="ledger-txn-exclude" data-field="exclude_from_reports" ${excluded ? 'checked' : ''} />
            <span>Exclude</span>
          </label>
          <div class="ledger-txn-row__desc">
            ${subCatField}
            <input type="text" class="ledger-txn-input ledger-txn-input--desc" data-field="description" value="${esc(t.description || '')}" placeholder="Description" />
            ${!t.description && detail ? `<span class="ledger-txn-row__desc-hint">${detail}</span>` : ''}
          </div>
          <div class="ledger-txn-row__dr">${dr}</div>
          <div class="ledger-txn-row__cr">${cr}</div>
          <div class="ledger-txn-row__amount ${amountClass}">${amountText}</div>
          <div class="ledger-txn-row__actions">
            ${receiptBtn}
            <button type="button" class="btn btn-outline btn--small ledger-row-save" data-txn="${t.id}" title="Save this row" ${isDirty(t.id) ? '' : 'disabled'}>Save</button>
            <button type="button" class="btn btn-outline ledger-txn-row__action-btn" type="button" onclick="window.editTxn('${t.id}')" title="Full edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
            <button type="button" class="btn btn-outline ledger-txn-row__action-btn ledger-txn-row__action-btn--danger" type="button" onclick="window.delTxn('${t.id}')"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
          </div>`;
        list.appendChild(row);
    });

    wireLedgerTableEvents();
    syncLedgerBulkBar();
};

const selectedTxnIds = () =>
    [...document.querySelectorAll('.ledger-row-check:checked')].map((el) => el.dataset.txn).filter(Boolean);

let bulkStatusTimer = null;

const setLedgerBulkSaving = (saving, statusText = '') => {
    const bar = document.getElementById('ledger-bulk-bar');
    if (!bar) return;
    bar.classList.toggle('ledger-bulk-bar--busy', saving);
    bar.querySelectorAll('select, input, button:not(#ledger-bulk-save)').forEach((el) => {
        el.disabled = saving;
    });
    const countEl = bar.querySelector('#ledger-bulk-count');
    if (countEl && saving && statusText) {
        countEl.textContent = statusText;
        countEl.classList.add('ledger-bulk-bar__count--busy');
    }
};

const flashBulkStatus = (message, ms = 2800) => {
    const countEl = document.getElementById('ledger-bulk-count');
    if (!countEl) return;
    clearTimeout(bulkStatusTimer);
    countEl.textContent = message;
    countEl.classList.remove('ledger-bulk-bar__count--busy');
    countEl.classList.add('ledger-bulk-bar__count--flash');
    bulkStatusTimer = setTimeout(() => {
        countEl.classList.remove('ledger-bulk-bar__count--flash');
        syncLedgerBulkBar();
    }, ms);
};

export const syncLedgerBulkBar = () => {
    const bar = document.getElementById('ledger-bulk-bar');
    if (!bar || bar.classList.contains('ledger-bulk-bar--busy')) return;
    const selected = selectedTxnIds();
    const dirtyCount = pendingEdits.size;
    const countEl = bar.querySelector('#ledger-bulk-count');
    const saveBtn = bar.querySelector('#ledger-bulk-save');
    const applyBtn = bar.querySelector('#ledger-bulk-apply');
    if (countEl && !countEl.classList.contains('ledger-bulk-bar__count--flash')) {
        countEl.textContent = `${selected.length} selected · ${dirtyCount} unsaved`;
    }
    if (saveBtn && saveBtn.dataset.busy !== '1') saveBtn.disabled = dirtyCount === 0;
    if (applyBtn) applyBtn.disabled = selected.length === 0;
    const selectAll = bar.querySelector('#ledger-select-all');
    const headerAll = document.getElementById('ledger-header-select-all');
    const checks = [...document.querySelectorAll('.ledger-row-check')];
    if (selectAll && checks.length) {
        selectAll.checked = checks.every((c) => c.checked);
        selectAll.indeterminate = checks.some((c) => c.checked) && !selectAll.checked;
    }
    if (headerAll && checks.length) {
        headerAll.checked = checks.every((c) => c.checked);
        headerAll.indeterminate = checks.some((c) => c.checked) && !headerAll.checked;
    }
};

const readRowPatch = (row) => {
    const patch = {};
    const cat = row.querySelector('[data-field="cat"]')?.value;
    if (cat != null) patch.cat = cat;
    const desc = row.querySelector('[data-field="description"]')?.value;
    if (desc != null) patch.description = desc.trim() || null;
    const sub = row.querySelector('[data-field="sub_category"]');
    if (sub) patch.sub_category = sub.value.trim() || null;
    patch.exclude_from_reports = row.querySelector('[data-field="exclude_from_reports"]')?.checked === true;
    return patch;
};

const onRowFieldChange = (row) => {
    const txnId = row?.dataset?.txnId;
    if (!txnId) return;
    const patch = readRowPatch(row);
    if (patch.cat === BANK_REJECT_CAT) patch.exclude_from_reports = true;
    markDirty(txnId, patch);
    const saveBtn = row.querySelector('.ledger-row-save');
    if (saveBtn) saveBtn.disabled = false;
    const excludeEl = row.querySelector('.ledger-txn-exclude');
    if (excludeEl && patch.cat === BANK_REJECT_CAT) excludeEl.checked = true;
};

const collectUpdatesFromPending = () => {
    const updates = [];
    for (const [id, patch] of pendingEdits.entries()) {
        updates.push({ id, fields: patch });
    }
    return updates;
};

export const saveLedgerPendingEdits = async (txnIds = null) => {
    const ids = txnIds || [...pendingEdits.keys()];
    if (!ids.length) return { updated: 0 };

    const updates = ids
        .filter((id) => pendingEdits.has(id))
        .map((id) => ({ id, fields: pendingEdits.get(id) }));

    if (!updates.length) return { updated: 0 };

    const { updated } = await postFinanceMutation('bulkUpdateTransactions', { updates });
    updates.forEach(({ id }) => pendingEdits.delete(id));
    await pullState();
    return { updated };
};

const applyBulkToSelected = () => {
    const ids = selectedTxnIds();
    if (!ids.length) return;

    const cat = document.getElementById('ledger-bulk-cat')?.value?.trim();
    const excludeMode = document.getElementById('ledger-bulk-exclude')?.value || 'nochange';

    ids.forEach((id) => {
        const row = document.querySelector(`.ledger-txn-row[data-txn-id="${id}"]`);
        const patch = { ...(pendingEdits.get(id) || {}) };
        if (cat) {
            patch.cat = cat;
            if (cat === BANK_REJECT_CAT || defaultExcludeFromReports(cat)) patch.exclude_from_reports = true;
            row?.querySelector('[data-field="cat"]') && (row.querySelector('[data-field="cat"]').value = cat);
        }
        if (excludeMode === 'exclude') patch.exclude_from_reports = true;
        if (excludeMode === 'include') patch.exclude_from_reports = false;
        pendingEdits.set(id, patch);
        row?.classList.add('ledger-txn-row--dirty');
        if (row) {
            if (patch.exclude_from_reports != null) {
                const ex = row.querySelector('.ledger-txn-exclude');
                if (ex) ex.checked = patch.exclude_from_reports;
            }
            const saveBtn = row.querySelector('.ledger-row-save');
            if (saveBtn) saveBtn.disabled = false;
        }
    });
    syncLedgerBulkBar();
};

let ledgerTableWired = false;

export const wireLedgerTableEvents = () => {
    syncLedgerBulkBar();

    const list = document.getElementById('cash-ledger-items');
    if (!list || list.dataset.editWired) return;
    list.dataset.editWired = '1';

    list.addEventListener('change', (e) => {
        const row = e.target.closest('.ledger-txn-row');
        if (!row) return;
        if (e.target.matches('.ledger-row-check')) {
            syncLedgerBulkBar();
            return;
        }
        if (e.target.matches('.ledger-txn-input, .ledger-txn-exclude')) onRowFieldChange(row);
    });

    list.addEventListener('input', (e) => {
        const row = e.target.closest('.ledger-txn-row');
        if (row && e.target.matches('.ledger-txn-input')) onRowFieldChange(row);
    });

    list.addEventListener('click', async (e) => {
        const saveBtn = e.target.closest('.ledger-row-save');
        if (!saveBtn || saveBtn.disabled || saveBtn.dataset.busy === '1') return;
        const txnId = saveBtn.dataset.txn;
        if (!txnId) return;
        try {
            await withButtonBusy(saveBtn, 'Saving…', async () => {
                setLedgerBulkSaving(true, 'Saving row…');
                await saveLedgerPendingEdits([txnId]);
                window.renderCashLedger?.();
                window.processFinances?.();
                window.renderFinanceAnalytics?.();
            });
        } catch (err) {
            alert(err?.message || 'Could not save row.');
        } finally {
            setLedgerBulkSaving(false);
        }
    });
};

const populateBulkCategorySelect = () => {
    const sel = document.getElementById('ledger-bulk-cat');
    if (!sel) return;
    const escOpt = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    sel.innerHTML = [
        '<option value="">— no change —</option>',
        `<optgroup label="Income">${INCOME_CATS.map((c) => `<option value="${escOpt(c)}">${escOpt(c)}</option>`).join('')}</optgroup>`,
        `<optgroup label="Expenses">${EXPENSE_CATS.map((c) => `<option value="${escOpt(c)}">${escOpt(c)}</option>`).join('')}</optgroup>`,
    ].join('');
};

export const initLedgerBulkBar = () => {
    if (ledgerTableWired) return;
    ledgerTableWired = true;

    populateBulkCategorySelect();

    const setAllSelected = (on) => {
        document.querySelectorAll('.ledger-row-check').forEach((c) => { c.checked = on; });
        const bulkAll = document.getElementById('ledger-select-all');
        const headerAll = document.getElementById('ledger-header-select-all');
        if (bulkAll) bulkAll.checked = on;
        if (headerAll) headerAll.checked = on;
        syncLedgerBulkBar();
    };

    document.getElementById('ledger-select-all')?.addEventListener('change', (e) => setAllSelected(e.target.checked));
    document.getElementById('ledger-header-select-all')?.addEventListener('change', (e) => setAllSelected(e.target.checked));

    document.getElementById('ledger-bulk-apply')?.addEventListener('click', () => applyBulkToSelected());

    document.getElementById('ledger-bulk-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('ledger-bulk-save');
        if (!pendingEdits.size || btn?.dataset.busy === '1') return;
        const count = pendingEdits.size;
        try {
            await withButtonBusy(btn, 'Saving…', async () => {
                setLedgerBulkSaving(true, `Saving ${count} row${count === 1 ? '' : 's'}…`);
                const { updated } = await saveLedgerPendingEdits();
                window.renderCashLedger?.();
                window.processFinances?.();
                window.renderFinanceAnalytics?.();
                if (updated) flashBulkStatus(`Saved ${updated} row${updated === 1 ? '' : 's'}.`);
            });
        } catch (err) {
            alert(err?.message || 'Bulk save failed.');
            syncLedgerBulkBar();
        } finally {
            setLedgerBulkSaving(false);
        }
    });
};
