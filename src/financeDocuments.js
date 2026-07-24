/**
 * Bills & receipts — supporting vouchers with R2 attachments, linked to ledger lines.
 * Cash spends link 1→many to a Petty Cash / cash-float funding ledger line.
 */
import ExcelJS from 'exceljs';
import { portalState } from './store.js';
import {
  EXPENSE_CATS,
  INCOME_CATS,
  normalizeCategoryKey,
  categoryDisplayLabel,
  SUB_CAT_SUGGESTIONS,
} from './expenseCategories.js';
import { postFinanceMutation, filesToBase64Payload } from './financeApi.js';
import { withButtonBusy } from './buttonBusy.js';
import { applySavedTransactionLocally } from './ledgerTxnLocal.js';
import { computeCashFloatStore, isBankPettyFunding } from './cashFloat.js';
import {
  wireClassifyCombobox,
  setClassifyInputState,
  isExactListMatch,
} from './classifyCombobox.js';

const formatMoney = (n) =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const todayISO = () => new Date().toISOString().slice(0, 10);

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/"/g, '&quot;');

export const getFinanceDocuments = () =>
  (portalState.finances.financeDocuments || []).filter((d) => d.status !== 'void');

/** Open (unlinked) expense bills — proposed / not yet posted to ledger. */
export const getOpenExpenseDocuments = () =>
  getFinanceDocuments().filter((d) => d.kind === 'OUT' && d.status === 'open');

/** Open Bills & receipts filtered to unlinked expenses. */
export const focusOpenExpenseBills = () => {
  docsReportFilter = null;
  filterState.kind = 'OUT';
  filterState.status = 'open';
  filterState.pay = 'all';
  filterState.q = '';
  const kindEl = document.getElementById('fdoc-filter-kind');
  const statusEl = document.getElementById('fdoc-filter-status');
  const payEl = document.getElementById('fdoc-filter-pay');
  const searchEl = document.getElementById('fdoc-search');
  if (kindEl) kindEl.value = 'OUT';
  if (statusEl) statusEl.value = 'open';
  if (payEl) payEl.value = 'all';
  if (searchEl) searchEl.value = '';
  renderFdocReportBanner();
  window.switchView?.('finance-docs');
  renderFinanceDocumentsPage();
};

const applyDocLocally = (doc) => {
  if (!portalState.finances.financeDocuments) portalState.finances.financeDocuments = [];
  const list = portalState.finances.financeDocuments;
  const idx = list.findIndex((d) => d.id === doc.id);
  if (idx >= 0) list[idx] = doc;
  else list.unshift(doc);
};

const removeDocLocally = (id) => {
  portalState.finances.financeDocuments = (portalState.finances.financeDocuments || [])
    .filter((d) => d.id !== id);
};

const attachmentKeyOf = (entry) => {
  if (!entry) return null;
  if (typeof entry === 'object' && entry.key) return String(entry.key);
  if (typeof entry === 'string') return entry.replace(/^r2:/, '');
  return null;
};

const attachmentLabelOf = (entry, i = 0) => {
  if (entry && typeof entry === 'object') {
    return entry.originalName || String(entry.key || '').split('/').pop() || `file-${i + 1}`;
  }
  return String(entry || '').split('/').pop() || `file-${i + 1}`;
};

/** Private R2: short-lived presigned GET via /api/storage (notebook pattern). */
async function signedAttachmentUrl(entry) {
  const key = attachmentKeyOf(entry);
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  const res = await fetch('/api/storage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'createSignedUrl', path: key, expiresIn: 120 }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Could not open attachment.');
  return json.signedUrl || json.url || null;
}

const unwrapExcelValue = (raw) => {
  if (raw == null) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw !== 'object') return raw;
  if (raw.result != null) return unwrapExcelValue(raw.result);
  if (raw.text != null) return String(raw.text);
  if (Array.isArray(raw.richText)) return raw.richText.map((p) => p?.text || '').join('');
  if (raw.sharedString != null) return String(raw.sharedString);
  if (raw.hyperlink && raw.text) return String(raw.text);
  return null;
};

const cellRaw = (row, colIdx) => {
  if (colIdx == null || !row) return null;
  return unwrapExcelValue(row.getCell(colIdx).value);
};

const parseDate = (val) => {
  const v = unwrapExcelValue(val);
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial date (days since 1899-12-30)
    if (v > 20000 && v < 80000) {
      const utc = Date.UTC(1899, 11, 30) + Math.round(v * 86400000);
      return new Date(utc).toISOString().slice(0, 10);
    }
    return null;
  }
  const s = String(v).trim();
  if (!s || s === '-' || s === '–' || s === '—') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && /[a-z]/i.test(s)) return d.toISOString().slice(0, 10);
  const parts = s.split(/[\/\-.]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map((x) => parseInt(x, 10));
    if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
  }
  return null;
};

const parseAmount = (val) => {
  const v = unwrapExcelValue(val);
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v);
  if (v instanceof Date) return 0;
  const cleaned = String(v).replace(/₹/g, '').replace(/Rs\.?/gi, '').replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : 0;
};

const cellStr = (cellOrVal) => {
  // Accept either a cell object or a raw/unwrapped value
  const v = cellOrVal && typeof cellOrVal === 'object' && 'value' in cellOrVal
    ? unwrapExcelValue(cellOrVal.value)
    : unwrapExcelValue(cellOrVal);
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};

const resolveCat = (raw, kind) => {
  const allowed = kind === 'IN' ? INCOME_CATS : EXPENSE_CATS;
  const t = String(raw ?? '').trim();
  if (!t) return kind === 'IN' ? 'Other Income' : 'Other';
  const key = normalizeCategoryKey(t);
  if (allowed.includes(key)) return key;
  const lower = t.toLowerCase();
  const hit = allowed.find((c) => c.toLowerCase() === lower || categoryDisplayLabel(c).toLowerCase() === lower);
  return hit || (kind === 'IN' ? 'Other Income' : 'Other');
};

const filterState = {
  kind: 'all',
  status: 'all',
  pay: 'all',
  q: '',
};

/** Report pivot drill-down applied on Bills (cash expenses matching cat / month). */
let docsReportFilter = null;

const docMatchesReportFilter = (d, f) => {
  if (!f || !d) return true;
  if (f.type === 'OUT' && d.kind !== 'OUT') return false;
  if (f.type === 'IN' && d.kind !== 'IN') return false;
  if (paymentInfo(d).mode !== 'cash') return false;
  if (f.key && f.key !== '__other__') {
    const dim = f.dimension || 'cat';
    let key;
    if (dim === 'sub_category') key = d.sub_category?.trim() || '(none)';
    else if (dim === 'vendor') key = d.vendor_name?.trim() || '(none)';
    else key = normalizeCategoryKey(d.cat || 'Other');
    if (key !== f.key) return false;
  }
  const dateStr = String(d.doc_date || '').slice(0, 10);
  const dt = dateStr ? new Date(`${dateStr}T12:00:00`) : null;
  if (!dt || Number.isNaN(dt.getTime())) return false;
  if (f.year != null && f.month != null) {
    if (dt.getFullYear() !== f.year || dt.getMonth() !== f.month) return false;
  } else if (f.rangeStart != null && f.rangeEnd != null) {
    if (dt < f.rangeStart || dt > f.rangeEnd) return false;
  }
  return true;
};

export const applyFinanceDocsReportFilter = (filter) => {
  docsReportFilter = filter ? { ...filter } : null;
  if (docsReportFilter) {
    filterState.kind = docsReportFilter.type === 'IN' ? 'IN' : 'OUT';
    filterState.pay = 'cash';
    const kindEl = document.getElementById('fdoc-filter-kind');
    const payEl = document.getElementById('fdoc-filter-pay');
    if (kindEl) kindEl.value = filterState.kind;
    if (payEl) payEl.value = 'cash';
  }
  renderFdocReportBanner();
  renderFinanceDocumentsPage();
};

export const clearFinanceDocsReportFilter = () => {
  docsReportFilter = null;
  renderFdocReportBanner();
  renderFinanceDocumentsPage();
};

/** Open Bills page and scroll/highlight a document (from ledger cash-bill row). */
export const focusFinanceDocument = async (docId) => {
  if (!docId) return;
  docsReportFilter = null;
  window.switchView?.('finance-docs');
  filterState.kind = 'all';
  filterState.status = 'all';
  filterState.pay = 'all';
  filterState.q = '';
  const kindEl = document.getElementById('fdoc-filter-kind');
  const statusEl = document.getElementById('fdoc-filter-status');
  const payEl = document.getElementById('fdoc-filter-pay');
  const searchEl = document.getElementById('fdoc-search');
  if (kindEl) kindEl.value = 'all';
  if (statusEl) statusEl.value = 'all';
  if (payEl) payEl.value = 'all';
  if (searchEl) searchEl.value = '';
  renderFdocReportBanner();
  renderFinanceDocumentsPage();
  requestAnimationFrame(() => {
    const row = document.querySelector(`tr.fdoc-row[data-doc-id="${CSS.escape(docId)}"]`);
    if (!row) return;
    row.classList.add('fdoc-row--highlight');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => row.classList.remove('fdoc-row--highlight'), 2500);
  });
};

