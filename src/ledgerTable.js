/**
 * Editable Financial Ledger table — bank-recon style layout with classify comboboxes.
 */
import { portalState } from './store.js';
import { postFinanceMutation } from './financeApi.js';
import {
    INCOME_CATS,
    EXPENSE_CATS,
    BANK_REJECT_CAT,
    SUB_CAT_SUGGESTIONS,
    defaultExcludeFromReports,
    normalizeCategoryKey,
    categoryDisplayLabel,
} from './expenseCategories.js';
import { isTransactionReconciled, getBankOpeningConfig } from './bankReconciliation.js';
import { withButtonBusy } from './buttonBusy.js';
import { setLedgerActivity } from './ledgerFilter.js';
import { annotateLedgerRunningBalances, getExcludedLedgerTxns, patchAffectsLedgerBalance } from './ledgerBalance.js';
import {
    wireClassifyCombobox,
    setClassifyInputState,
    isExactListMatch,
} from './classifyCombobox.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const formatDisplayDate = (isoDate) => {
    if (!isoDate) return '';
    const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return String(isoDate || '');
    const [, year, month, day] = match;
    return `${day}-${month}-${year.slice(-2)}`;
};

const LEDGER_COLUMNS_KEY = 'ledgerTableColumns_v1';

const loadLedgerColumns = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(LEDGER_COLUMNS_KEY) || 'null');
        return { calculatedBalance: saved?.calculatedBalance !== false };
    } catch {
        return { calculatedBalance: true };
    }
};

let ledgerVisibleColumns = loadLedgerColumns();

const persistLedgerColumns = () => {
    localStorage.setItem(LEDGER_COLUMNS_KEY, JSON.stringify(ledgerVisibleColumns));
};

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

const categoryOptionsForTxnRow = (row) => {
    const isIncome = row?.dataset.lineType === 'IN';
    return isIncome ? INCOME_CATS : EXPENSE_CATS;
};

const subCatOptionsForLedgerCategory = (catKey) => {
    if (!catKey) return [];
    const defaults = SUB_CAT_SUGGESTIONS[catKey] || SUB_CAT_SUGGESTIONS.Other || [];
    const saved = (portalState.finances.subCategories || [])
        .filter((row) => row.category === catKey)
        .map((row) => row.name);
    return [...new Set([...defaults, ...saved])].sort((a, b) => a.localeCompare(b));
};

const resolvedCategoryForLedgerRow = (row) => {
    const input = row?.querySelector('.bank-recon-cat-input');
    const raw = input?.value?.trim() || '';
    if (!raw) return '';
    const options = categoryOptionsForTxnRow(row);
    return isExactListMatch(raw, options) || raw;
};

const syncLedgerRowExcludeForCategory = (row) => {
    const cat = row.querySelector('.bank-recon-cat-input')?.value?.trim();
    const excludeInput = row.querySelector('.bank-recon-exclude-reports-input');
    if (excludeInput && (cat === BANK_REJECT_CAT || defaultExcludeFromReports(cat))) {
        excludeInput.checked = true;
    }
};

const renderSortHeader = (label, field, extraClass = '') =>
    `<button type="button" class="ledger-sort-btn ${extraClass}" data-sort="${field}" aria-sort="none">${label} <span class="ledger-sort-indicator"></span></button>`;

const renderLedgerClassifyCell = (t, isIncome) => {
    const excludeCheck = `
      <label class="bank-recon-exclude-reports" title="Omit from income/expense reports">
        <input type="checkbox" class="bank-recon-exclude-reports-input" data-field="exclude_from_reports" ${t.exclude_from_reports ? 'checked' : ''} />
        <span>No reports</span>
      </label>`;
    const catCombobox = `
      <div class="bank-recon-classify-combobox bank-recon-classify-combobox--cat">
        <input type="text" class="bank-recon-cell-input bank-recon-cat-input" placeholder="Category…" autocomplete="off" />
        <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
      </div>`;
    if (isIncome) {
        return `<div class="bank-recon-classify-actions">${catCombobox}${excludeCheck}</div>`;
    }
    return `
      <div class="bank-recon-classify-actions">
        ${catCombobox}
        <div class="bank-recon-classify-combobox bank-recon-classify-combobox--sub">
          <input type="text" class="bank-recon-cell-input bank-recon-subcat-input" placeholder="Sub-category" autocomplete="off" />
          <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
        </div>
        <input type="text" class="bank-recon-cell-input bank-recon-vendor-input" list="ledger-vendors" placeholder="Vendor" />
        ${excludeCheck}
      </div>`;
};

