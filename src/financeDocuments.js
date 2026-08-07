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
} from './expenseCategories.js';
import {
  buildCategoryOptions,
  buildSubCategoryOptions,
  registerCustomCategory,
  registerCustomSubCategory,
} from './classifyOptions.js';
import { postFinanceMutation, filesToBase64Payload } from './financeApi.js';
import { withButtonBusy } from './buttonBusy.js';
import { applySavedTransactionLocally } from './ledgerTxnLocal.js';
import { computeCashFloatStore, isBankPettyFunding } from './cashFloat.js';
import {
  wireClassifyCombobox,
  setClassifyInputState,
  isExactListMatch,
} from './classifyCombobox.js';
import { hasClientPermission } from './rbac.js';

const formatMoney = (n) =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Full bills management (link, delete, float, deposit). */
export const canManageFinanceDocs = () => hasClientPermission('accounts.edit');

/** Add / upload / view bills (includes staff entry). */
export const canEnterFinanceDocs = () =>
  hasClientPermission('accounts.edit') || hasClientPermission('accounts.bills_entry');

const isStaffBillsOnly = () =>
  hasClientPermission('accounts.bills_entry') && !hasClientPermission('accounts.edit');

const applyFinanceDocsStaffMode = () => {
  const root = document.getElementById('subview-finance-docs');
  if (!root) return;
  const staffOnly = isStaffBillsOnly();
  root.classList.toggle('fdoc-staff-mode', staffOnly);
  const funding = document.getElementById('fdoc-funding-details');
  const kpis = document.getElementById('fdoc-float-kpis');
  if (funding) funding.hidden = staffOnly;
  if (kpis) kpis.hidden = staffOnly;
  ['fdoc-bulk-link', 'fdoc-deposit-wallet', 'fdoc-sync-cats', 'fdoc-bulk-delete'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = staffOnly;
  });
  const checkCol = root.querySelector('.fdoc-check-col');
  if (checkCol) checkCol.hidden = staffOnly;
};

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/"/g, '&quot;');

export const getFinanceDocuments = () =>
  (portalState.finances.financeDocuments || []).filter((d) => d.status !== 'void');

/** Resolve bookkeeping status: unpaid → paid → linked (legacy `open` via payment notes). */
export const bookStatus = (doc) => {
  const raw = String(doc?.status || '').toLowerCase();
  if (raw === 'void') return 'void';
  if (raw === 'linked' || doc?.transaction_id) return 'linked';
  if (raw === 'unpaid' || raw === 'paid') return raw;
  // Legacy open / unknown
  const mode = paymentModeFromNotes(doc?.notes);
  return mode === 'cash' || mode === 'cheque' || mode === 'online' ? 'paid' : 'unpaid';
};

const paymentModeFromNotes = (notes) => {
  const text = String(notes || '').trim();
  if (/^Cheque:\s*.+/i.test(text)) return 'cheque';
  if (/^Online:\s*.+/i.test(text) || /Payment:\s*Online/i.test(text)) return 'online';
  if (/^Payment:\s*Cash$/i.test(text) || text.toLowerCase() === 'cash') return 'cash';
  if (/Payment:\s*Unpaid/i.test(text) || !text) return 'unpaid';
  return 'unknown';
};

/** Unpaid expense bills — still to pay (planned spend). */
export const getOpenExpenseDocuments = () =>
  getFinanceDocuments().filter((d) => d.kind === 'OUT' && bookStatus(d) === 'unpaid');

/** Cheque payment on a bill/receipt (notes: `Cheque: …`). */
export const isChequeFinanceDocument = (doc) =>
  /^Cheque:\s*.+/i.test(String(doc?.notes || '').trim());

/** Paid cheque expenses — issued but not yet linked to a bank ledger line. */
export const getOpenChequeExpenseDocuments = () =>
  getFinanceDocuments().filter(
    (d) => d.kind === 'OUT' && bookStatus(d) === 'paid' && isChequeFinanceDocument(d),
  );

/** Bills & receipts filtered to unpaid expenses. */
export const focusOpenExpenseBills = () => {
  docsReportFilter = null;
  filterState.kind = 'OUT';
  filterState.status = 'unpaid';
  filterState.pay = 'all';
  filterState.q = '';
  const kindEl = document.getElementById('fdoc-filter-kind');
  const statusEl = document.getElementById('fdoc-filter-status');
  const payEl = document.getElementById('fdoc-filter-pay');
  const searchEl = document.getElementById('fdoc-search');
  if (kindEl) kindEl.value = 'OUT';
  if (statusEl) statusEl.value = 'unpaid';
  if (payEl) payEl.value = 'all';
  if (searchEl) searchEl.value = '';
  renderFdocReportBanner();
  window.switchView?.('finance-docs');
  renderFinanceDocumentsPage();
};