const describeDocsReportFilter = (f) => {
  if (!f) return '';
  const parts = [f.type === 'IN' ? 'Income' : 'Expense', 'cash bills'];
  if (f.key && f.key !== '__other__') {
    const dim = f.dimension === 'sub_category' ? 'sub-category' : f.dimension === 'vendor' ? 'vendor' : 'category';
    parts.push(`${dim}: ${categoryDisplayLabel(f.key)}`);
  }
  if (f.year != null && f.month != null) {
    parts.push(new Date(f.year, f.month, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
  }
  return parts.join(' · ');
};

const renderFdocReportBanner = () => {
  const el = document.getElementById('fdoc-report-banner');
  if (!el) return;
  if (!docsReportFilter) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <span class="ledger-pivot-banner__label"><i class="fa-solid fa-filter" aria-hidden="true"></i> ${esc(describeDocsReportFilter(docsReportFilter))}</span>
    <button type="button" class="btn btn-outline btn--small" id="fdoc-report-clear">Clear report filter</button>`;
  el.querySelector('#fdoc-report-clear')?.addEventListener('click', () => {
    clearFinanceDocsReportFilter();
  }, { once: true });
};

const editing = {
  id: null,
  pendingFiles: [],
  keepAttachments: [],
};

const linkPicker = {
  docIds: [],
  mode: 'cash', // 'cash' | 'cheque' | 'cash-deposit'
  search: '',
  includeWalletFloat: true,
};

const fillCatOptions = (kind) => {
  const sel = document.getElementById('fdoc-cat');
  if (!sel) return;
  const cats = kind === 'IN' ? INCOME_CATS : EXPENSE_CATS.filter((c) => c !== 'Petty Cash');
  const cur = sel.value;
  sel.innerHTML = cats.map((c) =>
    `<option value="${esc(c)}">${esc(categoryDisplayLabel(c))}</option>`,
  ).join('');
  if (cats.includes(cur)) sel.value = cur;
};

const resetForm = () => {
  editing.id = null;
  editing.pendingFiles = [];
  editing.keepAttachments = [];
  const kindEl = document.getElementById('fdoc-kind');
  const dateEl = document.getElementById('fdoc-date');
  const amountEl = document.getElementById('fdoc-amount');
  const vendorEl = document.getElementById('fdoc-vendor');
  const descEl = document.getElementById('fdoc-desc');
  const subEl = document.getElementById('fdoc-sub');
  const filesEl = document.getElementById('fdoc-files');
  if (kindEl) kindEl.value = 'OUT';
  if (dateEl) dateEl.value = todayISO();
  if (amountEl) amountEl.value = '';
  if (vendorEl) vendorEl.value = '';
  if (descEl) descEl.value = '';
  if (subEl) subEl.value = '';
  if (filesEl) filesEl.value = '';
  fillCatOptions('OUT');
  document.getElementById('fdoc-form-title').textContent = 'Edit bill / receipt';
  const form = document.getElementById('fdoc-form');
  if (form) form.hidden = true;
  renderAttachmentChips();
};

const openEdit = (doc) => {
  editing.id = doc.id;
  editing.pendingFiles = [];
  editing.keepAttachments = Array.isArray(doc.attachment_urls) ? [...doc.attachment_urls] : [];
  document.getElementById('fdoc-kind').value = doc.kind === 'IN' ? 'IN' : 'OUT';
  fillCatOptions(doc.kind === 'IN' ? 'IN' : 'OUT');
  document.getElementById('fdoc-date').value = String(doc.doc_date || '').slice(0, 10);
  document.getElementById('fdoc-amount').value = doc.amount ?? '';
  document.getElementById('fdoc-cat').value = doc.cat || '';
  document.getElementById('fdoc-vendor').value = doc.vendor_name || '';
  document.getElementById('fdoc-desc').value = doc.description || '';
  document.getElementById('fdoc-sub').value = doc.sub_category || '';
  document.getElementById('fdoc-form-title').textContent = 'Edit bill / receipt';
  const form = document.getElementById('fdoc-form');
  if (form) form.hidden = false;
  renderAttachmentChips();
  form?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const renderAttachmentChips = () => {
  const el = document.getElementById('fdoc-attach-list');
  if (!el) return;
  const parts = [];
  editing.keepAttachments.forEach((att, i) => {
    const name = attachmentLabelOf(att, i);
    parts.push(`<span class="fdoc-chip"><button type="button" class="fdoc-chip__open" data-keep-open="${i}">${esc(name)}</button> <button type="button" data-keep-idx="${i}" aria-label="Remove">×</button></span>`);
  });
  editing.pendingFiles.forEach((file, i) => {
    parts.push(`<span class="fdoc-chip fdoc-chip--new">${esc(file.name)} <button type="button" data-pend-idx="${i}" aria-label="Remove">×</button></span>`);
  });
  el.innerHTML = parts.length ? parts.join('') : '<span class="fa-panel__hint">No attachments yet (stored in private R2).</span>';
};

async function saveDocumentFromForm() {
  const kind = document.getElementById('fdoc-kind')?.value === 'IN' ? 'IN' : 'OUT';
  const doc_date = document.getElementById('fdoc-date')?.value;
  const amount = parseFloat(document.getElementById('fdoc-amount')?.value || '0');
  const cat = document.getElementById('fdoc-cat')?.value || (kind === 'IN' ? 'Other Income' : 'Other');
  const vendor_name = document.getElementById('fdoc-vendor')?.value?.trim() || null;
  const description = document.getElementById('fdoc-desc')?.value?.trim() || null;
  const sub_category = document.getElementById('fdoc-sub')?.value?.trim() || null;

  if (!doc_date) throw new Error('Date is required.');
  if (!(amount > 0)) throw new Error('Enter a valid amount.');
  if (kind === 'OUT' && !vendor_name) throw new Error('Vendor is required for expenses.');

  const existing = editing.id
    ? (portalState.finances.financeDocuments || []).find((d) => d.id === editing.id)
    : null;
  const original = Array.isArray(existing?.attachment_urls) ? existing.attachment_urls : [];
  const keepKeys = new Set(editing.keepAttachments.map(attachmentKeyOf).filter(Boolean));
  const removeAttachments = original.filter((a) => !keepKeys.has(attachmentKeyOf(a)));

  const result = await postFinanceMutation('saveFinanceDocument', {
    document: {
      id: editing.id || undefined,
      kind,
      doc_date,
      amount: round2(amount),
      cat,
      vendor_name,
      description,
      sub_category,
      transaction_id: existing?.transaction_id || null,
      source: existing?.source || 'manual',
    },
    keepAttachments: editing.keepAttachments,
    removeAttachments,
    newAttachmentFiles: await filesToBase64Payload(editing.pendingFiles),
  });

  applyDocLocally(result.document);
  resetForm();
  renderFinanceDocumentsPage();
}

const isFundingLedgerTxn = (t) => {
  if (!t || t.excluded_from_ledger) return false;
  if (t.is_cash_float) return true;
  if (normalizeCategoryKey(t.cat) === 'Petty Cash') return true;
  return isBankPettyFunding(t);
};

const linkedCashTotalForTxn = (txnId) => {
  if (!txnId) return 0;
  return round2(
    getFinanceDocuments()
      .filter((d) => d.transaction_id === txnId && d.kind === 'OUT' && paymentInfo(d).mode === 'cash')
      .reduce((s, d) => s + (parseFloat(d.amount) || 0), 0),
  );
};

const fundingBucketOf = (txnId) => {
  const t = (portalState.finances.txns || []).find((x) => x.id === txnId);
  if (!t) return null;
  const amt = Math.abs(parseFloat(t.amount) || 0);
  const linked = linkedCashTotalForTxn(txnId);
  const remaining = round2(amt - linked);
  return { t, amt, linked, remaining, full: remaining <= 0.009 };
};

/** Fit selected cash bills into a funding bucket without exceeding remaining capacity. */
const fitCashDocsToBucket = (docs, remaining) => {
  const room = round2(Math.max(0, remaining));
  const ordered = [...docs].sort((a, b) => {
    const da = String(a.doc_date || '');
    const db = String(b.doc_date || '');
    if (da !== db) return da.localeCompare(db);
    return (parseFloat(a.amount) || 0) - (parseFloat(b.amount) || 0);
  });
  const fit = [];
  const overflow = [];
  let used = 0;
  for (const doc of ordered) {
    const amt = round2(parseFloat(doc.amount) || 0);
    if (amt <= 0) {
      overflow.push(doc);
      continue;
    }
    if (round2(used + amt) <= room + 0.009) {
      fit.push(doc);
      used = round2(used + amt);
    } else {
      overflow.push(doc);
    }
  }
  return { fit, overflow, used, room };
};

const docsLinkMode = (docs) => {
  const modes = new Set(docs.map((d) => paymentInfo(d).mode));
  const kinds = new Set(docs.map((d) => d.kind));
  if (modes.has('cheque') && !modes.has('cash')) return 'cheque';
  if (modes.has('cash') && modes.has('cheque')) return 'cheque';
  if (modes.has('cash')) {
    if (kinds.has('IN') && kinds.has('OUT')) return 'mixed-cash';
    if (kinds.has('IN')) return 'cash-deposit';
    return 'cash';
  }
  return 'cash';
};

const ledgerCandidatesForCashLink = () => {
  return (portalState.finances.txns || [])
    .filter(isFundingLedgerTxn)
    .map((t) => {
      const linked = linkedCashTotalForTxn(t.id);
      const amt = Math.abs(parseFloat(t.amount) || 0);
      const remaining = round2(amt - linked);
      return { t, linked, remaining, amt, full: remaining <= 0.009 };
    })
    // Oldest open bucket first — fill month-on-month (bills may land on the next month).
    .sort((a, b) => {
      if (a.full !== b.full) return a.full ? 1 : -1;
      return String(a.t.date || '').localeCompare(String(b.t.date || ''));
    });
};

/** Bank deposits that take cash off the desk (link cash receipts and/or wallet float here). */
const ledgerCandidatesForCashDeposit = (docs, query) => {
  const q = String(query || '').trim().toLowerCase();
  const primary = docs[0];
  const docAmt = docs.length === 1 ? (parseFloat(primary?.amount) || 0) : 0;
  const selectedTotal = round2(docs.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const txns = (portalState.finances.txns || []).filter((t) => {
    if (t.excluded_from_ledger) return false;
    if (t.type !== 'IN') return false;
    return (t.wallet || 'CASH') === 'BANK';
  });

  const scored = txns.map((t) => {
    const hay = [
      t.bank_reference,
      t.description,
      t.vendor_name,
      t.vendor_invoice,
      t.cat,
      categoryDisplayLabel(t.cat),
    ].join(' ').toLowerCase();
    let score = 1;
    if (q) {
      if (hay.includes(q)) score += 40;
      const ref = String(t.bank_reference || '').toLowerCase();
      if (ref && (ref === q || ref.includes(q) || q.includes(ref))) score += 50;
      q.split(/\s+/).filter(Boolean).forEach((tok) => {
        if (tok.length >= 2 && hay.includes(tok)) score += 8;
      });
    }
    const txnAmt = Math.abs(parseFloat(t.amount) || 0);
    if (docAmt > 0 && Math.abs(txnAmt - docAmt) < 0.02) score += 35;
    else if (selectedTotal > 0 && Math.abs(txnAmt - selectedTotal) < 0.02) score += 30;
    else if (selectedTotal > 0 && txnAmt > 0 && Math.abs(txnAmt - selectedTotal) / Math.max(txnAmt, selectedTotal) < 0.05) score += 15;
    return { t, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || String(b.t.date || '').localeCompare(String(a.t.date || '')))
    .slice(0, 40)
    .map((x) => x.t);
};

const walletLeftAvailable = () => {
  const s = computeBillsCashFloatSummary();
  return Math.max(0, s.unused || 0);
};

/** How a bank deposit splits across selected receipts + optional wallet float. */
const depositAllocation = (txn, docs, { includeWalletFloat = true, walletLeft = walletLeftAvailable() } = {}) => {
  const depositAmt = round2(Math.abs(parseFloat(txn?.amount) || 0));
  const receiptsAmt = round2(docs.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  // Receipts being deposited are part of current Left — float can use the rest.
  const floatCap = round2(Math.max(0, walletLeft - receiptsAmt));
  const shortfall = round2(Math.max(0, depositAmt - receiptsAmt));
  const fromWallet = includeWalletFloat ? round2(Math.min(shortfall, floatCap)) : 0;
  const uncovered = round2(Math.max(0, shortfall - fromWallet));
  const covered = round2(receiptsAmt + fromWallet);
  return { depositAmt, receiptsAmt, fromWallet, uncovered, covered, floatCap };
};

const ledgerCandidatesForChequeSearch = (docs, query) => {
  const q = String(query || '').trim().toLowerCase();
  const primary = docs[0];
  const chequeHint = paymentInfo(primary).mode === 'cheque'
    ? String(paymentInfo(primary).short || '').toLowerCase()
    : '';
  const docAmt = docs.length === 1 ? (parseFloat(primary?.amount) || 0) : 0;
  const txns = (portalState.finances.txns || []).filter((t) => !t.excluded_from_ledger);
  const needle = q || chequeHint;
  if (!needle && !docAmt) return [];

  const scored = txns.map((t) => {
    const hay = [
      t.bank_reference,
      t.description,
      t.vendor_name,
      t.vendor_invoice,
      t.cat,
      categoryDisplayLabel(t.cat),
    ].join(' ').toLowerCase();
    let score = 0;
    if (needle) {
      if (hay.includes(needle)) score += 40;
      const ref = String(t.bank_reference || '').toLowerCase();
      if (ref && (ref === needle || ref.includes(needle) || needle.includes(ref))) score += 50;
      needle.split(/\s+/).filter(Boolean).forEach((tok) => {
        if (tok.length >= 2 && hay.includes(tok)) score += 8;
      });
    }
    const txnAmt = Math.abs(parseFloat(t.amount) || 0);
    if (docAmt > 0 && Math.abs(txnAmt - docAmt) < 0.02) score += 35;
    else if (docAmt > 0 && Math.abs(txnAmt - docAmt) / docAmt < 0.02) score += 20;
    if ((t.wallet || 'CASH') === 'BANK') score += 5;
    if (primary?.kind === 'OUT' && t.type === 'OUT') score += 3;
    if (primary?.kind === 'IN' && t.type === 'IN') score += 3;
    return { t, score };
  }).filter((x) => x.score > 0);

  return scored
    .sort((a, b) => b.score - a.score || String(b.t.date || '').localeCompare(String(a.t.date || '')))
    .slice(0, 40)
    .map((x) => x.t);
};

const renderLinkCandidateRows = (candidates, {
  cashMode = false,
  depositMode = false,
  selectedTotal = 0,
  docs = [],
} = {}) => {
  if (!candidates.length) {
    if (cashMode) {
      return '<p class="fa-panel__hint">No Petty Cash funding lines found. Mark a bank Petty Cash withdrawal on the Ledger (wallet icon), then link here — oldest bucket first.</p>';
    }
    if (depositMode) {
      return '<p class="fa-panel__hint">No bank credits found. Add or import the deposit on the Ledger (BANK income), then link receipts and/or wallet float here.</p>';
    }
    return '<p class="fa-panel__hint">Type a cheque number, vendor, or amount to find the matching ledger row.</p>';
  }
  const walletLeft = depositMode ? walletLeftAvailable() : 0;
  return candidates.map((item) => {
    const t = cashMode ? item.t : item;
    const d = t.date
      ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
      : '—';
    if (cashMode) {
      const full = item.full || item.remaining <= 0.009;
      const canTake = !full && selectedTotal > 0 && selectedTotal - item.remaining > 0.009;
      const statusBadge = full
        ? '<span class="fdoc-status fdoc-status--full">Full</span>'
        : `<span class="fdoc-status fdoc-status--linked">Left ${formatMoney(item.remaining)}</span>`;
      const warn = canTake
        ? `<span class="fdoc-status fdoc-status--open">Selected ${formatMoney(selectedTotal)} &gt; left — will only allocate what fits</span>`
        : '';
      const disabled = full ? 'disabled aria-disabled="true"' : '';
      const rowClass = full ? 'fdoc-link-row fdoc-link-row--disabled' : 'fdoc-link-row';
      return `<button type="button" class="${rowClass}" data-link-txn="${esc(t.id)}" ${disabled}>
        <span class="fdoc-link-row__main">${esc(d)} · ${esc(categoryDisplayLabel(t.cat))} · Bucket ${formatMoney(item.amt)}</span>
        <span class="fdoc-link-row__sub">${esc((t.description || t.vendor_name || '').slice(0, 80))}
          <span class="fdoc-chip">Used ${formatMoney(item.linked)}</span> ${statusBadge} ${warn}</span>
      </button>`;
    }
    if (depositMode) {
      const split = depositAllocation(t, docs, {
        includeWalletFloat: linkPicker.includeWalletFloat,
        walletLeft,
      });
      const bits = [
        docs.length ? `<span class="fdoc-chip">Receipts ${formatMoney(split.receiptsAmt)}</span>` : '',
        split.fromWallet > 0 ? `<span class="fdoc-chip">Wallet ${formatMoney(split.fromWallet)}</span>` : '',
        split.uncovered > 0.009 ? `<span class="fdoc-status fdoc-status--open">Short ${formatMoney(split.uncovered)}</span>` : '',
        split.receiptsAmt > split.depositAmt + 0.009
          ? `<span class="fdoc-status fdoc-status--open">Receipts exceed deposit</span>`
          : '',
      ].filter(Boolean).join(' ');
      return `<button type="button" class="fdoc-link-row" data-link-txn="${esc(t.id)}">
        <span class="fdoc-link-row__main">${esc(d)} · Bank deposit ${formatMoney(split.depositAmt)}</span>
        <span class="fdoc-link-row__sub">${esc((t.description || t.vendor_name || t.bank_reference || '').slice(0, 80))} ${bits}</span>
      </button>`;
    }
    const badges = [
      t.bank_reference ? `<span class="fdoc-chip">Ref ${esc(t.bank_reference)}</span>` : '',
    ].filter(Boolean).join(' ');
    return `<button type="button" class="fdoc-link-row" data-link-txn="${esc(t.id)}">
      <span class="fdoc-link-row__main">${esc(d)} · ${esc(t.wallet || 'CASH')} · ${esc(categoryDisplayLabel(t.cat))} · ${formatMoney(t.amount)}</span>
      <span class="fdoc-link-row__sub">${esc((t.description || t.vendor_name || '').slice(0, 80))} ${badges}</span>
    </button>`;
  }).join('');
};

const syncDepositWalletToggle = () => {
  const wrap = document.getElementById('fdoc-link-wallet-wrap');
  const cb = document.getElementById('fdoc-link-wallet-float');
  if (!wrap || !cb) return;
  const show = linkPicker.mode === 'cash-deposit';
  wrap.hidden = !show;
  cb.checked = !!linkPicker.includeWalletFloat;
};

const refreshLinkModalList = () => {
  const list = document.getElementById('fdoc-link-list');
  if (!list) return;
  if (linkPicker.mode !== 'cash-deposit' && !linkPicker.docIds.length) return;

  const docs = linkPicker.docIds
    .map((id) => (portalState.finances.financeDocuments || []).find((d) => d.id === id))
    .filter(Boolean);

  if (linkPicker.mode === 'cash') {
    const selectedTotal = round2(docs.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
    list.innerHTML = renderLinkCandidateRows(ledgerCandidatesForCashLink(), {
      cashMode: true,
      selectedTotal,
    });
    return;
  }
  if (linkPicker.mode === 'cash-deposit') {
    list.innerHTML = renderLinkCandidateRows(
      ledgerCandidatesForCashDeposit(docs, linkPicker.search),
      { depositMode: true, docs, selectedTotal: round2(docs.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0)) },
    );
    return;
  }
  list.innerHTML = renderLinkCandidateRows(
    ledgerCandidatesForChequeSearch(docs, linkPicker.search),
    { cashMode: false },
  );
};

const closeLinkModal = () => {
  const modal = document.getElementById('fdoc-link-modal');
  if (modal) modal.hidden = true;
  linkPicker.docIds = [];
  linkPicker.search = '';
  linkPicker.mode = 'cash';
  linkPicker.includeWalletFloat = true;
  const searchEl = document.getElementById('fdoc-link-search');
  if (searchEl) searchEl.value = '';
  syncDepositWalletToggle();
};

const openLinkModal = (docIds, { walletDeposit = false } = {}) => {
  linkPicker.docIds = Array.isArray(docIds) ? docIds : [];
  const modal = document.getElementById('fdoc-link-modal');
  const hint = document.getElementById('fdoc-link-hint');
  const searchWrap = document.getElementById('fdoc-link-search-wrap');
  const searchEl = document.getElementById('fdoc-link-search');
  if (!modal) return;

  const docs = linkPicker.docIds
    .map((id) => (portalState.finances.financeDocuments || []).find((d) => d.id === id))
    .filter(Boolean);

  let mode = walletDeposit ? 'cash-deposit' : docsLinkMode(docs);
  if (mode === 'mixed-cash') {
    alert('Select only cash expenses (to fill buckets) or only cash receipts (to match a bank deposit) — not both.');
    return;
  }
  if (!docs.length && !walletDeposit) {
    alert('Select bills or receipts to link, or use Deposit wallet to bank.');
    return;
  }
  linkPicker.mode = mode;
  linkPicker.includeWalletFloat = true;

  const chequePrefill = docs.length === 1 && paymentInfo(docs[0]).mode === 'cheque'
    ? paymentInfo(docs[0]).short
    : '';
  linkPicker.search = chequePrefill || '';

  const selectedTotal = round2(docs.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const left = walletLeftAvailable();

  const titleEl = document.getElementById('fdoc-link-title');
  if (titleEl) {
    if (mode === 'cash-deposit') {
      titleEl.textContent = docs.length
        ? `Deposit ${docs.length} cash receipt(s) to bank`
        : 'Deposit wallet cash to bank';
    } else if (mode === 'cash') {
      titleEl.textContent = 'Link cash bills to Petty Cash bucket';
    } else {
      titleEl.textContent = 'Link to ledger row';
    }
  }

  if (hint) {
    if (mode === 'cash') {
      hint.textContent = docs.length > 1
        ? `Allocate ${docs.length} cash bills (${formatMoney(selectedTotal)}) into buckets oldest → newest. Overflow can go to the next month’s bucket.`
        : `Allocate this cash bill (${formatMoney(selectedTotal)}) — pick a bucket with room (oldest first; next month is fine if earlier ones are full).`;
    } else if (mode === 'cash-deposit') {
      if (docs.length) {
        hint.textContent = `Bank deposit need not match exactly. ${docs.length} receipt(s) ${formatMoney(selectedTotal)}; wallet on hand ${formatMoney(left)} can cover any shortfall.`;
      } else {
        hint.textContent = `Deposit wallet cash to bank (on hand ${formatMoney(left)}). Pick the bank credit — use all or part of the wallet balance.`;
      }
    } else {
      hint.textContent = docs.length > 1
        ? `Search the ledger for the matching cheque / bank payment, then link ${docs.length} bills.`
        : 'Search by cheque number, vendor, or amount to find the bank ledger row.';
    }
  }

  if (searchWrap) searchWrap.hidden = mode !== 'cheque' && mode !== 'cash-deposit';
  if (searchEl) {
    searchEl.value = linkPicker.search;
    searchEl.placeholder = mode === 'cash-deposit'
      ? 'Search bank deposit — amount, narration, ref…'
      : 'Search cheque #, vendor, narration, amount…';
  }

  syncDepositWalletToggle();
  refreshLinkModalList();
  modal.hidden = false;
  if (mode === 'cheque' || mode === 'cash-deposit') setTimeout(() => searchEl?.focus(), 40);
};

const linkSelectedDocsToTxn = async (txnId) => {
  const docs = linkPicker.docIds
    .map((id) => (portalState.finances.financeDocuments || []).find((d) => d.id === id))
    .filter(Boolean);
  if (!docs.length) return;

  if (linkPicker.mode === 'cash') {
    const bucket = fundingBucketOf(txnId);
    if (!bucket) return alert('Funding bucket not found.');
    if (bucket.full) {
      return alert(`This funding bucket is already full (${formatMoney(bucket.amt)} used). Pick another bucket.`);
    }

    const selectedTotal = round2(docs.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
    const { fit, overflow, used, room } = fitCashDocsToBucket(docs, bucket.remaining);

    if (!fit.length) {
      return alert(
        `Nothing fits in this bucket.\n`
        + `Remaining: ${formatMoney(room)}\n`
        + `Selected: ${formatMoney(selectedTotal)}\n`
        + `Pick a bucket with more remaining, or link smaller bills first.`,
      );
    }

    if (overflow.length) {
      const ok = confirm(
        `This bucket only has ${formatMoney(room)} left.\n\n`
        + `Will link ${fit.length} bill(s) (${formatMoney(used)}) into this bucket.\n`
        + `${overflow.length} bill(s) (${formatMoney(selectedTotal - used)}) stay open — link them to another bucket next.\n\n`
        + `Continue?`,
      );
      if (!ok) return;
    }

    const result = await postFinanceMutation('linkFinanceDocuments', {
      transaction_id: txnId,
      document_ids: fit.map((d) => d.id),
    });
    (result.documents || []).forEach(applyDocLocally);
    closeLinkModal();
    renderFinanceDocumentsPage();
    window.renderCashLedger?.();
    if (overflow.length) {
      alert(
        `Linked ${fit.length} bill(s) to this bucket.\n`
        + `${overflow.length} bill(s) remain open — select them and choose the next funding bucket.`,
      );
    }
    return;
  }

  // Cheque payments + cash receipts / wallet deposited to bank
  const txn = (portalState.finances.txns || []).find((t) => t.id === txnId);
  if (linkPicker.mode === 'cash-deposit') {
    if (!txn || txn.type !== 'IN' || (txn.wallet || 'CASH') !== 'BANK') {
      return alert('Pick a bank credit (deposit) to take this cash off the desk.');
    }
    const split = depositAllocation(txn, docs, {
      includeWalletFloat: linkPicker.includeWalletFloat,
      walletLeft: walletLeftAvailable(),
    });
    if (!docs.length && split.fromWallet <= 0.009) {
      return alert('Turn on “Use wallet float for shortfall”, or select cash receipt(s) to deposit.');
    }
    if (split.uncovered > 0.009) {
      const ok = confirm(
        `Bank deposit ${formatMoney(split.depositAmt)}\n`
        + `Receipts ${formatMoney(split.receiptsAmt)} + wallet ${formatMoney(split.fromWallet)}\n`
        + `Still short ${formatMoney(split.uncovered)} (not enough wallet on hand).\n\n`
        + `Link what we can anyway?`,
      );
      if (!ok) return;
    } else if (split.receiptsAmt > split.depositAmt + 0.009) {
      const ok = confirm(
        `Selected receipts (${formatMoney(split.receiptsAmt)}) exceed this deposit (${formatMoney(split.depositAmt)}).\n`
        + `That’s OK if several receipts were banked together under a smaller/larger credit, or split across deposits.\n\nContinue?`,
      );
      if (!ok) return;
    }

    const existingDeposit = round2(parseFloat(txn.cash_desk_deposit) || 0);
    const cashDeskDeposit = round2(existingDeposit + split.fromWallet);

    const result = await postFinanceMutation('linkFinanceDocuments', {
      transaction_id: txnId,
      document_ids: docs.map((d) => d.id),
      cash_desk_deposit: cashDeskDeposit,
    });
    (result.documents || []).forEach(applyDocLocally);
    if (result.transaction) applySavedTransactionLocally(result.transaction);
    else if (cashDeskDeposit > 0) {
      applySavedTransactionLocally({ ...txn, cash_desk_deposit: cashDeskDeposit });
    }
    closeLinkModal();
    renderFinanceDocumentsPage();
    window.renderCashLedger?.();
    return;
  }

  // Cheque → bank: sync categories (bank wins if set; else bill → bank). No sync for cash.
  const result = await postFinanceMutation('linkFinanceDocuments', {
    transaction_id: txnId,
    document_ids: linkPicker.docIds,
    sync_categories: true,
  });
  (result.documents || []).forEach(applyDocLocally);
  if (result.transaction) applySavedTransactionLocally(result.transaction);
  closeLinkModal();
  renderFinanceDocumentsPage();
  window.renderCashLedger?.();
};

const isBlankExcelCell = (val) => {
  const v = unwrapExcelValue(val);
  if (v == null || v === '') return true;
  const s = String(v).trim();
  return !s || s === '-' || s === '–' || s === '—' || s.toLowerCase() === 'n/a';
};

const chequeRefFromCell = (val) => {
  const v = unwrapExcelValue(val);
  if (isBlankExcelCell(v)) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
  const s = String(v).trim();
  return s.replace(/\.0+$/, '') || null;
};

/** Prefer specific header tokens; avoid short needles like "rs" matching "particulars". */
const findHeaderCol = (headers, candidates) => {
  let best = null;
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i];
    if (!h) continue;
    for (const { keys, score } of candidates) {
      const hit = keys.some((k) => {
        if (k.length <= 2) return h === k || new RegExp(`(?:^|\\b)${k}(?:\\b|$)`, 'i').test(h);
        return h === k || h.includes(k);
      });
      if (!hit) continue;
      if (!best || score > best.score) best = { idx: i, score };
    }
  }
  return best?.idx ?? null;
};

const findHeaderRow = (ws) => {
  const maxScan = Math.min(ws.rowCount || 10, 10);
  for (let r = 1; r <= maxScan; r += 1) {
    const headers = [];
    ws.getRow(r).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = cellStr(cell).toLowerCase();
    });
    const amountCol = findHeaderCol(headers, [
      { keys: ['amount', 'debit', 'credit'], score: 10 },
      { keys: ['₹'], score: 4 },
    ]);
    const descCol = findHeaderCol(headers, [
      { keys: ['description', 'particular', 'narration', 'remark'], score: 8 },
    ]);
    const dateCol = findHeaderCol(headers, [{ keys: ['date'], score: 8 }]);
    if (amountCol && (descCol || dateCol)) return { headerRow: r, headers };
  }
  return null;
};

const parseSheetDocuments = (ws, defaultKind) => {
  if (!ws) return { rows: [], undated: 0 };
  const name = String(ws.name || '').toLowerCase();
  if (/read\s*me|instruction|note|help/.test(name)) return { rows: [], undated: 0 };

  const found = findHeaderRow(ws);
  if (!found) return { rows: [], undated: 0 };
  const { headerRow, headers } = found;

  const dateCol = findHeaderCol(headers, [{ keys: ['date'], score: 10 }]);
  const amountCol = findHeaderCol(headers, [
    { keys: ['amount'], score: 12 },
    { keys: ['debit', 'credit'], score: 10 },
    { keys: ['₹'], score: 3 },
  ]);
  const catCol = findHeaderCol(headers, [
    { keys: ['category', 'head'], score: 10 },
    { keys: ['cat'], score: 4 },
  ]);
  const vendorCol = findHeaderCol(headers, [
    { keys: ['vendor', 'payee', 'supplier'], score: 10 },
  ]);
  const descCol = findHeaderCol(headers, [
    { keys: ['description', 'particular', 'narration', 'remark'], score: 10 },
  ]);
  const subCol = findHeaderCol(headers, [
    { keys: ['sub-category', 'subcategory', 'sub category'], score: 10 },
  ]);
  const kindCol = findHeaderCol(headers, [
    { keys: ['kind', 'in/out'], score: 10 },
    { keys: ['type'], score: 4 },
  ]);
  const chequeCol = findHeaderCol(headers, [
    { keys: ['cheque', 'check', 'chq'], score: 12 },
    { keys: ['utr', 'neft', 'reference'], score: 6 },
  ]);

  if (!amountCol) return { rows: [], undated: 0 };

  const rows = [];
  let undated = 0;
  const fallbackDate = todayISO();

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const amount = parseAmount(cellRaw(row, amountCol));
    if (amount <= 0.001) return;

    let doc_date = dateCol ? parseDate(cellRaw(row, dateCol)) : null;
    if (!doc_date) {
      doc_date = fallbackDate;
      undated += 1;
    }

    let kind = defaultKind;
    if (kindCol) {
      const k = cellStr(cellRaw(row, kindCol)).toUpperCase();
      if (k.startsWith('IN') || k === 'CREDIT' || k === 'INCOME' || k === 'RECEIPT') kind = 'IN';
      else if (k.startsWith('OUT') || k === 'DEBIT' || k === 'EXPENSE' || k === 'BILL') kind = 'OUT';
    }

    const particulars = descCol ? cellStr(cellRaw(row, descCol)) : '';
    const vendorExplicit = vendorCol ? cellStr(cellRaw(row, vendorCol)) : '';
    const cheque = chequeCol ? chequeRefFromCell(cellRaw(row, chequeCol)) : null;
    const paymentNote = cheque ? `Cheque: ${cheque}` : 'Payment: Cash';
    const vendor_name = vendorExplicit
      || particulars
      || (kind === 'IN' ? 'Receipt' : (cheque ? 'Cheque payment' : 'Cash expense'));

    rows.push({
      kind,
      doc_date,
      amount: round2(amount),
      cat: resolveCat(catCol ? cellStr(cellRaw(row, catCol)) : '', kind),
      vendor_name,
      description: particulars || null,
      sub_category: subCol ? cellStr(cellRaw(row, subCol)) || null : null,
      notes: paymentNote,
      cheque_no: cheque,
      payment_mode: cheque ? 'BANK' : 'CASH',
    });
  });

  return { rows, undated };
};

const sheetDefaultKind = (ws, fallback = 'OUT') => {
  const name = String(ws?.name || '').toLowerCase();
  if (/income|receipt|credit/.test(name)) return 'IN';
  if (/expense|bill|debit/.test(name)) return 'OUT';
  return fallback;
};

export async function parseFinanceDocumentsExcel(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  if (!wb.worksheets?.length) throw new Error('No worksheet found.');

  const allRows = [];
  let undated = 0;
  const sheetStats = [];

  // Parse every sheet that looks like a data table (not only Expenses/Income names).
  for (const ws of wb.worksheets) {
    const kind = sheetDefaultKind(ws, 'OUT');
    const parsed = parseSheetDocuments(ws, kind);
    if (parsed.rows.length) {
      sheetStats.push(`${ws.name}: ${parsed.rows.length}`);
      allRows.push(...parsed.rows);
      undated += parsed.undated;
    }
  }

  if (!allRows.length) {
    throw new Error('No document rows found. Need columns: Date, Cheque No. (optional), Description / Particulars, Amount.');
  }
  return { rows: allRows, undated, sheetStats };
}

export async function downloadFinanceDocumentsTemplate() {
  const wb = new ExcelJS.Workbook();

  const styleHeader = (ws) => {
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E3A5F' },
    };
    row.alignment = { vertical: 'middle', horizontal: 'center' };
    ws.columns = [
      { width: 12 },
      { width: 14 },
      { width: 42 },
      { width: 14 },
    ];
  };

  const expenses = wb.addWorksheet('Expenses');
  expenses.addRow(['Date', 'Cheque No.', 'Description / Particulars', 'Amount']);
  expenses.addRow(['', '', 'Airtel Wifi', 356]);
  expenses.addRow(['', '', 'Staff - Tea / Coffee / Biscuits', 3080]);
  expenses.addRow([todayISO(), '27091', 'Tria Solution LLP', 12150.82]);
  expenses.addRow([todayISO(), '27101', 'B. Munikrishna Petty Cash', 10000]);
  styleHeader(expenses);

  const income = wb.addWorksheet('Income');
  income.addRow(['Date', 'Cheque No.', 'Description / Particulars', 'Amount']);
  income.addRow([todayISO(), '', 'Cash collection - Flat A101', 5000]);
  income.addRow([todayISO(), '45210', 'Maintenance - Flat B204', 8500]);
  styleHeader(income);

  // Tip sheet
  const notes = wb.addWorksheet('Read me');
  notes.addRow(['Bills & receipts import']);
  notes.addRow([]);
  notes.addRow(['• Sheet "Expenses" → expense bills (OUT)']);
  notes.addRow(['• Sheet "Income" → income receipts (IN)']);
  notes.addRow(['• Leave Cheque No. blank (or "-") for cash']);
  notes.addRow(['• Date can be blank for cash lines — import uses today\'s date']);
  notes.addRow(['• Description / Particulars is used as vendor / payee when needed']);
  notes.getColumn(1).width = 72;

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Bills_receipts_template.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

const paymentInfo = (doc) => {
  const notes = String(doc?.notes || '').trim();
  const chequeMatch = notes.match(/^Cheque:\s*(.+)$/i);
  if (chequeMatch) {
    return { mode: 'cheque', label: `Cheque ${chequeMatch[1].trim()}`, short: chequeMatch[1].trim() };
  }
  if (/^Payment:\s*Cash$/i.test(notes) || notes.toLowerCase() === 'cash') {
    return { mode: 'cash', label: 'Cash', short: 'Cash' };
  }
  // Heuristic for older rows without notes
  return { mode: 'unknown', label: '—', short: '—' };
};

/**
 * Cash expense bills as pseudo-ledger rows for Financial Reports (cash_detail mode).
 * Category / subcategory on the bill drive the expense pivot.
 */
export const cashBillsAsReportExpenses = () =>
  getFinanceDocuments()
    .filter((d) => d.kind === 'OUT' && paymentInfo(d).mode === 'cash')
    .map((d) => ({
      id: `fdoc:${d.id}`,
      type: 'OUT',
      date: String(d.doc_date || '').slice(0, 10),
      amount: parseFloat(d.amount) || 0,
      cat: d.cat || 'Other',
      sub_category: d.sub_category || null,
      vendor_name: d.vendor_name || null,
      description: d.description || null,
      wallet: 'CASH',
      _fromFinanceDocument: true,
      finance_document_id: d.id,
    }));

const filteredDocs = () => {
  const q = filterState.q.trim().toLowerCase();
  return getFinanceDocuments().filter((d) => {
    if (docsReportFilter && !docMatchesReportFilter(d, docsReportFilter)) return false;
    if (filterState.kind !== 'all' && d.kind !== filterState.kind) return false;
    if (filterState.status !== 'all' && d.status !== filterState.status) return false;
    if (filterState.pay !== 'all') {
      const pay = paymentInfo(d).mode;
      if (filterState.pay === 'cash' && pay !== 'cash') return false;
      if (filterState.pay === 'cheque' && pay !== 'cheque') return false;
    }
    if (!q) return true;
    const hay = [d.vendor_name, d.description, d.cat, d.sub_category, d.notes].join(' ').toLowerCase();
    return hay.includes(q);
  });
};

/** Cash-float snapshot: bank buckets + cash receipts − expenses − deposits. */
const computeBillsCashFloatSummary = () => {
  const store = computeCashFloatStore();
  const funding = [...store.funding];
  const txns = portalState.finances.txns || [];
  const marked = txns.filter((t) => t.is_cash_float && !funding.some((f) => f.id === t.id));
  // Oldest → newest so month-on-month allocation reads top to bottom.
  const allFunding = [...funding, ...marked].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );

  const bankFunded = round2(allFunding.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0));
  const bankUnused = round2(allFunding.reduce((s, t) => {
    const amt = Math.abs(parseFloat(t.amount) || 0);
    const linked = linkedCashTotalForTxn(t.id);
    return s + Math.max(0, round2(amt - linked));
  }, 0));

  const cashOut = getFinanceDocuments().filter((d) => d.kind === 'OUT' && paymentInfo(d).mode === 'cash');
  const cashIn = getFinanceDocuments().filter((d) => d.kind === 'IN' && paymentInfo(d).mode === 'cash');

  const linkedCash = cashOut.filter((d) => d.status === 'linked' && d.transaction_id);
  const openCash = cashOut.filter((d) => d.status === 'open');
  const linkedAmt = round2(linkedCash.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const openAmt = round2(openCash.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));

  const receiptsAmt = round2(cashIn.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const deposited = cashIn.filter((d) => d.status === 'linked' && d.transaction_id);
  const depositedAmt = round2(deposited.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const receiptsOnHand = round2(receiptsAmt - depositedAmt);

  const deskDeposits = round2(
    txns
      .filter((t) => t.type === 'IN' && (t.wallet || 'CASH') === 'BANK')
      .reduce((s, t) => s + Math.max(0, parseFloat(t.cash_desk_deposit) || 0), 0),
  );

  // Wallet left = unused bank float + cash receipts still on desk − float drawn into bank deposits
  const unused = round2(bankUnused + receiptsOnHand - deskDeposits);
  const funded = round2(bankFunded + receiptsAmt);
  const remaining = unused;

  return {
    funding: allFunding,
    funded,
    bankFunded,
    fundingCount: allFunding.length,
    linkedAmt,
    linkedCount: linkedCash.length,
    openAmt,
    openCount: openCash.length,
    receiptsAmt,
    receiptsCount: cashIn.length,
    depositedAmt,
    depositedCount: deposited.length,
    receiptsOnHand,
    deskDeposits,
    bankUnused,
    unused,
    remaining,
    walletCash: store.walletCash,
    variance: round2(remaining - store.walletCash),
  };
};

/** Cash-desk wallet Left (bank float unused + receipts on hand − desk deposits). */
export const getCashWalletLeft = () => computeBillsCashFloatSummary().unused;

const renderFundingTableHtml = (funding, summary = {}) => {
  if (!funding.length) {
    return '<p class="fa-panel__hint">No bank Petty Cash funding yet. Classify withdrawals as Petty Cash on the Ledger, or mark a line with the wallet icon.</p>';
  }

  const funded = summary.bankFunded ?? summary.funded ?? 0;
  const linkedAmt = summary.linkedAmt ?? 0;
  const openAmt = summary.openAmt ?? 0;

  const rows = funding.map((t) => {
    const d = t.date
      ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
      : '—';
    const amt = Math.abs(parseFloat(t.amount) || 0);
    const linked = linkedCashTotalForTxn(t.id);
    const rowLeft = round2(amt - linked);
    const full = rowLeft <= 0.009;
    const isUnused = linked <= 0.009;
    const pct = amt > 0 ? Math.min(100, Math.round((linked / amt) * 100)) : 0;
    const status = full
      ? '<span class="fdoc-status fdoc-status--full">Full</span>'
      : isUnused
        ? '<span class="fdoc-status fdoc-status--open">Unused</span>'
        : `<span class="fdoc-status fdoc-status--linked">${pct}%</span>`;
    const rowClass = full ? 'fdoc-funding-row--full' : (isUnused ? 'fdoc-funding-row--unused' : '');
    return `<tr class="${rowClass}">
      <td class="fdoc-funding-col-date">${esc(d)}</td>
      <td class="fdoc-funding-col-note">${esc(t.vendor_name || t.description || '—')}</td>
      <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(amt)}</td>
      <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(linked)}</td>
      <td class="fdoc-funding-col-status">
        <div class="fdoc-bucket-meter" title="${pct}% used">
          <div class="fdoc-bucket-meter__bar" style="width:${pct}%"></div>
        </div>
        ${status}
      </td>
    </tr>`;
  }).join('');

  return `<table class="fa-pivot-table cash-float-table fdoc-funding-table">
    <thead>
      <tr>
        <th class="fdoc-funding-col-date">Date</th>
        <th class="fdoc-funding-col-note">Vendor / note</th>
        <th class="cash-float-amt fdoc-funding-col-num">Bucket</th>
        <th class="cash-float-amt fdoc-funding-col-num">Used</th>
        <th class="fdoc-funding-col-status">Status</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr class="fdoc-funding-totals">
        <td colspan="2">Bucket totals</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(funded)}</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(linkedAmt)}</td>
        <td class="fdoc-funding-col-status">
          <span class="fdoc-funding-left-agg">Bank unused ${formatMoney(summary.bankUnused ?? funded - linkedAmt)}</span>
          <span class="fdoc-funding-pending-agg">Expense bills pending ${formatMoney(openAmt)}</span>
        </td>
      </tr>
    </tfoot>
  </table>`;
};

/** Bank credits that took cash off the desk (linked receipts and/or wallet float). */
const listCashToBankDeposits = () => {
  const cashInLinked = getFinanceDocuments().filter(
    (d) => d.kind === 'IN' && paymentInfo(d).mode === 'cash' && d.status === 'linked' && d.transaction_id,
  );
  const byTxn = new Map();
  cashInLinked.forEach((d) => {
    const cur = byTxn.get(d.transaction_id) || { receipts: [], receiptsAmt: 0 };
    cur.receipts.push(d);
    cur.receiptsAmt = round2(cur.receiptsAmt + (parseFloat(d.amount) || 0));
    byTxn.set(d.transaction_id, cur);
  });

  const txns = portalState.finances.txns || [];
  const rows = [];
  const seen = new Set();

  byTxn.forEach((info, txnId) => {
    const t = txns.find((x) => x.id === txnId);
    if (!t) return;
    seen.add(txnId);
    const fromWallet = round2(Math.max(0, parseFloat(t.cash_desk_deposit) || 0));
    rows.push({
      t,
      receiptsAmt: info.receiptsAmt,
      receiptCount: info.receipts.length,
      fromWallet,
      offDesk: round2(info.receiptsAmt + fromWallet),
    });
  });

  txns.forEach((t) => {
    if (seen.has(t.id)) return;
    if (t.type !== 'IN' || (t.wallet || 'CASH') !== 'BANK') return;
    const fromWallet = round2(Math.max(0, parseFloat(t.cash_desk_deposit) || 0));
    if (fromWallet <= 0.009) return;
    rows.push({
      t,
      receiptsAmt: 0,
      receiptCount: 0,
      fromWallet,
      offDesk: fromWallet,
    });
  });

  return rows.sort((a, b) => String(b.t.date || '').localeCompare(String(a.t.date || '')));
};

const renderCashToBankTableHtml = (summary = {}) => {
  const rows = listCashToBankDeposits();
  if (!rows.length) {
    return `<p class="fa-panel__hint">No cash banked yet. Select cash receipt(s) below → <strong>Deposit to bank</strong> → pick the bank credit. Shortfall pulls from wallet float and shows here.</p>`;
  }

  const body = rows.map(({ t, receiptsAmt, receiptCount, fromWallet, offDesk }) => {
    const d = t.date
      ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
      : '—';
    const bankAmt = Math.abs(parseFloat(t.amount) || 0);
    const note = t.description || t.vendor_name || t.bank_reference || '—';
    return `<tr>
      <td class="fdoc-funding-col-date">${esc(d)}</td>
      <td class="fdoc-funding-col-note" title="${esc(note)}">${esc(note)}</td>
      <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(bankAmt)}</td>
      <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(receiptsAmt)}${receiptCount ? `<div class="fdoc-subcat">${receiptCount} receipt(s)</div>` : ''}</td>
      <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(fromWallet)}</td>
      <td class="cash-float-amt fdoc-funding-col-num fdoc-funding-offdesk">${formatMoney(offDesk)}</td>
    </tr>`;
  }).join('');

  const totalOff = round2(rows.reduce((s, r) => s + r.offDesk, 0));
  const totalReceipts = round2(rows.reduce((s, r) => s + r.receiptsAmt, 0));
  const totalWallet = round2(rows.reduce((s, r) => s + r.fromWallet, 0));

  return `<table class="fa-pivot-table cash-float-table fdoc-funding-table fdoc-cash-to-bank-table">
    <thead>
      <tr>
        <th class="fdoc-funding-col-date">Date</th>
        <th class="fdoc-funding-col-note">Bank credit</th>
        <th class="cash-float-amt fdoc-funding-col-num">Deposit</th>
        <th class="cash-float-amt fdoc-funding-col-num">Receipts</th>
        <th class="cash-float-amt fdoc-funding-col-num">Wallet</th>
        <th class="cash-float-amt fdoc-funding-col-num">Off desk</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
    <tfoot>
      <tr class="fdoc-funding-totals">
        <td colspan="3">Reduces Left</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(totalReceipts)}</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(totalWallet)}</td>
        <td class="cash-float-amt fdoc-funding-col-num fdoc-funding-offdesk">${formatMoney(totalOff)}</td>
      </tr>
    </tfoot>
  </table>
  <p class="fa-panel__hint" style="margin:0.45rem 0 0;">
    Left on hand now ${formatMoney(summary.unused ?? 0)}
    (bank unused ${formatMoney(summary.bankUnused ?? 0)}
    + receipts ${formatMoney(summary.receiptsOnHand ?? 0)}
    − wallet→bank ${formatMoney(summary.deskDeposits ?? 0)}).
  </p>`;
};

const renderFloatKpis = (f) => {
  const kpiEl = document.getElementById('fdoc-float-kpis');
  const fundingMeta = document.getElementById('fdoc-funding-summary-meta');
  const fundingTable = document.getElementById('fdoc-funding-table');
  const cashToBankTable = document.getElementById('fdoc-cash-to-bank-table');
  if (!kpiEl) return;

  kpiEl.innerHTML = `
    <div class="ledger-kpi">
      <i class="fa-solid fa-building-columns" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Bank buckets</span>
        <span class="ledger-kpi__value">${formatMoney(f.bankFunded)}</span>
        <span class="ledger-kpi__hint">${f.fundingCount} month(s) · used ${formatMoney(f.linkedAmt)}</span>
      </div>
    </div>
    <div class="ledger-kpi">
      <i class="fa-solid fa-arrow-down-to-bracket" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Cash receipts</span>
        <span class="ledger-kpi__value">${formatMoney(f.receiptsAmt)}</span>
        <span class="ledger-kpi__hint">${f.receiptsCount} · banked ${formatMoney(f.depositedAmt)}${f.deskDeposits ? ` · float ${formatMoney(f.deskDeposits)}` : ''}</span>
      </div>
    </div>
    <div class="ledger-kpi">
      <i class="fa-solid fa-vault" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Left (on hand)</span>
        <span class="ledger-kpi__value">${formatMoney(f.unused)}</span>
        <span class="ledger-kpi__hint">Unused ${formatMoney(f.bankUnused)} + receipts ${formatMoney(f.receiptsOnHand)} − banked float ${formatMoney(f.deskDeposits)}</span>
      </div>
    </div>
    <div class="ledger-kpi">
      <i class="fa-solid fa-hourglass-half" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Pending expense bills</span>
        <span class="ledger-kpi__value">${formatMoney(f.openAmt)}</span>
        <span class="ledger-kpi__hint">${f.openCount} open cash</span>
      </div>
    </div>
  `;

  if (fundingMeta) {
    fundingMeta.textContent = `Left ${formatMoney(f.unused)} · buckets ${formatMoney(f.bankFunded)} · to bank ${formatMoney(round2(f.depositedAmt + f.deskDeposits))}`;
  }
  if (fundingTable) {
    fundingTable.innerHTML = renderFundingTableHtml(f.funding, f);
  }
  if (cashToBankTable) {
    cashToBankTable.innerHTML = renderCashToBankTableHtml(f);
  }
};

const syncBulkActionButtons = () => {
  const checked = [...document.querySelectorAll('#fdoc-table-body .fdoc-row-check:checked')];
  const selectedIds = checked.map((el) => el.value).filter(Boolean);
  const openIds = selectedIds.filter((id) => {
    const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === id);
    return doc && !doc.transaction_id;
  });
  const openDocs = openIds
    .map((id) => (portalState.finances.financeDocuments || []).find((d) => d.id === id))
    .filter(Boolean);
  const openReceiptIds = openDocs
    .filter((d) => d.kind === 'IN' && paymentInfo(d).mode === 'cash')
    .map((d) => d.id);
  const openExpenseIds = openDocs
    .filter((d) => d.kind === 'OUT' && paymentInfo(d).mode === 'cash')
    .map((d) => d.id);

  const linkBtn = document.getElementById('fdoc-bulk-link');
  if (linkBtn) {
    linkBtn.disabled = openIds.length === 0;
    const label = openReceiptIds.length && !openExpenseIds.length
      ? 'Link to bank deposit'
      : openExpenseIds.length && !openReceiptIds.length
        ? 'Link to bucket'
        : 'Link selected';
    linkBtn.innerHTML = `<i class="fa-solid fa-link" aria-hidden="true"></i> ${label}${openIds.length ? ` (${openIds.length})` : ''}`;
  }

  const depositBtn = document.getElementById('fdoc-deposit-wallet');
  if (depositBtn) {
    if (openReceiptIds.length) {
      depositBtn.innerHTML = `<i class="fa-solid fa-building-columns" aria-hidden="true"></i> Deposit to bank (${openReceiptIds.length})`;
    } else {
      depositBtn.innerHTML = `<i class="fa-solid fa-building-columns" aria-hidden="true"></i> Deposit wallet to bank`;
    }
  }

  const delBtn = document.getElementById('fdoc-bulk-delete');
  if (delBtn) {
    delBtn.disabled = selectedIds.length === 0;
    delBtn.innerHTML = `<i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete selected${selectedIds.length ? ` (${selectedIds.length})` : ''}`;
  }
};

const selectedDocIds = () =>
  [...document.querySelectorAll('#fdoc-table-body .fdoc-row-check:checked')]
    .map((el) => el.value)
    .filter(Boolean);

const selectedUnlinkedDocIds = () =>
  selectedDocIds().filter((id) => {
    const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === id);
    return doc && !doc.transaction_id;
  });

const selectedOpenCashReceiptIds = () =>
  selectedUnlinkedDocIds().filter((id) => {
    const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === id);
    return doc && doc.kind === 'IN' && paymentInfo(doc).mode === 'cash';
  });

const bulkDeleteSelectedDocs = async () => {
  const ids = selectedDocIds();
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} bill(s)/receipt(s)? This cannot be undone.`)) return;

  for (const document_id of ids) {
    await postFinanceMutation('deleteFinanceDocument', { document_id });
    removeDocLocally(document_id);
  }
  renderFinanceDocumentsPage();
  window.renderCashLedger?.();
};