const renderLedgerRow = (raw, { formatTxnDetail, getAllAttachmentPaths, visibleColumns, runningBalances, needsOpening }) => {
    const t = mergedTxn(raw);
    const isIncome = t.type === 'IN';
    const lineType = isIncome ? 'IN' : 'OUT';
    const isBank = (t.wallet || '').toUpperCase() === 'BANK';
    const reconciled = isTransactionReconciled(t.id);
    const reconBadge = reconciled
        ? '<span class="ledger-recon-badge" title="Reconciled to bank statement">Reconciled</span>'
        : (isBank ? '<span class="ledger-recon-badge ledger-recon-badge--open">Unreconciled</span>' : '');
    const attachmentPaths = getAllAttachmentPaths ? getAllAttachmentPaths(raw) : [];
    const receiptBtn = attachmentPaths.length
        ? `<button class="btn btn-outline btn--small btn--icon" type="button" title="View attachment(s)" onclick="window.viewReceipts('${t.id}')"><i class="fa-solid fa-paperclip" aria-hidden="true"></i></button>`
        : '';
    const detail = formatTxnDetail(t);
    const descPlaceholder = !t.description && detail ? ` placeholder="${esc(detail)}"` : ' placeholder="Description"';
    const dr = !isIncome ? formatMoney(t.amount) : '—';
    const cr = isIncome ? formatMoney(t.amount) : '—';
    const drClass = !isIncome ? ' bank-recon-amt--out' : '';
    const crClass = isIncome ? ' bank-recon-amt--in' : '';
    const calcCell = visibleColumns.calculatedBalance
        ? `<td class="bank-recon-table__cell bank-recon-table__cell--num">${isBank && runningBalances.has(t.id) ? formatMoney(runningBalances.get(t.id)) : (isBank && needsOpening ? '—' : '—')}</td>`
        : '';

    return `<tr class="bank-recon-table__row ledger-txn-row${isDirty(t.id) ? ' ledger-txn-row--dirty' : ''}" data-txn-id="${t.id}" data-line-type="${lineType}">
      <td class="bank-recon-table__cell bank-recon-table__cell--check">
        <input type="checkbox" class="ledger-row-check" data-txn="${t.id}" aria-label="Select row" />
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--date">${esc(formatDisplayDate(t.date))}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--desc">
        <textarea class="bank-recon-cell-input bank-recon-cell-input--desc" data-field="description" rows="2"${descPlaceholder}>${esc(t.description || '')}</textarea>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num${drClass}">${dr}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num${crClass}">${cr}</td>
      ${calcCell}
      <td class="bank-recon-table__cell bank-recon-table__cell--type">
        <span class="bank-recon-type-badge bank-recon-type-badge--${lineType.toLowerCase()}">${isIncome ? 'Income' : 'Expense'}</span>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--classify">
        ${renderLedgerClassifyCell(t, isIncome)}
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--ledger">
        <span class="ledger-txn-chip ledger-txn-chip--wallet">${esc(t.wallet)}</span>
        ${reconBadge}
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--actions">
        <div class="bank-recon-row-actions">
          ${receiptBtn}
          <button type="button" class="btn btn-outline btn--small ledger-row-save" data-txn="${t.id}" title="Save this row" ${isDirty(t.id) ? '' : 'disabled'}>Save</button>
          <button type="button" class="btn btn-outline btn--small btn--icon ledger-exclude-btn" data-txn="${t.id}" title="Remove from ledger (move to excluded)" aria-label="Remove from ledger"><i class="fa-solid fa-box-archive" aria-hidden="true"></i></button>
          <button type="button" class="btn btn-outline btn--small btn--icon" onclick="window.editTxn('${t.id}')" title="Full edit" aria-label="Full edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          <button type="button" class="btn btn-outline btn--small btn--icon btn--danger" onclick="window.delTxn('${t.id}')" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
        </div>
      </td>
    </tr>`;
};