/** Paid cheque bills on Bills & receipts (issued, not linked to bank yet). */
export const focusOpenChequeBills = () => {
  docsReportFilter = null;
  filterState.kind = 'OUT';
  filterState.status = 'paid';
  filterState.pay = 'cheque';
  filterState.q = '';
  const kindEl = document.getElementById('fdoc-filter-kind');
  const statusEl = document.getElementById('fdoc-filter-status');
  const payEl = document.getElementById('fdoc-filter-pay');
  const searchEl = document.getElementById('fdoc-search');
  if (kindEl) kindEl.value = 'OUT';
  if (statusEl) statusEl.value = 'paid';
  if (payEl) payEl.value = 'cheque';
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

/** Calendar YYYY-MM-DD from a Date using local components (avoid UTC day-shift). */
const isoDateLocal = (d) => {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** Expand 2-digit year → 20xx (petty-cash / bank books use YY). */
const expandYear = (y) => {
  if (y >= 100) return y;
  if (y < 0 || !Number.isFinite(y)) return null;
  return 2000 + y;
};

const parseDate = (val) => {
  const v = unwrapExcelValue(val);
  if (v == null || v === '') return null;
  if (v instanceof Date) return isoDateLocal(v);
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
  // Prefer explicit numeric dates before Date() — "25/07/26" is invalid / wrong under US parse.
  const parts = s.split(/[\/\-.]/).map((x) => x.trim());
  if (parts.length === 3 && parts.every((p) => /^\d{1,4}$/.test(p))) {
    const [a, b, c] = parts.map((x) => parseInt(x, 10));
    // YYYY-MM-DD or YYYY/MM/DD
    if (a > 1000 && b >= 1 && b <= 12 && c >= 1 && c <= 31) {
      return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
    // DD/MM/YYYY or DD/MM/YY (Indian bank / cash books)
    const year = expandYear(c);
    if (year && a >= 1 && a <= 31 && b >= 1 && b <= 12) {
      return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    }
  }
  // Named months e.g. "1 Aug 2026"
  if (/[a-z]/i.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return isoDateLocal(d);
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
  // Bills linked to a specific Petty Cash funding bucket (pivot-style drill-down).
  if (f.transactionId) {
    return d.transaction_id === f.transactionId;
  }
  // Cash bills never belong under Bank in Cash / Bank → Category.
  if (f.wallet === 'BANK' || f.key === 'BANK') return false;
  if (f.key && f.key !== '__other__') {
    const dim = f.dimension || 'cat';
    if (dim === 'wallet_cat') {
      if (f.key.includes('|')) {
        const cat = f.key.split('|').slice(1).join('|');
        if (normalizeCategoryKey(d.cat || 'Other') !== cat) return false;
      }
      // else whole Cash group — any cash bill in range matches
    } else {
      let key;
      if (dim === 'sub_category') key = d.sub_category?.trim() || '(none)';
      else if (dim === 'vendor') key = d.vendor_name?.trim() || '(none)';
      else key = normalizeCategoryKey(d.cat || 'Other');
      if (key !== f.key) return false;
    }
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
    filterState.status = docsReportFilter.transactionId ? 'linked' : (filterState.status || 'all');
    const kindEl = document.getElementById('fdoc-filter-kind');
    const payEl = document.getElementById('fdoc-filter-pay');
    const statusEl = document.getElementById('fdoc-filter-status');
    if (kindEl) kindEl.value = filterState.kind;
    if (payEl) payEl.value = 'cash';
    if (statusEl && docsReportFilter.transactionId) statusEl.value = 'linked';
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
  if (f.transactionId) {
    parts.push(f.label || 'linked to Petty Cash bucket');
  } else if (f.key && f.key !== '__other__') {
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
  if (t.exclude_from_cash_float) return false;
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

/** Negative opening = prior / untracked spend that must consume oldest bucket capacity first. */
const openingDeficitOf = (openingAmt) => round2(Math.max(0, -(Number(openingAmt) || 0)));

/**
 * Running cash through buckets (oldest → newest):
 *   carryIn (can be −ve) + bucket − linked bills = carryOut (can be −ve into next month).
 * Bills stay on their linked bucket; overspend is pocket/float shortfall carried forward.
 * No whole-bill forced moves — a month can finish negative.
 */
const planCashFloatBucketAllocation = (funding, openingAmt = getCashFloatOpeningConfig().amount) => {
  const list = [...(funding || [])].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')),
  );

  const startCarry = openingAmt != null && Number.isFinite(Number(openingAmt))
    ? round2(Number(openingAmt))
    : 0;

  let carry = startCarry;
  const rows = [];

  for (const t of list) {
    const amt = Math.abs(parseFloat(t.amount) || 0);
    const carryIn = carry;
    const linkedBills = linkedCashTotalForTxn(t.id);
    const remaining = round2(carryIn + amt - linkedBills);
    // Prior shortfall absorbed into this bucket (up to bucket size), plus this month's bills.
    const broughtForward = carryIn < -0.009 ? round2(-carryIn) : 0;
    const effectiveUsed = round2(broughtForward + linkedBills);
    const pct = amt > 0 ? Math.min(100, Math.round((Math.min(effectiveUsed, amt) / amt) * 100)) : 0;
    const overdrawn = remaining < -0.009;

    rows.push({
      t,
      id: t.id,
      amt,
      carryIn,
      linkedBills,
      openingHit: broughtForward,
      billRoom: round2(Math.max(0, amt - broughtForward)),
      billUsed: linkedBills,
      assignedDocs: [],
      effectiveUsed,
      remaining,
      full: remaining <= 0.009,
      overdrawn,
      isUnused: effectiveUsed <= 0.009 && remaining > 0.009,
      pct: overdrawn ? 100 : pct,
    });

    carry = remaining;
  }

  const finalCarry = carry;
  const effectiveUnused = round2(Math.max(0, finalCarry));
  const openingAbsorbed = openingDeficitOf(openingAmt);
  const billsTotal = round2(rows.reduce((s, r) => s + r.linkedBills, 0));
  const funded = round2(rows.reduce((s, r) => s + r.amt, 0));
  // Used across the run = opening deficit + all bills (matches funded − final unused when final ≥ 0).
  const effectiveUsedTotal = round2(openingAbsorbed + billsTotal);

  return {
    rows,
    byTxnId: new Map(rows.map((r) => [r.id, r])),
    moves: [],
    effectiveUnused,
    effectiveUsedTotal: funded > 0 ? round2(funded - effectiveUnused) : effectiveUsedTotal,
    openingAbsorbed,
    finalCarry,
    deficit: openingAbsorbed,
  };
};

const fundingBucketOf = (txnId) => {
  const t = (portalState.finances.txns || []).find((x) => x.id === txnId);
  if (!t) return null;
  const funding = (portalState.finances.txns || [])
    .filter(isFundingLedgerTxn)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const plan = planCashFloatBucketAllocation(funding);
  const row = plan.byTxnId.get(txnId);
  if (row) {
    return {
      t,
      amt: row.amt,
      linked: row.linkedBills,
      // Room for new links = positive carry-out only (overdrawn months are full).
      remaining: round2(Math.max(0, row.remaining)),
      full: row.remaining <= 0.009,
      openingHit: row.openingHit,
    };
  }
  const amt = Math.abs(parseFloat(t.amount) || 0);
  const linked = linkedCashTotalForTxn(txnId);
  const remaining = round2(amt - linked);
  return { t, amt, linked, remaining, full: remaining <= 0.009, openingHit: 0 };
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
  const funding = (portalState.finances.txns || []).filter(isFundingLedgerTxn);
  const plan = planCashFloatBucketAllocation(
    [...funding].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))),
  );
  return funding
    .map((t) => {
      const row = plan.byTxnId.get(t.id);
      const amt = row?.amt ?? Math.abs(parseFloat(t.amount) || 0);
      const linked = row?.linkedBills ?? linkedCashTotalForTxn(t.id);
      const remaining = row
        ? round2(Math.max(0, row.remaining))
        : round2(amt - linked);
      return {
        t,
        linked,
        remaining,
        amt,
        full: remaining <= 0.009,
        openingHit: row?.openingHit || 0,
      };
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
  notes.addRow(['• Date: use DD/MM/YY or DD/MM/YYYY (e.g. 25/07/26). Blank → today\'s date']);
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
  const paidOnMatch = notes.match(/Paid on:\s*(\d{4}-\d{2}-\d{2})/i);
  const paidOn = paidOnMatch ? paidOnMatch[1] : '';
  const withDate = (label) => (paidOn ? `${label} · ${paidOn}` : label);
  const chequeMatch = notes.match(/^Cheque:\s*(.+)$/im);
  if (chequeMatch) {
    const no = chequeMatch[1].trim().split('\n')[0].trim();
    return { mode: 'cheque', label: withDate(`Cheque ${no}`), short: no, paidOn };
  }
  const onlineMatch = notes.match(/^Online:\s*(.+)$/im);
  if (onlineMatch) {
    const ref = onlineMatch[1].trim().split('\n')[0].trim();
    return { mode: 'online', label: withDate(`Online ${ref}`), short: ref, paidOn };
  }
  if (/Payment:\s*Online/i.test(notes)) {
    return { mode: 'online', label: withDate('Online'), short: 'Online', paidOn };
  }
  if (/^Payment:\s*Cash$/im.test(notes) || notes.toLowerCase() === 'cash') {
    return { mode: 'cash', label: withDate('Cash'), short: 'Cash', paidOn };
  }
  if (/Payment:\s*Unpaid/i.test(notes) || !notes) {
    return { mode: 'unpaid', label: 'Unpaid', short: 'Unpaid', paidOn: '' };
  }
  return { mode: 'unknown', label: '—', short: '—', paidOn: '' };
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
    if (filterState.status !== 'all' && bookStatus(d) !== filterState.status) return false;
    if (filterState.pay !== 'all') {
      const pay = paymentInfo(d).mode;
      if (filterState.pay === 'cash' && pay !== 'cash') return false;
      if (filterState.pay === 'cheque' && pay !== 'cheque') return false;
      if (filterState.pay === 'online' && pay !== 'online') return false;
      if (filterState.pay === 'unpaid' && pay !== 'unpaid') return false;
    }
    if (!q) return true;
    const hay = [d.vendor_name, d.description, d.cat, d.sub_category, d.notes].join(' ').toLowerCase();
    return hay.includes(q);
  });
};

/** Cash-float snapshot: bank buckets + cash receipts − expenses − deposits. */
const getCashFloatOpeningConfig = () => {
  const bank = portalState.admin?.bankAccount;
  const raw = bank?.cash_float_opening_balance;
  const amount = raw == null || raw === '' ? null : Number(raw);
  return {
    amount: amount != null && Number.isFinite(amount) ? amount : null,
    date: bank?.cash_float_opening_date ? String(bank.cash_float_opening_date).slice(0, 10) : null,
  };
};

const computeBillsCashFloatSummary = () => {
  const store = computeCashFloatStore();
  const funding = [...store.funding];
  const txns = portalState.finances.txns || [];
  const marked = txns.filter((t) =>
    t.is_cash_float
    && !t.exclude_from_cash_float
    && !funding.some((f) => f.id === t.id),
  );
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

  const linkedCash = cashOut.filter((d) => bookStatus(d) === 'linked' && d.transaction_id);
  const openCash = cashOut.filter((d) => bookStatus(d) === 'paid');
  const linkedAmt = round2(linkedCash.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const openAmt = round2(openCash.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));

  const receiptsAmt = round2(cashIn.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const deposited = cashIn.filter((d) => bookStatus(d) === 'linked' && d.transaction_id);
  const depositedAmt = round2(deposited.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const receiptsOnHand = round2(receiptsAmt - depositedAmt);

  const deskDeposits = round2(
    txns
      .filter((t) => t.type === 'IN' && (t.wallet || 'CASH') === 'BANK')
      .reduce((s, t) => s + Math.max(0, parseFloat(t.cash_desk_deposit) || 0), 0),
  );

  const opening = getCashFloatOpeningConfig();
  const openingAmt = opening.amount != null ? round2(opening.amount) : 0;
  // Raw per-bucket leftover (ignores opening carry) — kept for reference only.
  const bookUnused = round2(bankUnused + receiptsOnHand - deskDeposits);

  const bucketPlan = planCashFloatBucketAllocation(allFunding, opening.amount);
  // On-hand Left follows the month-to-month run (final = Left), then receipts / desk deposits.
  const bucketLeft = allFunding.length
    ? round2(bucketPlan.finalCarry ?? 0)
    : round2((opening.amount != null ? openingAmt : 0) + bankUnused);
  const unused = round2(bucketLeft + receiptsOnHand - deskDeposits);
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
    bookUnused,
    bucketPlan,
    bucketLeft,
    effectiveUnused: bucketPlan.effectiveUnused,
    effectiveUsedTotal: bucketPlan.effectiveUsedTotal,
    openingAbsorbed: bucketPlan.openingAbsorbed,
    openingAmt: opening.amount != null ? openingAmt : null,
    openingDate: opening.date,
    unused,
    remaining,
    walletCash: store.walletCash,
    variance: round2(remaining - store.walletCash),
  };
};

/** Cash-desk wallet Left (bank float unused + receipts on hand − desk deposits). */
export const getCashWalletLeft = () => computeBillsCashFloatSummary().unused;

const moneyClass = (n) => {
  const v = round2(n);
  if (v < -0.009) return 'fdoc-amt--neg';
  if (v > 0.009) return 'fdoc-amt--pos';
  return '';
};

const renderFundingTableHtml = (funding, summary = {}) => {
  if (!funding.length) {
    return '<p class="fa-panel__hint">No bank Petty Cash funding yet. Classify withdrawals as Petty Cash on the Ledger, or mark a line with the wallet icon.</p>';
  }

  const openAmt = summary.openAmt ?? 0;
  const plan = summary.bucketPlan || planCashFloatBucketAllocation(funding, summary.openingAmt);
  const unusedTotal = plan.effectiveUnused ?? summary.bankUnused ?? 0;
  const billsTotal = round2(plan.rows.reduce((s, r) => s + r.linkedBills, 0));
  const chequeTotal = round2(plan.rows.reduce((s, r) => s + r.amt, 0));
  const openingStart = plan.rows[0]?.carryIn ?? (summary.openingAmt != null ? round2(summary.openingAmt) : 0);

  const rows = plan.rows.map((row, idx) => {
    const t = row.t;
    const d = t.date
      ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
      : '—';
    const prevLabel = idx === 0 && summary.openingAmt != null
      ? 'Opening'
      : 'Prev';

    const rowClass = [
      'fdoc-funding-row',
      'fdoc-funding-row--clickable',
      row.overdrawn ? 'fdoc-funding-row--over' : '',
      row.remaining > 0.009 && row.linkedBills <= 0.009 ? 'fdoc-funding-row--unused' : '',
    ].filter(Boolean).join(' ');

    return `<tr class="${rowClass}" data-funding-txn="${esc(t.id)}" title="Open ledger entry">
      <td class="fdoc-funding-col-date">${esc(d)}</td>
      <td class="fdoc-funding-col-note">${esc(t.vendor_name || t.description || '—')}</td>
      <td class="cash-float-amt fdoc-funding-col-num ${moneyClass(row.carryIn)}" title="${prevLabel} balance brought forward">
        <span class="fdoc-funding-col-caption">${prevLabel}</span>
        ${formatMoney(row.carryIn)}
      </td>
      <td class="cash-float-amt fdoc-funding-col-num">
        <button type="button" class="fdoc-funding-drill fdoc-amt--pos" data-funding-cheque="${esc(t.id)}" title="Open Petty Cash ledger / cheque entry">
          <span class="fdoc-funding-col-caption">+ Cheque</span>
          ${formatMoney(row.amt)}
        </button>
      </td>
      <td class="cash-float-amt fdoc-funding-col-num">
        <button type="button" class="fdoc-funding-drill fdoc-amt--neg" data-funding-bills="${esc(t.id)}" title="Show cash bills linked to this bucket" ${row.linkedBills <= 0.009 ? 'disabled' : ''}>
          <span class="fdoc-funding-col-caption">− Bills</span>
          ${formatMoney(row.linkedBills)}
        </button>
      </td>
      <td class="cash-float-amt fdoc-funding-col-num ${moneyClass(row.remaining)}" title="Prev + cheque − bills (carries to next month)">
        <span class="fdoc-funding-col-caption">= Left</span>
        <strong>${formatMoney(row.remaining)}</strong>
      </td>
      <td class="fdoc-funding-col-actions">
        <button type="button" class="btn btn-outline btn--small fdoc-funding-exclude" data-funding-exclude="${esc(t.id)}" title="Remove from Petty Cash buckets (keeps the ledger line)">
          Exclude
        </button>
      </td>
    </tr>`;
  }).join('');

  const finalLeft = plan.finalCarry ?? unusedTotal;

  return `<table class="fa-pivot-table cash-float-table fdoc-funding-table fdoc-funding-table--ledger">
    <thead>
      <tr>
        <th class="fdoc-funding-col-date">Date</th>
        <th class="fdoc-funding-col-note">Vendor / note</th>
        <th class="cash-float-amt fdoc-funding-col-num" title="Balance brought into this month (opening or previous left)">Prev</th>
        <th class="cash-float-amt fdoc-funding-col-num" title="Bank Petty Cash cheque — click to open on Ledger">+ Cheque</th>
        <th class="cash-float-amt fdoc-funding-col-num" title="Cash bills linked to this bucket — click to filter">− Bills</th>
        <th class="cash-float-amt fdoc-funding-col-num" title="Prev + cheque − bills (carries to next month)">= Left</th>
        <th class="fdoc-funding-col-actions"></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr class="fdoc-funding-totals">
        <td colspan="2">Total</td>
        <td class="cash-float-amt fdoc-funding-col-num ${moneyClass(openingStart)}">${formatMoney(openingStart)}</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(chequeTotal)}</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(billsTotal)}</td>
        <td class="cash-float-amt fdoc-funding-col-num ${moneyClass(finalLeft)}"><strong>${formatMoney(finalLeft)}</strong></td>
        <td class="fdoc-funding-col-actions">
          ${openAmt > 0.009 ? `<span class="fdoc-funding-pending-agg">Pending ${formatMoney(openAmt)}</span>` : ''}
        </td>
      </tr>
    </tfoot>
  </table>`;
};

/** Bank credits that took cash off the desk (linked receipts and/or wallet float). */
const listCashToBankDeposits = () => {
  const cashInLinked = getFinanceDocuments().filter(
    (d) => d.kind === 'IN' && paymentInfo(d).mode === 'cash' && bookStatus(d) === 'linked' && d.transaction_id,
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
    return `<p class="fdoc-funding-empty">None yet. Use Deposit to bank on open cash receipts.</p>`;
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
        <td colspan="3">Total</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(totalReceipts)}</td>
        <td class="cash-float-amt fdoc-funding-col-num">${formatMoney(totalWallet)}</td>
        <td class="cash-float-amt fdoc-funding-col-num fdoc-funding-offdesk">${formatMoney(totalOff)}</td>
      </tr>
    </tfoot>
  </table>`;
};

const renderFloatKpis = (f) => {
  const kpiEl = document.getElementById('fdoc-float-kpis');
  const fundingMeta = document.getElementById('fdoc-funding-summary-meta');
  const cashToBankMeta = document.getElementById('fdoc-cash-to-bank-meta');
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
      <i class="fa-solid fa-vault" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Left (on hand)</span>
        <span class="ledger-kpi__value">${formatMoney(f.unused)}</span>
        <span class="ledger-kpi__hint">Final bucket Left</span>
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
    fundingMeta.textContent = `Left ${formatMoney(f.unused)} · ${f.fundingCount} bucket${f.fundingCount === 1 ? '' : 's'}`;
  }
  if (cashToBankMeta) {
    const banked = round2((f.depositedAmt || 0) + (f.deskDeposits || 0));
    cashToBankMeta.textContent = banked > 0.009 ? formatMoney(banked) : 'None';
  }
  if (fundingTable) {
    fundingTable.innerHTML = renderFundingTableHtml(f.funding, f);
  }
  if (cashToBankTable) {
    cashToBankTable.innerHTML = renderCashToBankTableHtml(f);
  }
  renderCashOpeningControls(f);
};

const suggestedOpeningForTarget = (f, targetLeft) => {
  // finalLeft = opening + cheques − bills + receipts − deskDeposits
  const runExOpening = round2(
    (f.bankFunded || 0) - (f.linkedAmt || 0) + (f.receiptsOnHand || 0) - (f.deskDeposits || 0),
  );
  return round2((Number(targetLeft) || 0) - runExOpening);
};

const renderCashOpeningControls = (f) => {
  const dateEl = document.getElementById('fdoc-cash-opening-date');
  const amtEl = document.getElementById('fdoc-cash-opening-amount');
  const hintEl = document.getElementById('fdoc-cash-opening-hint');
  if (!dateEl || !amtEl) return;

  const opening = getCashFloatOpeningConfig();
  if (!dateEl.dataset.touched) {
    dateEl.value = opening.date || '2026-04-01';
  }
  if (!amtEl.dataset.touched) {
    amtEl.value = opening.amount != null ? String(opening.amount) : '';
  }

  if (hintEl) {
    if (opening.amount == null) {
      const suggest360 = suggestedOpeningForTarget(f, 360);
      hintEl.hidden = false;
      hintEl.textContent = `Suggested for ₹360 on hand: ${formatMoney(suggest360)}`;
    } else {
      hintEl.hidden = true;
      hintEl.textContent = '';
    }
  }
};

export async function saveCashFloatOpening(date, amount) {
  const apt = portalState.access?.activeApartmentId;
  if (!apt) throw new Error('Select an apartment first.');
  const bank = portalState.admin?.bankAccount || {};
  const result = await postFinanceMutation('saveCashFloatOpening', {
    apartment_id: apt,
    date,
    amount,
    bank,
  });
  if (result.bankAccount) {
    portalState.admin = portalState.admin || {};
    portalState.admin.bankAccount = {
      ...(portalState.admin.bankAccount || {}),
      ...result.bankAccount,
    };
  } else if (portalState.admin?.bankAccount) {
    portalState.admin.bankAccount.cash_float_opening_balance = amount;
    portalState.admin.bankAccount.cash_float_opening_date = amount == null ? null : date;
  }
  return result;
}

const syncBulkActionButtons = () => {
  const checked = [...document.querySelectorAll('#fdoc-table-body .fdoc-row-check:checked')];
  const selectedIds = checked.map((el) => el.value).filter(Boolean);
  const openIds = selectedIds.filter((id) => {
    const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === id);
    return doc && bookStatus(doc) === 'paid';
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

  const actionLabel = (full, short) =>
    `<span class="fdoc-action-full">${full}</span><span class="fdoc-action-short">${short}</span>`;

  const linkBtn = document.getElementById('fdoc-bulk-link');
  if (linkBtn) {
    linkBtn.disabled = openIds.length === 0;
    const count = openIds.length ? ` (${openIds.length})` : '';
    const full = openReceiptIds.length && !openExpenseIds.length
      ? `Link to bank deposit${count}`
      : openExpenseIds.length && !openReceiptIds.length
        ? `Link to bucket${count}`
        : `Link selected${count}`;
    const short = `Link${count}`;
    linkBtn.title = full;
    linkBtn.innerHTML = `<i class="fa-solid fa-link" aria-hidden="true"></i> ${actionLabel(full, short)}`;
  }

  const depositBtn = document.getElementById('fdoc-deposit-wallet');
  if (depositBtn) {
    if (openReceiptIds.length) {
      const full = `Deposit to bank (${openReceiptIds.length})`;
      depositBtn.title = full;
      depositBtn.innerHTML = `<i class="fa-solid fa-building-columns" aria-hidden="true"></i> ${actionLabel(full, `Deposit (${openReceiptIds.length})`)}`;
    } else {
      depositBtn.title = 'Deposit wallet to bank';
      depositBtn.innerHTML = `<i class="fa-solid fa-building-columns" aria-hidden="true"></i> ${actionLabel('Deposit wallet to bank', 'Deposit')}`;
    }
  }

  const delBtn = document.getElementById('fdoc-bulk-delete');
  if (delBtn) {
    delBtn.disabled = selectedIds.length === 0;
    const count = selectedIds.length ? ` (${selectedIds.length})` : '';
    const full = `Delete selected${count}`;
    delBtn.title = full;
    delBtn.innerHTML = `<i class="fa-solid fa-trash-can" aria-hidden="true"></i> ${actionLabel(full, `Delete${count}`)}`;
  }
};

const selectedDocIds = () =>
  [...document.querySelectorAll('#fdoc-table-body .fdoc-row-check:checked')]
    .map((el) => el.value)
    .filter(Boolean);

const selectedUnlinkedDocIds = () =>
  selectedDocIds().filter((id) => {
    const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === id);
    return doc && bookStatus(doc) === 'paid';
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

const renderFdocAttachmentIcons = (doc) => {
  const atts = Array.isArray(doc.attachment_urls) ? doc.attachment_urls : [];
  if (!atts.length) return '';
  const n = atts.length;
  return `<button type="button" class="fdoc-attach-icon fdoc-attach-icon--count" data-fdoc-preview="${esc(doc.id)}" data-preview-idx="0" title="${n} file(s) — click to preview" aria-label="Preview ${n} file(s)">
    <i class="fa-solid fa-paperclip" aria-hidden="true"></i>
    <span class="fdoc-attach-count">${n}</span>
  </button>`;
};

export function renderFinanceDocumentsPage() {
  const body = document.getElementById('fdoc-table-body');
  const meta = document.getElementById('fdoc-meta');
  if (!body) return;

  applyFinanceDocsStaffMode();
  const staffOnly = isStaffBillsOnly();
  const manage = canManageFinanceDocs();

  renderFdocReportBanner();

  const docs = filteredDocs();
  const all = getFinanceDocuments();
  const unpaidAmt = round2(all.filter((d) => bookStatus(d) === 'unpaid' && d.kind === 'OUT').reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const paidAmt = round2(all.filter((d) => bookStatus(d) === 'paid' && d.kind === 'OUT').reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));
  const linkedAmt = round2(all.filter((d) => bookStatus(d) === 'linked' && d.kind === 'OUT').reduce((s, d) => s + (parseFloat(d.amount) || 0), 0));

  if (meta) {
    meta.textContent = staffOnly
      ? `${all.length} bill(s)/receipt(s) · add & upload only`
      : `${all.length} bill(s)/receipt(s) · unpaid ${formatMoney(unpaidAmt)} · paid ${formatMoney(paidAmt)} · linked ${formatMoney(linkedAmt)}`;
  }

  if (!staffOnly) {
    renderFloatKpis(computeBillsCashFloatSummary());
  }

  const selectAll = document.getElementById('fdoc-select-all');
  if (selectAll) {
    selectAll.checked = false;
    selectAll.hidden = staffOnly;
  }

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
    const status = bookStatus(d);
    const linkLabel = status === 'linked'
      ? `<span class="fdoc-status fdoc-status--linked" title="${esc(txnLabel(d.transaction_id))}">Linked</span>`
      : status === 'paid'
        ? `<span class="fdoc-status fdoc-status--paid">Paid</span>`
        : `<span class="fdoc-status fdoc-status--unpaid">Unpaid</span>`;
    const linkBtn = manage
      ? (status === 'linked'
        ? `<button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-unlink="${esc(d.id)}" title="Unlink" aria-label="Unlink"><i class="fa-solid fa-link-slash" aria-hidden="true"></i></button>`
        : status === 'paid'
          ? `<button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-link="${esc(d.id)}" title="Link" aria-label="Link"><i class="fa-solid fa-link" aria-hidden="true"></i></button>`
          : '')
      : '';
    const delBtn = manage
      ? `<button type="button" class="btn btn-outline btn--small btn--icon btn--danger" data-fdoc-del="${esc(d.id)}" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`
      : '';
    const pay = paymentInfo(d);
    const payClass = pay.mode === 'cash'
      ? 'fdoc-pay fdoc-pay--cash'
      : pay.mode === 'cheque'
        ? 'fdoc-pay fdoc-pay--cheque'
        : pay.mode === 'online'
          ? 'fdoc-pay fdoc-pay--online'
          : (pay.mode === 'unpaid' ? 'fdoc-pay fdoc-pay--unpaid' : 'fdoc-pay');
    const isIncome = d.kind === 'IN';
    return `<tr class="fdoc-row fdoc-row--clickable" data-doc-id="${esc(d.id)}" data-doc-kind="${isIncome ? 'IN' : 'OUT'}" title="Click row to view details">
      <td class="fdoc-check-col"${staffOnly ? ' hidden' : ''}>
        <input type="checkbox" class="fdoc-row-check" value="${esc(d.id)}" aria-label="Select bill" ${staffOnly ? 'disabled' : ''} />
      </td>
      <td class="fdoc-cell-open">${esc(date)}</td>
      <td class="fdoc-cell-open">${isIncome ? 'Income' : 'Expense'}</td>
      <td class="fdoc-cat-col">${renderFdocClassifyCell(d, isIncome)}</td>
      <td class="fdoc-cell-open">${esc(d.vendor_name || d.description || '—')}</td>
      <td class="fdoc-cell-open"><span class="${payClass}">${esc(pay.label)}</span></td>
      <td class="cash-float-amt fdoc-cell-open">${formatMoney(d.amount)}</td>
      <td class="fdoc-status-cell">${linkLabel}${renderFdocAttachmentIcons(d)}</td>
      <td class="fdoc-actions">
        ${linkBtn}
        <button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-view="${esc(d.id)}" title="View details" aria-label="View details"><i class="fa-solid fa-eye" aria-hidden="true"></i></button>
        <button type="button" class="btn btn-outline btn--small btn--icon" data-fdoc-edit="${esc(d.id)}" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
        ${delBtn}
      </td>
    </tr>`;
  }).join('');
  syncBulkActionButtons();
}

const fdocCatOptions = (isIncome) => buildCategoryOptions(isIncome);

const fdocSubOptions = (catKey) => buildSubCategoryOptions(catKey);

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
        onCustomSelect: (value) => {
          registerCustomCategory(value, isIncome);
        },
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
        onCustomSelect: (value) => {
          const raw = row.querySelector('.fdoc-cat-input')?.value?.trim() || '';
          const key = normalizeCategoryKey(isExactListMatch(raw, fdocCatOptions(isIncome)) || raw) || raw;
          registerCustomSubCategory(key, value);
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
  return pool.filter((d) => d.transaction_id && bookStatus(d) === 'linked' && paymentInfo(d).mode === 'cheque');
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
      alert('Select at least one paid (unlinked) bill or receipt to link.');
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
      + 'Tip: tick one or more paid cash receipts first, then Deposit to bank.\n\n'
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

    const previewBtn = e.target.closest('[data-fdoc-preview]');
    if (previewBtn) {
      e.preventDefault();
      e.stopPropagation();
      const docId = previewBtn.dataset.fdocPreview;
      const startIdx = parseInt(previewBtn.dataset.previewIdx || '0', 10) || 0;
      const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === docId);
      const atts = Array.isArray(doc?.attachment_urls) ? doc.attachment_urls : [];
      if (!atts.length) return;
      void window.viewAttachmentGallery?.(atts, startIdx);
      return;
    }

    const viewId = e.target.closest('[data-fdoc-view]')?.dataset?.fdocView;
    if (viewId) {
      const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === viewId);
      if (doc) window.openFinanceDocumentView?.(doc);
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
      return;
    }

    // Click empty row area → open full detail (read-only).
    const row = e.target.closest('tr.fdoc-row[data-doc-id]');
    if (row && e.target.closest('.fdoc-cell-open, .fdoc-status-cell')) {
      if (e.target.closest('[data-fdoc-preview], .fdoc-attach-icons')) return;
      const doc = (portalState.finances.financeDocuments || []).find((d) => d.id === row.dataset.docId);
      if (doc) window.openFinanceDocumentView?.(doc);
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

  document.getElementById('fdoc-funding-table')?.addEventListener('click', (e) => {
    const excludeBtn = e.target.closest('[data-funding-exclude]');
    if (excludeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const txnId = excludeBtn.dataset.fundingExclude;
      if (!txnId) return;
      void withButtonBusy(excludeBtn, '…', async () => {
        const updated = await excludeLedgerFromCashFloat(txnId);
        if (updated) {
          renderFinanceDocumentsPage();
          window.renderCashLedger?.();
        }
      }).catch((err) => alert(err?.message || 'Could not exclude from float.'));
      return;
    }

    const chequeBtn = e.target.closest('[data-funding-cheque]');
    if (chequeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const txnId = chequeBtn.dataset.fundingCheque;
      if (!txnId) return;
      const t = (portalState.finances.txns || []).find((x) => x.id === txnId);
      const label = t
        ? `${t.date ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : ''} · ${formatMoney(t.amount)} · Petty Cash cheque`.trim()
        : 'Petty Cash funding cheque';
      void import('./ledgerFilter.js').then(({ navigateToLedgerFromPivot }) => {
        navigateToLedgerFromPivot({
          type: 'OUT',
          transactionId: txnId,
          label,
        });
      });
      return;
    }

    const billsBtn = e.target.closest('[data-funding-bills]');
    if (billsBtn) {
      e.preventDefault();
      e.stopPropagation();
      const txnId = billsBtn.dataset.fundingBills;
      if (!txnId) return;
      const t = (portalState.finances.txns || []).find((x) => x.id === txnId);
      const label = t
        ? `bucket ${t.date ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : ''} · ${formatMoney(t.amount)}`.trim()
        : 'Petty Cash bucket';
      void import('./ledgerFilter.js').then(({ navigateToFinanceDocsFromPivot }) => {
        navigateToFinanceDocsFromPivot({
          type: 'OUT',
          transactionId: txnId,
          label,
        });
        // Ensure bill list is visible under any open funding panel.
        requestAnimationFrame(() => {
          document.getElementById('fdoc-report-banner')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      });
      return;
    }

    const row = e.target.closest('tr.fdoc-funding-row[data-funding-txn]');
    if (!row) return;
    // Ignore clicks on numeric drill targets already handled above.
    if (e.target.closest('.fdoc-funding-drill, .fdoc-funding-col-actions')) return;
    const txnId = row.dataset.fundingTxn;
    if (!txnId) return;
    window.editTxn?.(txnId);
  });

  const openingDateEl = document.getElementById('fdoc-cash-opening-date');
  const openingAmtEl = document.getElementById('fdoc-cash-opening-amount');
  openingDateEl?.addEventListener('input', () => { openingDateEl.dataset.touched = '1'; });
  openingAmtEl?.addEventListener('input', () => { openingAmtEl.dataset.touched = '1'; });

  document.getElementById('fdoc-cash-opening-save')?.addEventListener('click', () => {
    const btn = document.getElementById('fdoc-cash-opening-save');
    const date = openingDateEl?.value || '';
    const raw = openingAmtEl?.value?.trim();
    const amount = raw === '' || raw == null ? null : parseFloat(raw);
    void withButtonBusy(btn, 'Saving…', async () => {
      await saveCashFloatOpening(date || '2026-04-01', amount);
      if (openingDateEl) delete openingDateEl.dataset.touched;
      if (openingAmtEl) delete openingAmtEl.dataset.touched;
      renderFinanceDocumentsPage();
    }).catch((err) => alert(err?.message || 'Could not save opening cash.'));
  });

  document.getElementById('fdoc-cash-opening-match')?.addEventListener('click', () => {
    const f = computeBillsCashFloatSummary();
    const runExOpening = round2(
      (f.bankFunded || 0) - (f.linkedAmt || 0) + (f.receiptsOnHand || 0) - (f.deskDeposits || 0),
    );
    const raw = prompt(
      `Physical cash on hand now (₹)?\n\n`
      + `Without opening, the bucket run ends at ${formatMoney(runExOpening)} `
      + `(cheques ${formatMoney(f.bankFunded)} − bills ${formatMoney(f.linkedAmt)}`
      + `${(f.receiptsOnHand > 0.009 || f.deskDeposits > 0.009)
        ? ` + receipts ${formatMoney(f.receiptsOnHand)} − banked ${formatMoney(f.deskDeposits)}`
        : ''}).\n`
      + `Opening will be: physical − that run.`,
      '360',
    );
    if (raw == null) return;
    const target = parseFloat(String(raw).replace(/[,₹]/g, ''));
    if (!Number.isFinite(target)) {
      alert('Enter a valid amount.');
      return;
    }
    const opening = suggestedOpeningForTarget(f, target);
    const date = openingDateEl?.value || '2026-04-01';
    if (openingAmtEl) {
      openingAmtEl.value = String(opening);
      openingAmtEl.dataset.touched = '1';
    }
    if (openingDateEl && !openingDateEl.value) {
      openingDateEl.value = date;
      openingDateEl.dataset.touched = '1';
    }
    const ok = confirm(
      `Set opening cash to ${formatMoney(opening)} as of ${date}?\n\n`
      + `Then Left (on hand) = ${formatMoney(opening)} + ${formatMoney(runExOpening)} = ${formatMoney(target)}.\n\n`
      + `Negative monthly Left carries into the next Prev until the final Left matches ${formatMoney(target)}.`,
    );
    if (!ok) return;
    const btn = document.getElementById('fdoc-cash-opening-match');
    void withButtonBusy(btn, 'Saving…', async () => {
      await saveCashFloatOpening(date, opening);
      if (openingDateEl) delete openingDateEl.dataset.touched;
      if (openingAmtEl) delete openingAmtEl.dataset.touched;
      renderFinanceDocumentsPage();
    }).catch((err) => alert(err?.message || 'Could not save opening cash.'));
  });

  renderFinanceDocumentsPage();
}

/** Mark a ledger row as cash-float funding (Petty Cash) — used from ledger actions. */
export async function markLedgerAsCashFloat(txnId, isCashFloat = true) {
  const result = await postFinanceMutation('setCashFloatFlag', {
    transaction_id: txnId,
    is_cash_float: isCashFloat,
    set_petty_cash_cat: true,
    // Clearing the wallet mark also opts the line out of auto Petty Cash buckets.
    exclude_from_cash_float: !isCashFloat,
  });
  if (result.transaction) applySavedTransactionLocally(result.transaction);
  return result.transaction;
}

/** Remove a funding line from Petty Cash buckets without deleting the ledger entry. */
export async function excludeLedgerFromCashFloat(txnId) {
  const linked = linkedCashTotalForTxn(txnId);
  if (linked > 0.009) {
    const ok = confirm(
      `This bucket still has ${formatMoney(linked)} in linked cash bills.\n\n`
      + 'Exclude it from Petty Cash buckets anyway?\n'
      + '(Bills stay linked on the ledger; the bucket just leaves the float list.)',
    );
    if (!ok) return null;
  } else {
    const ok = confirm(
      'Exclude this line from Petty Cash buckets?\n\n'
      + 'The ledger entry stays; it will no longer count toward float / Wallet Left.\n'
      + 'You can put it back later with the wallet icon on the Ledger.',
    );
    if (!ok) return null;
  }
  return markLedgerAsCashFloat(txnId, false);
}

const paymentNotesFromTxn = (txn) => {
  const wallet = String(txn?.wallet || '').toUpperCase();
  const ref = String(txn?.bank_reference || '').trim();
  if (wallet === 'BANK' && ref) return `Cheque: ${ref}`;
  if (wallet === 'CASH') return 'Payment: Cash';
  return null;
};

/**
 * Create a linked bill (OUT) or receipt (IN) from a ledger transaction,
 * then open it for editing so attachments can be uploaded.
 */
export async function createFinanceDocumentFromLedgerTxn(txnId, { openEditor = true } = {}) {
  const txn = (portalState.finances.txns || []).find((t) => t.id === txnId);
  if (!txn) throw new Error('Ledger entry not found.');

  const amount = Math.abs(parseFloat(txn.amount) || 0);
  if (!(amount > 0)) throw new Error('Ledger entry has no amount.');

  const kind = txn.type === 'IN' ? 'IN' : 'OUT';
  const doc_date = String(txn.date || '').slice(0, 10) || todayISO();
  const result = await postFinanceMutation('saveFinanceDocument', {
    document: {
      kind,
      doc_date,
      amount,
      cat: txn.cat || (kind === 'IN' ? 'Other Income' : 'Other'),
      sub_category: txn.sub_category || null,
      vendor_name: txn.vendor_name || null,
      description: txn.description || null,
      notes: paymentNotesFromTxn(txn),
      transaction_id: txn.id,
      source: 'manual',
    },
    keepAttachments: [],
    removeAttachments: [],
    newAttachmentFiles: [],
  });

  const doc = result.document;
  if (!doc?.id) throw new Error('Could not create bill/receipt.');
  applyDocLocally(doc);

  if (openEditor) {
    // Prefer the shared bill/receipt modal so attachments can be uploaded immediately.
    if (typeof window.openFinanceDocumentEdit === 'function') {
      window.openFinanceDocumentEdit(doc, { readOnly: false });
    } else {
      await focusFinanceDocument(doc.id);
    }
  }

  return doc;
}