const txnLabel = (txnId) => {
  if (!txnId) return '';
  const t = (portalState.finances.txns || []).find((x) => x.id === txnId);
  if (!t) return 'Ledger linked';
  const d = t.date
    ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
    : '';
  return `${d} · ${formatMoney(t.amount)} · ${categoryDisplayLabel(t.cat)}`;
};

export function renderFinanceDocumentsPage() {
  const body = document.getElementById('fdoc-table-body');
  const meta = document.getElementById('fdoc-meta');
  if (!body) return;

  renderFdocReportBanner();

  const docs = filteredDocs();
  const all = getFinanceDocuments();
  const openAmt = round2(all.filter((d) => d.status === 'open' && d.kind === 'OUT').reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const linkedAmt = round2(all.filter((d) => d.status === 'linked' && d.kind === 'OUT').reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));

  if (meta) {
    meta.textContent = `${all.length} bill(s)/receipt(s) · open ${formatMoney(openAmt)} · linked ${formatMoney(linkedAmt)}`;
  }

  renderFloatKpis(computeBillsCashFloatSummary());

  const selectAll = document.getElementById('fdoc-select-all');
  if (selectAll) selectAll.checked = false;

  if (!docs.length) {
    body.innerHTML = `<tr><td colspan="9" class="fa-panel__hint">No bills or receipts yet. Use Add bill / Add receipt, or Import Excel (Expenses + Income sheets). Attachments go to private Cloudflare R2.</td></tr>`;
    syncBulkActionButtons();
    return;
  }

  body.innerHTML = docs.map((d) => {
    const date = d.doc_date
      ? new Date(`${String(d.doc_date).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: '2-digit',
      })
      : '—';
    const attachCount = Array.isArray(d.attachment_urls) ? d.attachment_urls.length : 0;
    const linkLabel = d.transaction_id
      ? `<span class="fdoc-status fdoc-status--linked" title="${esc(txnLabel(d.transaction_id))}">Linked</span>`
      : `<span class="fdoc-status fdoc-status--open">Open</span>`;
    const linkBtn = d.transaction_id
      ? `<button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-unlink="${esc(d.id)}" title="Unlink" aria-label="Unlink"><i class="fa-solid fa-link-slash" aria-hidden="true"></i></button>`
      : `<button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-link="${esc(d.id)}" title="Link" aria-label="Link"><i class="fa-solid fa-link" aria-hidden="true"></i></button>`;
    const pay = paymentInfo(d);
    const payClass = pay.mode === 'cash' ? 'fdoc-pay fdoc-pay--cash' : (pay.mode === 'cheque' ? 'fdoc-pay fdoc-pay--cheque' : 'fdoc-pay');
    const isIncome = d.kind === 'IN';
    return `<tr class="fdoc-row" data-doc-id="${esc(d.id)}" data-doc-kind="${isIncome ? 'IN' : 'OUT'}">
      <td class="fdoc-check-col">
        <input type="checkbox" class="fdoc-row-check" value="${esc(d.id)}" aria-label="Select bill" />
      </td>
      <td>${esc(date)}</td>
      <td>${isIncome ? 'Income' : 'Expense'}</td>
      <td class="fdoc-cat-col">${renderFdocClassifyCell(d, isIncome)}</td>
      <td>${esc(d.vendor_name || d.description || '—')}</td>
      <td><span class="${payClass}">${esc(pay.label)}</span></td>
      <td class="cash-float-amt">${formatMoney(d.amount)}</td>
      <td>${linkLabel}${attachCount ? ` · ${attachCount} file(s)` : ''}</td>
      <td class="fdoc-actions">
        ${linkBtn}
        <button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-edit="${esc(d.id)}" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-outline btn--small btn--icon btn--danger" data-fdoc-del="${esc(d.id)}" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
      </td>
    </tr>`;
  }).join('');
  syncBulkActionButtons();
}

const fdocCatOptions = (isIncome) => {
  const base = isIncome ? INCOME_CATS : EXPENSE_CATS;
  const fromDocs = (portalState.finances.financeDocuments || [])
    .filter((d) => (isIncome ? d.kind === 'IN' : d.kind === 'OUT') && d.cat)
    .map((d) => normalizeCategoryKey(d.cat) || d.cat);
  const fromTxns = (portalState.finances.txns || [])
    .filter((t) => (isIncome ? t.type === 'IN' : t.type === 'OUT') && t.cat)
    .map((t) => normalizeCategoryKey(t.cat) || t.cat);
  return [...new Set([...base, ...fromDocs, ...fromTxns].filter(Boolean))]
    .sort((a, b) => categoryDisplayLabel(a).localeCompare(categoryDisplayLabel(b)));
};

const fdocSubOptions = (catKey) => {
  if (!catKey) return [];
  const key = normalizeCategoryKey(catKey) || catKey;
  const defaults = SUB_CAT_SUGGESTIONS[key] || SUB_CAT_SUGGESTIONS.Other || [];
  const saved = (portalState.finances.subCategories || [])
    .filter((row) => row.category === key || row.category === catKey)
    .map((row) => row.name);
  const fromDocs = (portalState.finances.financeDocuments || [])
    .filter((d) => d.kind === 'OUT' && d.sub_category && (normalizeCategoryKey(d.cat) || d.cat) === key)
    .map((d) => d.sub_category);
  return [...new Set([...defaults, ...saved, ...fromDocs].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
};

const renderFdocClassifyDisplay = (d, isIncome) => {
  const catKey = d.cat ? (normalizeCategoryKey(d.cat) || d.cat) : '';
  const catLabel = catKey ? categoryDisplayLabel(catKey) : '';
  const sub = String(d.sub_category || '').trim();
  let main = catLabel || 'Set category…';
  if (!isIncome && sub && sub.toLowerCase() !== catLabel.toLowerCase()) {
    main = `${catLabel} · ${sub}`;
  }
  return `<button type="button" class="fdoc-cat-display${catLabel ? '' : ' fdoc-cat-display--empty'}" data-fdoc-cat-edit="${esc(d.id)}" title="Edit category">
    <span class="fdoc-cat-display__main">${esc(main)}</span>
    <i class="fa-solid fa-pen fdoc-cat-display__pen" aria-hidden="true"></i>
  </button>`;
};

const renderFdocClassifyCell = (d, isIncome) => `
  <div class="fdoc-classify-cell">
    ${renderFdocClassifyDisplay(d, isIncome)}
    <div class="fdoc-cat-editor" hidden>
      <div class="bank-recon-classify-combobox bank-recon-classify-combobox--cat">
        <input type="text" class="bank-recon-cell-input fdoc-cat-input" placeholder="Category…" autocomplete="off" aria-label="Category" />
        <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
      </div>
      ${isIncome ? '' : `
        <div class="bank-recon-classify-combobox bank-recon-classify-combobox--sub">
          <input type="text" class="bank-recon-cell-input fdoc-sub-input" placeholder="Sub-category" autocomplete="off" aria-label="Sub-category" />
          <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
        </div>
      `}
      <div class="fdoc-cat-editor__actions">
        <button type="button" class="btn btn-primary btn--small btn--icon" data-fdoc-cat-save="${esc(d.id)}" title="Save" aria-label="Save category"><i class="fa-solid fa-check" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-cat-cancel="${esc(d.id)}" title="Cancel" aria-label="Cancel"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
    </div>
  </div>`;

const openFdocCatEditor = (docId) => {
  const row = document.querySelector(`#fdoc-table-body tr.fdoc-row[data-doc-id="${docId}"]`);
  if (!row) return;
  closeAllFdocCatEditors(docId);
  row.classList.add('fdoc-row--classify-open');
  const editor = row.querySelector('.fdoc-cat-editor');
  if (editor) editor.hidden = false;

  const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === docId);
  if (!doc) return;
  const isIncome = doc.kind === 'IN';
  const catKey = doc.cat ? (normalizeCategoryKey(doc.cat) || doc.cat) : '';

  const catInput = row.querySelector('.fdoc-cat-input');
  if (catInput) {
    catInput.value = catKey;
    setClassifyInputState(catInput, catKey && isExactListMatch(catKey, fdocCatOptions(isIncome)) ? 'known' : (catKey ? 'custom' : ''));
  }
  const subInput = row.querySelector('.fdoc-sub-input');
  if (subInput) {
    subInput.value = doc.sub_category || '';
    setClassifyInputState(
      subInput,
      doc.sub_category && isExactListMatch(doc.sub_category, fdocSubOptions(catKey)) ? 'known' : (doc.sub_category ? 'custom' : ''),
    );
  }

  if (!row.dataset.classifyWired) {
    row.dataset.classifyWired = '1';
    const catWrap = row.querySelector('.bank-recon-classify-combobox--cat');
    if (catWrap) {
      wireClassifyCombobox(catWrap, {
        getOptions: () => fdocCatOptions(isIncome),
        onKnownSelect: () => {
          if (subInput) {
            subInput.value = '';
            setClassifyInputState(subInput, '');
          }
        },
      });
    }
    const subWrap = row.querySelector('.bank-recon-classify-combobox--sub');
    if (subWrap) {
      wireClassifyCombobox(subWrap, {
        getOptions: () => {
          const raw = row.querySelector('.fdoc-cat-input')?.value?.trim() || '';
          const key = normalizeCategoryKey(isExactListMatch(raw, fdocCatOptions(isIncome)) || raw) || raw;
          return fdocSubOptions(key);
        },
      });
    }
  }

  catInput?.focus();
};

const closeAllFdocCatEditors = (exceptId = null) => {
  document.querySelectorAll('#fdoc-table-body tr.fdoc-row').forEach((row) => {
    if (exceptId && row.dataset.docId === exceptId) return;
    row.classList.remove('fdoc-row--classify-open');
    const editor = row.querySelector('.fdoc-cat-editor');
    if (editor) editor.hidden = true;
  });
};

const saveFdocClassifyRow = async (row) => {
  const docId = row?.dataset?.docId;
  const existing = (portalState.finances.financeDocuments || []).find((d) => d.id === docId);
  if (!existing) return;
  const apartment_id = portalState.access?.activeApartmentId;
  if (!apartment_id) return;

  const isIncome = existing.kind === 'IN';
  const rawCat = row.querySelector('.fdoc-cat-input')?.value?.trim() || '';
  const options = fdocCatOptions(isIncome);
  const matched = isExactListMatch(rawCat, options);
  const cat = rawCat
    ? (normalizeCategoryKey(matched || rawCat) || matched || rawCat)
    : (existing.cat || (isIncome ? 'Other Income' : 'Other'));
  const sub_category = isIncome
    ? null
    : (row.querySelector('.fdoc-sub-input')?.value?.trim() || null);

  if (cat === existing.cat && (sub_category || null) === (existing.sub_category || null)) {
    closeAllFdocCatEditors();
    return;
  }

  row.classList.add('fdoc-row--saving');
  try {
    const result = await postFinanceMutation('saveFinanceDocument', {
      apartment_id,
      document: { ...existing, cat, sub_category },
      keepAttachments: Array.isArray(existing.attachment_urls) ? existing.attachment_urls : [],
      removeAttachments: [],
      newAttachmentFiles: [],
    });
    if (result.document) applyDocLocally(result.document);
    if (sub_category && cat && !isIncome) {
      if (!portalState.finances.subCategories) portalState.finances.subCategories = [];
      const exists = portalState.finances.subCategories.some(
        (r) => r.category === cat && r.name === sub_category,
      );
      if (!exists) {
        portalState.finances.subCategories.push({ category: cat, name: sub_category });
      }
    }
    const cell = row.querySelector('.fdoc-cat-col');
    if (cell) {
      cell.innerHTML = renderFdocClassifyCell(result.document || { ...existing, cat, sub_category }, isIncome);
    }
    row.classList.remove('fdoc-row--classify-open');
    delete row.dataset.classifyWired;
  } catch (err) {
    alert(err?.message || 'Could not save category.');
  } finally {
    row.classList.remove('fdoc-row--saving');
  }
};

/** Linked cheque bills to sync — selected rows, else currently filtered linked cheques. */
const docsForCategorySync = () => {
  const selected = selectedDocIds();
  const pool = (selected.length
    ? selected.map((id) => (portalState.finances.financeDocuments || []).find((d) => d.id === id)).filter(Boolean)
    : filteredDocs()
  );
  return pool.filter((d) => d.transaction_id && d.status === 'linked' && paymentInfo(d).mode === 'cheque');
};

const syncSelectedCategories = async () => {
  const docs = docsForCategorySync();
  if (!docs.length) {
    alert('Select linked cheque bill(s), or filter to linked cheques. Cash links are not synced (1 ledger → many bills).');
    return;
  }
  const result = await postFinanceMutation('syncFinanceDocumentCategories', {
    document_ids: docs.map((d) => d.id),
  });
  (result.documents || []).forEach(applyDocLocally);
  (result.transactions || []).forEach((t) => applySavedTransactionLocally(t));
  renderFinanceDocumentsPage();
  window.renderCashLedger?.();
  alert(
    `Synced ${result.count || docs.length} cheque bill(s)`
    + (result.ledger_updated ? ` · updated ${result.ledger_updated} ledger row(s)` : '')
    + '.\nBank category wins when set; otherwise bill → bank.',
  );
};

export function initFinanceDocumentsPage() {
  const root = document.getElementById('subview-finance-docs');
  if (!root) return;
  if (root.dataset.wired) {
    renderFinanceDocumentsPage();
    return;
  }
  root.dataset.wired = '1';

  document.getElementById('fdoc-filter-kind')?.addEventListener('change', (e) => {
    filterState.kind = e.target.value;
    renderFinanceDocumentsPage();
  });
  document.getElementById('fdoc-filter-status')?.addEventListener('change', (e) => {
    filterState.status = e.target.value;
    renderFinanceDocumentsPage();
  });
  document.getElementById('fdoc-filter-pay')?.addEventListener('change', (e) => {
    filterState.pay = e.target.value || 'all';
    renderFinanceDocumentsPage();
  });
  document.getElementById('fdoc-search')?.addEventListener('input', (e) => {
    filterState.q = e.target.value || '';
    renderFinanceDocumentsPage();
  });

  document.getElementById('fdoc-select-all')?.addEventListener('change', (e) => {
    const on = !!e.target.checked;
    document.querySelectorAll('#fdoc-table-body .fdoc-row-check').forEach((cb) => {
      cb.checked = on;
    });
    syncBulkActionButtons();
  });
  document.getElementById('fdoc-table-body')?.addEventListener('change', (e) => {
    if (e.target.closest('.fdoc-row-check')) syncBulkActionButtons();
  });
  document.getElementById('fdoc-bulk-link')?.addEventListener('click', () => {
    const ids = selectedUnlinkedDocIds();
    if (!ids.length) {
      alert('Select at least one open (unlinked) bill or receipt to link.');
      return;
    }
    openLinkModal(ids);
  });
  document.getElementById('fdoc-deposit-wallet')?.addEventListener('click', () => {
    const receiptIds = selectedOpenCashReceiptIds();
    if (receiptIds.length) {
      openLinkModal(receiptIds);
      return;
    }
    const ok = confirm(
      'No cash receipts selected.\n\n'
      + 'Tip: tick one or more open cash receipts first, then Deposit to bank.\n\n'
      + 'Continue with wallet float only (no receipts)?',
    );
    if (!ok) return;
    openLinkModal([], { walletDeposit: true });
  });
  document.getElementById('fdoc-bulk-delete')?.addEventListener('click', () => {
    const btn = document.getElementById('fdoc-bulk-delete');
    void withButtonBusy(btn, 'Deleting…', bulkDeleteSelectedDocs);
  });
  document.getElementById('fdoc-sync-cats')?.addEventListener('click', () => {
    const btn = document.getElementById('fdoc-sync-cats');
    void withButtonBusy(btn, 'Syncing…', syncSelectedCategories);
  });

  document.getElementById('fdoc-template-btn')?.addEventListener('click', () => {
    void downloadFinanceDocumentsTemplate();
  });

  const uploadBtn = document.getElementById('fdoc-upload-btn');
  const fileInput = document.getElementById('fdoc-file');
  uploadBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void withButtonBusy(uploadBtn, 'Importing…', async () => {
      try {
        const { rows, undated, sheetStats } = await parseFinanceDocumentsExcel(file);
        const undatedNote = undated
          ? `\n(${undated} row(s) had no date — set to today.)`
          : '';
        const sheetsNote = sheetStats?.length
          ? `\n${sheetStats.join(', ')}`
          : '';
        if (!confirm(`Import ${rows.length} bill(s)/receipt(s)?${sheetsNote}${undatedNote}`)) return;
        const result = await postFinanceMutation('importFinanceDocuments', {
          rows,
          source_file: file.name,
        });
        (result.documents || []).forEach(applyDocLocally);
        renderFinanceDocumentsPage();
        alert(`Imported ${result.count || rows.length} bill(s)/receipt(s).`);
      } catch (err) {
        alert(err?.message || 'Import failed.');
      }
    });
  });

  document.getElementById('fdoc-table-body')?.addEventListener('click', (e) => {
    const catEditId = e.target.closest('[data-fdoc-cat-edit]')?.dataset?.fdocCatEdit;
    if (catEditId) {
      openFdocCatEditor(catEditId);
      return;
    }
    const catSaveId = e.target.closest('[data-fdoc-cat-save]')?.dataset?.fdocCatSave;
    if (catSaveId) {
      const row = document.querySelector(`#fdoc-table-body tr.fdoc-row[data-doc-id="${catSaveId}"]`);
      void saveFdocClassifyRow(row);
      return;
    }
    const catCancelId = e.target.closest('[data-fdoc-cat-cancel]')?.dataset?.fdocCatCancel;
    if (catCancelId) {
      closeAllFdocCatEditors();
      return;
    }

    const linkId = e.target.closest('[data-fdoc-link]')?.dataset?.fdocLink;
    if (linkId) {
      openLinkModal([linkId]);
      return;
    }
    const unlinkId = e.target.closest('[data-fdoc-unlink]')?.dataset?.fdocUnlink;
    if (unlinkId) {
      void postFinanceMutation('unlinkFinanceDocuments', { document_ids: [unlinkId] })
        .then((result) => {
          (result.documents || []).forEach(applyDocLocally);
          renderFinanceDocumentsPage();
          window.renderCashLedger?.();
        })
        .catch((err) => alert(err?.message || 'Unlink failed.'));
      return;
    }
    const editId = e.target.closest('[data-fdoc-edit]')?.dataset?.fdocEdit;
    if (editId) {
      const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === editId);
      if (doc) window.openFinanceDocumentEdit?.(doc);
      return;
    }
    const delId = e.target.closest('[data-fdoc-del]')?.dataset?.fdocDel;
    if (delId) {
      if (!confirm('Delete this bill / receipt?')) return;
      void postFinanceMutation('deleteFinanceDocument', { document_id: delId })
        .then(() => {
          removeDocLocally(delId);
          renderFinanceDocumentsPage();
        })
        .catch((err) => alert(err?.message || 'Delete failed.'));
    }
  });

  document.getElementById('fdoc-link-close')?.addEventListener('click', closeLinkModal);
  document.getElementById('fdoc-link-backdrop')?.addEventListener('click', closeLinkModal);
  document.getElementById('fdoc-link-search')?.addEventListener('input', (e) => {
    linkPicker.search = e.target.value || '';
    refreshLinkModalList();
  });
  document.getElementById('fdoc-link-wallet-float')?.addEventListener('change', (e) => {
    linkPicker.includeWalletFloat = !!e.target.checked;
    refreshLinkModalList();
  });
  document.getElementById('fdoc-link-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-link-txn]');
    if (!btn || btn.disabled || btn.classList.contains('fdoc-link-row--disabled')) return;
    const txnId = btn.dataset?.linkTxn;
    if (!txnId) return;
    if (!linkPicker.docIds.length && linkPicker.mode !== 'cash-deposit') return;
    void linkSelectedDocsToTxn(txnId).catch((err) => alert(err?.message || 'Link failed.'));
  });

  renderFinanceDocumentsPage();
}

/** Mark a ledger row as cash-float funding (Petty Cash) — used from ledger actions. */
export async function markLedgerAsCashFloat(txnId, isCashFloat = true) {
  const result = await postFinanceMutation('setCashFloatFlag', {
    transaction_id: txnId,
    is_cash_float: isCashFloat,
    set_petty_cash_cat: true,
  });
  if (result.transaction) applySavedTransactionLocally(result.transaction);
  return result.transaction;
}