const initRowClassifyValues = (row) => {
    const txnId = row.dataset.txnId;
    const raw = portalState.finances.txns.find((txn) => txn.id === txnId);
    if (!raw) return;
    const t = mergedTxn(raw);

    const catInput = row.querySelector('.bank-recon-cat-input');
    if (catInput && t.cat) {
        const key = normalizeCategoryKey(t.cat) || t.cat;
        catInput.value = key;
        const options = categoryOptionsForTxnRow(row);
        setClassifyInputState(catInput, isExactListMatch(key, options) ? 'known' : 'custom');
    }

    const subInput = row.querySelector('.bank-recon-subcat-input');
    if (subInput && t.sub_category) {
        subInput.value = t.sub_category;
        const options = subCatOptionsForLedgerCategory(resolvedCategoryForLedgerRow(row));
        setClassifyInputState(subInput, isExactListMatch(t.sub_category, options) ? 'known' : 'custom');
    }

    const vendorInput = row.querySelector('.bank-recon-vendor-input');
    if (vendorInput && t.vendor_name) vendorInput.value = t.vendor_name;
};

const wireLedgerClassifyRows = (root) => {
    root.querySelectorAll('tr.ledger-txn-row').forEach((row) => {
        const onClassifyChange = () => onRowFieldChange(row);

        const catWrap = row.querySelector('.bank-recon-classify-combobox--cat');
        if (catWrap) {
            wireClassifyCombobox(catWrap, {
                getOptions: () => categoryOptionsForTxnRow(row),
                onKnownSelect: () => {
                    const subInput = row.querySelector('.bank-recon-subcat-input');
                    if (subInput) {
                        subInput.value = '';
                        setClassifyInputState(subInput, '');
                    }
                    syncLedgerRowExcludeForCategory(row);
                    onClassifyChange();
                },
                onStateChange: onClassifyChange,
            });
        }

        const subWrap = row.querySelector('.bank-recon-classify-combobox--sub');
        if (subWrap) {
            wireClassifyCombobox(subWrap, {
                getOptions: () => subCatOptionsForLedgerCategory(resolvedCategoryForLedgerRow(row)),
                onKnownSelect: onClassifyChange,
                onStateChange: onClassifyChange,
            });
        }

        const vendorInput = row.querySelector('.bank-recon-vendor-input');
        vendorInput?.addEventListener('change', onClassifyChange);
        vendorInput?.addEventListener('input', onClassifyChange);
    });

    root.querySelectorAll('tr.ledger-txn-row').forEach(initRowClassifyValues);
};

