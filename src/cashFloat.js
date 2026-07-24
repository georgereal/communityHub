/**
 * Cash float store: bank Petty Cash funding accumulates; cash desk expenses draw it down.
 */
import ExcelJS from 'exceljs';
import { portalState } from './store.js';
import { normalizeCategoryKey, EXPENSE_CATS, categoryDisplayLabel } from './expenseCategories.js';
import { postFinanceMutation } from './financeApi.js';
import { applySavedTransactionLocally } from './ledgerTxnLocal.js';
import { withButtonBusy } from './buttonBusy.js';

const formatMoney = (n) =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const txnWallet = (t) => (t?.wallet === 'BANK' ? 'BANK' : 'CASH');

/** Bank withdrawal classified as Petty Cash — funds the float store. */
export const isBankPettyFunding = (t) =>
  t?.type === 'OUT'
  && txnWallet(t) === 'BANK'
  && normalizeCategoryKey(t.cat) === 'Petty Cash';

/** Cash-desk spend that draws down the float (real expense categories). */
export const isCashDeskSpend = (t) =>
  t?.type === 'OUT'
  && txnWallet(t) === 'CASH'
  && normalizeCategoryKey(t.cat) !== 'Petty Cash';

/** Optional desk top-ups recorded as Petty Inflow on CASH. */
export const isCashDeskTopUp = (t) =>
  t?.type === 'IN'
  && txnWallet(t) === 'CASH'
  && normalizeCategoryKey(t.cat) === 'Petty Inflow';

export const getCashExpenseReportingMode = () => {
  const el = document.getElementById('fa-cash-expense-reporting');
  const fromDom = el?.dataset?.mode;
  const v = fromDom || localStorage.getItem('fa-cash-expense-reporting') || 'petty_bank';
  return v === 'cash_detail' ? 'cash_detail' : 'petty_bank';
};

export const setCashExpenseReportingMode = (mode) => {
  const v = mode === 'cash_detail' ? 'cash_detail' : 'petty_bank';
  localStorage.setItem('fa-cash-expense-reporting', v);
  const el = document.getElementById('fa-cash-expense-reporting');
  if (!el) return;
  el.dataset.mode = v;
  el.classList.toggle('fa-cash-mode--on', v === 'cash_detail');
  el.querySelectorAll('.fa-cash-mode__side').forEach((side) => {
    side.classList.toggle('fa-cash-mode__side--active', side.dataset.side === v);
  });
  const toggle = el.querySelector('.fa-cash-mode__toggle');
  if (toggle) toggle.setAttribute('aria-checked', v === 'cash_detail' ? 'true' : 'false');
};

const amountOf = (t) => Math.abs(parseFloat(t?.amount) || 0);

export const computeCashFloatStore = (txns = portalState.finances?.txns || []) => {
  const funding = txns.filter(isBankPettyFunding);
  const spends = txns.filter(isCashDeskSpend);
  const topUps = txns.filter(isCashDeskTopUp);

  const funded = round2(funding.reduce((s, t) => s + amountOf(t), 0));
  const spent = round2(spends.reduce((s, t) => s + amountOf(t), 0));
  const topUpTotal = round2(topUps.reduce((s, t) => s + amountOf(t), 0));
  const remaining = round2(funded - spent);

  const walletCash = round2(txns.reduce((s, t) => {
    if (txnWallet(t) !== 'CASH') return s;
    const a = amountOf(t);
    return t.type === 'IN' ? s + a : s - a;
  }, 0));

  const variance = round2(remaining - walletCash);

  const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));

  return {
    funding: [...funding].sort(byDateDesc),
    spends: [...spends].sort(byDateDesc),
    topUps: [...topUps].sort(byDateDesc),
    funded,
    spent,
    topUpTotal,
    remaining,
    walletCash,
    variance,
  };
};

const parseDate = (val) => {
  if (!val) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const parts = s.split(/[\/\-.]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map((x) => parseInt(x, 10));
    if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
  }
  return null;
};

