/**
 * Editable Financial Ledger table — bank-recon style layout with classify comboboxes.
 */
import { portalState } from './store.js';
import { postFinanceMutation } from './financeApi.js';
import { removeTransactionsLocally } from './ledgerTxnLocal.js';
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
import {
    buildLedgerStatementContext,
    enrichTxnWithStatementLine,
    buildSameDayLedgerOrderMeta,
    moveLedgerTxnInDay,
} from './ledgerStatementContext.js';
import { formatOcrRowDisplay } from './bankStatementLineUtils.js';

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

const DEFAULT_LEDGER_COLUMNS = {
    calculatedBalance: true,
    passbookBalance: false,
    ocrRow: false,
    rowOrder: false,
};

const loadLedgerColumns = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(LEDGER_COLUMNS_KEY) || 'null');
        return {
            calculatedBalance: saved?.calculatedBalance !== false,
            passbookBalance: !!saved?.passbookBalance,
            ocrRow: !!saved?.ocrRow,
            rowOrder: !!saved?.rowOrder,
        };
    } catch {
        return { ...DEFAULT_LEDGER_COLUMNS };
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

const CLASSIFY_PATCH_KEYS = new Set(['cat', 'sub_category', 'vendor_name', 'exclude_from_reports']);

const markDirty = (txnId, patch) => {
    pendingEdits.set(txnId, { ...(pendingEdits.get(txnId) || {}), ...patch });
    syncLedgerBulkBar();
    const row = document.querySelector(`.ledger-txn-row[data-txn-id="${txnId}"]`);
    row?.classList.add('ledger-txn-row--dirty');
    if (Object.keys(patch).some((k) => CLASSIFY_PATCH_KEYS.has(k))) {
        row?.classList.add('ledger-txn-row--classify-open');
    }
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
    const txnId = row?.dataset?.txnId;
    if (!txnId) return;
    if (cat === BANK_REJECT_CAT || defaultExcludeFromReports(cat)) {
        markDirty(txnId, { exclude_from_reports: true });
    }
};

/** Bank statement narrations copied into vendor (e.g. "To REJECT:…") — hide in table. */
const isBankNarrationVendor = (vendor, description) => {
    const v = String(vendor || '').trim();
    if (!v) return true;
    if (/^to\s+/i.test(v)) return true;
    const d = String(description || '').trim();
    if (!d) return false;
    if (v === d) return true;
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
    const vn = norm(v);
    const dn = norm(d);
    return dn.startsWith(vn) || vn.startsWith(dn.slice(0, Math.min(vn.length + 4, dn.length)));
};

const formatClassifyDisplayParts = (t, isIncome) => {
    const catKey = t.cat ? (normalizeCategoryKey(t.cat) || t.cat) : '';
    const catLabel = catKey ? categoryDisplayLabel(catKey) : '';
    const sub = String(t.sub_category || '').trim();
    let main = catLabel || 'Set category…';
    if (!isIncome && sub && sub.toLowerCase() !== catLabel.toLowerCase()) {
        main = `${catLabel} – ${sub}`;
    }
    const vendor = String(t.vendor_name || '').trim();
    const showVendor = !isIncome && vendor && !isBankNarrationVendor(vendor, t.description);
    return { main, vendor: showVendor ? vendor : '', empty: !catLabel };
};

const renderClassifyDisplay = (t, isIncome) => {
    const { main, vendor, empty } = formatClassifyDisplayParts(t, isIncome);
    const vendorLine = vendor
        ? `<span class="ledger-classify-display__vendor">${esc(vendor)}</span>`
        : '';
    return `<button type="button" class="ledger-classify-display${empty ? ' ledger-classify-display--empty' : ''}" title="Click to edit category">
      <span class="ledger-classify-display__main">${esc(main)}</span>${vendorLine}
    </button>`;
};

const openClassifyEdit = (row) => {
    if (!row) return;
    row.classList.add('ledger-txn-row--classify-open');
    row.querySelector('.bank-recon-cat-input')?.focus();
};

const closeClassifyEditIfClean = (row) => {
    const txnId = row?.dataset?.txnId;
    if (txnId && !isDirty(txnId)) row.classList.remove('ledger-txn-row--classify-open');
};

const renderSortHeader = (label, field, extraClass = '') =>
    `<button type="button" class="ledger-sort-btn ${extraClass}" data-sort="${field}" aria-sort="none">${label} <span class="ledger-sort-indicator"></span></button>`;

const renderLedgerClassifyCell = (t, isIncome) => {
    const catCombobox = `
      <div class="bank-recon-classify-combobox bank-recon-classify-combobox--cat">
        <input type="text" class="bank-recon-cell-input bank-recon-cat-input" placeholder="Category…" autocomplete="off" />
        <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
      </div>`;
    const expenseFields = `
        <div class="bank-recon-classify-combobox bank-recon-classify-combobox--sub">
          <input type="text" class="bank-recon-cell-input bank-recon-subcat-input" placeholder="Sub-category" autocomplete="off" />
          <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
        </div>
        <input type="text" class="bank-recon-cell-input bank-recon-vendor-input" list="ledger-vendors" placeholder="Vendor" />`;
    const editInner = isIncome
        ? catCombobox
        : `${catCombobox}${expenseFields}`;
    return `<div class="ledger-classify-cell">
      ${renderClassifyDisplay(t, isIncome)}
      <div class="ledger-classify-edit bank-recon-classify-actions">${editInner}</div>
    </div>`;
};

const renderLedgerOrderButtons = (txnId, orderMeta) => {
    const o = orderMeta.get(txnId);
    if (!o || o.count <= 1) {
        return '<td class="bank-recon-table__cell bank-recon-table__cell--order"></td>';
    }
    const upDisabled = o.index === 0 ? ' disabled' : '';
    const downDisabled = o.index === o.count - 1 ? ' disabled' : '';
    return `<td class="bank-recon-table__cell bank-recon-table__cell--order">
      <div class="bank-recon-order-btns">
        <button type="button" class="btn btn-outline btn--small btn--icon ledger-move-up" data-txn="${txnId}" title="Move up (same day)" aria-label="Move up"${upDisabled}><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>
        <input type="number" class="bank-recon-move-step expense-combobox ledger-move-step" min="1" max="${Math.max(1, o.count - 1)}" value="1" title="Number of positions to move" aria-label="Rows to move" />
        <button type="button" class="btn btn-outline btn--small btn--icon ledger-move-down" data-txn="${txnId}" title="Move down (same day)" aria-label="Move down"${downDisabled}><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
      </div>
    </td>`;
};

const renderLedgerRow = (raw, {
    formatTxnDetail,
    getAllAttachmentPaths,
    visibleColumns,
    runningBalances,
    needsOpening,
    statementCtx,
    orderMeta,
}) => {
    const t = mergedTxn(raw);
    const isIncome = t.type === 'IN';
    const lineType = isIncome ? 'IN' : 'OUT';
    const isBank = (t.wallet || '').toUpperCase() === 'BANK';
    const reconciled = isTransactionReconciled(t.id);
    const stmt = enrichTxnWithStatementLine(t, statementCtx);
    const reportsBadge = t.exclude_from_reports
        ? '<span class="ledger-recon-badge ledger-recon-badge--report-excluded" title="Omitted from Financial Reports">No reports</span>'
        : '';
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

    const ledgerCalcNum = isBank && runningBalances.has(t.id) ? runningBalances.get(t.id) : null;
    const ledgerCalc = ledgerCalcNum != null ? formatMoney(ledgerCalcNum) : '—';
    const passbookNum = stmt.passbookBalance;
    const passbookMismatch = passbookNum != null && ledgerCalcNum != null
        && Math.abs(ledgerCalcNum - passbookNum) > 0.01;
    const mismatchClass = passbookMismatch ? ' bank-recon-balance--mismatch' : '';
    const calcTitle = ledgerCalcNum != null
        ? (passbookMismatch
            ? `Ledger calculated ${ledgerCalc} ≠ passbook ${formatMoney(passbookNum)}`
            : 'Running balance from opening + BANK ledger entries only (excludes unmatched statement lines)')
        : (needsOpening ? 'Set opening balance to calculate' : '');
    const calcCell = visibleColumns.calculatedBalance
        ? `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--computed${mismatchClass}"${calcTitle ? ` title="${esc(calcTitle)}"` : ''}>${ledgerCalc}${passbookMismatch ? '<i class="fa-solid fa-triangle-exclamation bank-recon-mismatch-icon" aria-hidden="true"></i>' : ''}</td>`
        : '';
    const passbookCell = visibleColumns.passbookBalance
        ? `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--passbook${mismatchClass}"${passbookMismatch ? ` title="${esc(calcTitle)}"` : ''}>${passbookNum != null ? formatMoney(passbookNum) : '—'}${passbookMismatch ? '<i class="fa-solid fa-triangle-exclamation bank-recon-mismatch-icon" aria-hidden="true"></i>' : ''}</td>`
        : '';
    const ocrCell = visibleColumns.ocrRow
        ? `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--ocr" title="OCR / statement row sequence">${formatOcrRowDisplay(stmt.line) ?? '—'}</td>`
        : '';

    return `<tr class="bank-recon-table__row ledger-txn-row${isDirty(t.id) ? ' ledger-txn-row--dirty' : ''}${passbookMismatch ? ' bank-recon-table__row--mismatch' : ''}" data-txn-id="${t.id}" data-line-type="${lineType}" data-txn-date="${esc(String(t.date || '').slice(0, 10))}">
      ${visibleColumns.rowOrder ? renderLedgerOrderButtons(t.id, orderMeta) : ''}
      <td class="bank-recon-table__cell bank-recon-table__cell--check">
        <input type="checkbox" class="ledger-row-check" data-txn="${t.id}" aria-label="Select row" />
      </td>
      ${ocrCell}
      <td class="bank-recon-table__cell bank-recon-table__cell--date">${esc(formatDisplayDate(t.date))}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--desc">
        <textarea class="bank-recon-cell-input bank-recon-cell-input--desc" data-field="description" rows="2"${descPlaceholder}>${esc(t.description || '')}</textarea>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num${drClass}">${dr}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num${crClass}">${cr}</td>
      ${calcCell}
      ${passbookCell}
      <td class="bank-recon-table__cell bank-recon-table__cell--type">
        <span class="bank-recon-type-badge bank-recon-type-badge--${lineType.toLowerCase()}">${isIncome ? 'Income' : 'Expense'}</span>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--classify">
        ${renderLedgerClassifyCell(t, isIncome)}
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--ledger">
        <span class="ledger-txn-chip ledger-txn-chip--wallet">${esc(t.wallet)}</span>
        ${reportsBadge}
        ${reconBadge}
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--actions">
        <div class="bank-recon-row-actions">
          ${receiptBtn}
          <button type="button" class="btn btn-outline btn--small btn--icon ledger-row-save" data-txn="${t.id}" title="Save this row" aria-label="Save row" ${isDirty(t.id) ? '' : 'disabled'}><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i></button>
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
    if (vendorInput && t.vendor_name && !isBankNarrationVendor(t.vendor_name, t.description)) {
        vendorInput.value = t.vendor_name;
    }
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

const mountLedgerColumnsPicker = (visibleColumns) => {
    const slot = document.getElementById('ledger-columns-slot');
    if (!slot) return;
    slot.innerHTML = `
      <details class="bank-recon-columns-picker ledger-columns-picker">
        <summary class="btn btn-outline btn--small" title="Show or hide columns"><i class="fa-solid fa-table-columns" aria-hidden="true"></i> Columns</summary>
        <div class="bank-recon-columns-picker__menu">
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="calculatedBalance" ${visibleColumns.calculatedBalance ? 'checked' : ''} />
            <span>Ledger calculated</span>
          </label>
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="passbookBalance" ${visibleColumns.passbookBalance ? 'checked' : ''} />
            <span>Passbook balance</span>
          </label>
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="ocrRow" ${visibleColumns.ocrRow ? 'checked' : ''} />
            <span>OCR row #</span>
          </label>
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="rowOrder" ${visibleColumns.rowOrder ? 'checked' : ''} />
            <span>Row order (↑ ↓)</span>
          </label>
        </div>
      </details>`;
    slot.querySelectorAll('[data-ledger-column-toggle]').forEach((input) => {
        input.addEventListener('change', () => {
            const key = input.dataset.ledgerColumnToggle;
            if (!key) return;
            ledgerVisibleColumns = { ...ledgerVisibleColumns, [key]: !!input.checked };
            persistLedgerColumns();
            window.renderCashLedger?.();
        });
    });
};

export const renderEditableLedgerRows = (txns, { formatTxnDetail, getAllAttachmentPaths }) => {
    const list = document.getElementById('cash-ledger-items');
    if (!list) return;

    const visibleColumns = { ...ledgerVisibleColumns };
    const running = annotateLedgerRunningBalances();
    const opening = getBankOpeningConfig();
    const statementCtx = buildLedgerStatementContext();
    const orderMeta = buildSameDayLedgerOrderMeta(statementCtx);
    const calculatedHeaderHint = visibleColumns.calculatedBalance && opening.amount == null
        ? ' title="Set opening balance via the Opening control above"'
        : '';
    const rowOpts = {
        formatTxnDetail,
        getAllAttachmentPaths,
        visibleColumns,
        runningBalances: running.byId,
        needsOpening: running.needsOpening,
        statementCtx,
        orderMeta,
    };

    if (!txns.length) {
        mountLedgerColumnsPicker(visibleColumns);
        list.innerHTML = '<p class="maintenance-dues-empty">No transactions match your filters.</p>';
        syncLedgerBulkBar();
        return;
    }

    const vendorDatalist = (portalState.finances.vendors || [])
        .map((v) => `<option value="${esc(v.name)}">`).join('');

    const rows = txns.map((raw) => renderLedgerRow(raw, rowOpts)).join('');

    mountLedgerColumnsPicker(visibleColumns);

    list.innerHTML = `
      <datalist id="ledger-vendors">${vendorDatalist}</datalist>
      <div class="bank-recon-table-shell ledger-table-shell" id="ledger-table-shell">
        <div class="bank-recon-table-wrap" id="ledger-table-wrap">
          <table class="bank-recon-table bank-recon-table--ledger">
            <thead>
              <tr>
                ${visibleColumns.rowOrder ? '<th class="bank-recon-table__th--order" title="Reorder reconciled rows on the same date">Order</th>' : ''}
                <th class="bank-recon-table__th--check">
                  <input type="checkbox" id="ledger-header-select-all" aria-label="Select all" />
                </th>
                ${visibleColumns.ocrRow ? '<th class="bank-recon-table__th--num" title="OCR / statement row sequence">OCR #</th>' : ''}
                <th>${renderSortHeader('Date', 'date')}</th>
                <th>Description</th>
                <th class="bank-recon-table__th--num">${renderSortHeader('Debit', 'dr', 'ledger-sort-btn--num')}</th>
                <th class="bank-recon-table__th--num">${renderSortHeader('Credit', 'cr', 'ledger-sort-btn--num')}</th>
                ${visibleColumns.calculatedBalance ? `<th class="bank-recon-table__th--num"${calculatedHeaderHint || ' title="Opening + BANK ledger entries only — does not include unmatched statement lines"'}>${renderSortHeader('Calculated', 'computedBalance', 'ledger-sort-btn--num')}</th>` : ''}
                ${visibleColumns.passbookBalance ? '<th class="bank-recon-table__th--num" title="Balance printed on the matched passbook / statement line">Passbook</th>' : ''}
                <th>Type</th>
                <th>${renderSortHeader('Category / vendor', 'cat')}</th>
                <th>${renderSortHeader('Ledger', 'wallet')}</th>
                <th class="bank-recon-table__th--actions"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;

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
    bar.querySelectorAll('select, button:not(#ledger-bulk-save)').forEach((el) => {
        el.disabled = saving;
    });
    const countEl = bar.querySelector('#ledger-bulk-count');
    if (countEl && saving && statusText) {
        countEl.textContent = statusText;
        countEl.classList.add('ledger-bulk-bar__status--busy');
    }
};

const flashBulkStatus = (message, ms = 2800) => {
    const countEl = document.getElementById('ledger-bulk-count');
    if (!countEl) return;
    clearTimeout(bulkStatusTimer);
    countEl.textContent = message;
    countEl.classList.remove('ledger-bulk-bar__status--busy');
    countEl.classList.add('ledger-bulk-bar__status--flash');
    bulkStatusTimer = setTimeout(() => {
        countEl.classList.remove('ledger-bulk-bar__status--flash');
        syncLedgerBulkBar();
    }, ms);
};

export const syncLedgerBulkBar = () => {
    const bar = document.getElementById('ledger-bulk-bar');
    if (!bar || bar.classList.contains('ledger-bulk-bar--busy')) return;
    const selected = selectedTxnIds();
    const dirtyCount = pendingEdits.size;
    const showBar = selected.length > 0 || dirtyCount > 0;
    bar.hidden = !showBar;
    const countEl = bar.querySelector('#ledger-bulk-count');
    const saveBtn = bar.querySelector('#ledger-bulk-save');
    const applyBtn = bar.querySelector('#ledger-bulk-apply');
    const deleteBtn = bar.querySelector('#ledger-bulk-delete');
    if (countEl && !countEl.classList.contains('ledger-bulk-bar__status--flash')) {
        const parts = [];
        if (selected.length) parts.push(`${selected.length} selected`);
        if (dirtyCount) parts.push(`${dirtyCount} unsaved`);
        countEl.textContent = parts.length ? parts.join(' · ') : 'Select rows to bulk edit';
    }
    if (saveBtn && saveBtn.dataset.busy !== '1') saveBtn.disabled = dirtyCount === 0;
    if (applyBtn) applyBtn.disabled = selected.length === 0;
    if (deleteBtn) deleteBtn.disabled = selected.length === 0;
    const headerAll = document.getElementById('ledger-header-select-all');
    const checks = [...document.querySelectorAll('.ledger-row-check')];
    if (headerAll && checks.length) {
        headerAll.checked = checks.every((c) => c.checked);
        headerAll.indeterminate = checks.some((c) => c.checked) && !headerAll.checked;
    }
};

const readRowPatch = (row) => {
    const txnId = row?.dataset?.txnId;
    const raw = txnId ? portalState.finances.txns.find((t) => t.id === txnId) : null;
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
    if (vendorInput) {
        const v = vendorInput.value.trim();
        if (v) {
            patch.vendor_name = v;
        } else if (raw && !isBankNarrationVendor(raw.vendor_name, raw.description)) {
            patch.vendor_name = null;
        }
    }
    const pending = txnId ? pendingEdits.get(txnId) : null;
    if (pending && 'exclude_from_reports' in pending) {
        patch.exclude_from_reports = pending.exclude_from_reports;
    } else if (raw) {
        patch.exclude_from_reports = !!raw.exclude_from_reports;
    }
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
    window.renderBankReconciliation?.();
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
        setLedgerActivity('Choose a category or reports option first', { flashMs: 3500 });
        return;
    }

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
            const saveBtn = row.querySelector('.ledger-row-save');
            if (saveBtn) saveBtn.disabled = false;
        }
    });
    syncLedgerBulkBar();
    setLedgerActivity(
        `Staged ${ids.length} row${ids.length === 1 ? '' : 's'} — click Save changes`,
        { flashMs: 3500 },
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
    });

    list.addEventListener('input', (e) => {
        const row = e.target.closest('.ledger-txn-row');
        if (row && e.target.matches('.bank-recon-cell-input--desc, .bank-recon-vendor-input')) {
            onRowFieldChange(row);
        }
    });

    list.addEventListener('click', async (e) => {
        if (e.target.closest('.ledger-move-step')) {
            e.stopPropagation();
        }

        const moveBtn = e.target.closest('.ledger-move-up, .ledger-move-down');
        if (moveBtn) {
            if (moveBtn.disabled || moveBtn.dataset.busy === '1') return;
            const txnId = moveBtn.dataset.txn;
            if (!txnId) return;
            const direction = moveBtn.classList.contains('ledger-move-up') ? -1 : 1;
            const stepInput = moveBtn.closest('.bank-recon-order-btns')?.querySelector('.ledger-move-step');
            const steps = Math.max(1, parseInt(stepInput?.value, 10) || 1);
            try {
                await withButtonBusy(moveBtn, '…', async () => {
                    await moveLedgerTxnInDay(txnId, direction, { steps, recalculate: true });
                    window.processFinances?.();
                    window.renderCashLedger?.();
                });
            } catch (err) {
                alert(err?.message || 'Could not reorder row.');
            }
            return;
        }

        const classifyBtn = e.target.closest('.ledger-classify-display');
        if (classifyBtn) {
            openClassifyEdit(classifyBtn.closest('.ledger-txn-row'));
            return;
        }

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
        '<option value="">Set category…</option>',
        `<optgroup label="Income">${INCOME_CATS.map((c) => `<option value="${escOpt(c)}">${escOpt(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
        `<optgroup label="Expenses">${EXPENSE_CATS.map((c) => `<option value="${escOpt(c)}">${escOpt(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
    ].join('');
};

export const initLedgerBulkBar = () => {
    if (ledgerTableWired) return;
    ledgerTableWired = true;

    populateBulkCategorySelect();

    if (!document.body.dataset.ledgerClassifyDismissWired) {
        document.body.dataset.ledgerClassifyDismissWired = '1';
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ledger-classify-cell')) return;
            document.querySelectorAll('.ledger-txn-row--classify-open').forEach((row) => {
                closeClassifyEditIfClean(row);
            });
        });
    }

    const setAllSelected = (on) => {
        document.querySelectorAll('.ledger-row-check').forEach((c) => { c.checked = on; });
        const headerAll = document.getElementById('ledger-header-select-all');
        if (headerAll) headerAll.checked = on;
        syncLedgerBulkBar();
    };

    document.getElementById('cash-ledger-items')?.addEventListener('change', (e) => {
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

    document.getElementById('ledger-bulk-delete')?.addEventListener('click', async () => {
        const btn = document.getElementById('ledger-bulk-delete');
        const ids = selectedTxnIds();
        if (!ids.length || btn?.dataset.busy === '1') return;
        if (!confirm(`Permanently delete ${ids.length} ledger entr${ids.length === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
        try {
            await withButtonBusy(btn, 'Deleting…', async () => {
                setLedgerBulkSaving(true, `Deleting ${ids.length}…`);
                await postFinanceMutation('deleteTransactions', { transaction_ids: ids });
                ids.forEach((id) => pendingEdits.delete(id));
                removeTransactionsLocally(ids);
                refreshAfterLedgerSave({ analytics: true });
                flashBulkStatus(`Deleted ${ids.length} row${ids.length === 1 ? '' : 's'}.`);
            });
        } catch (err) {
            alert(err?.message || 'Bulk delete failed.');
            syncLedgerBulkBar();
        } finally {
            setLedgerBulkSaving(false);
        }
    });
};