export const renderEditableLedgerRows = (txns, { formatTxnDetail, getAllAttachmentPaths }) => {
    const list = document.getElementById('cash-ledger-items');
    if (!list) return;

    const visibleColumns = { ...ledgerVisibleColumns };
    const running = annotateLedgerRunningBalances();
    const opening = getBankOpeningConfig();
    const calculatedHeaderHint = visibleColumns.calculatedBalance && opening.amount == null
        ? ' title="Set opening balance in Bank Reconciliation"'
        : '';
    const rowOpts = {
        formatTxnDetail,
        getAllAttachmentPaths,
        visibleColumns,
        runningBalances: running.byId,
        needsOpening: running.needsOpening,
    };

    if (!txns.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No transactions match your filters.</p>';
        syncLedgerBulkBar();
        return;
    }

    const vendorDatalist = (portalState.finances.vendors || [])
        .map((v) => `<option value="${esc(v.name)}">`).join('');

    const rows = txns.map((raw) => renderLedgerRow(raw, rowOpts)).join('');

    list.innerHTML = `
      <datalist id="ledger-vendors">${vendorDatalist}</datalist>
      <p class="bank-recon-work-hint ledger-table-hint">Edit inline, then <strong>Save</strong>. <strong>Calculated</strong> is running bank balance from opening + each BANK row (date order). Use <i class="fa-solid fa-box-archive" aria-hidden="true"></i> to move a row to Excluded entries.</p>
      <div class="bank-recon-bulk-bar ledger-table-toolbar">
        <details class="bank-recon-columns-picker">
          <summary class="btn btn-outline btn--small"><i class="fa-solid fa-table-columns" aria-hidden="true"></i> Columns</summary>
          <div class="bank-recon-columns-picker__menu">
            <label class="bank-recon-columns-picker__option">
              <input type="checkbox" data-ledger-column-toggle="calculatedBalance" ${visibleColumns.calculatedBalance ? 'checked' : ''} />
              <span>Calculated balance</span>
            </label>
          </div>
        </details>
      </div>
      <div class="bank-recon-table-shell ledger-table-shell" id="ledger-table-shell">
        <div class="bank-recon-table-wrap" id="ledger-table-wrap">
          <table class="bank-recon-table bank-recon-table--ledger">
            <thead>
              <tr>
                <th class="bank-recon-table__th--check">
                  <input type="checkbox" id="ledger-header-select-all" aria-label="Select all" />
                </th>
                <th>${renderSortHeader('Date', 'date')}</th>
                <th>${renderSortHeader('Description', 'description')}</th>
                <th class="bank-recon-table__th--num">${renderSortHeader('Debit', 'dr', 'ledger-sort-btn--num')}</th>
                <th class="bank-recon-table__th--num">${renderSortHeader('Credit', 'cr', 'ledger-sort-btn--num')}</th>
                ${visibleColumns.calculatedBalance ? `<th class="bank-recon-table__th--num"${calculatedHeaderHint}>${renderSortHeader('Calculated', 'computedBalance', 'ledger-sort-btn--num')}</th>` : ''}
                <th>${renderSortHeader('Type', 'type')}</th>
                <th>${renderSortHeader('Category / vendor', 'cat')}</th>
                <th>${renderSortHeader('Ledger', 'wallet')}</th>
                <th class="bank-recon-table__th--actions"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;

    list.querySelectorAll('[data-ledger-column-toggle]').forEach((input) => {
        input.addEventListener('change', () => {
            const key = input.dataset.ledgerColumnToggle;
            if (!key) return;
            ledgerVisibleColumns = { ...ledgerVisibleColumns, [key]: !!input.checked };
            persistLedgerColumns();
            window.renderCashLedger?.();
        });
    });

    wireLedgerClassifyRows(list);
    wireLedgerTableEvents();
    syncLedgerBulkBar();
};

const renderExcludedRow = (t, { formatTxnDetailPlain }) => {
    const isIncome = t.type === 'IN';
    const dr = !isIncome ? formatMoney(t.amount) : '—';
    const cr = isIncome ? formatMoney(t.amount) : '—';
    const detail = formatTxnDetailPlain
        ? formatTxnDetailPlain(t)
        : (t.description || t.cat || '—');
    return `<tr class="bank-recon-table__row bank-recon-table__row--readonly ledger-excluded-row" data-txn-id="${t.id}">
      <td class="bank-recon-table__cell bank-recon-table__cell--date">${esc(formatDisplayDate(t.date))}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--desc">${esc(detail)}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num">${dr}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num">${cr}</td>
      <td class="bank-recon-table__cell">${esc(t.cat || '')}</td>
      <td class="bank-recon-table__cell">${esc(t.wallet || '')}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--actions">
        <button type="button" class="btn btn-outline btn--small ledger-restore-btn" data-txn="${t.id}" title="Restore to ledger">Restore</button>
      </td>
    </tr>`;
};

export const renderExcludedLedgerSection = ({ formatTxnDetailPlain } = {}) => {
    const host = document.getElementById('ledger-excluded-items');
    if (!host) return;

    const excluded = [...getExcludedLedgerTxns()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!excluded.length) {
        host.innerHTML = '';
        return;
    }

    const body = excluded.map((t) => renderExcludedRow(t, { formatTxnDetailPlain })).join('');
    host.innerHTML = `
      <section class="bank-recon-processed ledger-excluded-section">
        <h4 class="bank-recon-processed__title">Excluded from ledger <span class="bank-recon-processed__count">(${excluded.length})</span></h4>
        <p class="bank-recon-processed__hint">These rows are omitted from the main ledger and bank balance. Restore to include them again.</p>
        <div class="bank-recon-table-wrap bank-recon-table-wrap--compact">
          <table class="bank-recon-table bank-recon-table--ledger">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th class="bank-recon-table__th--num">Debit</th>
                <th class="bank-recon-table__th--num">Credit</th>
                <th>Category</th>
                <th>Wallet</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>`;

    host.querySelectorAll('.ledger-restore-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const txnId = btn.dataset.txn;
            if (!txnId || btn.dataset.busy === '1') return;
            if (!confirm('Restore this entry to the main ledger?')) return;
            try {
                await withButtonBusy(btn, 'Restoring…', async () => {
                    await setLedgerExclusion(txnId, false);
                    refreshAfterLedgerSave();
                });
            } catch (err) {
                alert(err?.message || 'Could not restore row.');
            }
        });
    });
};

export async function setLedgerExclusion(txnId, excluded = true) {
    await postFinanceMutation('setLedgerExclusion', {
        transaction_id: txnId,
        excluded_from_ledger: excluded,
    });
    const idx = portalState.finances.txns.findIndex((t) => t.id === txnId);
    if (idx >= 0) {
        portalState.finances.txns[idx] = { ...portalState.finances.txns[idx], excluded_from_ledger: excluded };
    }
    pendingEdits.delete(txnId);
}

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
    const catInput = row.querySelector('.bank-recon-cat-input');
    const rawCat = catInput?.value?.trim();
    if (rawCat) {
        const options = categoryOptionsForTxnRow(row);
        patch.cat = normalizeCategoryKey(isExactListMatch(rawCat, options) || rawCat) || rawCat;
    }
    const desc = row.querySelector('[data-field="description"]')?.value;
    if (desc != null) patch.description = desc.trim() || null;
    const subInput = row.querySelector('.bank-recon-subcat-input');
    if (subInput) patch.sub_category = subInput.value.trim() || null;
    const vendorInput = row.querySelector('.bank-recon-vendor-input');
    if (vendorInput) patch.vendor_name = vendorInput.value.trim() || null;
    patch.exclude_from_reports = row.querySelector('.bank-recon-exclude-reports-input')?.checked === true;
    return patch;
};

const onRowFieldChange = (row) => {
    const txnId = row?.dataset?.txnId;
    if (!txnId) return;
    const patch = readRowPatch(row);
    if (patch.cat === BANK_REJECT_CAT || defaultExcludeFromReports(patch.cat)) {
        patch.exclude_from_reports = true;
    }
    markDirty(txnId, patch);
    const saveBtn = row.querySelector('.ledger-row-save');
    if (saveBtn) saveBtn.disabled = false;
    const excludeEl = row.querySelector('.bank-recon-exclude-reports-input');
    if (excludeEl && patch.exclude_from_reports) excludeEl.checked = true;
};

const applyLocalTxnPatches = (updates) => {
    for (const { id, fields } of updates) {
        const idx = portalState.finances.txns.findIndex((t) => t.id === id);
        if (idx >= 0) {
            portalState.finances.txns[idx] = { ...portalState.finances.txns[idx], ...fields };
        }
    }
};

const refreshAfterLedgerSave = ({ analytics = false } = {}) => {
    window.renderCashLedger?.();
    window.processFinances?.();
    if (analytics) window.renderFinanceAnalytics?.();
};

export const saveLedgerPendingEdits = async (txnIds = null) => {
    const ids = txnIds || [...pendingEdits.keys()];
    if (!ids.length) return { updated: 0, balanceChanged: false };

    const updates = ids
        .filter((id) => pendingEdits.has(id))
        .map((id) => ({ id, fields: pendingEdits.get(id) }));

    if (!updates.length) return { updated: 0, balanceChanged: false };

    const balanceChanged = updates.some(({ fields }) => patchAffectsLedgerBalance(fields));

    const { updated } = await postFinanceMutation('bulkUpdateTransactions', { updates });
    applyLocalTxnPatches(updates);
    updates.forEach(({ id }) => pendingEdits.delete(id));

    // Metadata-only inline edits skip full cloud pull; running balances recalc on render.
    return { updated, balanceChanged };
};

const applyBulkToSelected = () => {
    const ids = selectedTxnIds();
    if (!ids.length) {
        setLedgerActivity('Select rows first, then click Apply to selected', { flashMs: 3500 });
        return;
    }

    const cat = document.getElementById('ledger-bulk-cat')?.value?.trim();
    const excludeMode = document.getElementById('ledger-bulk-exclude')?.value || 'nochange';
    if (!cat && excludeMode === 'nochange') {
        setLedgerActivity('Choose a bulk category or reports option first', { flashMs: 3500 });
        return;
    }

    setLedgerActivity(`Staging changes for ${ids.length} row${ids.length === 1 ? '' : 's'}…`, { busy: true });

    ids.forEach((id) => {
        const row = document.querySelector(`.ledger-txn-row[data-txn-id="${id}"]`);
        const patch = { ...(pendingEdits.get(id) || {}) };
        if (cat) {
            patch.cat = cat;
            if (cat === BANK_REJECT_CAT || defaultExcludeFromReports(cat)) patch.exclude_from_reports = true;
            const catInput = row?.querySelector('.bank-recon-cat-input');
            if (catInput) {
                catInput.value = cat;
                setClassifyInputState(catInput, 'known');
            }
        }
        if (excludeMode === 'exclude') patch.exclude_from_reports = true;
        if (excludeMode === 'include') patch.exclude_from_reports = false;
        pendingEdits.set(id, patch);
        row?.classList.add('ledger-txn-row--dirty');
        if (row) {
            if (patch.exclude_from_reports != null) {
                const ex = row.querySelector('.bank-recon-exclude-reports-input');
                if (ex) ex.checked = patch.exclude_from_reports;
            }
            const saveBtn = row.querySelector('.ledger-row-save');
            if (saveBtn) saveBtn.disabled = false;
        }
    });
    syncLedgerBulkBar();
    setLedgerActivity(
        `Staged ${ids.length} row${ids.length === 1 ? '' : 's'} — click Save changes to persist`,
        { flashMs: 4000 },
    );
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
        if (e.target.matches('.bank-recon-exclude-reports-input')) onRowFieldChange(row);
    });

    list.addEventListener('input', (e) => {
        const row = e.target.closest('.ledger-txn-row');
        if (row && e.target.matches('.bank-recon-cell-input--desc, .bank-recon-vendor-input')) {
            onRowFieldChange(row);
        }
    });

    list.addEventListener('click', async (e) => {
        const excludeBtn = e.target.closest('.ledger-exclude-btn');
        if (excludeBtn && excludeBtn.dataset.busy !== '1') {
            const txnId = excludeBtn.dataset.txn;
            if (!txnId) return;
            if (!confirm('Remove this entry from the ledger? It will move to Excluded entries and no longer affect bank balance.')) return;
            try {
                await withButtonBusy(excludeBtn, '…', async () => {
                    await setLedgerExclusion(txnId, true);
                    refreshAfterLedgerSave();
                });
            } catch (err) {
                alert(err?.message || 'Could not exclude row.');
            }
            return;
        }

        const saveBtn = e.target.closest('.ledger-row-save');
        if (!saveBtn || saveBtn.disabled || saveBtn.dataset.busy === '1') return;
        const txnId = saveBtn.dataset.txn;
        if (!txnId) return;
        try {
            await withButtonBusy(saveBtn, 'Saving…', async () => {
                setLedgerBulkSaving(true, 'Saving row…');
                await saveLedgerPendingEdits([txnId]);
                refreshAfterLedgerSave();
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
        `<optgroup label="Income">${INCOME_CATS.map((c) => `<option value="${escOpt(c)}">${escOpt(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
        `<optgroup label="Expenses">${EXPENSE_CATS.map((c) => `<option value="${escOpt(c)}">${escOpt(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
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

    document.querySelector('.ledger-registry-list')?.addEventListener('change', (e) => {
        if (e.target.id === 'ledger-header-select-all') setAllSelected(e.target.checked);
    });

    document.getElementById('ledger-bulk-apply')?.addEventListener('click', () => {
        withButtonBusy(document.getElementById('ledger-bulk-apply'), 'Applying…', async () => {
            applyBulkToSelected();
        });
    });

    document.getElementById('ledger-bulk-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('ledger-bulk-save');
        if (!pendingEdits.size || btn?.dataset.busy === '1') return;
        const count = pendingEdits.size;
        try {
            await withButtonBusy(btn, 'Saving…', async () => {
                setLedgerBulkSaving(true, `Saving ${count} row${count === 1 ? '' : 's'}…`);
                const { updated } = await saveLedgerPendingEdits();
                refreshAfterLedgerSave();
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