const parseAmount = (val) => {
  if (val == null || val === '') return 0;
  const n = parseFloat(String(val).replace(/[,₹]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
};

const resolveExpenseCat = (raw) => {
  const t = String(raw ?? '').trim();
  if (!t) return 'Other';
  const key = normalizeCategoryKey(t);
  if (EXPENSE_CATS.includes(key) && key !== 'Petty Cash') return key;
  const lower = t.toLowerCase();
  const hit = EXPENSE_CATS.find((c) => c.toLowerCase() === lower || categoryDisplayLabel(c).toLowerCase() === lower);
  if (hit && hit !== 'Petty Cash') return hit;
  return 'Other';
};

const cellStr = (cell) => {
  const v = cell?.value;
  if (v == null) return '';
  if (typeof v === 'object' && v.text) return String(v.text).trim();
  if (typeof v === 'object' && v.result != null) return String(v.result).trim();
  return String(v).trim();
};

export async function parseCashExpenseExcel(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found.');

  const headerRow = ws.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = cellStr(cell).toLowerCase();
  });

  const col = (names) => {
    const idx = headers.findIndex((h) => h && names.some((n) => h.includes(n)));
    return idx >= 0 ? idx : null;
  };

  const dateCol = col(['date']);
  const amountCol = col(['amount', 'debit', 'expense']);
  const catCol = col(['category', 'cat', 'head']);
  const vendorCol = col(['vendor', 'payee', 'supplier']);
  const descCol = col(['description', 'narration', 'particular', 'remark', 'note']);
  const subCol = col(['sub-category', 'subcategory', 'sub category', 'sub_cat']);

  if (!dateCol || !amountCol) throw new Error('Need Date and Amount columns.');

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const date = parseDate(row.getCell(dateCol).value);
    const amount = parseAmount(row.getCell(amountCol).value);
    if (!date || amount <= 0.001) return;
    const cat = resolveExpenseCat(catCol ? cellStr(row.getCell(catCol)) : '');
    const vendor = vendorCol ? cellStr(row.getCell(vendorCol)) : '';
    const description = descCol ? cellStr(row.getCell(descCol)) : '';
    const sub_category = subCol ? cellStr(row.getCell(subCol)) || null : null;
    rows.push({
      date,
      amount: round2(amount),
      cat,
      vendor_name: vendor || 'Cash expense',
      description: description || null,
      sub_category,
    });
  });

  if (!rows.length) throw new Error('No cash expense rows found.');
  return rows;
}

export async function importCashExpenseRows(rows) {
  const apartment_id = portalState.access?.activeApartmentId;
  if (!apartment_id) throw new Error('No active apartment selected.');

  let saved = 0;
  for (const row of rows) {
    const payload = {
      id: crypto.randomUUID(),
      apartment_id,
      type: 'OUT',
      wallet: 'CASH',
      amount: row.amount,
      date: new Date(`${row.date}T12:00:00`).toISOString(),
      cat: row.cat,
      vendor_name: row.vendor_name,
      description: row.description,
      sub_category: row.sub_category,
      exclude_from_reports: false,
    };
    const result = await postFinanceMutation('saveTransaction', {
      apartment_id,
      transaction: payload,
      keepReceiptPaths: [],
      keepBankProofPaths: [],
      removeReceiptPaths: [],
      removeBankProofPaths: [],
      newReceiptFiles: [],
      newBankProofFiles: [],
    });
    applySavedTransactionLocally(result.transaction || payload);
    saved += 1;
  }
  return saved;
}

export async function downloadCashExpenseTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash expenses');
  ws.addRow(['Date', 'Amount', 'Category', 'Vendor', 'Description', 'Sub-category']);
  ws.addRow([
    new Date().toISOString().slice(0, 10),
    500,
    'Housekeeping material',
    'Local store',
    'Cleaning supplies',
    '',
  ]);
  ws.getRow(1).font = { bold: true };
  ws.columns = [
    { width: 14 },
    { width: 12 },
    { width: 22 },
    { width: 20 },
    { width: 28 },
    { width: 16 },
  ];
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Cash_expenses_template.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/"/g, '&quot;');

const renderTxnTable = (rows, emptyMsg) => {
  if (!rows.length) {
    return `<p class="fa-panel__hint">${esc(emptyMsg)}</p>`;
  }
  const body = rows.slice(0, 80).map((t) => {
    const d = t.date ? new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
    return `<tr>
      <td>${esc(d)}</td>
      <td>${esc(categoryDisplayLabel(t.cat))}</td>
      <td>${esc(t.vendor_name || t.description || '—')}</td>
      <td class="cash-float-amt">${formatMoney(amountOf(t))}</td>
    </tr>`;
  }).join('');
  const more = rows.length > 80
    ? `<p class="fa-panel__hint">Showing 80 of ${rows.length}.</p>`
    : '';
  return `<div class="fa-table-wrap"><table class="fa-pivot-table cash-float-table">
    <thead><tr><th>Date</th><th>Category</th><th>Vendor / note</th><th>Amount</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>${more}`;
};

