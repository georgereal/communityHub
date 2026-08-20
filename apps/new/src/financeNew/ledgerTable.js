/** Finance-New clone (ledgerTable.js) */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
/**
 * Editable Financial Ledger table — bank-recon layout with pencil/save/cancel category edit.
 */
import { portalState } from '../store.js';
import { postFnMutation } from './mongoMutations.js';
import { removeTransactionsLocally } from './ledgerTxnLocal.js';
import {
    BANK_REJECT_CAT,
    defaultExcludeFromReports,
    normalizeCategoryKey,
    categoryDisplayLabel,
} from '../expenseCategories.js';
import { buildCategoryOptionGroups } from '../classifyOptions.js';
import { isTransactionReconciled, getBankOpeningConfig } from './bankStatementQueries.js';
import { withButtonBusy } from '../buttonBusy.js';
import { setLedgerActivity, ledgerHasActiveFilters, sortLedgerTxnsChronological } from './ledgerFilter.js';
import {
    getActiveLedgerTxns,
    getExcludedLedgerTxns,
    patchAffectsLedgerBalance,
    getLedgerBalanceMeta,
    storedLedgerRunningById,
    annotateLedgerRunningBalancesInOrder,
} from './ledgerBalance.js';
import {
    wireClassifyCombobox,
    setClassifyInputState,
    isExactListMatch,
} from '../classifyCombobox.js';
import {
    buildCategoryOptions,
    buildSubCategoryOptions,
    registerCustomCategory,
    registerCustomSubCategory,
} from '../classifyOptions.js';
import {
    buildLedgerStatementContext,
    enrichTxnWithStatementLine,
    buildSameDayLedgerOrderMeta,
    moveLedgerTxnInDay,
} from './ledgerStatementContext.js';
import { formatOcrRowDisplay } from '../bankStatementLineUtils.js';
import { isBankPettyFunding } from './cashFloatPredicates.js';
import { can } from '../capabilities.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const canDeleteAccounts = () => can('accounts.delete');

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const linkedFinanceDocsForTxn = (txnId) =>
    (fnFinances().financeDocuments || []).filter(
        (d) => d.transaction_id === txnId && d.status !== 'void',
    );