export function renderCashFloatPage() {
  const root = document.getElementById('cash-float-root');
  if (!root) return;

  const store = computeCashFloatStore();
  const varClass = Math.abs(store.variance) < 1
    ? 'cash-float-ok'
    : store.variance > 0 ? 'cash-float-warn' : 'cash-float-bad';

  root.innerHTML = `
    <section class="ledger-kpi-bar cash-float-kpi" aria-label="Cash float store">
      <div class="ledger-kpi">
        <i class="fa-solid fa-building-columns" aria-hidden="true"></i>
        <div class="ledger-kpi__body">
          <span class="ledger-kpi__label">Funded (bank Petty Cash)</span>
          <span class="ledger-kpi__value">${formatMoney(store.funded)}</span>
          <span class="ledger-kpi__hint">${store.funding.length} record(s)</span>
        </div>
      </div>
      <div class="ledger-kpi">
        <i class="fa-solid fa-receipt" aria-hidden="true"></i>
        <div class="ledger-kpi__body">
          <span class="ledger-kpi__label">Cash expenses</span>
          <span class="ledger-kpi__value ledger-kpi__value--out">${formatMoney(store.spent)}</span>
          <span class="ledger-kpi__hint">${store.spends.length} record(s)</span>
        </div>
      </div>
      <div class="ledger-kpi">
        <i class="fa-solid fa-vault" aria-hidden="true"></i>
        <div class="ledger-kpi__body">
          <span class="ledger-kpi__label">Store remaining</span>
          <span class="ledger-kpi__value">${formatMoney(store.remaining)}</span>
          <span class="ledger-kpi__hint">Funded − expenses</span>
        </div>
      </div>
      <div class="ledger-kpi">
        <i class="fa-solid fa-wallet" aria-hidden="true"></i>
        <div class="ledger-kpi__body">
          <span class="ledger-kpi__label">Ledger petty cash</span>
          <span class="ledger-kpi__value">${formatMoney(store.walletCash)}</span>
          <span class="ledger-kpi__hint ${varClass}">Δ ${formatMoney(store.variance)}</span>
        </div>
      </div>
    </section>

    <p class="fa-panel__hint cash-float-blurb">
      This page is a <strong>ledger funding view</strong> (bank Petty Cash lines).
      Day-to-day cash spends belong under <strong>Bills &amp; receipts</strong> — import, attach, and bulk-link them to a funding line.
      Prefer that page for cash float remaining (funded − linked cash bills).
      Legacy cash-wallet ledger expenses still appear here until migrated.
      ${store.topUpTotal > 0 ? `Desk top-ups (Petty Inflow) on ledger: ${formatMoney(store.topUpTotal)}.` : ''}
    </p>

    <div class="cash-float-grid">
      <section class="fa-panel">
        <div class="fa-panel__head">
          <h3 class="fa-panel__title">Funding — bank Petty Cash</h3>
          <p class="fa-panel__hint">Classify bank withdrawals as Petty Cash in the ledger or bank reconciliation.</p>
        </div>
        ${renderTxnTable(store.funding, 'No bank Petty Cash funding yet.')}
      </section>
      <section class="fa-panel">
        <div class="fa-panel__head">
          <h3 class="fa-panel__title">Cash expenses</h3>
          <p class="fa-panel__hint">Manual Add Expense (Petty Cash wallet) or Excel import below.</p>
        </div>
        ${renderTxnTable(store.spends, 'No cash desk expenses yet.')}
      </section>
    </div>
  `;
}

export function initCashFloatPage() {
  const uploadBtn = document.getElementById('cash-float-upload-btn');
  const fileInput = document.getElementById('cash-float-file');
  const templateBtn = document.getElementById('cash-float-template-btn');
  const addBtn = document.getElementById('cash-float-add-expense');

  if (templateBtn && !templateBtn.dataset.wired) {
    templateBtn.dataset.wired = '1';
    templateBtn.addEventListener('click', () => {
      void downloadCashExpenseTemplate();
    });
  }

  if (addBtn && !addBtn.dataset.wired) {
    addBtn.dataset.wired = '1';
    addBtn.addEventListener('click', () => {
      window.openBillExpense?.();
    });
  }

  if (uploadBtn && fileInput && !uploadBtn.dataset.wired) {
    uploadBtn.dataset.wired = '1';
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      void withButtonBusy(uploadBtn, 'Importing…', async () => {
        try {
          const rows = await parseCashExpenseExcel(file);
          if (!confirm(`Import ${rows.length} cash expense(s) onto the Petty Cash wallet?`)) return;
          const n = await importCashExpenseRows(rows);
          renderCashFloatPage();
          window.processFinances?.();
          alert(`Imported ${n} cash expense(s).`);
        } catch (err) {
          alert(err?.message || 'Could not import cash expenses.');
        }
      });
    });
  }

  renderCashFloatPage();
}