/** Open linked bill/receipt for edit, or create/link when none. */
export const openBillReceiptForLedgerTxn = async (txnId, triggerBtn = null) => {
    const docs = linkedFinanceDocsForTxn(txnId);
    if (docs.length === 1) {
        window.openFinanceDocumentEdit?.(docs[0]);
        return;
    }
    if (docs.length > 1) {
        openLinkedBillsForLedgerTxn(txnId, { edit: true });
        return;
    }

    // None linked — choose create vs link existing
    let modal = document.getElementById('fn-ledger-bill-choice-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'ledger-bill-choice-modal';
        modal.className = 'fdoc-link-modal';
        modal.hidden = true;
        modal.innerHTML = `
          <div class="fdoc-link-modal__backdrop" data-bill-choice-close></div>
          <div class="fdoc-link-modal__panel" role="dialog" aria-labelledby="ledger-bill-choice-title">
            <div class="fdoc-link-modal__head">
              <h3 id="ledger-bill-choice-title" class="fa-panel__title" style="margin:0;">Bill / receipt</h3>
              <button type="button" class="btn btn-outline btn--small" data-bill-choice-close>Close</button>
            </div>
            <p class="fa-panel__hint">Link paperwork to this ledger line, or create a bill/receipt from it.</p>
            <div class="fdoc-link-list">
              <button type="button" class="fdoc-link-row" data-bill-choice="create">
                <span class="fdoc-link-row__main">Create from this line</span>
                <span class="fdoc-link-row__sub">Opens the bill/receipt form with amount, date, and category filled in</span>
              </button>
              <button type="button" class="fdoc-link-row" data-bill-choice="link">
                <span class="fdoc-link-row__main">Link existing</span>
                <span class="fdoc-link-row__sub">Pick an unlinked bill or receipt and attach it here</span>
              </button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-bill-choice-close]')) {
                modal.hidden = true;
                return;
            }
            const choice = e.target.closest('[data-bill-choice]')?.dataset?.billChoice;
            const id = modal.dataset.txnId;
            if (!choice || !id) return;
            modal.hidden = true;
            if (choice === 'link') {
                void import('./financeDocuments.js').then((m) => m.openAttachDocsToLedgerModal(id));
                return;
            }
            void withButtonBusy(null, 'Creating…', async () => {
                const { createFinanceDocumentFromLedgerTxn } = await import('./financeDocuments.js');
                await createFinanceDocumentFromLedgerTxn(id, { openEditor: true });
                refreshLedgerView();
            }).catch((err) => alert(err?.message || 'Could not create bill/receipt.'));
        });
    }
    modal.dataset.txnId = txnId;
    modal.hidden = false;
};

/** Open the same Bills & receipts modal. If several are linked, pick one first. */
export const openLinkedBillsForLedgerTxn = (txnId, { cashOutOnly = false, edit = false } = {}) => {
    let docs = linkedFinanceDocsForTxn(txnId);
    if (cashOutOnly) {
        docs = docs.filter((d) => {
            if (d.kind !== 'OUT') return false;
            // Cheque bills carry "Cheque: …" in notes; cash desk spends do not.
            return !/^Cheque:\s*/i.test(String(d.notes || '').trim());
        });
    }
    if (!docs.length) {
        alert(cashOutOnly
            ? 'No cash bills linked to this Petty Cash bucket yet.'
            : 'No bills or receipts linked to this ledger entry.');
        return;
    }
    if (docs.length === 1) {
        if (edit) window.openFinanceDocumentEdit?.(docs[0]);
        else window.openFinanceDocumentView?.(docs[0]);
        return;
    }

    let modal = document.getElementById('fn-ledger-linked-bills-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'ledger-linked-bills-modal';
        modal.className = 'fdoc-link-modal';
        modal.hidden = true;
        modal.innerHTML = `
          <div class="fdoc-link-modal__backdrop" data-linked-bills-close></div>
          <div class="fdoc-link-modal__panel" role="dialog" aria-labelledby="ledger-linked-bills-title">
            <div class="fdoc-link-modal__head">
              <h3 id="ledger-linked-bills-title" class="fa-panel__title" style="margin:0;">Linked bills &amp; receipts</h3>
              <button type="button" class="btn btn-outline btn--small" data-linked-bills-close>Close</button>
            </div>
            <p class="fa-panel__hint" id="ledger-linked-bills-hint">Choose a bill/receipt to open in the same details form used on Bills &amp; receipts.</p>
            <div id="ledger-linked-bills-list" class="fdoc-link-list"></div>
          </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target.closest('[data-linked-bills-close]')) {
                modal.hidden = true;
                return;
            }
            const docId = e.target.closest('[data-open-doc]')?.dataset?.openDoc;
            if (docId) {
                const doc = (fnFinances().financeDocuments || []).find((d) => d.id === docId);
                const asEdit = modal.dataset.openEdit === '1';
                modal.hidden = true;
                if (!doc) return;
                if (asEdit) window.openFinanceDocumentEdit?.(doc);
                else window.openFinanceDocumentView?.(doc);
            }
        });
    }

    modal.dataset.openEdit = edit ? '1' : '0';

    const title = document.getElementById('fn-ledger-linked-bills-title');
    const hint = document.getElementById('fn-ledger-linked-bills-hint');
    if (title) {
        title.textContent = cashOutOnly
            ? `Cash bills in this bucket (${docs.length})`
            : `Linked bills & receipts (${docs.length})`;
    }
    if (hint) {
        hint.textContent = cashOutOnly
            ? 'These cash expenses are linked to this Petty Cash funding line. Click one to open.'
            : (edit
                ? 'Choose a bill/receipt to edit.'
                : 'Choose a bill/receipt to open in the same details form used on Bills & receipts.');
    }

    const list = document.getElementById('fn-ledger-linked-bills-list');
    if (list) {
        list.innerHTML = docs.map((d) => {
            const date = d.doc_date
                ? new Date(`${String(d.doc_date).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
                    day: '2-digit', month: 'short', year: '2-digit',
                })
                : '—';
            return `<button type="button" class="fdoc-link-row" data-open-doc="${esc(d.id)}">
              <span class="fdoc-link-row__main">${esc(date)} · ${d.kind === 'IN' ? 'Income' : 'Expense'} · ${esc(categoryDisplayLabel(d.cat))} · ${formatMoney(d.amount)}</span>
              <span class="fdoc-link-row__sub">${esc(d.vendor_name || d.description || '—')}</span>
            </button>`;
        }).join('');
    }
    modal.hidden = false;
};

const formatDisplayDate = (isoDate) => {
    if (!isoDate) return '';
    const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return String(isoDate || '');
    const [, year, month, day] = match;
    // Non-breaking hyphens so DD-MM-YY never wraps mid-date in narrow columns
    return `${day}\u2011${month}\u2011${year.slice(-2)}`;
};

const LEDGER_COLUMNS_KEY = 'ledgerTableColumns_v3';

const DEFAULT_LEDGER_COLUMNS = {
    /** Passbook column with optional calculated running balance in parentheses. */
    passbookBalance: true,
    ocrRow: false,
    rowOrder: false,
    wallet: false,
};

const loadLedgerColumns = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(LEDGER_COLUMNS_KEY) || 'null');
        if (saved) {
            return {
                passbookBalance: saved.passbookBalance !== false,
                ocrRow: !!saved.ocrRow,
                rowOrder: !!saved.rowOrder,
                wallet: !!saved.wallet,
            };
        }
        // Migrate v2: show Passbook column if either balance column was on
        const v2 = JSON.parse(localStorage.getItem('ledgerTableColumns_v2') || 'null');
        if (v2) {
            return {
                passbookBalance: v2.passbookBalance === true || v2.calculatedBalance !== false,
                ocrRow: !!v2.ocrRow,
                rowOrder: !!v2.rowOrder,
                wallet: !!v2.wallet,
            };
        }
        return { ...DEFAULT_LEDGER_COLUMNS };
    } catch {
        return { ...DEFAULT_LEDGER_COLUMNS };
    }
};

let ledgerVisibleColumns = loadLedgerColumns();

const persistLedgerColumns = () => {
    localStorage.setItem(LEDGER_COLUMNS_KEY, JSON.stringify(ledgerVisibleColumns));
};

/** Registered by finances.js — avoids relying on a stale window.renderCashLedger after HMR. */
let refreshLedgerView = () => {
    if (typeof window.renderCashLedger === 'function') window.renderCashLedger();
};

export const setLedgerViewRefresh = (fn) => {
    if (typeof fn === 'function') refreshLedgerView = fn;
};

const applyLedgerColumnToggle = (key, checked) => {
    if (!key || !(key in DEFAULT_LEDGER_COLUMNS)) return;
    ledgerVisibleColumns = { ...ledgerVisibleColumns, [key]: !!checked };
    persistLedgerColumns();
    refreshLedgerView();
};

const ensureLedgerColumnsSlotWired = () => {
    const slot = document.getElementById('fn-ledger-columns-slot');
    if (!slot || slot.dataset.columnWired === '1') return;
    slot.dataset.columnWired = '1';
    slot.addEventListener('change', (e) => {
        const input = e.target.closest('[data-ledger-column-toggle]');
        if (!input || !slot.contains(input)) return;
        applyLedgerColumnToggle(input.dataset.ledgerColumnToggle, input.checked);
    });
};

const mountLedgerColumnsPicker = (visibleColumns) => {
    const slot = document.getElementById('fn-ledger-columns-slot');
    if (!slot) return;
    ensureLedgerColumnsSlotWired();
    const wasOpen = slot.querySelector('details.ledger-columns-picker')?.open;
    slot.innerHTML = `
      <details class="bank-recon-columns-picker ledger-columns-picker"${wasOpen ? ' open' : ''}>
        <summary class="btn btn-outline btn--small" title="Show or hide columns"><i class="fa-solid fa-table-columns" aria-hidden="true"></i> <span class="fdoc-action-full">Columns</span><span class="fdoc-action-short">Cols</span></summary>
        <div class="bank-recon-columns-picker__menu">
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="passbookBalance" ${visibleColumns.passbookBalance ? 'checked' : ''} />
            <span>Passbook / calculated</span>
          </label>
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="ocrRow" ${visibleColumns.ocrRow ? 'checked' : ''} />
            <span>OCR row #</span>
          </label>
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="rowOrder" ${visibleColumns.rowOrder ? 'checked' : ''} />
            <span>Row order (↑ ↓)</span>
          </label>
          <label class="bank-recon-columns-picker__option">
            <input type="checkbox" data-ledger-column-toggle="wallet" ${visibleColumns.wallet ? 'checked' : ''} />
            <span>Ledger (BANK / CASH)</span>
          </label>
        </div>
      </details>`;
};

/** @type {Map<string, object>} pending field patches keyed by transaction id (or fdoc:… for cash bills) */
const pendingEdits = new Map();

export const getLedgerPendingEdits = () => pendingEdits;

export const clearLedgerPendingEdits = () => {
    pendingEdits.clear();
    syncLedgerBulkBar();
};

const isCashBillLedgerId = (id) => String(id || '').startsWith('fdoc:');

const financeDocIdFromLedgerId = (id) => String(id || '').replace(/^fdoc:/, '');

/** Resolve a ledger row source — real txn or cash bill pseudo-row. */
const resolveLedgerRowSource = (txnId) => {
    if (!txnId) return null;
    if (isCashBillLedgerId(txnId)) {
        const docId = financeDocIdFromLedgerId(txnId);
        const d = (fnFinances().financeDocuments || []).find((x) => x.id === docId);
        if (!d) return null;
        return {
            id: txnId,
            type: d.kind === 'IN' ? 'IN' : 'OUT',
            date: String(d.doc_date || '').slice(0, 10),
            amount: parseFloat(d.amount) || 0,
            cat: d.cat,
            sub_category: d.sub_category,
            vendor_name: d.vendor_name,
            description: d.description,
            wallet: 'CASH',
            _fromFinanceDocument: true,
            finance_document_id: d.id,
        };
    }
    return fnFinances().txns.find((t) => t.id === txnId) || null;
};

const applyFinanceDocLocally = (doc) => {
    if (!doc?.id) return;
    if (!fnFinances().financeDocuments) fnFinances().financeDocuments = [];
    const list = fnFinances().financeDocuments;
    const idx = list.findIndex((d) => d.id === doc.id);
    if (idx >= 0) list[idx] = doc;
    else list.unshift(doc);
};

const mergedTxn = (txn) => ({ ...txn, ...(pendingEdits.get(txn.id) || {}) });

const isDirty = (txnId) => pendingEdits.has(txnId);

const markDirty = (txnId, patch) => {
    pendingEdits.set(txnId, { ...(pendingEdits.get(txnId) || {}), ...patch });
    syncLedgerBulkBar();
    const row = document.querySelector(`.ledger-txn-row[data-txn-id="${CSS.escape(txnId)}"]`);
    row?.classList.add('ledger-txn-row--dirty');
};

const categoryOptionsForTxnRow = (row) => {
    const isIncome = row?.dataset.lineType === 'IN';
    return buildCategoryOptions(isIncome);
};

const subCatOptionsForLedgerCategory = (catKey) => buildSubCategoryOptions(catKey);

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
    if (!txnId || isCashBillLedgerId(txnId)) return;
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

const renderSortHeader = (label, field, extraClass = '') =>
    `<button type="button" class="ledger-sort-btn ${extraClass}" data-sort="${field}" aria-sort="none">${label} <span class="ledger-sort-indicator"></span></button>`;

/** Category / vendor — display + pencil, edit with save/cancel (same as Bills & receipts). */
const renderLedgerClassifyDisplay = (t, isIncome) => {
    const catKey = t.cat ? (normalizeCategoryKey(t.cat) || t.cat) : '';
    const catLabel = catKey ? categoryDisplayLabel(catKey) : '';
    const sub = String(t.sub_category || '').trim();
    const vendor = (!isIncome && t.vendor_name && !isBankNarrationVendor(t.vendor_name, t.description))
        ? String(t.vendor_name).trim()
        : '';
    let main = catLabel || 'Set category…';
    if (!isIncome) {
        const parts = [
            catLabel,
            sub && sub.toLowerCase() !== catLabel.toLowerCase() ? sub : '',
            vendor,
        ].filter(Boolean);
        main = parts.length ? parts.join(' · ') : 'Set category…';
    }
    return `<button type="button" class="fdoc-cat-display${catLabel ? '' : ' fdoc-cat-display--empty'}" data-ledger-cat-edit="${esc(t.id)}" title="Edit category">
    <span class="fdoc-cat-display__main">${esc(main)}</span>
    <i class="fa-solid fa-pen fdoc-cat-display__pen" aria-hidden="true"></i>
  </button>`;
};

const renderLedgerClassifyCell = (t, isIncome) => `
  <div class="ledger-classify-cell fdoc-classify-cell">
    ${renderLedgerClassifyDisplay(t, isIncome)}
    <div class="fdoc-cat-editor" hidden>
      <div class="bank-recon-classify-combobox bank-recon-classify-combobox--cat">
        <input type="text" class="bank-recon-cell-input bank-recon-cat-input" placeholder="Category…" autocomplete="off" aria-label="Category" />
        <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
      </div>
      ${isIncome ? '' : `
        <div class="bank-recon-classify-combobox bank-recon-classify-combobox--sub">
          <input type="text" class="bank-recon-cell-input bank-recon-subcat-input" placeholder="Sub-category" autocomplete="off" aria-label="Sub-category" />
          <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
        </div>
        <input type="text" class="bank-recon-cell-input bank-recon-vendor-input" list="ledger-vendors" placeholder="Vendor" aria-label="Vendor" />
      `}
      <div class="fdoc-cat-editor__actions">
        <button type="button" class="btn btn-primary btn--small btn--icon" data-ledger-cat-save="${esc(t.id)}" title="Save" aria-label="Save category"><i class="fa-solid fa-check" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-outline btn--small btn--icon" data-ledger-cat-cancel="${esc(t.id)}" title="Cancel" aria-label="Cancel"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
    </div>
  </div>`;

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

/** Cash bill row from Financial Reports drill-down — editable like ledger (category drives the pivot). */
const renderCashBillPivotRow = (raw, { visibleColumns }) => {
    const t = mergedTxn(raw);
    const isIncome = t.type === 'IN';
    const lineType = isIncome ? 'IN' : 'OUT';
    const amtClass = isIncome ? ' bank-recon-amt--in' : ' bank-recon-amt--out';
    const amtLabel = `${isIncome ? '+' : '−'}${formatMoney(t.amount)}`;
    const detail = t.description || t.vendor_name || '';
    const docId = t.finance_document_id || String(t.id || '').replace(/^fdoc:/, '');
    const emptyOrder = visibleColumns.rowOrder
        ? '<td class="bank-recon-table__cell bank-recon-table__cell--order"></td>'
        : '';
    const emptyOcr = visibleColumns.ocrRow
        ? '<td class="bank-recon-table__cell bank-recon-table__cell--num">—</td>'
        : '';
    const emptyPassbook = visibleColumns.passbookBalance
        ? '<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--passbook">—</td>'
        : '';

    return `<tr class="bank-recon-table__row ledger-txn-row ledger-txn-row--cash-bill${isDirty(t.id) ? ' ledger-txn-row--dirty' : ''}" data-txn-id="${esc(t.id)}" data-fdoc-id="${esc(docId)}" data-line-type="${lineType}" data-txn-date="${esc(String(t.date || '').slice(0, 10))}">
      ${emptyOrder}
      <td class="bank-recon-table__cell bank-recon-table__cell--check">
        <input type="checkbox" class="ledger-row-check" data-txn="${esc(t.id)}" aria-label="Select row" />
      </td>
      ${emptyOcr}
      <td class="bank-recon-table__cell bank-recon-table__cell--date">
        <span class="ledger-card-date">${esc(formatDisplayDate(t.date))}</span>
        <span class="ledger-card-meta" aria-label="Status">
          <span class="ledger-card-meta__item ledger-card-meta__item--${lineType.toLowerCase()}">${isIncome ? 'Income' : 'Expense'}</span>
          <span class="ledger-card-meta__sep" aria-hidden="true">·</span>
          <span class="ledger-card-meta__item">CASH</span>
          <span class="ledger-card-meta__sep" aria-hidden="true">·</span>
          <span class="ledger-card-meta__item">Cash bill</span>
        </span>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--desc">
        <span class="ledger-desc-text">${esc(detail) || '—'}</span>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--amount${amtClass}">${amtLabel}</td>
      ${emptyPassbook}
      <td class="bank-recon-table__cell bank-recon-table__cell--type">
        <span class="bank-recon-type-badge bank-recon-type-badge--${lineType.toLowerCase()}">${isIncome ? 'Income' : 'Expense'}</span>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--classify">
        ${renderLedgerClassifyCell(t, isIncome)}
      </td>
      ${visibleColumns.wallet ? `<td class="bank-recon-table__cell bank-recon-table__cell--ledger">
        <span class="ledger-txn-chip ledger-txn-chip--wallet">CASH</span>
        <span class="ledger-recon-badge ledger-recon-badge--cash-bill" title="From Bills &amp; receipts (cash)">Cash bill</span>
      </td>` : ''}
      <td class="bank-recon-table__cell bank-recon-table__cell--bills">—</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--actions">
        <div class="bank-recon-row-actions">
          <button type="button" class="btn btn-outline btn--small btn--icon ledger-open-cash-bill" data-fdoc="${esc(docId)}" title="Open in Bills &amp; receipts" aria-label="Open in Bills"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button>
        </div>
      </td>
    </tr>`;
};

const renderPassbookBalanceCell = ({
    visibleColumns,
    passbookNum,
    ledgerCalcNum,
    showCalculated,
    needsOpening,
    balancesTrusted = true,
}) => {
    if (!visibleColumns.passbookBalance) return '';

    const passbookLabel = passbookNum != null ? formatMoney(passbookNum) : '—';
    const calcShown = showCalculated && ledgerCalcNum != null;
    const passbookMismatch = balancesTrusted
        && passbookNum != null
        && ledgerCalcNum != null
        && Math.abs(ledgerCalcNum - passbookNum) > 0.01;
    const mismatchClass = passbookMismatch ? ' bank-recon-balance--mismatch' : '';
    const calcTitle = !showCalculated
        ? 'Calculated balance hidden while ledger filters are active'
        : (!balancesTrusted
            ? 'Ledger calculated may be stale — click Recalculate'
            : (calcShown
                ? (passbookMismatch
                    ? `Ledger calculated ${formatMoney(ledgerCalcNum)} ≠ passbook ${formatMoney(passbookNum)}`
                    : 'Passbook balance; calculated running balance in parentheses')
                : (needsOpening ? 'Set opening balance to calculate' : 'Passbook balance from matched statement line')));
    const calcHtml = calcShown
        ? `<span class="ledger-passbook-calc${balancesTrusted ? '' : ' ledger-passbook-calc--stale'}" title="Ledger calculated running balance">(${esc(formatMoney(ledgerCalcNum))})</span>`
        : '';
    const warnIcon = passbookMismatch
        ? '<i class="fa-solid fa-triangle-exclamation bank-recon-mismatch-icon" aria-hidden="true"></i>'
        : '';

    return `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--passbook${mismatchClass}" title="${esc(calcTitle)}">
      <span class="ledger-passbook-stack">
        <span class="ledger-passbook-main">${passbookLabel}</span>
        ${calcHtml}
      </span>${warnIcon}
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
    showCalculated,
    balancesTrusted = true,
}) => {
    if (raw?._fromFinanceDocument) {
        return renderCashBillPivotRow(raw, { visibleColumns });
    }
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
    const linkedDocs = linkedFinanceDocsForTxn(t.id);
    const linkedBillsCell = linkedDocs.length
        ? `<button type="button" class="btn btn--icon ledger-linked-bills-btn" data-txn="${t.id}" title="${linkedDocs.length} linked bill(s)/receipt(s)" aria-label="View linked bills">
            <i class="fa-solid fa-file-invoice" aria-hidden="true"></i>
            <span class="ledger-linked-bills-btn__count">${linkedDocs.length}</span>
          </button>`
        : '<span class="ledger-linked-bills-empty">—</span>';
    const detail = formatTxnDetail(t);
    const descText = esc(t.description || detail || '—');
    const amtClass = isIncome ? ' bank-recon-amt--in' : ' bank-recon-amt--out';
    const amtLabel = `${isIncome ? '+' : '−'}${formatMoney(t.amount)}`;

    const ledgerCalcNum = showCalculated && isBank && runningBalances.has(t.id)
        ? runningBalances.get(t.id)
        : null;
    const passbookNum = stmt.passbookBalance;
    const passbookMismatch = balancesTrusted
        && passbookNum != null
        && ledgerCalcNum != null
        && Math.abs(ledgerCalcNum - passbookNum) > 0.01;
    const passbookCell = renderPassbookBalanceCell({
        visibleColumns,
        passbookNum,
        ledgerCalcNum,
        showCalculated,
        needsOpening,
        balancesTrusted,
    });
    const ocrCell = visibleColumns.ocrRow
        ? `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--ocr" title="OCR / statement row sequence">${formatOcrRowDisplay(stmt.line) ?? '—'}</td>`
        : '';

    return `<tr class="bank-recon-table__row ledger-txn-row${isDirty(t.id) ? ' ledger-txn-row--dirty' : ''}${passbookMismatch ? ' bank-recon-table__row--mismatch' : ''}" data-txn-id="${t.id}" data-line-type="${lineType}" data-txn-date="${esc(String(t.date || '').slice(0, 10))}">
      ${visibleColumns.rowOrder ? renderLedgerOrderButtons(t.id, orderMeta) : ''}
      <td class="bank-recon-table__cell bank-recon-table__cell--check">
        <input type="checkbox" class="ledger-row-check" data-txn="${t.id}" aria-label="Select row" />
      </td>
      ${ocrCell}
      <td class="bank-recon-table__cell bank-recon-table__cell--date">
        <span class="ledger-card-date">${esc(formatDisplayDate(t.date))}</span>
        <span class="ledger-card-meta" aria-label="Status">
          <span class="ledger-card-meta__item ledger-card-meta__item--${lineType.toLowerCase()}">${isIncome ? 'Income' : 'Expense'}</span>
          <span class="ledger-card-meta__sep" aria-hidden="true">·</span>
          <span class="ledger-card-meta__item">${esc(t.wallet || '—')}</span>
          ${reconciled
            ? '<span class="ledger-card-meta__sep" aria-hidden="true">·</span><span class="ledger-card-meta__item ledger-card-meta__item--ok">Reconciled</span>'
            : (isBank ? '<span class="ledger-card-meta__sep" aria-hidden="true">·</span><span class="ledger-card-meta__item ledger-card-meta__item--open">Unreconciled</span>' : '')}
          ${t.exclude_from_reports
            ? '<span class="ledger-card-meta__sep" aria-hidden="true">·</span><span class="ledger-card-meta__item ledger-card-meta__item--warn">No reports</span>'
            : ''}
        </span>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--desc">
        <span class="ledger-desc-text" title="${descText}">${descText}</span>
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--amount${amtClass}">${amtLabel}</td>
      ${passbookCell}
      <td class="bank-recon-table__cell bank-recon-table__cell--type">
        <span class="bank-recon-type-badge bank-recon-type-badge--${lineType.toLowerCase()}">${isIncome ? 'Income' : 'Expense'}</span>
        ${!visibleColumns.wallet ? `${reportsBadge}${reconBadge}` : ''}
      </td>
      <td class="bank-recon-table__cell bank-recon-table__cell--classify">
        ${renderLedgerClassifyCell(t, isIncome)}
      </td>
      ${visibleColumns.wallet ? `<td class="bank-recon-table__cell bank-recon-table__cell--ledger">
        <span class="ledger-txn-chip ledger-txn-chip--wallet">${esc(t.wallet)}</span>
        ${reportsBadge}
        ${reconBadge}
      </td>` : ''}
      <td class="bank-recon-table__cell bank-recon-table__cell--bills">${linkedBillsCell}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--actions">
        <div class="bank-recon-row-actions">
          ${receiptBtn}
          <button type="button" class="btn btn-outline btn--small btn--icon ledger-cash-float-btn" data-txn="${t.id}" title="${t.is_cash_float ? 'Remove from Petty Cash float buckets' : (t.exclude_from_cash_float ? 'Add back to Petty Cash float buckets' : 'Mark as cash float (Petty Cash funding)')}" aria-label="Cash float">${t.is_cash_float || (isBankPettyFunding(t) && !t.exclude_from_cash_float) ? '<i class="fa-solid fa-wallet" aria-hidden="true"></i>' : '<i class="fa-regular fa-wallet" aria-hidden="true"></i>'}</button>
          <button type="button" class="btn btn-outline btn--small btn--icon ledger-exclude-btn" data-txn="${t.id}" title="Remove from ledger (move to excluded)" aria-label="Remove from ledger"><i class="fa-solid fa-box-archive" aria-hidden="true"></i></button>
          <button type="button" class="btn btn-outline btn--small btn--icon ledger-bill-btn" data-txn="${t.id}" title="Bill / receipt — create, link, or edit" aria-label="Bill or receipt"><i class="fa-solid fa-file-invoice" aria-hidden="true"></i></button>
          <button type="button" class="btn btn-outline btn--small btn--icon" onclick="window.editTxn('${t.id}')" title="Edit ledger line" aria-label="Edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          ${canDeleteAccounts()
            ? `<button type="button" class="btn btn-outline btn--small btn--icon btn--danger" onclick="window.delTxn('${t.id}')" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`
            : ''}
        </div>
      </td>
    </tr>`;
};

const initRowClassifyValues = (row) => {
    const txnId = row.dataset.txnId;
    const raw = resolveLedgerRowSource(txnId);
    if (!raw) return;
    const t = mergedTxn(raw);

    const catInput = row.querySelector('.bank-recon-cat-input');
    if (catInput) {
        if (t.cat) {
            const key = normalizeCategoryKey(t.cat) || t.cat;
            catInput.value = key;
            const options = categoryOptionsForTxnRow(row);
            setClassifyInputState(catInput, isExactListMatch(key, options) ? 'known' : 'custom');
        } else {
            catInput.value = '';
            setClassifyInputState(catInput, '');
        }
    }

    const subInput = row.querySelector('.bank-recon-subcat-input');
    if (subInput) {
        if (t.sub_category) {
            subInput.value = t.sub_category;
            const options = subCatOptionsForLedgerCategory(resolvedCategoryForLedgerRow(row));
            setClassifyInputState(subInput, isExactListMatch(t.sub_category, options) ? 'known' : 'custom');
        } else {
            subInput.value = '';
            setClassifyInputState(subInput, '');
        }
    }

    const vendorInput = row.querySelector('.bank-recon-vendor-input');
    if (vendorInput) {
        vendorInput.value = (t.vendor_name && !isBankNarrationVendor(t.vendor_name, t.description))
            ? t.vendor_name
            : '';
    }
};

const closeAllLedgerCatEditors = (exceptId = null) => {
    document.querySelectorAll('#fn-cash-ledger-items tr.ledger-txn-row').forEach((row) => {
        if (exceptId && row.dataset.txnId === exceptId) return;
        row.classList.remove('ledger-txn-row--classify-open');
        const editor = row.querySelector('.fdoc-cat-editor');
        if (editor) editor.hidden = true;
    });
};

const openLedgerCatEditor = (txnId) => {
    const row = document.querySelector(`#fn-cash-ledger-items tr.ledger-txn-row[data-txn-id="${CSS.escape(txnId)}"]`);
    if (!row) return;
    closeAllLedgerCatEditors(txnId);
    row.classList.add('ledger-txn-row--classify-open');
    const editor = row.querySelector('.fdoc-cat-editor');
    if (editor) editor.hidden = false;

    // Wire first, then populate — avoids combobox handlers wiping loaded values.
    if (!row.dataset.classifyWired) {
        row.dataset.classifyWired = '1';
        const catWrap = row.querySelector('.bank-recon-classify-combobox--cat');
        if (catWrap) {
            wireClassifyCombobox(catWrap, {
                getOptions: () => categoryOptionsForTxnRow(row),
                onCustomSelect: (value) => {
                    registerCustomCategory(value, row.dataset.lineType === 'IN');
                },
                onKnownSelect: (value) => {
                    const subInput = row.querySelector('.bank-recon-subcat-input');
                    const prev = row.dataset.classifyCatSnapshot || '';
                    // Only clear sub when the user actually changes category
                    if (subInput && String(value || '') !== prev) {
                        subInput.value = '';
                        setClassifyInputState(subInput, '');
                    }
                    row.dataset.classifyCatSnapshot = String(value || '');
                    syncLedgerRowExcludeForCategory(row);
                },
            });
        }
        const subWrap = row.querySelector('.bank-recon-classify-combobox--sub');
        if (subWrap) {
            wireClassifyCombobox(subWrap, {
                getOptions: () => subCatOptionsForLedgerCategory(resolvedCategoryForLedgerRow(row)),
                onCustomSelect: (value) => {
                    registerCustomSubCategory(resolvedCategoryForLedgerRow(row), value);
                },
            });
        }
    }

    initRowClassifyValues(row);
    row.dataset.classifyCatSnapshot = row.querySelector('.bank-recon-cat-input')?.value?.trim() || '';

    // Focus first empty classify field so sub/vendor stay visible
    const catInput = row.querySelector('.bank-recon-cat-input');
    const subInput = row.querySelector('.bank-recon-subcat-input');
    const vendorInput = row.querySelector('.bank-recon-vendor-input');
    if (subInput && !subInput.value.trim()) subInput.focus();
    else if (vendorInput && !vendorInput.value.trim()) vendorInput.focus();
    else catInput?.focus();
};

const saveLedgerClassifyRow = async (row) => {
    const txnId = row?.dataset?.txnId;
    if (!txnId || row.dataset.classifySaving === '1') return;

    const existing = resolveLedgerRowSource(txnId);
    if (!existing) return;

    syncLedgerRowExcludeForCategory(row);
    const patch = readRowPatch(row);
    const nextCat = patch.cat || existing.cat || '';
    const nextSub = patch.sub_category || null;
    const nextVendor = Object.prototype.hasOwnProperty.call(patch, 'vendor_name')
        ? patch.vendor_name
        : existing.vendor_name;
    const prevVendor = isBankNarrationVendor(existing.vendor_name, existing.description)
        ? null
        : (existing.vendor_name || null);

    const unchanged = nextCat === (existing.cat || '')
        && (nextSub || null) === (existing.sub_category || null)
        && (nextVendor || null) === (prevVendor || null);

    if (unchanged) {
        closeAllLedgerCatEditors();
        return;
    }

    if (!isCashBillLedgerId(txnId)
        && (patch.cat === BANK_REJECT_CAT || defaultExcludeFromReports(patch.cat))) {
        patch.exclude_from_reports = true;
    }
    markDirty(txnId, patch);

    row.dataset.classifySaving = '1';
    row.classList.add('ledger-txn-row--saving');
    const saveBtn = row.querySelector('[data-ledger-cat-save]');
    try {
        await withButtonBusy(saveBtn, '…', async () => {
            setLedgerBulkSaving(true, 'Saving category…');
            await saveLedgerPendingEdits([txnId]);
            refreshAfterLedgerSave({ analytics: true });
        });
    } catch (err) {
        alert(err?.message || 'Could not save category.');
    } finally {
        delete row.dataset.classifySaving;
        row.classList.remove('ledger-txn-row--saving');
        setLedgerBulkSaving(false);
    }
};

/** Running balances for the Passbook / calculated cell — stored when trusted, else client walk. */
function ledgerRunningBalancesForDisplay(showCalculated) {
    if (!showCalculated) return new Map();
    const chron = sortLedgerTxnsChronological(getActiveLedgerTxns());
    const clientById = annotateLedgerRunningBalancesInOrder(chron).byId;
    const storedById = storedLedgerRunningById();
    const balanceMeta = getLedgerBalanceMeta();
    if (balanceMeta.needsRecalc || storedById.size === 0) return clientById;
    // Prefer persisted values; fill any gaps from the client walk.
    const merged = new Map(clientById);
    for (const [id, n] of storedById) merged.set(id, n);
    return merged;
}

export const renderEditableLedgerRows = (txns, { formatTxnDetail, getAllAttachmentPaths }) => {
    const list = document.getElementById('fn-cash-ledger-items');
    if (!list) return;

    const visibleColumns = { ...ledgerVisibleColumns };
    // Running balance: prefer persisted running_balance_after; fall back to client walk.
    // Blank under filters so filtered subsets do not show a misleading partial roll-forward.
    const showCalculated = !ledgerHasActiveFilters();
    const balanceMeta = getLedgerBalanceMeta();
    const balancesTrusted = showCalculated && !balanceMeta.needsRecalc;
    const runningBalances = ledgerRunningBalancesForDisplay(showCalculated);
    const opening = getBankOpeningConfig();
    const statementCtx = buildLedgerStatementContext();
    const orderMeta = buildSameDayLedgerOrderMeta(statementCtx);
    const passbookHeaderHint = !showCalculated
        ? ' title="Passbook balance (calculated hidden while filters are active)"'
        : (balanceMeta.needsRecalc
            ? ' title="Passbook / calculated — ledger calculated may be stale; click Recalculate"'
            : ' title="Passbook balance; ledger calculated running balance in parentheses"');
    const rowOpts = {
        formatTxnDetail,
        getAllAttachmentPaths,
        visibleColumns,
        runningBalances,
        needsOpening: showCalculated && opening.amount == null,
        statementCtx,
        orderMeta,
        showCalculated,
        balancesTrusted,
    };

    const paint = () => {
        if (!txns.length) {
            mountLedgerColumnsPicker(visibleColumns);
            list.innerHTML = '<p class="maintenance-dues-empty">No transactions match your filters.</p>';
            syncLedgerBulkBar();
            return;
        }

        const vendorDatalist = (fnFinances().vendors || [])
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
                ${visibleColumns.ocrRow ? '<th class="bank-recon-table__th--num bank-recon-table__th--ocr" title="OCR / statement row sequence">OCR #</th>' : ''}
                <th class="bank-recon-table__th--date">${renderSortHeader('Date', 'date')}</th>
                <th class="bank-recon-table__th--desc">Description</th>
                <th class="bank-recon-table__th--num">${renderSortHeader('Amount', 'amount', 'ledger-sort-btn--num')}</th>
                ${visibleColumns.passbookBalance ? `<th class="bank-recon-table__th--num"${passbookHeaderHint}>${renderSortHeader('Passbook / calc', 'passbook', 'ledger-sort-btn--num')}</th>` : ''}
                <th class="bank-recon-table__th--type">Type</th>
                <th class="bank-recon-table__th--classify">${renderSortHeader('Category / vendor', 'cat')}</th>
                ${visibleColumns.wallet ? `<th class="bank-recon-table__th--ledger">${renderSortHeader('Ledger', 'wallet')}</th>` : ''}
                <th class="bank-recon-table__th--bills" title="Bills & receipts linked to this ledger row">Bills</th>
                <th class="bank-recon-table__th--actions"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;

        wireLedgerTableEvents();
        syncLedgerBulkBar();
    };

    paint();
    const txnIds = (txns || []).map((t) => t?.id).filter(Boolean);
    if (txnIds.length) {
        void import('./financeDocuments.js')
            .then((m) => m.ensureFinanceDocsForTransactions(txnIds))
            .then((docs) => {
                if (docs?.length) paint();
            })
            .catch((err) => console.warn('[ledger] linked bills prefetch:', err?.message || err));
    }
};

const renderExcludedRow = (t, { formatTxnDetailPlain }) => {
    const isIncome = t.type === 'IN';
    const amtLabel = `${isIncome ? '+' : '−'}${formatMoney(t.amount)}`;
    const amtClass = isIncome ? ' bank-recon-amt--in' : ' bank-recon-amt--out';
    const detail = formatTxnDetailPlain
        ? formatTxnDetailPlain(t)
        : (t.description || t.cat || '—');
    return `<tr class="bank-recon-table__row bank-recon-table__row--readonly ledger-excluded-row" data-txn-id="${t.id}">
      <td class="bank-recon-table__cell bank-recon-table__cell--date">${esc(formatDisplayDate(t.date))}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--desc">${esc(detail)}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--num${amtClass}">${amtLabel}</td>
      <td class="bank-recon-table__cell">${esc(t.cat || '')}</td>
      <td class="bank-recon-table__cell">${esc(t.wallet || '')}</td>
      <td class="bank-recon-table__cell bank-recon-table__cell--actions">
        <button type="button" class="btn btn-outline btn--small ledger-restore-btn" data-txn="${t.id}" title="Restore to ledger">Restore</button>
      </td>
    </tr>`;
};

export const renderExcludedLedgerSection = ({ formatTxnDetailPlain } = {}) => {
    const host = document.getElementById('fn-ledger-excluded-items');
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
                <th class="bank-recon-table__th--num">Amount</th>
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
    await postFnMutation('setLedgerExclusion', {
        transaction_id: txnId,
        excluded_from_ledger: excluded,
    });
    const idx = fnFinances().txns.findIndex((t) => t.id === txnId);
    if (idx >= 0) {
        fnFinances().txns[idx] = { ...fnFinances().txns[idx], excluded_from_ledger: excluded };
    }
    pendingEdits.delete(txnId);
}

const selectedTxnIds = () =>
    [...document.querySelectorAll('.ledger-row-check:checked')].map((el) => el.dataset.txn).filter(Boolean);

let bulkStatusTimer = null;

const setLedgerBulkSaving = (saving, statusText = '') => {
    const bar = document.getElementById('fn-ledger-bulk-bar');
    if (!bar) return;
    bar.classList.toggle('ledger-bulk-bar--busy', saving);
    bar.querySelectorAll('select, button:not(#fn-ledger-bulk-save)').forEach((el) => {
        el.disabled = saving;
    });
    const countEl = bar.querySelector('#fn-ledger-bulk-count');
    if (countEl && saving && statusText) {
        countEl.textContent = statusText;
        countEl.classList.add('ledger-bulk-bar__status--busy');
    }
};

const flashBulkStatus = (message, ms = 2800) => {
    const countEl = document.getElementById('fn-ledger-bulk-count');
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
    const bar = document.getElementById('fn-ledger-bulk-bar');
    if (!bar || bar.classList.contains('ledger-bulk-bar--busy')) return;
    const selected = selectedTxnIds();
    const dirtyCount = pendingEdits.size;
    const showBar = selected.length > 0 || dirtyCount > 0;
    bar.hidden = !showBar;
    const countEl = bar.querySelector('#fn-ledger-bulk-count');
    const saveBtn = bar.querySelector('#fn-ledger-bulk-save');
    const applyBtn = bar.querySelector('#fn-ledger-bulk-apply');
    const deleteBtn = bar.querySelector('#fn-ledger-bulk-delete');
    if (countEl && !countEl.classList.contains('ledger-bulk-bar__status--flash')) {
        const parts = [];
        if (selected.length) parts.push(`${selected.length} selected`);
        if (dirtyCount) parts.push(`${dirtyCount} unsaved`);
        countEl.textContent = parts.length ? parts.join(' · ') : 'Select rows to bulk edit';
    }
    if (saveBtn && saveBtn.dataset.busy !== '1') saveBtn.disabled = dirtyCount === 0;
    if (applyBtn) applyBtn.disabled = selected.length === 0;
    if (deleteBtn) {
        const allowDelete = canDeleteAccounts();
        deleteBtn.hidden = !allowDelete;
        deleteBtn.disabled = !allowDelete || selected.length === 0;
    }
    const headerAll = document.getElementById('fn-ledger-header-select-all');
    const checks = [...document.querySelectorAll('.ledger-row-check')];
    if (headerAll && checks.length) {
        headerAll.checked = checks.every((c) => c.checked);
        headerAll.indeterminate = checks.some((c) => c.checked) && !headerAll.checked;
    }
};

const readRowPatch = (row) => {
    const txnId = row?.dataset?.txnId;
    const raw = txnId ? resolveLedgerRowSource(txnId) : null;
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
    if (!raw?._fromFinanceDocument) {
        const pending = txnId ? pendingEdits.get(txnId) : null;
        if (pending && 'exclude_from_reports' in pending) {
            patch.exclude_from_reports = pending.exclude_from_reports;
        } else if (raw) {
            patch.exclude_from_reports = !!raw.exclude_from_reports;
        }
    }
    return patch;
};

const applyLocalTxnPatches = (updates) => {
    for (const { id, fields } of updates) {
        const idx = fnFinances().txns.findIndex((t) => t.id === id);
        if (idx >= 0) {
            fnFinances().txns[idx] = { ...fnFinances().txns[idx], ...fields };
        }
    }
};

const saveCashBillFields = async (ledgerId, fields) => {
    const docId = financeDocIdFromLedgerId(ledgerId);
    const existing = (fnFinances().financeDocuments || []).find((d) => d.id === docId);
    if (!existing) throw new Error('Cash bill not found.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('Select an apartment first.');

    const next = {
        ...existing,
        ...(fields.cat !== undefined ? { cat: fields.cat } : {}),
        ...(fields.sub_category !== undefined ? { sub_category: fields.sub_category } : {}),
        ...(fields.vendor_name !== undefined ? { vendor_name: fields.vendor_name } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
    };

    const result = await postFnMutation('saveFinanceDocument', {
        apartment_id,
        document: next,
        keepAttachments: Array.isArray(existing.attachment_urls) ? existing.attachment_urls : [],
        removeAttachments: [],
        newAttachmentFiles: [],
    });
    if (result.document) {
        applyFinanceDocLocally(result.document);
        if (result.document.sub_category && result.document.cat && result.document.kind !== 'IN') {
            if (!fnFinances().subCategories) fnFinances().subCategories = [];
            const exists = fnFinances().subCategories.some(
                (r) => r.category === result.document.cat && r.name === result.document.sub_category,
            );
            if (!exists) {
                fnFinances().subCategories.push({
                    category: result.document.cat,
                    name: result.document.sub_category,
                });
            }
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
    if (!ids.length) return { updated: 0, balanceChanged: false, cashBillsUpdated: false };

    const updates = ids
        .filter((id) => pendingEdits.has(id))
        .map((id) => ({ id, fields: pendingEdits.get(id) }));

    if (!updates.length) return { updated: 0, balanceChanged: false, cashBillsUpdated: false };

    const billUpdates = updates.filter(({ id }) => isCashBillLedgerId(id));
    const txnUpdates = updates.filter(({ id }) => !isCashBillLedgerId(id));

    const balanceChanged = txnUpdates.some(({ fields }) => patchAffectsLedgerBalance(fields));
    let updated = 0;

    if (txnUpdates.length) {
        const result = await postFnMutation('bulkUpdateTransactions', { updates: txnUpdates });
        applyLocalTxnPatches(txnUpdates);
        updated += result.updated || txnUpdates.length;
        txnUpdates.forEach(({ id }) => pendingEdits.delete(id));
    }

    for (const { id, fields } of billUpdates) {
        await saveCashBillFields(id, fields);
        pendingEdits.delete(id);
        updated += 1;
    }

    return { updated, balanceChanged, cashBillsUpdated: billUpdates.length > 0 };
};

const applyBulkToSelected = () => {
    const ids = selectedTxnIds();
    if (!ids.length) {
        setLedgerActivity('Select rows first, then click Apply to selected', { flashMs: 3500 });
        return;
    }

    const cat = document.getElementById('fn-ledger-bulk-cat')?.value?.trim();
    const excludeMode = document.getElementById('fn-ledger-bulk-exclude')?.value || 'nochange';
    if (!cat && excludeMode === 'nochange') {
        setLedgerActivity('Choose a category or reports option first', { flashMs: 3500 });
        return;
    }

    ids.forEach((id) => {
        const row = document.querySelector(`.ledger-txn-row[data-txn-id="${CSS.escape(id)}"]`);
        const patch = { ...(pendingEdits.get(id) || {}) };
        const isBill = isCashBillLedgerId(id);
        if (cat) {
            patch.cat = cat;
            if (!isBill && (cat === BANK_REJECT_CAT || defaultExcludeFromReports(cat))) {
                patch.exclude_from_reports = true;
            }
            const catInput = row?.querySelector('.bank-recon-cat-input');
            if (catInput) {
                catInput.value = cat;
                setClassifyInputState(catInput, 'known');
            }
            const displayMain = row?.querySelector('.fdoc-cat-display__main');
            const displayBtn = row?.querySelector('.fdoc-cat-display');
            if (displayMain) {
                displayMain.textContent = categoryDisplayLabel(cat) || cat;
            }
            displayBtn?.classList.toggle('fdoc-cat-display--empty', !cat);
        }
        if (!isBill) {
            if (excludeMode === 'exclude') patch.exclude_from_reports = true;
            if (excludeMode === 'include') patch.exclude_from_reports = false;
        }
        pendingEdits.set(id, patch);
        row?.classList.add('ledger-txn-row--dirty');
    });
    syncLedgerBulkBar();
    setLedgerActivity(
        `Staged ${ids.length} row${ids.length === 1 ? '' : 's'} — click Save changes`,
        { flashMs: 3500 },
    );
};

const LEDGER_EVENTS_VERSION = 'ledger-events-v8';

export const wireLedgerTableEvents = () => {
    syncLedgerBulkBar();

    const list = document.getElementById('fn-cash-ledger-items');
    if (!list) return;

    // Rebind when handler version changes (avoids stale HMR listeners with no ↑ ↓ handlers).
    if (list.dataset.editWired === LEDGER_EVENTS_VERSION) return;
    if (list._ledgerOnClick) {
        list.removeEventListener('click', list._ledgerOnClick);
        list.removeEventListener('change', list._ledgerOnChange);
        list.removeEventListener('input', list._ledgerOnInput);
    }
    list.dataset.editWired = LEDGER_EVENTS_VERSION;

    list._ledgerOnChange = (e) => {
        const row = e.target.closest('.ledger-txn-row');
        if (!row) return;
        if (e.target.matches('.ledger-row-check')) {
            syncLedgerBulkBar();
        }
    };

    list._ledgerOnInput = () => {};

    list._ledgerOnClick = async (e) => {
        if (e.target.closest('.ledger-move-step')) {
            e.stopPropagation();
        }

        const catEditId = e.target.closest('[data-ledger-cat-edit]')?.dataset?.ledgerCatEdit;
        if (catEditId) {
            e.preventDefault();
            e.stopPropagation();
            openLedgerCatEditor(catEditId);
            return;
        }

        const catSaveId = e.target.closest('[data-ledger-cat-save]')?.dataset?.ledgerCatSave;
        if (catSaveId) {
            e.preventDefault();
            e.stopPropagation();
            const row = document.querySelector(`#fn-cash-ledger-items tr.ledger-txn-row[data-txn-id="${CSS.escape(catSaveId)}"]`);
            if (row) await saveLedgerClassifyRow(row);
            return;
        }

        const catCancelId = e.target.closest('[data-ledger-cat-cancel]')?.dataset?.ledgerCatCancel;
        if (catCancelId) {
            e.preventDefault();
            e.stopPropagation();
            closeAllLedgerCatEditors();
            return;
        }

        const moveBtn = e.target.closest('.ledger-move-up, .ledger-move-down');
        if (moveBtn) {
            e.preventDefault();
            e.stopPropagation();
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
                console.error('Ledger row reorder failed', err);
                alert(err?.message || 'Could not reorder row.');
            }
            return;
        }

        const openCashBillBtn = e.target.closest('.ledger-open-cash-bill');
        if (openCashBillBtn) {
            e.preventDefault();
            const docId = openCashBillBtn.dataset.fdoc;
            const { focusFinanceDocument } = await import('./financeDocuments.js');
            await focusFinanceDocument(docId);
            return;
        }

        const cashFloatBtn = e.target.closest('.ledger-cash-float-btn');
        if (cashFloatBtn && cashFloatBtn.dataset.busy !== '1') {
            const txnId = cashFloatBtn.dataset.txn;
            if (!txnId) return;
            const raw = fnFinances().txns.find((txn) => txn.id === txnId);
            // Active float = explicit mark, or auto bank Petty Cash (not excluded).
            const isActive = !!(raw?.is_cash_float && !raw?.exclude_from_cash_float)
                || isBankPettyFunding(raw);
            const next = !isActive;
            try {
                await withButtonBusy(cashFloatBtn, '…', async () => {
                    const { markLedgerAsCashFloat } = await import('./financeDocuments.js');
                    await markLedgerAsCashFloat(txnId, next);
                    refreshAfterLedgerSave();
                });
            } catch (err) {
                alert(err?.message || 'Could not update cash float mark.');
            }
            return;
        }

        const linkedBillsBtn = e.target.closest('.ledger-linked-bills-btn');
        if (linkedBillsBtn) {
            e.preventDefault();
            openLinkedBillsForLedgerTxn(linkedBillsBtn.dataset.txn);
            return;
        }
        const billBtn = e.target.closest('.ledger-bill-btn');
        if (billBtn) {
            e.preventDefault();
            void withButtonBusy(billBtn, '…', async () => {
                await openBillReceiptForLedgerTxn(billBtn.dataset.txn, billBtn);
            }).catch((err) => alert(err?.message || 'Could not open bill/receipt.'));
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
    };

    list.addEventListener('change', list._ledgerOnChange);
    list.addEventListener('input', list._ledgerOnInput);
    list.addEventListener('click', list._ledgerOnClick);
};

const populateBulkCategorySelect = () => {
    const sel = document.getElementById('fn-ledger-bulk-cat');
    if (!sel) return;
    const escOpt = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const { income, expense } = buildCategoryOptionGroups();
    sel.innerHTML = [
        '<option value="">Set category…</option>',
        `<optgroup label="Income">${income.map((c) => `<option value="${escOpt(c)}">${escOpt(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
        `<optgroup label="Expenses">${expense.map((c) => `<option value="${escOpt(c)}">${escOpt(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
    ].join('');
};

export const initLedgerBulkBar = () => {
    populateBulkCategorySelect();
    if (document.body.dataset.ledgerBulkBarWired === '1') return;
    document.body.dataset.ledgerBulkBarWired = '1';

    if (!document.body.dataset.ledgerClassifyDismissWired) {
        document.body.dataset.ledgerClassifyDismissWired = '1';
        document.addEventListener('click', (e) => {
            if (e.target.closest('.ledger-classify-cell, .bank-recon-classify-combobox__menu')) return;
            if (!document.querySelector('#fn-cash-ledger-items tr.ledger-txn-row--classify-open')) return;
            closeAllLedgerCatEditors();
        });
    }

    const setAllSelected = (on) => {
        document.querySelectorAll('.ledger-row-check').forEach((c) => { c.checked = on; });
        const headerAll = document.getElementById('fn-ledger-header-select-all');
        if (headerAll) headerAll.checked = on;
        syncLedgerBulkBar();
    };

    document.getElementById('fn-cash-ledger-items')?.addEventListener('change', (e) => {
        if (e.target.id === 'ledger-header-select-all') setAllSelected(e.target.checked);
    });

    document.getElementById('fn-ledger-bulk-apply')?.addEventListener('click', () => {
        withButtonBusy(document.getElementById('fn-ledger-bulk-apply'), 'Applying…', async () => {
            applyBulkToSelected();
        });
    });

    document.getElementById('fn-ledger-bulk-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('fn-ledger-bulk-save');
        if (!pendingEdits.size || btn?.dataset.busy === '1') return;
        const count = pendingEdits.size;
        try {
            await withButtonBusy(btn, 'Saving…', async () => {
                setLedgerBulkSaving(true, `Saving ${count} row${count === 1 ? '' : 's'}…`);
                const { updated, cashBillsUpdated } = await saveLedgerPendingEdits();
                refreshAfterLedgerSave({ analytics: !!cashBillsUpdated });
                if (updated) flashBulkStatus(`Saved ${updated} row${updated === 1 ? '' : 's'}.`);
            });
        } catch (err) {
            alert(err?.message || 'Bulk save failed.');
            syncLedgerBulkBar();
        } finally {
            setLedgerBulkSaving(false);
        }
    });

    document.getElementById('fn-ledger-bulk-delete')?.addEventListener('click', async () => {
        const btn = document.getElementById('fn-ledger-bulk-delete');
        if (!canDeleteAccounts()) {
            alert('You do not have permission to delete ledger entries.');
            return;
        }
        const ids = selectedTxnIds();
        if (!ids.length || btn?.dataset.busy === '1') return;
        const billIds = ids.filter((id) => isCashBillLedgerId(id));
        const txnIds = ids.filter((id) => !isCashBillLedgerId(id));
        if (billIds.length && !txnIds.length) {
            alert('Cash bills can’t be deleted from the ledger. Open them in Bills & receipts to delete.');
            return;
        }
        const confirmMsg = billIds.length
            ? `Permanently delete ${txnIds.length} ledger entr${txnIds.length === 1 ? 'y' : 'ies'}?\n\n(${billIds.length} cash bill${billIds.length === 1 ? '' : 's'} will be skipped — delete those in Bills & receipts.)`
            : `Permanently delete ${txnIds.length} ledger entr${txnIds.length === 1 ? 'y' : 'ies'}? This cannot be undone.`;
        if (!confirm(confirmMsg)) return;
        try {
            await withButtonBusy(btn, 'Deleting…', async () => {
                setLedgerBulkSaving(true, `Deleting ${txnIds.length}…`);
                await postFnMutation('deleteTransactions', { transaction_ids: txnIds });
                txnIds.forEach((id) => pendingEdits.delete(id));
                removeTransactionsLocally(txnIds);
                refreshAfterLedgerSave({ analytics: true });
                flashBulkStatus(`Deleted ${txnIds.length} row${txnIds.length === 1 ? '' : 's'}.`);
            });
        } catch (err) {
            alert(err?.message || 'Bulk delete failed.');
            syncLedgerBulkBar();
        } finally {
            setLedgerBulkSaving(false);
        }
    });
};
