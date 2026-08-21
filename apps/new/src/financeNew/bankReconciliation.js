import { navigateFinance } from '../financeApp/session.js';
/** Finance-New clone of classic module (bankReconciliation.js) — Mongo-backed, isolated DOM (fn-*). */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
import { bindFinanceNewWindow } from './windowBridge.js';
/**
 * Phase 2.2 — Bank statement import and reconciliation
 */
import ExcelJS from 'exceljs';
import { portalState } from '../store.js';
import { matchFlatFromText, parseNoBrokerCollectionLines } from '../bulkCollectionImport.js';
import { withButtonBusy, setButtonBusy, clearButtonBusy } from '../buttonBusy.js';
import { postFnMutation } from './mongoMutations.js';
import {
    validatePassbookFiles,
    parsePassbookFiles,
    fetchPassbookJobs,
    markPassbookJobImported,
    passbookJobImportLabel,
} from '../passbookEvolyx.js';
import {
    ensureExternalConnectionsLoaded,
    isPassbookOcrConfigured,
} from '../externalConnections.js';
import {
    buildDayOrderHints,
    compareLineOrder,
    prepareImportedStatementLines,
} from '../bankStatementOrdering.js';
import { bankLineAmount, bankLineFingerprint, bankLineType, formatOcrRowDisplay } from '../bankStatementLineUtils.js';
import { can } from '../capabilities.js';
import {
    analyzePassbookJobLines,
    IMPORT_LINE_STATUS,
    IMPORT_LINE_STATUS_LABEL,
} from '../passbookJobImportAnalysis.js';
import {
    getMatchedTransactionIds,
    isTransactionReconciled,
    getBankOpeningConfig,
    getStatementLinesChronological,
    annotateStatementLineBalances,
    getCalculatedBankBalance,
    getPassbookClosingBalance,
    getPostedPassbookBalance,
    getStatementClosingBalance,
    getBankBalanceReconciliation,
    getUnmatchedBankLines,
} from './bankStatementQueries.js';
import { getLedgerBankBalance } from './ledgerBalance.js';

export {
    getMatchedTransactionIds,
    isTransactionReconciled,
    getBankOpeningConfig,
    getStatementLinesChronological,
    annotateStatementLineBalances,
    getCalculatedBankBalance,
    getPassbookClosingBalance,
    getPostedPassbookBalance,
    getStatementClosingBalance,
    getBankBalanceReconciliation,
    getUnmatchedBankLines,
};
import {
    BANK_REJECT_CAT,
    defaultExcludeFromReports,
} from '../expenseCategories.js';
import {
    buildCategoryOptions,
    buildSubCategoryOptions,
    registerCustomCategory,
    registerCustomSubCategory,
} from '../classifyOptions.js';
import {
    isExactListMatch,
    isKnownClassifyInput,
    wireClassifyCombobox,
    setClassifyInputState,
} from '../classifyCombobox.js';
import {
    findMatchingRule,
    sortClassificationRules,
    suggestRuleMatchText,
} from '../bankClassificationRules.js';

const canDeleteAccounts = () => can('accounts.delete');

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

let activeBankReconTab = null;

const BANK_RECON_TAB_PANELS = {
    import: 'fn-bank-recon-import-panel',
    passbook: 'fn-bank-recon-passbook-panel',
    opening: 'fn-bank-recon-opening-panel',
};

const bankReconRoot = () => document.getElementById('fn-subview-bank-recon');

const setActiveBankReconTab = (tabKey) => {
    activeBankReconTab = tabKey || null;
    const root = bankReconRoot();
    (root || document).querySelectorAll('.bank-recon-source-tab').forEach((btn) => {
        const on = btn.dataset.bankReconTab === tabKey;
        btn.classList.toggle('bank-recon-source-tab--active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.entries(BANK_RECON_TAB_PANELS).forEach(([key, panelId]) => {
        const panel = document.getElementById(panelId);
        if (panel) panel.hidden = key !== tabKey;
    });
};

const wireBankReconSourceTabs = () => {
    const root = bankReconRoot()?.querySelector('.bank-recon-sources')
        || document.querySelector('#fn-subview-bank-recon .bank-recon-sources');
    if (!root || root.dataset.tabsWired === '1') return;
    root.dataset.tabsWired = '1';
    root.querySelectorAll('.bank-recon-source-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.bankReconTab;
            setActiveBankReconTab(activeBankReconTab === key ? null : key);
        });
    });
};

/** @deprecated use setActiveBankReconTab */
const openBankReconSourcePanel = (panelId) => {
    const key = Object.entries(BANK_RECON_TAB_PANELS).find(([, id]) => id === panelId)?.[0];
    if (key) setActiveBankReconTab(key);
};

const formatAmountInput = (n) => {
    const v = parseFloat(n || 0);
    return v > 0.001 ? String(v) : '';
};

const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const formatDisplayDate = (isoDate) => {
    if (!isoDate) return '';
    const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return String(isoDate || '');
    const [, year, month, day] = match;
    // Non-breaking hyphens so DD-MM-YY never wraps mid-date in narrow columns
    return `${day}\u2011${month}\u2011${year.slice(-2)}`;
};

const normalizeDateParts = (year, monthIndex, day) => {
    const y = parseInt(year, 10);
    const m = parseInt(monthIndex, 10);
    const d = parseInt(day, 10);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
    const dt = new Date(Date.UTC(y, m, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const parseEditableDate = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

    let match = raw.match(/^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{2}|\d{4})$/);
    if (match) {
        const [, day, mon, year] = match;
        const monthIndex = MONTHS_SHORT.indexOf(mon.toLowerCase());
        if (monthIndex < 0) return null;
        return normalizeDateParts(year.length === 2 ? `20${year}` : year, monthIndex, day);
    }

    match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
    if (match) {
        const [, day, month, year] = match;
        return normalizeDateParts(year.length === 2 ? `20${year}` : year, parseInt(month, 10) - 1, day);
    }

    return null;
};

const parseDate = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const parts = s.split(/[\/\-]/);
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

const normalizeDesc = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export { bankLineAmount, bankLineFingerprint, bankLineType } from '../bankStatementLineUtils.js';

export function dedupeBankImportLines(lines) {
    const existing = new Set((fnFinances().bankStatementLines || []).map(bankLineFingerprint));
    const seen = new Set();
    const unique = [];
    let skippedExisting = 0;
    let skippedBatch = 0;

    for (const line of lines) {
        const fp = bankLineFingerprint(line);
        if (existing.has(fp)) {
            skippedExisting += 1;
            continue;
        }
        if (seen.has(fp)) {
            skippedBatch += 1;
            continue;
        }
        seen.add(fp);
        unique.push(line);
    }

    return {
        unique,
        skipped: skippedExisting + skippedBatch,
        skippedExisting,
        skippedBatch,
    };
}

const bankStatementImportById = () => new Map(
    (fnFinances().bankStatementImports || []).map((row) => [row.id, row]),
);

/** Statement / passbook balance on a row (Excel Balance column or Evolyx OCR). */
const passbookRowBalance = (line) => {
    if (line?.balance == null || line.balance === '') return null;
    const value = parseFloat(line.balance);
    return Number.isFinite(value) ? value : null;
};

const detectStatementColumns = (headers) => {
    const normalized = headers.map((h) => String(h || '').trim().toLowerCase());
    const col = (names) => {
        const idx = normalized.findIndex((h) => names.some((n) => h.includes(n)));
        return idx >= 0 ? idx : -1;
    };
    return {
        dateCol: col(['date']),
        descCol: col(['description', 'narration', 'particular']),
        debitCol: col(['debit', 'withdraw']),
        creditCol: col(['credit', 'deposit']),
        balanceCol: col(['balance']),
    };
};

const buildStatementLinesFromRows = (headers, rows) => {
    const { dateCol, descCol, debitCol, creditCol, balanceCol } = detectStatementColumns(headers);
    if (dateCol < 0) {
        throw new Error('Could not find Date column. Use template headers: Date, Description, Debit, Credit, Balance.');
    }

    const lines = [];
    rows.forEach((row, index) => {
        const lineDate = parseDate(row[dateCol]);
        if (!lineDate) return;
        lines.push({
            line_date: lineDate,
            description: descCol >= 0 ? String(row[descCol] || '').trim() : '',
            debit: debitCol >= 0 ? parseAmount(row[debitCol]) : 0,
            credit: creditCol >= 0 ? parseAmount(row[creditCol]) : 0,
            balance: balanceCol >= 0 ? parseAmount(row[balanceCol]) : null,
            source_row_index: index,
        });
    });

    if (!lines.length) throw new Error('No data rows found.');
    return lines;
};

const parseCsvRows = (text) => {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += ch;
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(cell);
            cell = '';
        } else if (ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else if (ch !== '\r') {
            cell += ch;
        }
    }

    if (cell !== '' || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
};

export async function parseBankStatementFile(file) {
    const name = String(file?.name || '').toLowerCase();
    if (name.endsWith('.csv')) {
        const text = await file.text();
        const rows = parseCsvRows(text);
        if (rows.length < 2) throw new Error('CSV file is empty or missing data rows.');
        const [headers, ...dataRows] = rows;
        return buildStatementLinesFromRows(headers, dataRows);
    }
    if (name.endsWith('.xls')) {
        throw new Error('Legacy .xls files are not supported yet. Save the file as .xlsx or .csv and import again.');
    }

    const wb = new ExcelJS.Workbook();
    const buf = await file.arrayBuffer();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('No worksheet found in file.');
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col - 1] = String(cell.value || '').trim();
    });
    const dataRows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => {
            cells[col - 1] = cell.value;
        });
        dataRows.push(cells);
    });
    return buildStatementLinesFromRows(headers, dataRows);
}

export async function importBankStatement(file, lines, { fileLabel, skipDedupe = false, pull = true } = {}) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const { unique, skipped, skippedExisting, skippedBatch } = skipDedupe
        ? { unique: lines, skipped: 0, skippedExisting: 0, skippedBatch: 0 }
        : dedupeBankImportLines(lines);
    if (!unique.length) {
        return { importId: null, count: 0, skipped, skippedExisting, skippedBatch };
    }

    const bank_account_id = fnFinances().bankAccount?.id || null;
    const opening = getBankOpeningConfig();
    const orderedLines = prepareImportedStatementLines(unique, opening);
    const result = await postFnMutation('importBankStatement', {
        apartment_id,
        bank_account_id,
        file_name: fileLabel || file?.name || 'import.xlsx',
        lines: orderedLines,
    });
    return { importId: result.importId, count: result.count, skipped, skippedExisting, skippedBatch };
}

const showRecalcStatus = (message = 'Recalculating calculated balances… please wait.') => {
    document.querySelectorAll('.bank-recon-recalc-status').forEach((el) => {
        el.hidden = false;
        el.textContent = message;
    });
};

const hideRecalcStatus = () => {
    document.querySelectorAll('.bank-recon-recalc-status').forEach((el) => {
        el.hidden = true;
    });
};

/** Save mutation first, then refresh state with visible recalc feedback. */
async function saveThenRecalculate(btn, savingLabel, onSave) {
    const snapshot = setButtonBusy(btn, savingLabel);
    try {
        const result = await onSave();
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Recalculating…';
        showRecalcStatus();
        return result;
    } finally {
        hideRecalcStatus();
        clearButtonBusy(btn, snapshot);
    }
}

async function runBankReconRecalculate(btn) {
    const opening = getBankOpeningConfig();
    if (opening.amount == null) {
        alert('Set the opening balance first — calculated balances need a starting point.');
        return false;
    }
    await saveThenRecalculate(btn, 'Recalculating…', () => recalculateBankStatementBalances());
    renderBankReconciliation();
    window.renderCashLedger?.();
    return true;
}

export async function saveBankOpeningBalance(date, amount, { pull = true } = {}) {
    const apt = portalState.access?.activeApartmentId;
    if (!apt) throw new Error('Select an apartment first.');
    if (!date) throw new Error('Enter the opening balance date.');
    if (amount == null || Number.isNaN(amount)) throw new Error('Enter the opening balance amount.');

    const bank = { ...(fnFinances().bankAccount || {}) };
    await postFnMutation('saveBankOpeningBalance', {
        apartment_id: apt,
        date,
        amount,
        bank,
    });
    // Keep local FN state in sync even if boot payload is momentarily stale.
    fnFinances().bankAccount = {
        ...bank,
        opening_balance: parseFloat(amount),
        opening_balance_date: date,
    };
    const fnAdmin = ensureFnClassicShape().admin;
    if (fnAdmin) fnAdmin.bankAccount = fnFinances().bankAccount;
}

export async function reorderBankStatementLines(updates = [], { recalculate = false } = {}) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');
    if (!updates.length) throw new Error('No rows to reorder.');
    await postFnMutation('reorderBankStatementLines', {
        apartment_id,
        updates,
        recalculate_balances: recalculate,
    });
    // Always apply locally so same-day sort switches to manual line_order immediately.
    patchLocalLineOrder(updates);
    if (recalculate) {
        showRecalcStatus();
        hideRecalcStatus();
    }
}

export async function recalculateBankStatementBalances() {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');
    await postFnMutation('recalculateBankStatementBalances', { apartment_id });
}

const patchLocalLineOrder = (updates = []) => {
    const byId = new Map(updates.map((u) => [u.id, u]));
    for (const line of fnFinances().bankStatementLines || []) {
        if (!byId.has(line.id)) continue;
        const patch = byId.get(line.id);
        line.line_order = patch.line_order;
        line.order_source = patch.order_source || 'manual';
        // Drop stale cached balance — UI recomputes from current line_order.
        line.computed_balance = null;
    }
};

export const getUnmatchedLedgerTxns = (typeFilter = null) => {
    const matched = getMatchedTransactionIds();
    return (fnFinances().txns || []).filter((t) =>
        (t.wallet || '').toUpperCase() === 'BANK'
        && !matched.has(t.id)
        && (!typeFilter || t.type === typeFilter),
    );
};

let nobrokerDumpLines = [];
let nobrokerFileName = '';
let bankReconSortState = { key: 'line_date', dir: 'asc' };
/** passbookBalance toggles the joined Passbook / calc column (calculatedBalance kept in sync). */
let bankReconVisibleColumns = {
    passbookBalance: true,
    calculatedBalance: true,
    ocrRow: false,
    rowOrder: false,
};
/** Per-table filters on bank reconciliation. */
let bankReconFilters = {
    work: { q: '', type: 'all', mismatchOnly: false },
    processed: { q: '', status: 'all', type: 'all', mismatchOnly: false },
    ledger: { q: '', type: 'all' },
};
let bankReconMismatchNav = { work: -1, processed: -1 };
let bankReconFilterSearchTimer = null;
const BANK_RECON_TABLE_HEIGHT_KEY = 'bankReconTableHeightPx_v4';
/** Original scroll area was capped at 640px; minimum default is +250px. */
const BANK_RECON_TABLE_MIN_HEIGHT = 890;
const BANK_RECON_TABLE_HEIGHT_PRESETS = {
    compact: 650,
    medium: 890,
    tall: 1150,
};
let bankReconTableHeightControlsReady = false;

const initBankReconTableHeightControls = (linesEl) => {
    if (!linesEl || bankReconTableHeightControlsReady) return;
    bankReconTableHeightControlsReady = true;

    linesEl.addEventListener('click', (e) => {
        const preset = e.target.closest('.bank-recon-height-preset');
        if (!preset) return;
        setBankReconTableHeightPreset(preset.dataset.heightPreset);
        preset.closest('details')?.removeAttribute('open');
    });
};

let passbookJobsModalTimer = null;

const getDefaultBankReconTableHeight = () => BANK_RECON_TABLE_MIN_HEIGHT;

const getFullBankReconTableHeight = () => Math.max(BANK_RECON_TABLE_MIN_HEIGHT, window.innerHeight - 100);

const getBankReconTableShell = () => document.getElementById('fn-bank-recon-table-shell');

const applyBankReconTableHeight = (px, { persist = true } = {}) => {
    const shell = getBankReconTableShell();
    if (!shell || !Number.isFinite(px)) return;
    const height = Math.max(BANK_RECON_TABLE_MIN_HEIGHT, Math.min(getFullBankReconTableHeight(), Math.round(px)));
    shell.style.setProperty('height', `${height}px`, 'important');
    if (persist) localStorage.setItem(BANK_RECON_TABLE_HEIGHT_KEY, String(height));
};

const restoreBankReconTableHeight = () => {
    const shell = getBankReconTableShell();
    if (!shell) return;
    const saved = parseInt(localStorage.getItem(BANK_RECON_TABLE_HEIGHT_KEY), 10);
    if (Number.isFinite(saved) && saved >= BANK_RECON_TABLE_MIN_HEIGHT) {
        applyBankReconTableHeight(saved, { persist: false });
        return;
    }
    shell.style.removeProperty('height');
};

const setBankReconTableHeightPreset = (preset) => {
    const height = preset === 'full'
        ? getFullBankReconTableHeight()
        : BANK_RECON_TABLE_HEIGHT_PRESETS[preset] || getDefaultBankReconTableHeight();
    applyBankReconTableHeight(height);
};

const wireBankReconTableResize = () => {
    restoreBankReconTableHeight();
};

let latestPassbookJobs = [];
let passbookJobDetailState = { job: null, analysis: null, filter: 'all' };

export const getNoBrokerDump = () => ({ lines: nobrokerDumpLines, fileName: nobrokerFileName });

export const setNoBrokerDump = (lines, fileName = '') => {
    nobrokerDumpLines = lines || [];
    nobrokerFileName = fileName || '';
};

export const clearNoBrokerDump = () => {
    nobrokerDumpLines = [];
    nobrokerFileName = '';
};

const formatJobTimestamp = (value) => {
    if (!value) return '—';
    const dt = new Date(value);
    return Number.isNaN(dt.getTime())
        ? String(value)
        : dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

const passbookJobStatusLabel = (status) => {
    const raw = String(status || 'INITIALIZED').toUpperCase();
    if (raw === 'SUBMITTED') return 'Queued';
    if (raw === 'PROCESSING') return 'Processing';
    if (raw === 'COMPLETED') return 'Completed';
    if (raw === 'FAILED') return 'Failed';
    if (raw === 'IMPORTED') return 'Imported';
    return 'Initialized';
};

const passbookJobStatusClass = (status) => `passbook-job-status--${String(status || 'INITIALIZED').toLowerCase()}`;

const passbookJobFileNames = (job) => (
    Array.isArray(job.file_names) && job.file_names.length ? job.file_names.join(', ') : 'Passbook files'
);

const renderPassbookJobsTable = (jobs) => {
    if (!Array.isArray(jobs) || !jobs.length) return '';
    const body = jobs.map((job) => {
        const fileNames = passbookJobFileNames(job);
        const canImport = (job.status === 'COMPLETED' || job.status === 'IMPORTED') && job.mapped_line_count > 0;
        const canDetail = job.mapped_line_count > 0 && (job.status === 'COMPLETED' || job.status === 'IMPORTED');
        const importCount = job.import_count || 0;
        const importedAt = job.imported_at ? formatJobTimestamp(job.imported_at) : '—';
        const completedAt = job.completed_at ? formatJobTimestamp(job.completed_at) : '—';
        const importDisabled = job.status === 'IMPORTED' && importCount >= (job.mapped_line_count || 0);
        return `
          <tr class="passbook-jobs-table__row" data-job-id="${esc(job.id)}">
            <td class="passbook-jobs-table__cell passbook-jobs-table__cell--file">
              <div class="passbook-jobs-table__file">${esc(fileNames)}</div>
              <div class="passbook-jobs-table__meta">Created ${formatJobTimestamp(job.created_at)}${job.execution_id ? ` · ${esc(job.execution_id)}` : ''}</div>
            </td>
            <td class="passbook-jobs-table__cell">
              <span class="passbook-job-status ${passbookJobStatusClass(job.status)}">${passbookJobStatusLabel(job.status)}</span>
            </td>
            <td class="passbook-jobs-table__cell passbook-jobs-table__cell--num">${job.mapped_line_count || 0}</td>
            <td class="passbook-jobs-table__cell passbook-jobs-table__cell--num">${importCount || '—'}</td>
            <td class="passbook-jobs-table__cell">${esc(completedAt)}</td>
            <td class="passbook-jobs-table__cell">${esc(importedAt)}</td>
            <td class="passbook-jobs-table__cell passbook-jobs-table__cell--actions">
              <div class="passbook-jobs-table__actions">
                ${canDetail ? `<button type="button" class="btn btn-outline btn--small btn--icon passbook-job-detail-btn" data-job="${esc(job.id)}" title="View mapped vs imported rows" aria-label="View row details"><i class="fa-solid fa-table-list" aria-hidden="true"></i></button>` : ''}
                ${canImport ? `<button type="button" class="btn btn-primary btn--small btn--icon bank-recon-import-passbook-job" data-job="${esc(job.id)}" title="${importDisabled ? 'All mapped rows imported' : 'Import into bank reconciliation'}" aria-label="Import rows"${importDisabled ? ' disabled' : ''}><i class="fa-solid fa-file-import" aria-hidden="true"></i></button>` : ''}
              </div>
            </td>
          </tr>
          ${job.last_error ? `<tr class="passbook-jobs-table__row passbook-jobs-table__row--error"><td colspan="7" class="passbook-jobs-table__error">${esc(job.last_error)}</td></tr>` : ''}`;
    }).join('');

    return `
      <div class="passbook-jobs-table-wrap">
        <table class="passbook-jobs-table">
          <thead>
            <tr>
              <th>Files</th>
              <th>Status</th>
              <th class="passbook-jobs-table__th--num">Mapped</th>
              <th class="passbook-jobs-table__th--num">Imported</th>
              <th>Completed</th>
              <th>Imported at</th>
              <th class="passbook-jobs-table__th--actions"></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
};

const passbookJobDetailStatusClass = (status) => `passbook-job-detail-status--${status}`;

const renderPassbookJobDetailModal = (job, analysis, filter = 'all') => {
    const fileNames = passbookJobFileNames(job);
    const { rows, summary } = analysis;
    const filteredRows = filter === 'duplicates'
        ? rows.filter((row) =>
            row.status === IMPORT_LINE_STATUS.SKIPPED_EXISTING
            || row.status === IMPORT_LINE_STATUS.SKIPPED_BATCH,
        )
        : filter === 'imported'
            ? rows.filter((row) => row.status === IMPORT_LINE_STATUS.IMPORTED)
            : filter === 'ready'
                ? rows.filter((row) => row.status === IMPORT_LINE_STATUS.READY)
                : rows;

    const tableRows = filteredRows.map((row) => {
        const line = row.line;
        const isDup = row.status === IMPORT_LINE_STATUS.SKIPPED_EXISTING
            || row.status === IMPORT_LINE_STATUS.SKIPPED_BATCH;
        const canForce = isDup || row.status === IMPORT_LINE_STATUS.READY;
        const amt = bankLineAmount(line);
        const type = bankLineType(line);
        const amtLabel = type === 'IN' ? `+${formatMoney(amt)}` : `-${formatMoney(amt)}`;
        return `
          <tr class="passbook-job-detail-table__row passbook-job-detail-table__row--${row.status}" data-row-index="${row.index}">
            <td class="passbook-job-detail-table__cell passbook-job-detail-table__cell--check">
              ${canForce ? `<input type="checkbox" class="passbook-job-detail-check" data-row-index="${row.index}" aria-label="Select row" />` : ''}
            </td>
            <td class="passbook-job-detail-table__cell passbook-job-detail-table__cell--num">${formatOcrRowDisplay(line) ?? (row.index + 1)}</td>
            <td class="passbook-job-detail-table__cell">${esc(formatDisplayDate(line.line_date))}</td>
            <td class="passbook-job-detail-table__cell passbook-job-detail-table__cell--desc">${esc(line.description || '—')}</td>
            <td class="passbook-job-detail-table__cell passbook-job-detail-table__cell--num ${type === 'IN' ? 'bank-recon-amt--in' : 'bank-recon-amt--out'}">${amtLabel}</td>
            <td class="passbook-job-detail-table__cell passbook-job-detail-table__cell--num">${line.balance != null ? formatMoney(line.balance) : '—'}</td>
            <td class="passbook-job-detail-table__cell">
              <span class="passbook-job-detail-status ${passbookJobDetailStatusClass(row.status)}" title="${esc(row.reason)}">${IMPORT_LINE_STATUS_LABEL[row.status]}</span>
            </td>
          </tr>`;
    }).join('');

    return `
      <div class="passbook-job-detail__summary">
        <div class="passbook-job-detail__metric"><span class="label">Mapped</span><span class="value">${summary.mapped}</span></div>
        <div class="passbook-job-detail__metric"><span class="label">Imported rows</span><span class="value">${summary.imported}</span></div>
        <div class="passbook-job-detail__metric"><span class="label">Duplicates</span><span class="value">${summary.duplicates}</span></div>
        <div class="passbook-job-detail__metric"><span class="label">Ready</span><span class="value">${summary.ready}</span></div>
      </div>
      ${summary.importCountRecorded && summary.importCountRecorded !== summary.imported
        ? `<p class="passbook-job-detail__note">Bank import recorded <strong>${summary.importCountRecorded}</strong> row(s) on import — per-row replay shows <strong>${summary.imported}</strong> unique imported line(s).</p>`
        : ''}
      <div class="passbook-job-detail__toolbar">
        <div class="passbook-job-detail__filters" role="tablist" aria-label="Row filter">
          <button type="button" class="passbook-job-detail-filter${filter === 'all' ? ' passbook-job-detail-filter--active' : ''}" data-filter="all">All (${summary.mapped})</button>
          <button type="button" class="passbook-job-detail-filter${filter === 'duplicates' ? ' passbook-job-detail-filter--active' : ''}" data-filter="duplicates">Duplicates (${summary.duplicates})</button>
          <button type="button" class="passbook-job-detail-filter${filter === 'imported' ? ' passbook-job-detail-filter--active' : ''}" data-filter="imported">Imported (${summary.imported})</button>
          <button type="button" class="passbook-job-detail-filter${filter === 'ready' ? ' passbook-job-detail-filter--active' : ''}" data-filter="ready">Ready (${summary.ready})</button>
        </div>
        <div class="passbook-job-detail__bulk">
          <button type="button" class="btn btn-outline btn--small" id="passbook-job-detail-select-dupes">Select duplicates</button>
          <button type="button" class="btn btn-primary btn--small" id="passbook-job-detail-force-import" disabled>
            <i class="fa-solid fa-file-import" aria-hidden="true"></i> Import selected
          </button>
        </div>
      </div>
      <p class="passbook-job-detail__hint">Compare OCR mapped rows with what reached bank reconciliation. Select duplicate rows that were skipped incorrectly, then import them.</p>
      <div class="passbook-job-detail-table-wrap">
        <table class="passbook-job-detail-table">
          <thead>
            <tr>
              <th class="passbook-job-detail-table__th--check">
                <input type="checkbox" id="passbook-job-detail-select-all" aria-label="Select all visible rows" />
              </th>
              <th class="passbook-job-detail-table__th--num">OCR #</th>
              <th>Date</th>
              <th>Description</th>
              <th class="passbook-job-detail-table__th--num">Amount</th>
              <th class="passbook-job-detail-table__th--num">Balance</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${tableRows || `<tr><td colspan="7" class="passbook-job-detail-table__empty">No rows in this filter.</td></tr>`}</tbody>
        </table>
      </div>
      <input type="hidden" id="passbook-job-detail-job-id" value="${esc(job.id)}" />
      <input type="hidden" id="passbook-job-detail-file-label" value="${esc(passbookJobImportLabel(job))}" />`;
};

const updatePassbookJobsBadge = (jobs) => {
    const badge = document.getElementById('fn-bank-recon-passbook-jobs-badge');
    if (!badge) return;
    const pending = (jobs || []).filter((job) => ['INITIALIZED', 'SUBMITTED', 'PROCESSING'].includes(String(job.status || '').toUpperCase())).length;
    badge.hidden = pending <= 0;
    badge.textContent = String(pending);
};

const getVisibleBalanceColumns = () => {
    const joined = !!bankReconVisibleColumns.passbookBalance || !!bankReconVisibleColumns.calculatedBalance;
    return {
        passbookBalance: joined,
        calculatedBalance: joined,
        ocrRow: !!bankReconVisibleColumns.ocrRow,
        rowOrder: !!bankReconVisibleColumns.rowOrder,
    };
};

const lineMatchesTextFilter = (line, q) => {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return true;
    const hay = [
        line.description,
        line.cat,
        line.sub_category,
        line.vendor_name,
        line.line_date,
        line.match_status,
    ].map((v) => String(v || '').toLowerCase()).join(' ');
    return hay.includes(needle);
};

const filterWorkLines = (lines) => {
    const f = bankReconFilters.work;
    return lines.filter((line) => {
        if (f.mismatchOnly && !line.passbookMismatch) return false;
        if (f.type === 'IN' || f.type === 'OUT') {
            if (bankLineType(line) !== f.type) return false;
        }
        return lineMatchesTextFilter(line, f.q);
    });
};

const filterProcessedLines = (lines) => {
    const f = bankReconFilters.processed;
    return lines.filter((line) => {
        if (f.mismatchOnly && !line.passbookMismatch) return false;
        if (f.status === 'MATCHED' || f.status === 'IGNORED') {
            if (line.match_status !== f.status) return false;
        }
        if (f.type === 'IN' || f.type === 'OUT') {
            if (bankLineType(line) !== f.type) return false;
        }
        return lineMatchesTextFilter(line, f.q);
    });
};

const filterLedgerTxns = (txns) => {
    const f = bankReconFilters.ledger;
    return txns.filter((t) => {
        if (f.type === 'IN' || f.type === 'OUT') {
            if (t.type !== f.type) return false;
        }
        const needle = String(f.q || '').trim().toLowerCase();
        if (!needle) return true;
        const hay = [t.description, t.cat, t.sub_category, t.vendor_name, t.type]
            .map((v) => String(v || '').trim().toLowerCase()).join(' ');
        return hay.includes(needle);
    });
};

const renderFilterBar = (scope, { mismatchCount = 0, showStatus = false, showType = true, showMismatch = false } = {}) => {
    const f = bankReconFilters[scope] || { q: '', type: 'all', status: 'all', mismatchOnly: false };
    const statusOpts = showStatus
        ? `<select class="bank-recon-filter-status expense-combobox" data-filter-scope="${scope}" aria-label="Status filter">
            <option value="all"${f.status === 'all' ? ' selected' : ''}>All statuses</option>
            <option value="MATCHED"${f.status === 'MATCHED' ? ' selected' : ''}>Matched</option>
            <option value="IGNORED"${f.status === 'IGNORED' ? ' selected' : ''}>Ignored</option>
          </select>`
        : '';
    const typeOpts = showType
        ? `<select class="bank-recon-filter-type expense-combobox" data-filter-scope="${scope}" aria-label="Type filter">
            <option value="all"${f.type === 'all' ? ' selected' : ''}>All types</option>
            <option value="IN"${f.type === 'IN' ? ' selected' : ''}>Income</option>
            <option value="OUT"${f.type === 'OUT' ? ' selected' : ''}>Expense</option>
          </select>`
        : '';
    const mismatchControls = showMismatch
        ? `<label class="bank-recon-filter-mismatch-label">
            <input type="checkbox" class="bank-recon-filter-mismatch" data-filter-scope="${scope}" ${f.mismatchOnly ? 'checked' : ''} />
            <span>Mismatches only</span>
          </label>
          <span class="bank-recon-filter-mismatch-meta" title="${scope === 'work' ? 'Unmatched row: ledger running calc ≠ passbook on this row' : 'Posted row: historical statement-order calc ≠ passbook'}">
            ${mismatchCount} mismatch${mismatchCount === 1 ? '' : 'es'}
          </span>
          <button type="button" class="btn btn-outline btn--small bank-recon-mismatch-nav" data-filter-scope="${scope}" data-mismatch-dir="-1" ${mismatchCount ? '' : 'disabled'} title="Previous mismatch">
            <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
          </button>
          <button type="button" class="btn btn-outline btn--small bank-recon-mismatch-nav" data-filter-scope="${scope}" data-mismatch-dir="1" ${mismatchCount ? '' : 'disabled'} title="Next mismatch">
            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i> Next
          </button>`
        : '';
    return `
      <div class="bank-recon-filter-bar" data-filter-scope="${scope}">
        <input type="search" class="bank-recon-filter-q expense-combobox" data-filter-scope="${scope}" placeholder="Search…" value="${esc(f.q || '')}" aria-label="Search rows" />
        ${typeOpts}
        ${statusOpts}
        ${mismatchControls}
      </div>`;
};

const focusMismatchRow = (scope, dir) => {
    const linesRoot = document.getElementById('fn-bank-recon-lines');
    if (!linesRoot) return;
    const sel = scope === 'processed'
        ? '.bank-recon-processed tr.bank-recon-table__row--mismatch'
        : '.bank-recon-table-shell tr.bank-recon-table__row--mismatch, .bank-recon-work-table tr.bank-recon-table__row--mismatch';
    let rows = [...linesRoot.querySelectorAll(sel)];
    if (!rows.length && !bankReconFilters[scope]?.mismatchOnly) {
        bankReconFilters[scope] = { ...bankReconFilters[scope], mismatchOnly: true };
        renderBankReconciliation();
        requestAnimationFrame(() => focusMismatchRow(scope, dir));
        return;
    }
    if (!rows.length) return;
    const step = dir < 0 ? -1 : 1;
    let idx = bankReconMismatchNav[scope] ?? -1;
    idx = (idx + step + rows.length) % rows.length;
    bankReconMismatchNav[scope] = idx;
    const row = rows[idx];
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('bank-recon-table__row--flash');
    setTimeout(() => row.classList.remove('bank-recon-table__row--flash'), 1400);
};

const wireBankReconFiltersOnce = () => {
    if (document.documentElement.dataset.fnBankReconFiltersWired === '1') return;
    document.documentElement.dataset.fnBankReconFiltersWired = '1';

    const onFilterChange = (scope, patch, { debounce = false } = {}) => {
        if (!bankReconFilters[scope]) return;
        bankReconFilters[scope] = { ...bankReconFilters[scope], ...patch };
        bankReconMismatchNav[scope] = -1;
        const run = () => {
            const active = document.activeElement;
            const activeScope = active?.dataset?.filterScope;
            const isSearch = active?.classList?.contains('bank-recon-filter-q');
            const selStart = active?.selectionStart;
            const selEnd = active?.selectionEnd;
            renderBankReconciliation();
            if (isSearch && activeScope) {
                const next = document.querySelector(`.bank-recon-filter-q[data-filter-scope="${activeScope}"]`);
                if (next) {
                    next.focus();
                    if (typeof selStart === 'number') {
                        try { next.setSelectionRange(selStart, selEnd ?? selStart); } catch { /* ignore */ }
                    }
                }
            }
        };
        if (debounce) {
            clearTimeout(bankReconFilterSearchTimer);
            bankReconFilterSearchTimer = setTimeout(run, 280);
            return;
        }
        run();
    };

    document.addEventListener('input', (e) => {
        const q = e.target.closest?.('.bank-recon-filter-q');
        if (!q) return;
        onFilterChange(q.dataset.filterScope, { q: q.value }, { debounce: true });
    });
    document.addEventListener('change', (e) => {
        const typeEl = e.target.closest?.('.bank-recon-filter-type');
        if (typeEl) {
            onFilterChange(typeEl.dataset.filterScope, { type: typeEl.value || 'all' });
            return;
        }
        const statusEl = e.target.closest?.('.bank-recon-filter-status');
        if (statusEl) {
            onFilterChange(statusEl.dataset.filterScope, { status: statusEl.value || 'all' });
            return;
        }
        const mm = e.target.closest?.('.bank-recon-filter-mismatch');
        if (mm) {
            onFilterChange(mm.dataset.filterScope, { mismatchOnly: !!mm.checked });
        }
    });
    document.addEventListener('click', (e) => {
        const jump = e.target.closest?.('.bank-recon-mismatch-jump');
        if (jump) {
            let scope = jump.dataset.filterScope || 'work';
            if (scope === 'auto') {
                const annotated = annotateStatementLineBalances();
                const workHas = annotated.some((l) => l.match_status === 'UNMATCHED' && l.passbookMismatch);
                scope = workHas ? 'work' : 'processed';
            }
            bankReconFilters[scope] = { ...bankReconFilters[scope], mismatchOnly: true };
            if (scope === 'work') setActiveBankReconTab(null);
            renderBankReconciliation();
            requestAnimationFrame(() => focusMismatchRow(scope, 1));
            return;
        }
        const btn = e.target.closest?.('.bank-recon-mismatch-nav');
        if (!btn || btn.disabled) return;
        const scope = btn.dataset.filterScope;
        const dir = parseInt(btn.dataset.mismatchDir, 10) || 1;
        focusMismatchRow(scope, dir);
    });
};

export const getDateTolerance = () => {
    const raw = document.getElementById('fn-bank-recon-date-tolerance')?.value
        ?? document.getElementById('fn-fa-date-tolerance')?.value
        ?? '3';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 3;
};

const lineAmount = (line) => {
    const credit = parseFloat(line?.credit || 0);
    const debit = parseFloat(line?.debit || 0);
    if (credit > 0.001) return { amount: credit, type: 'IN' };
    if (debit > 0.001) return { amount: debit, type: 'OUT' };
    return null;
};

const txnDateStr = (txn) => new Date(txn.date).toISOString().slice(0, 10);

const daysDiff = (dateA, dateB) => {
    const a = new Date(`${dateA}T12:00:00`);
    const b = new Date(`${dateB}T12:00:00`);
    return Math.abs((a - b) / 86400000);
};

const inferIncomeCategory = (desc) => {
    const u = String(desc || '').toUpperCase();
    if (/INTEREST|\bINT\b/.test(u)) return 'Interest';
    if (/NOBROKER|MAINT|RENT|COLLECT|FLAT/.test(u)) return 'Maintenance Collection';
    return 'Other Income';
};

const inferBankPaymentType = (desc) => {
    const u = String(desc || '').toUpperCase();
    if (/UPI|GPAY|PHONEPE|PAYTM/.test(u)) return 'UPI';
    if (/NEFT|IMPS|RTGS/.test(u)) return 'NEFT';
    if (/CHQ|CHEQUE/.test(u)) return 'CHEQUE';
    return 'NEFT';
};

const statementReference = (lineId) => `STMT-${String(lineId || '').slice(0, 8)}`;

const referenceExists = (ref) => {
    const key = String(ref || '').trim().toLowerCase();
    if (!key) return false;
    return (fnFinances().txns || []).some(
        (t) => (t.bank_reference || '').trim().toLowerCase() === key,
    );
};

export const findNoBrokerForLine = (line, nobrokerLines = nobrokerDumpLines, maxDays = getDateTolerance()) => {
    const la = lineAmount(line);
    if (!la || la.type !== 'IN') return null;
    let best = null;
    let bestDiff = Infinity;
    nobrokerLines.forEach((nb) => {
        if (Math.abs(parseFloat(nb.amount) - la.amount) > 0.01) return;
        const diff = daysDiff(line.line_date, nb.date);
        if (diff > maxDays || diff >= bestDiff) return;
        bestDiff = diff;
        best = nb;
    });
    return best;
};

export const findLedgerMatch = (line, txns, maxDays = getDateTolerance()) => {
    const la = lineAmount(line);
    if (!la) return null;
    let best = null;
    let bestScore = Infinity;
    txns.forEach((t) => {
        if (t.type !== la.type) return;
        if ((t.wallet || '').toUpperCase() !== 'BANK') return;
        const amt = parseFloat(t.amount || 0);
        if (Math.abs(amt - la.amount) > 0.01) return;
        const diff = daysDiff(line.line_date, txnDateStr(t));
        if (diff > maxDays) return;
        const score = diff * 1000 + Math.abs(amt - la.amount);
        if (score < bestScore) {
            bestScore = score;
            best = t;
        }
    });
    return best;
};

/** Best unmatched statement line for an unreconciled BANK ledger entry. */
export const findStatementMatchForTxn = (txn, lines = getUnmatchedBankLines(), maxDays = getDateTolerance()) => {
    if (!txn || (txn.wallet || '').toUpperCase() !== 'BANK') return null;
    const amt = parseFloat(txn.amount) || 0;
    let best = null;
    let bestScore = Infinity;
    lines.forEach((line) => {
        const la = lineAmount(line);
        if (!la || la.type !== txn.type) return;
        if (Math.abs(la.amount - amt) > 0.01) return;
        const diff = daysDiff(line.line_date, txnDateStr(txn));
        if (diff > maxDays) return;
        const score = diff * 1000 + Math.abs(la.amount - amt);
        if (score < bestScore) {
            bestScore = score;
            best = line;
        }
    });
    return best;
};

/** Candidate statement lines for manual match (sorted by date proximity). */
export const findStatementMatchesForTxn = (txn, lines = getUnmatchedBankLines(), maxDays = 30) => {
    if (!txn || (txn.wallet || '').toUpperCase() !== 'BANK') return [];
    const amt = parseFloat(txn.amount) || 0;
    return lines
        .map((line) => {
            const la = lineAmount(line);
            if (!la || la.type !== txn.type) return null;
            if (Math.abs(la.amount - amt) > 0.01) return null;
            const diff = daysDiff(line.line_date, txnDateStr(txn));
            if (diff > maxDays) return null;
            return { line, score: diff * 1000 + Math.abs(la.amount - amt) };
        })
        .filter(Boolean)
        .sort((a, b) => a.score - b.score)
        .map((x) => x.line);
};

export async function createLedgerFromBankLine(lineId, { nobrokerRow = null, skipMatch = false } = {}) {
    const line = fnFinances().bankStatementLines?.find((l) => l.id === lineId);
    if (!line || line.match_status !== 'UNMATCHED') throw new Error('Statement line is not available for import.');

    const la = lineAmount(line);
    if (!la) throw new Error('Statement line has no debit or credit amount.');

    const result = await postFnMutation('createLedgerFromBankLineAuto', {
        apartment_id: portalState.access?.activeApartmentId,
        line_id: lineId,
        nobroker_row: nobrokerRow || findNoBrokerForLine(line) || null,
        skip_match: !!skipMatch,
    });
    return result.txnId;
}

export async function autoMatchByDateAndAmount({ maxDaysDiff = getDateTolerance() } = {}) {
    const lines = [...getUnmatchedBankLines()].sort((a, b) =>
        (a.line_date || '').localeCompare(b.line_date || ''),
    );
    let txns = getUnmatchedLedgerTxns();
    const matched = [];
    const errors = [];

    for (const line of lines) {
        const txn = findLedgerMatch(line, txns, maxDaysDiff);
        if (!txn) continue;
        try {
            await matchBankLine(line.id, txn.id);
            matched.push({ lineId: line.id, txnId: txn.id, date: line.line_date });
            txns = txns.filter((t) => t.id !== txn.id);
        } catch (err) {
            errors.push(`${line.line_date}: ${err?.message || 'Match failed'}`);
        }
    }

    return { matched, errors };
}

export async function autoCreateFromUnmatchedLines({
    maxDaysDiff = getDateTolerance(),
    includeDebits = true,
} = {}) {
    const lines = [...getUnmatchedBankLines()].sort((a, b) =>
        (a.line_date || '').localeCompare(b.line_date || ''),
    );
    let created = 0;
    let matchedExisting = 0;
    const skipped = [];
    const errors = [];

    for (const line of lines) {
        const la = lineAmount(line);
        if (!la) {
            skipped.push(`${line.line_date}: zero amount`);
            continue;
        }
        if (la.type === 'OUT' && !includeDebits) {
            skipped.push(`${line.line_date}: debit skipped`);
            continue;
        }

        const existing = findLedgerMatch(line, getUnmatchedLedgerTxns(), maxDaysDiff);
        if (existing) {
            try {
                await matchBankLine(line.id, existing.id);
                matchedExisting += 1;
            } catch (err) {
                errors.push(`${line.line_date}: ${err?.message || 'Match failed'}`);
            }
            continue;
        }

        try {
            const nb = findNoBrokerForLine(line, nobrokerDumpLines, maxDaysDiff);
            await createLedgerFromBankLine(line.id, { nobrokerRow: nb });
            created += 1;
        } catch (err) {
            skipped.push(`${line.line_date}: ${err?.message || 'Skipped'}`);
        }
    }

    return { created, matchedExisting, skipped, errors };
}

export async function reconcileBankWithNoBroker({
    maxDaysDiff = getDateTolerance(),
    createMissing = true,
} = {}) {
    if (!nobrokerDumpLines.length) throw new Error('Upload a NoBroker payment dump first.');

    const lines = getUnmatchedBankLines().filter((l) => parseFloat(l.credit || 0) > 0.001);
    let txns = getUnmatchedLedgerTxns();
    let matchedLedger = 0;
    let created = 0;
    const unmatched = [];
    const errors = [];

    for (const line of lines) {
        const nb = findNoBrokerForLine(line, nobrokerDumpLines, maxDaysDiff);
        if (!nb) {
            unmatched.push(`${line.line_date} · ${formatMoney(line.credit)} — no NoBroker row`);
            continue;
        }

        const flat = nb.flatHint || matchFlatFromText(nb.description);
        if (!flat) {
            errors.push(`${line.line_date}: NoBroker row matched amount/date but flat could not be resolved`);
            continue;
        }

        const ledgerMatch = txns.find((t) =>
            t.type === 'IN'
            && t.cat === 'Maintenance Collection'
            && Math.abs(parseFloat(t.amount) - parseFloat(nb.amount)) < 0.01
            && daysDiff(line.line_date, txnDateStr(t)) <= maxDaysDiff
            && (
                (t.description || '').toUpperCase().includes(flat.toUpperCase())
                || daysDiff(nb.date, txnDateStr(t)) <= maxDaysDiff
            ),
        );

        if (ledgerMatch) {
            try {
                await matchBankLine(line.id, ledgerMatch.id);
                txns = txns.filter((t) => t.id !== ledgerMatch.id);
                matchedLedger += 1;
            } catch (err) {
                errors.push(`${line.line_date}: ${err?.message || 'Match failed'}`);
            }
            continue;
        }

        if (!createMissing) {
            unmatched.push(`${line.line_date} · ${flat} · ${formatMoney(nb.amount)} — ledger entry missing`);
            continue;
        }

        try {
            await createLedgerFromBankLine(line.id, { nobrokerRow: nb });
            created += 1;
        } catch (err) {
            errors.push(`${line.line_date} · ${flat}: ${err?.message || 'Create failed'}`);
        }
    }

    return { matchedLedger, created, unmatched, errors };
}

export async function loadNoBrokerDumpFile(file) {
    const lines = await parseNoBrokerCollectionLines(file);
    setNoBrokerDump(lines, file?.name || 'NoBroker export');
    return lines.length;
};

export const suggestMatches = (line, txns = null, maxDays = getDateTolerance()) => {
    const lineType = bankLineType(line);
    const pool = txns ?? getUnmatchedLedgerTxns(lineType);
    const lineAmt = bankLineAmount(line);
    if (lineAmt <= 0.001) return [];

    const lineDate = new Date(`${line.line_date}T12:00:00`);
    return pool.filter((t) => {
        if (t.type !== lineType) return false;
        const amt = parseFloat(t.amount || 0);
        if (Math.abs(amt - lineAmt) > 0.01) return false;
        const txnDate = new Date(`${t.date}T12:00:00`);
        const diffDays = Math.abs((lineDate - txnDate) / 86400000);
        return diffDays <= maxDays;
    }).slice(0, 5);
};

const bankReconSortValue = (line, key) => {
    switch (key) {
    case 'line_date':
        return String(line?.line_date || '');
    case 'description':
        return String(line?.description || '').toLowerCase();
    case 'debit':
        return parseFloat(line?.debit || 0);
    case 'credit':
        return parseFloat(line?.credit || 0);
    case 'computedBalance':
        if (line?.computed_balance != null && line.computed_balance !== '') {
            return parseFloat(line.computed_balance);
        }
        return line?.computedBalance == null ? Number.NEGATIVE_INFINITY : parseFloat(line.computedBalance || 0);
    case 'balance':
        return passbookRowBalance(line) == null ? Number.NEGATIVE_INFINITY : passbookRowBalance(line);
    case 'source_row_index':
        return line?.source_row_index == null ? Number.MAX_SAFE_INTEGER : parseInt(line.source_row_index, 10);
    case 'type':
        return bankLineType(line);
    default:
        return '';
    }
};

const sortBankReconLines = (lines) => {
    const { key, dir } = bankReconSortState;
    const factor = dir === 'desc' ? -1 : 1;
    return [...lines].sort((a, b) => {
        const av = bankReconSortValue(a, key);
        const bv = bankReconSortValue(b, key);
        let cmp = 0;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
        if (cmp) return cmp * factor;
        return compareLineOrder(a, b, bankStatementImportById()) * factor;
    });
};

const buildSameDayOrderIndex = (lines) => {
    const imports = bankStatementImportById();
    const sorted = [...lines].sort((a, b) => compareLineOrder(a, b, imports));
    const byDate = new Map();
    for (const line of sorted) {
        const key = line.line_date || '';
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(line.id);
    }
    const meta = new Map();
    for (const ids of byDate.values()) {
        ids.forEach((id, index) => {
            meta.set(id, { index, count: ids.length });
        });
    }
    return meta;
};

const renderOrderButtons = (lineId, orderMeta) => {
    const o = orderMeta.get(lineId) || { index: 0, count: 1 };
    if (o.count <= 1) {
        return '<td class="bank-recon-table__cell bank-recon-table__cell--order"></td>';
    }
    const upDisabled = o.index === 0 ? ' disabled' : '';
    const downDisabled = o.index === o.count - 1 ? ' disabled' : '';
    return `<td class="bank-recon-table__cell bank-recon-table__cell--order">
      <div class="bank-recon-order-btns">
        <button type="button" class="btn btn-outline btn--small btn--icon bank-recon-move-up" data-line="${lineId}" title="Move up (same day)" aria-label="Move up"${upDisabled}><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>
        <input type="number" class="bank-recon-move-step expense-combobox" min="1" max="${o.count - 1}" value="1" title="Number of positions to move" aria-label="Rows to move" />
        <button type="button" class="btn btn-outline btn--small btn--icon bank-recon-move-down" data-line="${lineId}" title="Move down (same day)" aria-label="Move down"${downDisabled}><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
      </div>
    </td>`;
};

async function moveStatementLineInDay(lineId, direction, { recalculate = false, steps = 1 } = {}) {
    const imports = bankStatementImportById();
    const lines = fnFinances().bankStatementLines || [];
    const line = lines.find((l) => l.id === lineId);
    if (!line) return null;

    const dayLines = lines.filter((l) => l.line_date === line.line_date);
    if (dayLines.length <= 1) return null;

    const sorted = [...dayLines].sort((a, b) => compareLineOrder(a, b, imports));
    const idx = sorted.findIndex((l) => l.id === lineId);
    if (idx < 0) return null;

    const stepCount = Math.max(1, parseInt(steps, 10) || 1);
    const targetIdx = Math.max(0, Math.min(sorted.length - 1, idx + direction * stepCount));
    if (targetIdx === idx) return null;

    const ids = sorted.map((l) => l.id);
    const [moved] = ids.splice(idx, 1);
    ids.splice(targetIdx, 0, moved);
    const updates = ids.map((id, index) => ({ id, line_order: index, order_source: 'manual' }));
    await reorderBankStatementLines(updates, { recalculate });
    return { lineId, dayLineIds: ids, orderMeta: buildSameDayOrderIndex(lines) };
}

const refreshStatementTableRowOrder = (linesEl) => {
    const tbody = linesEl?.querySelector('.bank-recon-table tbody');
    if (!tbody) return;

    const unmatched = annotateStatementLineBalances().filter((l) => l.match_status === 'UNMATCHED');
    const sorted = sortBankReconLines(unmatched);
    const orderMeta = buildSameDayOrderIndex(unmatched);

    for (const line of sorted) {
        const row = tbody.querySelector(`[data-line-id="${line.id}"]`);
        if (row) tbody.appendChild(row);
    }

    tbody.querySelectorAll('.bank-recon-table__row[data-line-id]').forEach((row) => {
        const lineId = row.dataset.lineId;
        const o = orderMeta.get(lineId);
        const up = row.querySelector('.bank-recon-move-up');
        const down = row.querySelector('.bank-recon-move-down');
        const stepInput = row.querySelector('.bank-recon-move-step');
        if (!o || o.count <= 1) return;
        if (up) up.disabled = o.index === 0;
        if (down) down.disabled = o.index === o.count - 1;
        if (stepInput) {
            stepInput.max = String(Math.max(1, o.count - 1));
            const current = parseInt(stepInput.value, 10) || 1;
            if (current > o.count - 1) stepInput.value = String(Math.max(1, o.count - 1));
        }
    });
};

let pendingRowMoveChoice = null;

const promptRowMoveRecalc = () => new Promise((resolve) => {
    const modal = document.getElementById('bank-recon-move-confirm-modal');
    if (!modal) {
        resolve('just');
        return;
    }
    pendingRowMoveChoice = resolve;
    modal.classList.add('active');
});

const closeRowMoveConfirmModal = (choice) => {
    document.getElementById('bank-recon-move-confirm-modal')?.classList.remove('active');
    const resolve = pendingRowMoveChoice;
    pendingRowMoveChoice = null;
    resolve?.(choice);
};

const renderSortHeader = (label, key, extraClass = '') => {
    const active = bankReconSortState.key === key;
    const dir = active ? bankReconSortState.dir : '';
    const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
    const classes = ['bank-recon-sort-btn', active ? 'bank-recon-sort-btn--active' : '', extraClass]
        .filter(Boolean)
        .join(' ');
    return `<button type="button" class="${classes}" data-sort-key="${key}" aria-label="Sort by ${esc(label)}${active ? ` ${dir}` : ''}">${esc(label)}${arrow}</button>`;
};

export async function matchBankLine(lineId, transactionId) {
    await postFnMutation('matchBankLine', { line_id: lineId, transaction_id: transactionId });
}

export async function unmatchBankLine(lineId) {
    await postFnMutation('unmatchBankLine', { line_id: lineId });
}

export async function unmatchBankLines(lineIds = []) {
    const ids = [...new Set((lineIds || []).filter(Boolean))];
    if (!ids.length) return;
    await postFnMutation('unmatchBankLines', { line_ids: ids });
}

export async function ignoreBankLine(lineId) {
    await postFnMutation('ignoreBankLine', { line_id: lineId });
}

export async function updateBankStatementLine(lineId, patch) {
    const allowed = ['line_date', 'description', 'debit', 'credit', 'balance'];
    const payload = {};
    for (const key of allowed) {
        if (key in patch) payload[key] = patch[key];
    }
    if (!Object.keys(payload).length) return;

    await postFnMutation('updateBankStatementLine', { line_id: lineId, patch: payload });
    const line = fnFinances().bankStatementLines?.find((l) => l.id === lineId);
    if (line) Object.assign(line, payload);
}

export async function deleteBankStatementLine(lineId) {
    await deleteBankStatementLines([lineId]);
}

export async function deleteBankStatementLines(lineIds) {
    const ids = [...new Set(lineIds)].filter(Boolean);
    if (!ids.length) return;
    await postFnMutation('deleteBankStatementLines', { line_ids: ids });
}

export async function clearAllBankStatementData() {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const lines = fnFinances().bankStatementLines || [];
    if (!lines.length) return { deleted: 0 };

    await postFnMutation('clearBankStatementData', { apartment_id });

    return { deleted: lines.length };
}

export async function returnLedgerTxnToStatement(txnId) {
    if (!txnId) throw new Error('Transaction id is required.');
    await postFnMutation('returnLedgerTxnToStatement', { transaction_id: txnId });
}

export async function createTxnFromBankLine(lineId, { cat, sub_category, vendor_name, exclude_from_reports = false }) {
    const line = fnFinances().bankStatementLines?.find((l) => l.id === lineId);
    if (!line) throw new Error('Statement line not found.');

    const isIncome = bankLineType(line) === 'IN';
    const amount = bankLineAmount(line);
    if (amount <= 0.001) throw new Error('Enter a debit or credit amount.');
    if (!cat) throw new Error('Select a category.');
    if (!isIncome && !sub_category) throw new Error('Enter sub-category for expenses.');
    if (!isIncome && !vendor_name) throw new Error('Enter vendor name for expenses.');

    await postFnMutation('createTxnFromBankLine', {
        line_id: lineId,
        cat,
        sub_category,
        vendor_name,
        exclude_from_reports,
    });
}

export async function createTxnsFromBankLines(rows = []) {
    const clean = (rows || [])
        .filter((r) => r?.line_id && r?.cat)
        .map((r) => ({
            line_id: r.line_id,
            cat: r.cat,
            sub_category: r.sub_category || null,
            vendor_name: r.vendor_name || null,
            exclude_from_reports: !!r.exclude_from_reports,
        }));
    if (!clean.length) return { posted: 0, failed: 0, results: [] };
    const result = await postFnMutation('createTxnsFromBankLines', { rows: clean });
    return result;
}

const importResultMessage = ({ count, skipped, skippedExisting, skippedBatch }) => {
    if (!count && skipped) {
        return `No new lines imported — ${skipped} duplicate(s) skipped (same date, description, and amount).`;
    }
    let msg = `Imported ${count} line(s).`;
    if (skipped) {
        msg += ` Skipped ${skipped} duplicate(s)`;
        if (skippedExisting) msg += ` (${skippedExisting} already in system`;
        if (skippedBatch) msg += `${skippedExisting ? ', ' : ' ('}${skippedBatch} in file`;
        msg += ').';
    }
    return msg;
};

const categoryOptionsForRow = (row) => {
    const isIncome = row?.dataset.lineType === 'IN';
    return buildCategoryOptions(isIncome);
};

const subCatOptionsForCategory = (catKey) => buildSubCategoryOptions(catKey);

const resolvedCategoryForRow = (row) => {
    const input = row?.querySelector('.bank-recon-cat-input');
    const raw = input?.value?.trim() || '';
    if (!raw) return '';
    if (isKnownClassifyInput(input)) return raw;
    const options = categoryOptionsForRow(row);
    return isExactListMatch(raw, options) || raw;
};

const rowClassifyReady = (row, { allowCustom = false } = {}) => {
    if (!row) return false;
    const isIncome = row.dataset.lineType === 'IN';
    const catInput = row.querySelector('.bank-recon-cat-input');
    const cat = catInput?.value?.trim();
    if (!cat) return false;
    if (!allowCustom && !isKnownClassifyInput(catInput)) return false;
    if (allowCustom && !catInput?.dataset.classifyState) return false;
    if (isIncome) return true;

    const subInput = row.querySelector('.bank-recon-subcat-input');
    const sub_category = subInput?.value?.trim();
    const vendor_name = row.querySelector('.bank-recon-vendor-input')?.value?.trim();
    if (!sub_category || !vendor_name) return false;
    if (!allowCustom && !isKnownClassifyInput(subInput)) return false;
    if (allowCustom && !subInput?.dataset.classifyState) return false;
    return true;
};

const normalizeClassifyStatesForPost = (row) => {
    const catInput = row.querySelector('.bank-recon-cat-input');
    const subInput = row.querySelector('.bank-recon-subcat-input');
    if (catInput?.value?.trim() && !catInput.dataset.classifyState) {
        const exact = isExactListMatch(catInput.value, categoryOptionsForRow(row));
        setClassifyInputState(catInput, exact ? 'known' : 'custom');
    }
    if (subInput?.value?.trim() && !subInput.dataset.classifyState) {
        const exact = isExactListMatch(subInput.value, subCatOptionsForCategory(resolvedCategoryForRow(row)));
        setClassifyInputState(subInput, exact ? 'known' : 'custom');
    }
};

const fieldNeedsManualPost = (input, options = []) => {
    const raw = input?.value?.trim();
    if (!raw) return false;
    if (input?.dataset.classifyState === 'custom') return true;
    if (input?.dataset.classifyState === 'known') return false;
    return !isExactListMatch(raw, options);
};

const syncRowExcludeForCategory = (row) => {
    const cat = row?.querySelector('.bank-recon-cat-input')?.value?.trim();
    const excludeInput = row?.querySelector('.bank-recon-exclude-reports-input');
    if (excludeInput && cat === BANK_REJECT_CAT) excludeInput.checked = true;
};

const syncRowPostButton = (row) => {
    const btn = row?.querySelector('.bank-recon-post-classify');
    if (!btn) return;
    const catInput = row.querySelector('.bank-recon-cat-input');
    const subInput = row.querySelector('.bank-recon-subcat-input');
    const needsManual = fieldNeedsManualPost(catInput, categoryOptionsForRow(row))
        || fieldNeedsManualPost(subInput, subCatOptionsForCategory(resolvedCategoryForRow(row)));
    const isIncome = row.dataset.lineType === 'IN';
    const vendor = row.querySelector('.bank-recon-vendor-input')?.value?.trim();
    const ready = isIncome
        ? Boolean(catInput?.value?.trim())
        : Boolean(catInput?.value?.trim() && subInput?.value?.trim() && vendor);
    btn.hidden = !(needsManual && ready);
    syncRowExcludeForCategory(row);
    syncSaveRuleButton(row);
    syncBulkPostUi();
};

const syncSaveRuleButton = (row) => {
    const btn = row?.querySelector('.bank-recon-save-rule-btn');
    if (!btn) return;
    const cat = row.querySelector('.bank-recon-cat-input')?.value?.trim();
    btn.hidden = !cat;
};

const maybeAutoPostRow = (row) => {
    const lineId = row?.dataset.lineId;
    if (!lineId || !rowClassifyReady(row)) return;
    tryAutoPostFromRow(row, lineId);
};

const renderClassifyCell = (line, isIncome) => {
    const postBtn = `<button type="button" class="btn btn-outline btn--small bank-recon-post-classify" data-line="${line.id}" hidden title="Post with new category values">Post</button>`;
    const saveRuleBtn = `<button type="button" class="btn btn-outline btn--small btn--icon bank-recon-save-rule-btn" data-line="${line.id}" hidden title="Save current values as a classification rule"><i class="fa-solid fa-bookmark" aria-hidden="true"></i></button>`;
    const excludeCheck = `
      <label class="bank-recon-exclude-reports" title="Omit from income/expense reports (e.g. bank rejects with matching debit/credit)">
        <input type="checkbox" class="bank-recon-exclude-reports-input" data-line="${line.id}" />
        <span>No reports</span>
      </label>`;
    const catCombobox = `
      <div class="bank-recon-classify-combobox bank-recon-classify-combobox--cat">
        <input type="text" class="bank-recon-cell-input bank-recon-cat-input" data-line="${line.id}" placeholder="Category…" autocomplete="off" />
        <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
      </div>`;
    if (isIncome) {
        return `<div class="bank-recon-classify-actions">${catCombobox}${excludeCheck}${saveRuleBtn}${postBtn}</div>`;
    }
    return `
      <div class="bank-recon-classify-actions">
      ${catCombobox}
      <div class="bank-recon-classify-combobox bank-recon-classify-combobox--sub">
        <input type="text" class="bank-recon-cell-input bank-recon-subcat-input" data-line="${line.id}" placeholder="Sub-category *" autocomplete="off" />
        <ul class="bank-recon-classify-combobox__menu" role="listbox" hidden></ul>
      </div>
      <input type="text" class="bank-recon-cell-input bank-recon-vendor-input" data-line="${line.id}" list="bank-recon-vendors" placeholder="Vendor *" value="${esc((line.description || '').slice(0, 48))}" />
      ${excludeCheck}${saveRuleBtn}${postBtn}
      </div>`;
};

const isoDay = (value) => (value ? String(value).slice(0, 10) : null);

const getWorkReconSnapshot = (unmatchedRaw = null) => {
    const source = unmatchedRaw
        || annotateStatementLineBalances().filter((l) => l.match_status === 'UNMATCHED');
    const workLines = annotateWorkLinesFromLedger(source);
    const workMismatchCount = workLines.filter((l) => l.passbookMismatch).length;
    const ledgerBank = getLedgerBankBalance();
    const postedPassbook = getPostedPassbookBalance(ledgerBank.asOf);
    const calcAsOf = isoDay(ledgerBank.asOf);
    const passbookAsOf = isoDay(postedPassbook?.asOf);
    const sameAsOf = !!(calcAsOf && passbookAsOf && calcAsOf === passbookAsOf);
    const closingDiff = ledgerBank.balance != null && postedPassbook
        ? ledgerBank.balance - postedPassbook.balance
        : null;
    const closingGap = closingDiff != null && Math.abs(closingDiff) > 0.01;
    return {
        workLines,
        workMismatchCount,
        ledgerBank,
        postedPassbook,
        calcAsOf,
        passbookAsOf,
        sameAsOf,
        closingDiff,
        closingGap,
    };
};

const annotateWorkLinesFromLedger = (unmatched) => {
    const ledger = getLedgerBankBalance();
    if (ledger.balance == null) return unmatched;
    const imports = bankStatementImportById();
    const ordered = [...unmatched].sort((a, b) => compareLineOrder(a, b, imports));
    let running = ledger.balance;
    const byId = new Map();
    for (const line of ordered) {
        running += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
        const passbook = passbookRowBalance(line);
        byId.set(line.id, {
            computedBalance: running,
            passbookMismatch: passbook != null && Math.abs(running - passbook) > 0.01,
        });
    }
    return unmatched.map((line) => (byId.has(line.id) ? { ...line, ...byId.get(line.id) } : line));
};

const renderBalanceCells = (line, visibleColumns) => {
    const showJoined = !!visibleColumns?.passbookBalance || !!visibleColumns?.calculatedBalance;
    if (!showJoined) return '';
    const opening = getBankOpeningConfig();
    const needsOpening = opening.amount == null;
    const passbookValue = passbookRowBalance(line);
    const passbookLabel = passbookValue != null ? formatMoney(passbookValue) : '—';
    const calcLabel = line.computedBalance != null ? formatMoney(line.computedBalance) : null;
    const calcHtml = calcLabel != null
        ? `<span class="ledger-passbook-calc${needsOpening ? ' ledger-passbook-calc--stale' : ''}" title="Ledger calculated + unmatched rows in order through this line">( ${esc(calcLabel)} )</span>`
        : (needsOpening
            ? '<span class="ledger-passbook-calc ledger-passbook-calc--stale" title="Set opening balance to calculate">( set opening )</span>'
            : '');
    const mismatchTitle = line.passbookMismatch && line.computedBalance != null && passbookValue != null
        ? `Calculated ${formatMoney(line.computedBalance)} ≠ passbook ${formatMoney(passbookValue)}`
        : (needsOpening ? 'Set opening balance above to calculate' : 'Passbook balance; calculated running balance in parentheses');
    const mismatchClass = line.passbookMismatch ? ' bank-recon-balance--mismatch' : '';
    const icon = line.passbookMismatch
        ? '<i class="fa-solid fa-triangle-exclamation bank-recon-mismatch-icon" aria-hidden="true"></i>'
        : '';
    return `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--passbook${mismatchClass}" title="${esc(mismatchTitle)}">
      <span class="ledger-passbook-stack">
        <span class="ledger-passbook-main">${passbookLabel}${icon}</span>
        ${calcHtml}
      </span>
    </td>`;
};

const updateOpeningBalanceTabMeta = () => {
    const opening = getBankOpeningConfig();
    const hasOpening = opening.amount != null && opening.date;
    const hintEl = document.getElementById('fn-bank-recon-opening-tab-hint');
    const badgeEl = document.getElementById('fn-bank-recon-opening-tab-badge');
    if (hintEl) {
        hintEl.textContent = hasOpening
            ? `${formatMoney(opening.amount)} · ${formatDisplayDate(opening.date)}`
            : 'Not set — required';
    }
    if (!badgeEl) return;
    if (!hasOpening) {
        badgeEl.className = 'bank-recon-opening-panel__badge bank-recon-opening-panel__badge--unset';
        badgeEl.textContent = 'Not set';
        badgeEl.title = 'Set opening balance before calculated balances can be compared';
        badgeEl.hidden = false;
        return;
    }
    const snap = getWorkReconSnapshot();
    if (snap.workMismatchCount > 0) {
        badgeEl.className = 'bank-recon-opening-panel__badge bank-recon-opening-panel__badge--warn';
        badgeEl.textContent = 'Mismatch';
        badgeEl.title = `${snap.workMismatchCount} unmatched row(s) where calculated ≠ passbook`;
        badgeEl.hidden = false;
        return;
    }
    if (snap.closingGap && snap.sameAsOf) {
        badgeEl.className = 'bank-recon-opening-panel__badge bank-recon-opening-panel__badge--warn';
        badgeEl.textContent = 'Review';
        badgeEl.title = `Ledger ${formatMoney(snap.ledgerBank.balance)} ≠ passbook ${formatMoney(snap.postedPassbook.balance)} as of ${formatDisplayDate(snap.calcAsOf)}`;
        badgeEl.hidden = false;
        return;
    }
    if (snap.closingGap && !snap.sameAsOf) {
        badgeEl.className = 'bank-recon-opening-panel__badge bank-recon-opening-panel__badge--warn';
        badgeEl.textContent = 'Dates differ';
        badgeEl.title = `Ledger as of ${formatDisplayDate(snap.calcAsOf)} vs posted passbook ${formatDisplayDate(snap.passbookAsOf)}`;
        badgeEl.hidden = false;
        return;
    }
    if (snap.postedPassbook && !snap.closingGap) {
        badgeEl.className = 'bank-recon-opening-panel__badge bank-recon-opening-panel__badge--ok';
        badgeEl.textContent = 'In balance';
        badgeEl.title = 'Ledger calculated matches passbook on the last posted statement line';
        badgeEl.hidden = false;
        return;
    }
    badgeEl.hidden = true;
    badgeEl.title = '';
};

const renderOpeningBalancePanel = () => {
    const opening = getBankOpeningConfig();
    const hasOpening = opening.amount != null && opening.date;
    const showJoinedHint = (bankReconVisibleColumns.passbookBalance || bankReconVisibleColumns.calculatedBalance) && !hasOpening;

    const snap = getWorkReconSnapshot();
    let statusHtml = '';
    if (!hasOpening) {
        statusHtml = '<p class="bank-recon-balance-panel__hint"><strong>Mismatch</strong> on a work row means that row’s calculated amount (ledger + unmatched lines through that row) does not equal the passbook balance on the same row. Set opening balance and date below first.</p>';
        if (showJoinedHint) {
            statusHtml += '<p class="bank-recon-balance-panel__hint bank-recon-balance-panel__hint--emphasis">The <strong>Passbook / calc</strong> column shows statement balance with calculated in parentheses once opening is saved.</p>';
        }
    } else if (snap.workMismatchCount > 0) {
        statusHtml = `<p class="bank-recon-balance-panel__alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> <strong>${snap.workMismatchCount}</strong> unmatched work row(s) where calculated ≠ passbook. Use <strong>Mismatches only</strong> on the work table.</p>`;
    } else if (snap.closingGap && snap.sameAsOf) {
        statusHtml = `<p class="bank-recon-balance-panel__alert"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Closing gap of <strong>${formatMoney(Math.abs(snap.closingDiff))}</strong> on ${formatDisplayDate(snap.calcAsOf)} — ledger ${formatMoney(snap.ledgerBank.balance)} vs last posted passbook ${formatMoney(snap.postedPassbook.balance)}.</p>`;
    } else if (snap.closingGap && !snap.sameAsOf) {
        statusHtml = `<p class="bank-recon-balance-panel__hint">Posted-books comparison could not use the same date (ledger ${formatDisplayDate(snap.calcAsOf)}, passbook ${formatDisplayDate(snap.passbookAsOf)}).</p>`;
    } else if (snap.postedPassbook && !snap.closingGap) {
        statusHtml = '<p class="bank-recon-balance-panel__ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Ledger calculated matches passbook on the last posted statement line.</p>';
    } else if (snap.ledgerBank.balance != null) {
        statusHtml = `<p class="bank-recon-balance-panel__hint">Ledger calculated is ${formatMoney(snap.ledgerBank.balance)}${snap.calcAsOf ? ` as of ${formatDisplayDate(snap.calcAsOf)}` : ''}. Import statements with a Balance column (or passbook OCR) to compare row-by-row.</p>`;
    }

    const mismatchNote = snap.workMismatchCount > 0
        ? `<button type="button" class="bank-recon-balance-panel__mismatch-count bank-recon-mismatch-jump" data-filter-scope="work" title="Filter the work table to mismatched rows">${snap.workMismatchCount} unmatched row(s) with balance mismatch — click to find</button>`
        : '';

    return `
      <div class="bank-recon-balance-panel__fields">
        <label class="bank-recon-balance-panel__field">
          <span>As of date</span>
          <input type="date" id="fn-bank-recon-opening-date" value="${esc(opening.date || '')}" />
        </label>
        <label class="bank-recon-balance-panel__field">
          <span>Amount (₹)</span>
          <input type="number" step="0.01" id="fn-bank-recon-opening-amount" value="${opening.amount != null ? esc(opening.amount) : ''}" placeholder="e.g. 150000" />
        </label>
        <button type="button" class="btn btn-outline btn--small" id="fn-bank-recon-opening-save">Save opening</button>
      </div>
      ${mismatchNote}
      ${statusHtml}`;
};

const renderStatementTable = (unmatched, visibleColumns = {}) => {
    unmatched = annotateWorkLinesFromLedger(unmatched);
    const workMismatchCount = unmatched.filter((l) => l.passbookMismatch).length;
    const filtered = filterWorkLines(unmatched);
    const showJoined = !!visibleColumns.passbookBalance || !!visibleColumns.calculatedBalance;
    const filterBarHtml = renderFilterBar('work', {
        mismatchCount: workMismatchCount,
        showMismatch: true,
        showType: true,
    });
    const bulkBarHtml = `
      <div class="bank-recon-bulk-bar">
        <label class="bank-recon-bulk-select-all">
          <input type="checkbox" id="fn-bank-recon-select-all" aria-label="Select all rows" />
          <span>Select all</span>
        </label>
        <button type="button" class="btn btn-primary btn--small" id="fn-bank-recon-post-all-ready" disabled title="Create ledger entries for every row with category filled">
          <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Post all ready
        </button>
        <button type="button" class="btn btn-outline btn--small" id="fn-bank-recon-bulk-post" disabled title="Post selected rows that have category filled">
          <i class="fa-solid fa-check-double" aria-hidden="true"></i> Post selected
        </button>
        <button type="button" class="btn btn-outline btn--small" id="fn-bank-recon-bulk-delete" disabled ${canDeleteAccounts() ? '' : 'hidden'}>
          <i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete selected
        </button>
        <details class="bank-recon-height-picker">
          <summary class="btn btn-outline btn--small" title="Table height"><i class="fa-solid fa-up-down" aria-hidden="true"></i> Height</summary>
          <div class="bank-recon-height-picker__menu">
            <button type="button" class="bank-recon-height-preset" data-height-preset="compact">Compact</button>
            <button type="button" class="bank-recon-height-preset" data-height-preset="medium">Medium</button>
            <button type="button" class="bank-recon-height-preset" data-height-preset="tall">Tall</button>
            <button type="button" class="bank-recon-height-preset" data-height-preset="full">Full screen</button>
          </div>
        </details>
        <details class="bank-recon-columns-picker">
          <summary class="btn btn-outline btn--small"><i class="fa-solid fa-table-columns" aria-hidden="true"></i> Columns</summary>
          <div class="bank-recon-columns-picker__menu">
            <label class="bank-recon-columns-picker__option">
              <input type="checkbox" data-column-toggle="passbookBalance" ${showJoined ? 'checked' : ''} />
              <span>Passbook / calculated</span>
            </label>
            <label class="bank-recon-columns-picker__option">
              <input type="checkbox" data-column-toggle="ocrRow" ${visibleColumns.ocrRow ? 'checked' : ''} />
              <span>OCR row #</span>
            </label>
            <label class="bank-recon-columns-picker__option">
              <input type="checkbox" data-column-toggle="rowOrder" ${visibleColumns.rowOrder ? 'checked' : ''} />
              <span>Row order (↑ ↓)</span>
            </label>
          </div>
        </details>
        <span id="fn-bank-recon-bulk-count" class="bank-recon-bulk-count"></span>
      </div>`;

    const header = `
      <p class="bank-recon-work-hint">Calculated (parentheses) starts from the <strong>ledger</strong> bank balance, then adds unmatched rows in order. For <strong>expenses</strong>, pick category, sub-category, and vendor — auto-saves when you <strong>select</strong> from the list. Use <strong>+ Add</strong> for new values, then click <strong>Post</strong>. For <strong>income</strong>, selecting a category saves immediately. Use <strong>Rules</strong> above, then <strong>Post all ready</strong>. Drag the table corner to resize, or use <strong>Height</strong>.</p>
      ${filterBarHtml}
      ${bulkBarHtml}`;

    if (!unmatched.length) {
        return `${header}<p class="maintenance-dues-empty bank-recon-empty-hint">No unmatched statement lines. Expand <strong>Import statement</strong> or <strong>Passbook scan</strong> above to add rows.</p>`;
    }
    if (!filtered.length) {
        return `${header}<p class="maintenance-dues-empty bank-recon-empty-hint">No unmatched lines match the current filters (${unmatched.length} total). Clear filters to see all rows.</p>`;
    }

    const dayHints = buildDayOrderHints(filtered);
    const seenDates = new Set();
    const opening = getBankOpeningConfig();
    const balanceHeaderHint = showJoined && opening.amount == null
        ? ' title="Set opening balance above to calculate"'
        : (showJoined
            ? ' title="Passbook/statement balance; calculated running balance in parentheses"'
            : '');

    const orderMeta = buildSameDayOrderIndex(filtered);

    const rows = sortBankReconLines(filtered).map((line) => {
        const lineType = bankLineType(line);
        const isIncome = lineType === 'IN';
        const ledgerTxns = getUnmatchedLedgerTxns(lineType);
        const suggestions = suggestMatches(line, ledgerTxns);
        const sugOptions = suggestions.map((t) =>
            `<option value="${t.id}">★ ${new Date(t.date).toLocaleDateString('en-GB')} · ${formatMoney(t.amount)} · ${esc((t.description || t.cat || '').slice(0, 30))}</option>`,
        ).join('');
        const allOptions = ledgerTxns.map((t) =>
            `<option value="${t.id}">${new Date(t.date).toLocaleDateString('en-GB')} · ${esc(t.cat || t.type)} · ${formatMoney(t.amount)} · ${esc((t.description || '').slice(0, 30))}</option>`,
        ).join('');
        const showOrderHint = !seenDates.has(line.line_date) && dayHints.has(line.line_date);
        seenDates.add(line.line_date);
        const orderHint = showOrderHint
            ? `<span class="bank-recon-order-hint">${esc(dayHints.get(line.line_date))}</span>`
            : '';

        return `<tr class="bank-recon-table__row${line.passbookMismatch ? ' bank-recon-table__row--mismatch' : ''}" data-line-id="${line.id}" data-line-type="${lineType}" data-line-date="${esc(line.line_date)}">
          ${visibleColumns.rowOrder ? renderOrderButtons(line.id, orderMeta) : ''}
          <td class="bank-recon-table__cell bank-recon-table__cell--check">
            <input type="checkbox" class="bank-recon-row-check" data-line="${line.id}" aria-label="Select row" />
          </td>
          ${visibleColumns.ocrRow ? `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--ocr" title="AI extract row sequence">${formatOcrRowDisplay(line) ?? '—'}</td>` : ''}
          <td class="bank-recon-table__cell bank-recon-table__cell--date">
            ${orderHint}
            <input type="text" class="bank-recon-cell-input bank-recon-cell-input--date" data-line="${line.id}" data-field="line_date" value="${esc(formatDisplayDate(line.line_date))}" placeholder="DD-MM-YY" />
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--desc">
            <textarea class="bank-recon-cell-input bank-recon-cell-input--desc" data-line="${line.id}" data-field="description" rows="2" placeholder="Description">${esc(line.description || '')}</textarea>
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-amt--out">
            <input type="number" min="0" step="0.01" class="bank-recon-cell-input bank-recon-cell-input--num" data-line="${line.id}" data-field="debit" value="${formatAmountInput(line.debit)}" placeholder="0" ${isIncome ? 'disabled' : ''} />
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-amt--in">
            <input type="number" min="0" step="0.01" class="bank-recon-cell-input bank-recon-cell-input--num" data-line="${line.id}" data-field="credit" value="${formatAmountInput(line.credit)}" placeholder="0" ${!isIncome ? 'disabled' : ''} />
          </td>
          ${renderBalanceCells(line, visibleColumns)}
          <td class="bank-recon-table__cell bank-recon-table__cell--type">
            <span class="bank-recon-type-badge bank-recon-type-badge--${lineType.toLowerCase()}">${lineType === 'IN' ? 'Income' : 'Expense'}</span>
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--classify">
            ${renderClassifyCell(line, isIncome)}
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--match">
            <select class="bank-recon-cell-select bank-match-select" data-line="${line.id}">
              <option value="">Match…</option>
              ${sugOptions ? `<optgroup label="Suggested">${sugOptions}</optgroup>` : ''}
              ${allOptions ? `<optgroup label="All ${isIncome ? 'income' : 'expenses'}">${allOptions}</optgroup>` : ''}
            </select>
          </td>
          <td class="bank-recon-table__cell bank-recon-table__cell--actions">
            <div class="bank-recon-row-actions">
              <span class="bank-recon-row-status" hidden aria-live="polite"></span>
              <button type="button" class="btn btn-outline btn--small btn--icon bank-ignore-btn" data-line="${line.id}" title="Ignore line" aria-label="Ignore"><i class="fa-solid fa-eye-slash" aria-hidden="true"></i></button>
              ${canDeleteAccounts()
                ? `<button type="button" class="btn btn-outline btn--small btn--icon btn--danger bank-delete-btn" data-line="${line.id}" title="Delete line" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`
                : ''}
            </div>
          </td>
        </tr>`;
    }).join('');

    const vendorDatalist = (fnFinances().vendors || [])
        .map((v) => `<option value="${esc(v.name)}">`).join('');

    const filterNote = filtered.length !== unmatched.length
        ? `<p class="bank-recon-filter-note">Showing <strong>${filtered.length}</strong> of <strong>${unmatched.length}</strong> unmatched lines</p>`
        : '';

    return `
      <datalist id="bank-recon-vendors">${vendorDatalist}</datalist>
      ${header}
      ${filterNote}
      <div class="bank-recon-table-shell" id="fn-bank-recon-table-shell">
        <div class="bank-recon-table-wrap" id="fn-bank-recon-table-wrap">
        <table class="bank-recon-table bank-recon-work-table">
          <thead>
            <tr>
              ${visibleColumns.rowOrder ? '<th class="bank-recon-table__th--order"><span class="sr-only">Order</span></th>' : ''}
              <th class="bank-recon-table__th--check"><span class="sr-only">Select</span></th>
              ${visibleColumns.ocrRow ? `<th class="bank-recon-table__th--num bank-recon-table__th--ocr">${renderSortHeader('OCR #', 'source_row_index', 'bank-recon-sort-btn--num')}</th>` : ''}
              <th class="bank-recon-table__th--date">${renderSortHeader('Date', 'line_date')}</th>
              <th class="bank-recon-table__th--desc">${renderSortHeader('Description', 'description')}</th>
              <th class="bank-recon-table__th--num bank-recon-amt--out">${renderSortHeader('Debit', 'debit', 'bank-recon-sort-btn--num')}</th>
              <th class="bank-recon-table__th--num bank-recon-amt--in">${renderSortHeader('Credit', 'credit', 'bank-recon-sort-btn--num')}</th>
              ${showJoined ? `<th class="bank-recon-table__th--num bank-recon-table__th--passbook"${balanceHeaderHint}>${renderSortHeader('Passbook / calc', 'balance', 'bank-recon-sort-btn--num')}</th>` : ''}
              <th class="bank-recon-table__th--type">${renderSortHeader('Type', 'type')}</th>
              <th class="bank-recon-table__th--classify">Category / vendor</th>
              <th class="bank-recon-table__th--match">Match ledger</th>
              <th class="bank-recon-table__th--actions"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        </div>
      </div>`;
};

const renderProcessedLinesSection = (matched, ignored, visibleColumns = {}) => {
    const rows = [...matched, ...ignored];
    if (!rows.length) return '';

    const showJoined = !!visibleColumns.passbookBalance || !!visibleColumns.calculatedBalance;
    const processedMismatchCount = rows.filter((l) => l.passbookMismatch).length;
    const filtered = filterProcessedLines(rows);
    const sortedFiltered = [...filtered].sort((a, b) =>
        compareLineOrder(a, b, bankStatementImportById()),
    );
    const filterBarHtml = renderFilterBar('processed', {
        mismatchCount: processedMismatchCount,
        showMismatch: true,
        showType: true,
        showStatus: true,
    });

    const body = sortedFiltered.map((line) => {
        const isIncome = bankLineType(line) === 'IN';
        const amt = bankLineAmount(line);
        const amtLabel = isIncome ? `+${formatMoney(amt)}` : `-${formatMoney(amt)}`;
        const status = line.match_status === 'MATCHED' ? 'Matched' : 'Ignored';
        const statusClass = line.match_status === 'MATCHED' ? 'bank-recon-status--matched' : 'bank-recon-status--ignored';
        const txn = line.transaction_id
            ? fnFinances().txns?.find((t) => t.id === line.transaction_id)
            : null;
        const txnLabel = txn
            ? `${txn.cat || txn.type}${txn.sub_category ? ` · ${txn.sub_category}` : ''}${txn.vendor_name ? ` · ${txn.vendor_name}` : ''} · ${formatMoney(txn.amount)}`
            : '';

        return `<tr class="bank-recon-table__row bank-recon-table__row--processed bank-recon-table__row--readonly${line.passbookMismatch ? ' bank-recon-table__row--mismatch' : ''}" data-line-id="${line.id}">
          <td class="bank-recon-table__cell bank-recon-table__cell--check">
            <input type="checkbox" class="bank-recon-processed-check" data-line="${line.id}" aria-label="Select processed line" />
          </td>
          ${visibleColumns.ocrRow ? `<td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--ocr">${formatOcrRowDisplay(line) ?? '—'}</td>` : ''}
          <td class="bank-recon-table__cell">${esc(formatDisplayDate(line.line_date))}</td>
          <td class="bank-recon-table__cell bank-recon-table__cell--desc">${esc(line.description || '—')}</td>
          <td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--amount ${isIncome ? 'bank-recon-amt--in' : 'bank-recon-amt--out'}">${amtLabel}</td>
          ${renderBalanceCells(line, visibleColumns)}
          <td class="bank-recon-table__cell"><span class="bank-recon-status ${statusClass}">${status}</span>${txnLabel ? `<span class="bank-recon-processed-txn">${esc(txnLabel)}</span>` : ''}</td>
          <td class="bank-recon-table__cell bank-recon-table__cell--actions">
            <div class="bank-recon-row-actions">
              ${line.match_status === 'MATCHED' ? `<button type="button" class="btn btn-outline btn--small bank-edit-btn" data-line="${line.id}" title="Return to work queue to re-classify or re-match">Edit</button>` : ''}
              ${canDeleteAccounts()
                ? `<button type="button" class="btn btn-outline btn--small btn--icon btn--danger bank-delete-btn" data-line="${line.id}" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>`
                : ''}
            </div>
          </td>
        </tr>`;
    }).join('');

    const filterNote = sortedFiltered.length !== rows.length
        ? `<p class="bank-recon-filter-note">Showing <strong>${sortedFiltered.length}</strong> of <strong>${rows.length}</strong> processed lines</p>`
        : '';
    const emptyFiltered = !sortedFiltered.length
        ? '<p class="maintenance-dues-empty">No processed lines match the current filters.</p>'
        : '';

    return `
      <section class="bank-recon-processed">
        <div class="bank-recon-processed__head">
          <div>
            <h4 class="bank-recon-processed__title">Matched &amp; ignored <span class="bank-recon-processed__count">(${rows.length})</span></h4>
            <p class="bank-recon-processed__hint">Posted/ignored lines. Mismatches here are historical (statement-order calc vs passbook) and are not counted on the work queue above.</p>
          </div>
          <button type="button" class="btn btn-outline btn--small bank-recon-processed-recalc-btn" title="Recalculate Calculated balance for all statement lines (including matched)">
            <i class="fa-solid fa-calculator" aria-hidden="true"></i> Recalculate
          </button>
        </div>
        <p class="bank-recon-recalc-status bank-recon-recalc-status--inline bank-recon-processed-recalc-status" hidden></p>
        ${filterBarHtml}
        <div class="bank-recon-bulk-bar bank-recon-bulk-bar--processed">
          <label class="bank-recon-bulk-select-all">
            <input type="checkbox" class="bank-recon-processed-select-all" aria-label="Select all processed rows" />
            <span>Select all</span>
          </label>
          <button type="button" class="btn btn-outline btn--small bank-recon-processed-bulk-return" disabled title="Move selected rows back to unmatched work queue">
            <i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Return selected
          </button>
          <button type="button" class="btn btn-outline btn--small btn--danger bank-recon-processed-bulk-delete" disabled title="Permanently delete selected statement lines">
            <i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete selected
          </button>
          <details class="bank-recon-columns-picker">
            <summary class="btn btn-outline btn--small"><i class="fa-solid fa-table-columns" aria-hidden="true"></i> Columns</summary>
            <div class="bank-recon-columns-picker__menu">
              <label class="bank-recon-columns-picker__option">
                <input type="checkbox" data-column-toggle="passbookBalance" ${showJoined ? 'checked' : ''} />
                <span>Passbook / calculated</span>
              </label>
              <label class="bank-recon-columns-picker__option">
                <input type="checkbox" data-column-toggle="ocrRow" ${visibleColumns.ocrRow ? 'checked' : ''} />
                <span>OCR row #</span>
              </label>
            </div>
          </details>
          <span class="bank-recon-bulk-count bank-recon-bulk-count--processed"></span>
        </div>
        ${filterNote}
        ${emptyFiltered || `<div class="bank-recon-table-wrap bank-recon-table-wrap--compact">
          <table class="bank-recon-table bank-recon-table--processed">
            <thead>
              <tr>
                <th class="bank-recon-table__th--check"><span class="sr-only">Select</span></th>
                ${visibleColumns.ocrRow ? '<th class="bank-recon-table__th--num bank-recon-table__th--ocr">OCR #</th>' : ''}
                <th>Date</th>
                <th>Description</th>
                <th class="bank-recon-table__th--num">Amount</th>
                ${showJoined ? '<th class="bank-recon-table__th--num bank-recon-table__th--passbook" title="Passbook/statement balance; calculated in parentheses">Passbook / calc</th>' : ''}
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>`}
      </section>`;
};

const wireProcessedLines = (root) => {
    const processedRoot = root.querySelector('.bank-recon-processed');
    if (processedRoot) {
        const selectAll = processedRoot.querySelector('.bank-recon-processed-select-all');
        const bulkBtn = processedRoot.querySelector('.bank-recon-processed-bulk-return');
        const bulkDeleteBtn = processedRoot.querySelector('.bank-recon-processed-bulk-delete');
        const countEl = processedRoot.querySelector('.bank-recon-bulk-count--processed');

        const allChecks = () => [...processedRoot.querySelectorAll('.bank-recon-processed-check')];
        const selectedLineIds = () => allChecks().filter((c) => c.checked).map((c) => c.dataset.line).filter(Boolean);

        const refresh = () => {
            const checks = allChecks();
            const selected = checks.filter((c) => c.checked).length;
            if (bulkBtn) bulkBtn.disabled = selected === 0;
            if (bulkDeleteBtn) bulkDeleteBtn.disabled = selected === 0;
            if (countEl) countEl.textContent = selected ? `${selected} selected` : '';
            if (selectAll) {
                selectAll.checked = checks.length > 0 && selected === checks.length;
                selectAll.indeterminate = selected > 0 && selected < checks.length;
            }
        };

        processedRoot.addEventListener('change', (e) => {
            const box = e.target.closest('.bank-recon-processed-check');
            if (box) refresh();
            if (e.target === selectAll) {
                const checks = allChecks();
                checks.forEach((c) => { c.checked = !!selectAll.checked; });
                refresh();
            }
        });

        if (bulkBtn) {
            bulkBtn.addEventListener('click', async () => {
                const ids = selectedLineIds();
                if (!ids.length) return;
                if (!confirm(`Return ${ids.length} line(s) to the work queue?`)) return;
                try {
                    await withButtonBusy(bulkBtn, 'Returning…', async () => {
                        await unmatchBankLines(ids);
                    });
                    renderBankReconciliation();
                    window.renderCashLedger?.();
                } catch (err) {
                    alert(err?.message || 'Could not bulk return lines.');
                }
            });
        }

        if (bulkDeleteBtn) {
            bulkDeleteBtn.addEventListener('click', async () => {
                const ids = selectedLineIds();
                if (!ids.length) return;
                if (!confirm(`Permanently delete ${ids.length} matched/ignored statement line(s)? Linked ledger entries are not deleted.`)) return;
                try {
                    await withButtonBusy(bulkDeleteBtn, 'Deleting…', async () => {
                        await deleteBankStatementLines(ids);
                    });
                    renderBankReconciliation();
                    window.renderCashLedger?.();
                } catch (err) {
                    alert(err?.message || 'Could not delete selected lines.');
                }
            });
        }

        const recalcBtn = processedRoot.querySelector('.bank-recon-processed-recalc-btn');
        if (recalcBtn && !recalcBtn.dataset.wired) {
            recalcBtn.dataset.wired = '1';
            recalcBtn.addEventListener('click', async () => {
                try {
                    await runBankReconRecalculate(recalcBtn);
                } catch (err) {
                    alert(err?.message || 'Could not recalculate balances.');
                }
            });
        }

        refresh();
    }

    root.querySelectorAll('.bank-edit-btn, .bank-unmatch-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            try {
                await unmatchBankLine(btn.dataset.line);
                renderBankReconciliation();
                window.renderCashLedger?.();
            } catch (err) {
                alert(err?.message || 'Could not return line to work queue.');
            }
        });
    });

    root.querySelectorAll('.bank-recon-processed .bank-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this statement line permanently?')) return;
            try {
                await deleteBankStatementLine(btn.dataset.line);
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not delete line.');
            }
        });
    });
};

const renderLedgerTable = (ledgerTxns) => {
    const filtered = filterLedgerTxns(ledgerTxns);
    const filterBarHtml = renderFilterBar('ledger', { showType: true, showMismatch: false });

    if (!ledgerTxns.length) {
        return '<p class="maintenance-dues-empty">All bank ledger transactions are matched.</p>';
    }

    const unmatchedLines = getUnmatchedBankLines();
    const tol = getDateTolerance();

    if (!filtered.length) {
        return `
          ${filterBarHtml}
          <p class="maintenance-dues-empty">No unmatched ledger entries match the current filters (${ledgerTxns.length} total).</p>`;
    }

    const rows = filtered.slice(0, 80).map((t) => {
        const suggested = findStatementMatchForTxn(t, unmatchedLines, tol);
        const candidates = findStatementMatchesForTxn(t, unmatchedLines);
        const lineOptions = candidates.map((line) => {
            const star = line.id === suggested?.id ? '★ ' : '';
            return `<option value="${esc(line.id)}">${star}${formatDisplayDate(line.line_date)} · ${formatMoney(lineAmount(line)?.amount || 0)} · ${esc((line.description || '').slice(0, 36))}</option>`;
        }).join('');
        const isIncome = t.type === 'IN';
        const amtClass = isIncome ? 'bank-recon-amt--in' : 'bank-recon-amt--out';

        return `<tr class="bank-recon-table__row bank-recon-table__row--ledger" data-txn-id="${t.id}">
        <td class="bank-recon-table__cell bank-recon-table__cell--check">
          <input type="checkbox" class="bank-recon-ledger-check" data-txn="${t.id}" aria-label="Select ledger entry" />
        </td>
        <td class="bank-recon-table__cell">${new Date(t.date).toLocaleDateString('en-GB')}</td>
        <td class="bank-recon-table__cell">
          <span class="bank-recon-type-badge bank-recon-type-badge--${String(t.type || '').toLowerCase()}">${isIncome ? 'Income' : 'Expense'}</span>
        </td>
        <td class="bank-recon-table__cell bank-recon-table__cell--num bank-recon-table__cell--amount ${amtClass}">
          ${isIncome ? '+' : '-'}${formatMoney(t.amount)}
        </td>
        <td class="bank-recon-table__cell bank-recon-table__cell--desc">${esc(t.description || t.cat || '—')}</td>
        <td class="bank-recon-table__cell bank-recon-table__cell--ledger-actions">
          <div class="bank-recon-ledger-actions">
            <select class="bank-recon-cell-select bank-recon-ledger-match-select" data-txn="${t.id}" ${candidates.length ? '' : 'disabled'} title="${candidates.length ? 'Link to a statement line' : 'No unmatched statement line with same amount'}">
              <option value="">${candidates.length ? 'Match statement…' : 'No statement match'}</option>
              ${lineOptions}
            </select>
            <button type="button" class="btn btn-primary btn--small bank-recon-ledger-auto-match" data-txn="${t.id}" ${suggested ? '' : 'disabled'} title="${suggested ? 'Match best statement line' : 'No auto-match found (±' + tol + ' days, same amount)'}">Match</button>
            <button type="button" class="btn btn-outline btn--small bank-recon-ledger-to-statement" data-txn="${t.id}" title="Return to unmatched statement lines (removes this ledger entry)"><i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i> To statements</button>
            <button type="button" class="btn btn-outline btn--small bank-recon-ledger-edit" data-txn="${t.id}" title="Edit in ledger">Edit</button>
            ${canDeleteAccounts()
              ? `<button type="button" class="btn btn-outline btn--small btn--danger bank-recon-ledger-delete" data-txn="${t.id}" title="Delete ledger entry">Delete</button>`
              : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    const filterNote = filtered.length !== ledgerTxns.length
        ? `<p class="bank-recon-filter-note">Showing <strong>${Math.min(filtered.length, 80)}</strong> of <strong>${ledgerTxns.length}</strong> unmatched ledger entries</p>`
        : (filtered.length > 80 ? '<p class="bank-recon-filter-note">Showing first 80 unmatched ledger entries</p>' : '');

    return `
      <p class="bank-recon-work-hint bank-recon-work-hint--ledger">These BANK ledger entries have no linked statement line. <strong>To statements</strong> moves the row back to the work queue so you can classify and post again. Or <strong>Match</strong> to an existing statement row, or <strong>Edit</strong> / <strong>Delete</strong> if duplicate or wrong.</p>
      ${filterBarHtml}
      <div class="bank-recon-bulk-bar bank-recon-bulk-bar--ledger">
        <label class="bank-recon-bulk-select-all">
          <input type="checkbox" id="fn-bank-recon-ledger-select-all" aria-label="Select all unmatched ledger entries" />
          <span>Select all</span>
        </label>
        <button type="button" class="btn btn-outline btn--small" id="fn-bank-recon-ledger-bulk-to-statement" disabled title="Return selected entries to unmatched statement lines">
          <i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i> To statements
        </button>
        <button type="button" class="btn btn-outline btn--small btn--danger" id="fn-bank-recon-ledger-bulk-delete" disabled title="Permanently delete selected ledger entries">
          <i class="fa-solid fa-trash-can" aria-hidden="true"></i> Delete selected
        </button>
        <span class="bank-recon-bulk-count" id="fn-bank-recon-ledger-bulk-count"></span>
      </div>
      ${filterNote}
      <div class="bank-recon-table-wrap bank-recon-table-wrap--compact">
        <table class="bank-recon-table bank-recon-table--ledger">
          <thead>
            <tr>
              <th class="bank-recon-table__th--check"><span class="sr-only">Select</span></th>
              <th>Date</th>
              <th>Type</th>
              <th class="bank-recon-table__th--num">Amount</th>
              <th>Description</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
};

const wireLedgerTable = (txnsEl) => {
    if (!txnsEl || txnsEl.dataset.wired) return;
    txnsEl.dataset.wired = '1';

    const syncLedgerBulkUi = () => {
        const checks = [...txnsEl.querySelectorAll('.bank-recon-ledger-check')];
        const selected = checks.filter((c) => c.checked);
        const selectAll = txnsEl.querySelector('#fn-bank-recon-ledger-select-all');
        const bulkDelete = txnsEl.querySelector('#fn-bank-recon-ledger-bulk-delete');
        const bulkToStmt = txnsEl.querySelector('#fn-bank-recon-ledger-bulk-to-statement');
        const countEl = txnsEl.querySelector('#fn-bank-recon-ledger-bulk-count');
        if (bulkDelete) bulkDelete.disabled = selected.length === 0;
        if (bulkToStmt) bulkToStmt.disabled = selected.length === 0;
        if (countEl) countEl.textContent = selected.length ? `${selected.length} selected` : '';
        if (selectAll) {
            selectAll.checked = checks.length > 0 && selected.length === checks.length;
            selectAll.indeterminate = selected.length > 0 && selected.length < checks.length;
        }
    };

    const selectedLedgerTxnIds = () =>
        [...txnsEl.querySelectorAll('.bank-recon-ledger-check:checked')].map((c) => c.dataset.txn).filter(Boolean);

    txnsEl.addEventListener('change', async (e) => {
        if (e.target.id === 'bank-recon-ledger-select-all' || e.target.id === 'fn-bank-recon-ledger-select-all') {
            const on = !!e.target.checked;
            txnsEl.querySelectorAll('.bank-recon-ledger-check').forEach((c) => { c.checked = on; });
            syncLedgerBulkUi();
            return;
        }
        if (e.target.classList.contains('bank-recon-ledger-check')) {
            syncLedgerBulkUi();
            return;
        }

        const sel = e.target.closest('.bank-recon-ledger-match-select');
        if (!sel?.value) return;
        const txnId = sel.dataset.txn;
        const lineId = sel.value;
        try {
            await withButtonBusy(sel, 'Matching…', () => matchBankLine(lineId, txnId));
            renderBankReconciliation();
            window.renderCashLedger?.();
            window.processFinances?.();
            window.renderFinanceAnalytics?.();
        } catch (err) {
            alert(err?.message || 'Could not match.');
            sel.value = '';
        }
    });

    txnsEl.addEventListener('click', async (e) => {
        const bulkDeleteBtn = e.target.closest('#bank-recon-ledger-bulk-delete, #fn-bank-recon-ledger-bulk-delete');
        if (bulkDeleteBtn && !bulkDeleteBtn.disabled) {
            const ids = selectedLedgerTxnIds();
            if (!ids.length) return;
            if (!confirm(`Permanently delete ${ids.length} ledger entr${ids.length === 1 ? 'y' : 'ies'}?`)) return;
            try {
                await withButtonBusy(bulkDeleteBtn, 'Deleting…', async () => {
                    await postFnMutation('deleteTransactions', { transaction_ids: ids });
                });
                renderBankReconciliation();
                window.renderCashLedger?.();
                window.processFinances?.();
                window.renderFinanceAnalytics?.();
            } catch (err) {
                alert(err?.message || 'Could not delete selected entries.');
            }
            return;
        }

        const bulkToStmtBtn = e.target.closest('#bank-recon-ledger-bulk-to-statement, #fn-bank-recon-ledger-bulk-to-statement');
        if (bulkToStmtBtn && !bulkToStmtBtn.disabled) {
            const ids = selectedLedgerTxnIds();
            if (!ids.length) return;
            if (!confirm(`Return ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} to statement lines? Ledger transaction(s) will be removed.`)) return;
            try {
                await withButtonBusy(bulkToStmtBtn, 'Moving…', async () => {
                    for (const txnId of ids) {
                        await returnLedgerTxnToStatement(txnId);
                    }
                });
                renderBankReconciliation();
                window.renderCashLedger?.();
                window.processFinances?.();
                window.renderFinanceAnalytics?.();
            } catch (err) {
                alert(err?.message || 'Could not return selected entries to statements.');
            }
            return;
        }

        const autoBtn = e.target.closest('.bank-recon-ledger-auto-match');
        if (autoBtn && !autoBtn.disabled) {
            const txnId = autoBtn.dataset.txn;
            const txn = fnFinances().txns?.find((t) => t.id === txnId);
            const line = txn ? findStatementMatchForTxn(txn) : null;
            if (!line) {
                alert('No unmatched statement line found with the same amount within the date tolerance.');
                return;
            }
            try {
                await withButtonBusy(autoBtn, 'Matching…', () => matchBankLine(line.id, txnId));
                renderBankReconciliation();
                window.renderCashLedger?.();
                window.processFinances?.();
                window.renderFinanceAnalytics?.();
            } catch (err) {
                alert(err?.message || 'Could not match.');
            }
            return;
        }

        const toStatementBtn = e.target.closest('.bank-recon-ledger-to-statement');
        if (toStatementBtn && toStatementBtn.dataset.busy !== '1') {
            const txnId = toStatementBtn.dataset.txn;
            if (!txnId) return;
            if (!confirm('Return this entry to statement lines? The ledger transaction will be removed and an unmatched statement row will be created so you can classify and post again.')) return;
            try {
                await withButtonBusy(toStatementBtn, 'Moving…', async () => {
                    await returnLedgerTxnToStatement(txnId);
                    renderBankReconciliation();
                    window.renderCashLedger?.();
                    window.processFinances?.();
                    window.renderFinanceAnalytics?.();
                });
            } catch (err) {
                alert(err?.message || 'Could not return to statement lines.');
            }
            return;
        }

        const editBtn = e.target.closest('.bank-recon-ledger-edit');
        if (editBtn) {
            navigateFinance('finance-ledger');
            window.editTxn?.(editBtn.dataset.txn);
            return;
        }

        const delBtn = e.target.closest('.bank-recon-ledger-delete');
        if (delBtn) {
            try {
                await withButtonBusy(delBtn, 'Deleting…', async () => {
                    await window.delTxn?.(delBtn.dataset.txn);
                });
                renderBankReconciliation();
                window.renderFinanceAnalytics?.();
            } catch (err) {
                alert(err?.message || 'Could not delete.');
            }
        }
    });

    syncLedgerBulkUi();
};

const syncBulkSelectionUi = (root) => {
    const checks = [...root.querySelectorAll('.bank-recon-row-check')];
    const selected = checks.filter((c) => c.checked);
    const bulkDeleteBtn = root.querySelector('#fn-bank-recon-bulk-delete, #bank-recon-bulk-delete');
    const bulkPostBtn = root.querySelector('#fn-bank-recon-bulk-post, #bank-recon-bulk-post');
    const postAllBtn = root.querySelector('#fn-bank-recon-post-all-ready, #bank-recon-post-all-ready');
    const countEl = root.querySelector('#fn-bank-recon-bulk-count, #bank-recon-bulk-count');
    const selectAll = root.querySelector('#fn-bank-recon-select-all, #bank-recon-select-all');

    let postableAll = 0;
    let postableSelected = 0;
    root.querySelectorAll('.bank-recon-table__row[data-line-id]').forEach((row) => {
        normalizeClassifyStatesForPost(row);
        if (!rowClassifyReady(row, { allowCustom: true })) return;
        postableAll += 1;
        const cb = row.querySelector('.bank-recon-row-check');
        if (cb?.checked) postableSelected += 1;
    });

    if (bulkDeleteBtn) {
        const allowDelete = canDeleteAccounts();
        bulkDeleteBtn.hidden = !allowDelete;
        bulkDeleteBtn.disabled = !allowDelete || selected.length === 0;
    }
    if (bulkPostBtn) bulkPostBtn.disabled = postableSelected === 0;
    if (postAllBtn) {
        postAllBtn.disabled = postableAll === 0;
        postAllBtn.title = postableAll
            ? `Create ledger entries for ${postableAll} row(s) with category filled`
            : 'No rows ready to post — fill category (and sub-category/vendor for expenses) first';
    }
    if (countEl) {
        const parts = [];
        if (selected.length) parts.push(`${selected.length} selected`);
        if (postableAll) parts.push(`${postableAll} ready to post`);
        countEl.textContent = parts.join(' · ');
    }
    if (selectAll) {
        selectAll.indeterminate = selected.length > 0 && selected.length < checks.length;
        selectAll.checked = checks.length > 0 && selected.length === checks.length;
    }
};

const syncBulkPostUi = () => {
    const root = document.getElementById('fn-bank-recon-lines');
    if (root) syncBulkSelectionUi(root);
};

const collectPostableRows = (root, { selectedOnly = false } = {}) => {
    const rows = [...root.querySelectorAll('.bank-recon-table__row[data-line-id]')];
    const selectedIds = selectedOnly
        ? new Set([...root.querySelectorAll('.bank-recon-row-check:checked')].map((c) => c.dataset.line))
        : null;
    const postable = [];
    for (const row of rows) {
        if (selectedOnly && !selectedIds.has(row.dataset.lineId)) continue;
        normalizeClassifyStatesForPost(row);
        if (rowClassifyReady(row, { allowCustom: true })) postable.push(row);
    }
    return postable;
};

const bulkPostClassifiedRows = async ({ root, selectedOnly = false } = {}) => {
    const postable = collectPostableRows(root, { selectedOnly });
    if (!postable.length) return { posted: 0, failed: 0 };

    const rows = postable.map((row) => ({
        line_id: row.dataset.lineId,
        cat: row.querySelector('.bank-recon-cat-input')?.value?.trim() || '',
        sub_category: row.querySelector('.bank-recon-subcat-input')?.value?.trim() || null,
        vendor_name: row.querySelector('.bank-recon-vendor-input')?.value?.trim() || null,
        exclude_from_reports: row.querySelector('.bank-recon-exclude-reports-input')?.checked === true,
    }));

    const result = await createTxnsFromBankLines(rows);
    if (result?.posted) {
        renderBankReconciliation();
        window.renderCashLedger?.();
        window.processFinances?.();
    } else {
        syncBulkPostUi();
    }
    return { posted: result?.posted || 0, failed: result?.failed || 0 };
};

const setRowBusy = (row, busy, label = '') => {
    if (!row) return;
    row.classList.toggle('bank-recon-table__row--busy', busy);
    row.querySelectorAll('select, input, textarea, button').forEach((el) => { el.disabled = busy; });
    const statusEl = row.querySelector('.bank-recon-row-status');
    if (statusEl) {
        statusEl.textContent = busy ? label : '';
        statusEl.hidden = !busy;
    }
};

const clearRowClassify = (row) => {
    const cat = row?.querySelector('.bank-recon-cat-input');
    const sub = row?.querySelector('.bank-recon-subcat-input');
    const vendor = row?.querySelector('.bank-recon-vendor-input');
    if (cat) {
        cat.value = '';
        setClassifyInputState(cat, '');
    }
    if (sub) {
        sub.value = '';
        setClassifyInputState(sub, '');
    }
    if (vendor) vendor.value = '';
    const exclude = row?.querySelector('.bank-recon-exclude-reports-input');
    if (exclude) exclude.checked = false;
    syncRowPostButton(row);
};

const clearRowMatch = (row) => {
    const matchSel = row?.querySelector('.bank-match-select');
    if (matchSel) matchSel.value = '';
};

const getClassificationRules = () => fnFinances().bankClassificationRules || [];

const ensureClassificationRulesLoaded = async ({ force = false } = {}) => {
    if (!force && getClassificationRules().length) return getClassificationRules();

    try {
        const { rules } = await postFnMutation('listBankClassificationRules', {});
        fnFinances().bankClassificationRules = sortClassificationRules(rules || []);
        return fnFinances().bankClassificationRules;
    } catch (err) {
        console.warn('[bankRecon] listBankClassificationRules failed:', err?.message || err);
    }

    // Finance-New: rules come from Mongo finance_config only (no Postgres fallback).
    return fnFinances().bankClassificationRules || [];
};

const upsertLocalClassificationRule = (rule) => {
    const rules = [...getClassificationRules()];
    const idx = rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) rules[idx] = rule;
    else rules.push(rule);
    fnFinances().bankClassificationRules = sortClassificationRules(rules);
};

const saveBankClassificationRule = async (payload) => {
    const { rule } = await postFnMutation('saveBankClassificationRule', payload);
    upsertLocalClassificationRule(rule);
    return rule;
};

const deleteBankClassificationRule = async (id) => {
    await postFnMutation('deleteBankClassificationRule', { id });
    fnFinances().bankClassificationRules = getClassificationRules().filter((r) => r.id !== id);
};

const applyRuleToClassifyRow = (row, rule, { skipIfFilled = true } = {}) => {
    if (!row || !rule) return false;
    const catInput = row.querySelector('.bank-recon-cat-input');
    if (!catInput) return false;
    if (skipIfFilled && catInput.value?.trim()) return false;

    if (rule.category) {
        catInput.value = rule.category;
        setClassifyInputState(
            catInput,
            isExactListMatch(rule.category, categoryOptionsForRow(row)) ? 'known' : 'custom',
        );
    }

    const subInput = row.querySelector('.bank-recon-subcat-input');
    if (rule.sub_category && subInput) {
        subInput.value = rule.sub_category;
        setClassifyInputState(
            subInput,
            isExactListMatch(rule.sub_category, subCatOptionsForCategory(resolvedCategoryForRow(row))) ? 'known' : 'custom',
        );
    }

    const vendorInput = row.querySelector('.bank-recon-vendor-input');
    if (rule.vendor_name && vendorInput) vendorInput.value = rule.vendor_name;

    const excludeInput = row.querySelector('.bank-recon-exclude-reports-input');
    if (excludeInput && rule.exclude_from_reports) excludeInput.checked = true;

    syncRowPostButton(row);
    return Boolean(rule.category && catInput.value?.trim());
};

const runClassificationRulesOnUnmatched = async ({ autoPost = false, onlyEmpty = true } = {}) => {
    await ensureClassificationRulesLoaded({ force: true });
    const rules = getClassificationRules();
    const linesEl = document.getElementById('fn-bank-recon-lines');
    if (!linesEl || !rules.length) {
        return { applied: 0, posted: 0, examined: 0, noRule: 0, skippedFilled: 0, ruleCount: rules.length };
    }

    let preview = null;
    try {
        preview = await postFnMutation('previewBankClassificationRules', {});
    } catch (err) {
        console.warn('[bankRecon] previewBankClassificationRules failed:', err?.message || err);
    }

    let applied = 0;
    let posted = 0;
    let skippedFilled = 0;
    const examined = preview?.examined ?? 0;
    const noRule = preview?.noRule ?? 0;
    const ruleCount = preview?.ruleCount ?? rules.length;
    const matchList = preview?.matches?.length
        ? preview.matches
        : null;

    const applyMatch = async (lineId, rulePayload) => {
        const row = linesEl.querySelector(`tr[data-line-id="${lineId}"]`);
        if (!row || row.classList.contains('bank-recon-table__row--processed')) return;
        const rule = rulePayload.rule_id
            ? (rules.find((r) => r.id === rulePayload.rule_id) || rulePayload)
            : rulePayload;
        if (!applyRuleToClassifyRow(row, rule, { skipIfFilled: onlyEmpty })) {
            skippedFilled += 1;
            return;
        }
        applied += 1;
        if (autoPost) {
            normalizeClassifyStatesForPost(row);
            if (rowClassifyReady(row, { allowCustom: false })) {
                await tryAutoPostFromRow(row, lineId, { skipRender: true });
                posted += 1;
            }
        }
    };

    if (matchList) {
        for (const match of matchList) {
            await applyMatch(match.line_id, match);
        }
    } else {
        let clientExamined = 0;
        let clientNoRule = 0;
        for (const row of linesEl.querySelectorAll('.bank-recon-table__row[data-line-id]')) {
            if (row.classList.contains('bank-recon-table__row--processed')) continue;
            const lineId = row.dataset.lineId;
            const line = fnFinances().bankStatementLines?.find((l) => l.id === lineId);
            if (!line || line.match_status !== 'UNMATCHED') continue;
            clientExamined += 1;
            const rule = findMatchingRule(line, rules, row);
            if (!rule) {
                clientNoRule += 1;
                continue;
            }
            await applyMatch(lineId, rule);
        }
        if (!preview) {
            return {
                applied,
                posted,
                examined: clientExamined,
                noRule: clientNoRule,
                skippedFilled,
                ruleCount: rules.length,
            };
        }
    }

    if (posted) {
        renderBankReconciliation();
        window.renderCashLedger?.();
        window.processFinances?.();
    } else if (applied) {
        syncBulkPostUi();
    }

    return {
        applied,
        posted,
        examined,
        noRule,
        skippedFilled,
        ruleCount,
        sampleLineDescription: preview?.sampleLineDescription || null,
        sampleRuleMatch: preview?.sampleRuleMatch || null,
    };
};

const ruleTypeLabel = (type) => (type === 'IN' ? 'Income' : 'Expense');

const renderClassificationRulesList = () => {
    const listEl = document.getElementById('bank-recon-rules-list');
    const emptyEl = document.getElementById('bank-recon-rules-empty');
    if (!listEl) return;

    const rules = getClassificationRules();
    if (emptyEl) emptyEl.hidden = rules.length > 0;
    if (!rules.length) {
        listEl.innerHTML = '';
        return;
    }

    listEl.innerHTML = `
      <table class="bank-recon-rules-table">
        <thead>
          <tr>
            <th>Match</th>
            <th>Type</th>
            <th>Category</th>
            <th>Sub / vendor</th>
            <th>Reports</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rules.map((rule) => {
        const extras = [
            rule.sub_category ? esc(rule.sub_category) : '',
            rule.vendor_name ? esc(rule.vendor_name) : '',
        ].filter(Boolean).join(' · ');
        return `<tr data-rule-id="${rule.id}">
              <td class="bank-recon-rules-table__match" title="${esc(rule.description_match)}">${esc(rule.description_match)}</td>
              <td>${ruleTypeLabel(rule.line_type)}</td>
              <td>${esc(rule.category)}</td>
              <td class="bank-recon-rules-table__extras">${extras || '—'}</td>
              <td>${rule.exclude_from_reports ? 'Exclude' : 'Include'}</td>
              <td class="bank-recon-rules-table__actions">
                <button type="button" class="btn btn-outline btn--small btn--icon btn--danger bank-recon-rule-delete" data-rule-id="${rule.id}" title="Delete rule" aria-label="Delete rule"><i class="fa-solid fa-trash-can"></i></button>
              </td>
            </tr>`;
    }).join('')}
        </tbody>
      </table>`;
};

const refreshRuleFormCategoryList = () => {
    const datalist = document.getElementById('bank-recon-rule-categories');
    const typeSel = document.getElementById('bank-recon-rule-type');
    if (!datalist || !typeSel) return;
    const isIncome = typeSel.value === 'IN';
    const cats = buildCategoryOptions(isIncome);
    datalist.innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');

    const subInput = document.getElementById('bank-recon-rule-sub');
    if (!subInput) return;
    let subList = document.getElementById('bank-recon-rule-subcats');
    if (!subList) {
        subList = document.createElement('datalist');
        subList.id = 'bank-recon-rule-subcats';
        subInput.setAttribute('list', 'bank-recon-rule-subcats');
        subInput.after(subList);
    }
    const cat = document.getElementById('bank-recon-rule-category')?.value?.trim() || '';
    subList.innerHTML = isIncome
        ? ''
        : buildSubCategoryOptions(cat).map((s) => `<option value="${esc(s)}"></option>`).join('');
};

const syncRuleFormExpenseFields = () => {
    const typeSel = document.getElementById('bank-recon-rule-type');
    const isExpense = typeSel?.value === 'OUT';
    document.getElementById('bank-recon-rule-sub-wrap')?.classList.toggle('bank-recon-rules-field--hidden', !isExpense);
    document.getElementById('bank-recon-rule-vendor-wrap')?.classList.toggle('bank-recon-rules-field--hidden', !isExpense);
    refreshRuleFormCategoryList();
};

const prefillClassificationRuleForm = (prefill = {}) => {
    const matchInput = document.getElementById('bank-recon-rule-match');
    const typeSel = document.getElementById('bank-recon-rule-type');
    const catInput = document.getElementById('bank-recon-rule-category');
    const subInput = document.getElementById('bank-recon-rule-sub');
    const vendorInput = document.getElementById('bank-recon-rule-vendor');
    const priorityInput = document.getElementById('bank-recon-rule-priority');
    if (matchInput) matchInput.value = prefill.description_match || '';
    if (typeSel) typeSel.value = prefill.line_type === 'OUT' ? 'OUT' : 'IN';
    syncRuleFormExpenseFields();
    if (catInput) catInput.value = prefill.category || '';
    if (subInput) subInput.value = prefill.sub_category || '';
    if (vendorInput) vendorInput.value = prefill.vendor_name || '';
    if (priorityInput) priorityInput.value = String(prefill.priority ?? 0);
    const excludeInput = document.getElementById('bank-recon-rule-exclude-reports');
    if (excludeInput) excludeInput.checked = !!prefill.exclude_from_reports;
};

const openClassificationRulesModal = async (prefill = null) => {
    const modal = document.getElementById('bank-recon-rules-modal');
    if (!modal) return;
    await ensureClassificationRulesLoaded({ force: true });
    renderClassificationRulesList();
    prefillClassificationRuleForm(prefill || {});
    modal.classList.add('active');
    if (prefill) document.getElementById('bank-recon-rule-match')?.focus();
};

const closeClassificationRulesModal = () => {
    document.getElementById('bank-recon-rules-modal')?.classList.remove('active');
};

const openSaveRuleFromRow = (row) => {
    const lineId = row?.dataset.lineId;
    const line = fnFinances().bankStatementLines?.find((l) => l.id === lineId);
    if (!line) return;
    const category = row.querySelector('.bank-recon-cat-input')?.value?.trim();
    if (!category) {
        alert('Pick a category first, then save as a rule.');
        return;
    }
    openClassificationRulesModal({
        description_match: suggestRuleMatchText(line.description),
        line_type: bankLineType(line),
        category,
        sub_category: row.querySelector('.bank-recon-subcat-input')?.value?.trim() || '',
        vendor_name: row.querySelector('.bank-recon-vendor-input')?.value?.trim() || '',
        exclude_from_reports: row.querySelector('.bank-recon-exclude-reports-input')?.checked === true,
    });
};

const tryAutoPostFromRow = async (row, lineId, { allowCustom = false, skipRender = false } = {}) => {
    if (!row || row.classList.contains('bank-recon-table__row--busy')) return;
    const matchSel = row.querySelector('.bank-match-select');
    if (matchSel?.value) return;

    const cat = row.querySelector('.bank-recon-cat-input')?.value?.trim();
    if (!cat) return;
    const sub_category = row.querySelector('.bank-recon-subcat-input')?.value?.trim() || null;
    const vendor_name = row.querySelector('.bank-recon-vendor-input')?.value?.trim() || null;
    const exclude_from_reports = row.querySelector('.bank-recon-exclude-reports-input')?.checked === true;
    if (!rowClassifyReady(row, { allowCustom })) return;

    setRowBusy(row, true, 'Posting…');
    try {
        await createTxnFromBankLine(lineId, { cat, sub_category, vendor_name, exclude_from_reports });
        if (!skipRender) {
            renderBankReconciliation();
            window.renderCashLedger?.();
            window.processFinances?.();
        } else {
            setRowBusy(row, false);
        }
    } catch (err) {
        setRowBusy(row, false);
        alert(err?.message || 'Could not post transaction.');
        throw err;
    }
};

const tryAutoMatchFromRow = async (row, lineId, txnId) => {
    if (!row || row.classList.contains('bank-recon-table__row--busy')) return;
    clearRowClassify(row);
    setRowBusy(row, true, 'Matching…');
    try {
        await matchBankLine(lineId, txnId);
        renderBankReconciliation();
        window.renderCashLedger?.();
    } catch (err) {
        setRowBusy(row, false);
        const matchSel = row.querySelector('.bank-match-select');
        if (matchSel) matchSel.value = '';
        alert(err?.message || 'Match failed.');
    }
};

const wireRowOrderButtons = (linesEl) => {
    const onMove = async (btn, direction) => {
        if (!btn || btn.disabled || btn.dataset.busy === '1') return;
        const stepInput = btn.closest('.bank-recon-order-btns')?.querySelector('.bank-recon-move-step');
        const steps = Math.max(1, parseInt(stepInput?.value, 10) || 1);
        const choice = await promptRowMoveRecalc();
        if (choice === 'cancel') return;
        const recalculate = choice === 'recalc';
        try {
            await withButtonBusy(btn, 'Moving…', () => moveStatementLineInDay(btn.dataset.line, direction, { recalculate, steps }));
            if (recalculate) {
                renderBankReconciliation();
            } else {
                refreshStatementTableRowOrder(linesEl);
            }
        } catch (err) {
            alert(err?.message || 'Could not reorder row.');
        }
    };

    linesEl.querySelectorAll('.bank-recon-move-step').forEach((input) => {
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => e.stopPropagation());
    });

    linesEl.querySelectorAll('.bank-recon-move-up').forEach((btn) => {
        btn.addEventListener('click', () => onMove(btn, -1));
    });
    linesEl.querySelectorAll('.bank-recon-move-down').forEach((btn) => {
        btn.addEventListener('click', () => onMove(btn, 1));
    });
};

const wireStatementTable = (linesEl) => {
    const getSelectedLineIds = () => [...linesEl.querySelectorAll('.bank-recon-row-check:checked')]
        .map((c) => c.dataset.line);

    linesEl.querySelector('#fn-bank-recon-select-all')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        linesEl.querySelectorAll('.bank-recon-row-check').forEach((c) => { c.checked = on; });
        syncBulkSelectionUi(linesEl);
    });

    linesEl.querySelectorAll('.bank-recon-row-check').forEach((cb) => {
        cb.addEventListener('change', () => syncBulkSelectionUi(linesEl));
    });

    linesEl.querySelector('#fn-bank-recon-bulk-delete')?.addEventListener('click', async () => {
        const ids = getSelectedLineIds();
        if (!ids.length) return;
        if (!confirm(`Delete ${ids.length} statement line(s) permanently?`)) return;
        const btn = linesEl.querySelector('#fn-bank-recon-bulk-delete');
        try {
            await withButtonBusy(btn, 'Deleting…', () => deleteBankStatementLines(ids));
            renderBankReconciliation();
        } catch (err) {
            alert(err?.message || 'Bulk delete failed.');
        }
    });

    const confirmBulkPost = (count, selectedOnly) => {
        const scope = selectedOnly ? 'selected' : 'ready';
        return confirm(`Post ${count} ${scope} row(s) to the ledger? This creates transactions and marks lines as matched.`);
    };

    linesEl.querySelector('#fn-bank-recon-bulk-post')?.addEventListener('click', async () => {
        const postable = collectPostableRows(linesEl, { selectedOnly: true });
        if (!postable.length) return;
        if (!confirmBulkPost(postable.length, true)) return;
        const btn = linesEl.querySelector('#fn-bank-recon-bulk-post');
        try {
            const { posted, failed } = await withButtonBusy(btn, 'Posting…', () => bulkPostClassifiedRows({ root: linesEl, selectedOnly: true }));
            const failNote = failed ? ` ${failed} failed.` : '';
            alert(posted ? `Posted ${posted} row(s).${failNote}` : 'Could not post selected rows.');
        } catch (err) {
            alert(err?.message || 'Bulk post failed.');
        }
    });

    linesEl.querySelector('#fn-bank-recon-post-all-ready')?.addEventListener('click', async () => {
        const postable = collectPostableRows(linesEl, { selectedOnly: false });
        if (!postable.length) return;
        if (!confirmBulkPost(postable.length, false)) return;
        const btn = linesEl.querySelector('#fn-bank-recon-post-all-ready');
        try {
            const { posted, failed } = await withButtonBusy(btn, 'Posting…', () => bulkPostClassifiedRows({ root: linesEl, selectedOnly: false }));
            const failNote = failed ? ` ${failed} failed.` : '';
            alert(posted ? `Posted ${posted} row(s).${failNote}` : 'Could not post ready rows.');
        } catch (err) {
            alert(err?.message || 'Bulk post failed.');
        }
    });

    syncBulkSelectionUi(linesEl);
    wireBankReconTableResize();
    linesEl.querySelectorAll('[data-sort-key]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.sortKey;
            if (!key) return;
            bankReconSortState = bankReconSortState.key === key
                ? { key, dir: bankReconSortState.dir === 'asc' ? 'desc' : 'asc' }
                : { key, dir: 'asc' };
            renderBankReconciliation();
        });
    });
    linesEl.querySelectorAll('[data-column-toggle]').forEach((input) => {
        input.addEventListener('change', () => {
            const key = input.dataset.columnToggle;
            if (!key) return;
            const on = !!input.checked;
            if (key === 'passbookBalance' || key === 'calculatedBalance') {
                bankReconVisibleColumns = {
                    ...bankReconVisibleColumns,
                    passbookBalance: on,
                    calculatedBalance: on,
                };
            } else {
                bankReconVisibleColumns = {
                    ...bankReconVisibleColumns,
                    [key]: on,
                };
            }
            renderBankReconciliation();
        });
    });
    linesEl.querySelectorAll('.bank-recon-cell-input').forEach((input) => {
        input.addEventListener('change', async () => {
            const lineId = input.dataset.line;
            const field = input.dataset.field;
            try {
                let value = input.value;
                if (field === 'line_date') {
                    value = parseEditableDate(value);
                    if (!value) throw new Error('Enter date as DD-MM-YY.');
                    input.value = formatDisplayDate(value);
                }
                if (field === 'debit' || field === 'credit' || field === 'balance') {
                    value = value === '' ? 0 : parseFloat(value);
                    if (!Number.isFinite(value)) return;
                }
                await updateBankStatementLine(lineId, { [field]: value });
                if (field === 'debit' && value > 0) {
                    const creditInput = linesEl.querySelector(`input[data-line="${lineId}"][data-field="credit"]`);
                    if (creditInput?.value) {
                        creditInput.value = '';
                        await updateBankStatementLine(lineId, { credit: 0 });
                    }
                }
                if (field === 'credit' && value > 0) {
                    const debitInput = linesEl.querySelector(`input[data-line="${lineId}"][data-field="debit"]`);
                    if (debitInput?.value) {
                        debitInput.value = '';
                        await updateBankStatementLine(lineId, { debit: 0 });
                    }
                }
                if (field === 'debit' || field === 'credit' || field === 'line_date') {
                    renderBankReconciliation();
                }
            } catch (err) {
                alert(err?.message || 'Could not save line.');
                renderBankReconciliation();
            }
        });
    });

    linesEl.querySelectorAll('.bank-match-select').forEach((sel) => {
        sel.addEventListener('change', async () => {
            const txnId = sel.value;
            if (!txnId) return;
            await tryAutoMatchFromRow(sel.closest('tr'), sel.dataset.line, txnId);
        });
    });

    linesEl.querySelectorAll('.bank-recon-table__row[data-line-id]').forEach((row) => {
        const onClassifyStateChange = () => syncRowPostButton(row);

        const catWrap = row.querySelector('.bank-recon-classify-combobox--cat');
        if (catWrap) {
            wireClassifyCombobox(catWrap, {
                getOptions: () => categoryOptionsForRow(row),
                onCustomSelect: (value) => {
                    registerCustomCategory(value, row.dataset.lineType === 'IN');
                },
                onKnownSelect: () => {
                    clearRowMatch(row);
                    const isIncome = row.dataset.lineType === 'IN';
                    const subInput = row.querySelector('.bank-recon-subcat-input');
                    if (subInput) {
                        subInput.value = '';
                        setClassifyInputState(subInput, '');
                    }
                    syncRowPostButton(row);
                    if (isIncome) maybeAutoPostRow(row);
                },
                onStateChange: onClassifyStateChange,
            });
        }

        const subWrap = row.querySelector('.bank-recon-classify-combobox--sub');
        if (subWrap) {
            wireClassifyCombobox(subWrap, {
                getOptions: () => subCatOptionsForCategory(resolvedCategoryForRow(row)),
                onCustomSelect: (value) => {
                    registerCustomSubCategory(resolvedCategoryForRow(row), value);
                },
                onKnownSelect: () => {
                    syncRowPostButton(row);
                    maybeAutoPostRow(row);
                },
                onStateChange: onClassifyStateChange,
            });
        }
    });

    linesEl.querySelectorAll('.bank-recon-vendor-input').forEach((input) => {
        input.addEventListener('change', () => {
            const row = input.closest('tr');
            syncRowPostButton(row);
            maybeAutoPostRow(row);
        });
    });

    linesEl.querySelectorAll('.bank-recon-post-classify').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = btn.closest('tr');
            if (!row || btn.disabled || btn.dataset.busy === '1') return;
            if (!rowClassifyReady(row, { allowCustom: true })) {
                normalizeClassifyStatesForPost(row);
            }
            if (!rowClassifyReady(row, { allowCustom: true })) {
                alert('Pick category and sub-category from the list, or use + Add for new values, then fill vendor.');
                return;
            }
            const lineId = btn.dataset.line || row.dataset.lineId;
            try {
                await withButtonBusy(btn, 'Posting…', () => tryAutoPostFromRow(row, lineId, { allowCustom: true }));
            } catch (err) {
                alert(err?.message || 'Could not post transaction.');
            }
        });
    });

    linesEl.querySelectorAll('.bank-recon-save-rule-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            openSaveRuleFromRow(btn.closest('tr'));
        });
    });

    linesEl.querySelectorAll('.bank-recon-table__row[data-line-id]').forEach((row) => {
        if (row.classList.contains('bank-recon-table__row--processed')) return;
        const line = fnFinances().bankStatementLines?.find((l) => l.id === row.dataset.lineId);
        if (!line || line.match_status !== 'UNMATCHED') return;
        const rule = findMatchingRule(line, getClassificationRules(), row);
        if (rule) applyRuleToClassifyRow(row, rule, { skipIfFilled: true });
    });

    linesEl.querySelectorAll('.bank-delete-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this statement line permanently?')) return;
            try {
                await deleteBankStatementLine(btn.dataset.line);
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not delete line.');
            }
        });
    });

    linesEl.querySelectorAll('.bank-ignore-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Mark this line as ignored (bank charges, etc.)?')) return;
            try {
                await ignoreBankLine(btn.dataset.line);
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not ignore line.');
            }
        });
    });

    wireRowOrderButtons(linesEl);
};

export const renderBankReconciliation = () => {
    const linesEl = document.getElementById('fn-bank-recon-lines');
    const txnsEl = document.getElementById('fn-bank-recon-txns');
    const statsEl = document.getElementById('fn-bank-recon-stats');
    const openingPanelEl = document.getElementById('fn-bank-recon-opening-panel');
    const passbookBtn = document.getElementById('fn-bank-recon-passbook-btn');
    const passbookHint = document.getElementById('fn-bank-recon-passbook-hint');
    if (!linesEl || !txnsEl) return;

    const passbookReady = isPassbookOcrConfigured();
    if (passbookBtn) {
        passbookBtn.disabled = !passbookReady;
        passbookBtn.title = passbookReady
            ? 'Scan passbook photos or PDF with Evolyx OCR'
            : 'Configure Evolyx under Administration → Integrations';
    }
    if (passbookHint) {
        passbookHint.hidden = passbookReady;
        passbookHint.innerHTML = passbookReady
            ? ''
            : 'Passbook OCR is not configured. <a href="/admin/integrations">Set up Evolyx</a> under Administration → Integrations.';
    }
    updatePassbookJobsBadge(latestPassbookJobs);

    const annotated = annotateStatementLineBalances();
    const lines = fnFinances().bankStatementLines || [];
    const unmatchedRaw = annotated.filter((l) => l.match_status === 'UNMATCHED');
    const matched = annotated.filter((l) => l.match_status === 'MATCHED');
    const ignored = annotated.filter((l) => l.match_status === 'IGNORED');
    const snap = getWorkReconSnapshot(unmatchedRaw);
    const unmatched = snap.workLines;
    const visibleColumns = getVisibleBalanceColumns();

    if (openingPanelEl) {
        openingPanelEl.innerHTML = renderOpeningBalancePanel();
        updateOpeningBalanceTabMeta();
        document.getElementById('fn-bank-recon-opening-save')?.addEventListener('click', async () => {
            const date = document.getElementById('fn-bank-recon-opening-date')?.value;
            const raw = document.getElementById('fn-bank-recon-opening-amount')?.value?.trim();
            const amount = raw === '' ? null : parseFloat(raw);
            const btn = document.getElementById('fn-bank-recon-opening-save');
            try {
                await saveThenRecalculate(btn, 'Saving…', () => saveBankOpeningBalance(date, amount, { pull: false }));
                renderBankReconciliation();
            } catch (err) {
                alert(err?.message || 'Could not save opening balance.');
            }
        });
    }

    const openingCfg = getBankOpeningConfig();
    const needsOpeningTab = openingCfg.amount == null || !openingCfg.date;
    if (needsOpeningTab && !activeBankReconTab) {
        setActiveBankReconTab('opening');
    } else if (activeBankReconTab) {
        setActiveBankReconTab(activeBankReconTab);
    } else if (snap.workMismatchCount > 0 || (snap.closingGap && snap.sameAsOf)) {
        setActiveBankReconTab('opening');
    }

    if (statsEl) {
        const ledgerBank = snap.ledgerBank;
        const calcValue = ledgerBank.balance != null ? formatMoney(ledgerBank.balance) : '—';
        const asOfLabel = snap.sameAsOf ? snap.calcAsOf : (snap.passbookAsOf || snap.calcAsOf);
        const calcSub = ledgerBank.balance != null
            ? `posted books${asOfLabel ? ` · ${formatDisplayDate(asOfLabel)}` : ''} · ${ledgerBank.txnCount} BANK ${ledgerBank.txnCount === 1 ? 'entry' : 'entries'}`
            : 'set opening balance';
        const passbookWarn = snap.closingGap && snap.sameAsOf;
        const passbookBlock = snap.postedPassbook
            ? `<div class="bank-recon-kpi bank-recon-kpi--passbook${passbookWarn ? ' bank-recon-kpi--warn-border' : ''}">
                <span class="bank-recon-kpi__label">Passbook</span>
                <span class="bank-recon-kpi__value">${formatMoney(snap.postedPassbook.balance)}</span>
                <span class="bank-recon-kpi__sub">posted books${asOfLabel ? ` · ${formatDisplayDate(asOfLabel)}` : ''}</span>
              </div>`
            : '';
        const varianceSub = !snap.sameAsOf && snap.postedPassbook
            ? `dates ${formatDisplayDate(snap.calcAsOf)} / ${formatDisplayDate(snap.passbookAsOf)}`
            : (snap.closingGap ? 'posted books — review' : 'posted books');
        const varianceDanger = snap.closingGap && snap.sameAsOf;
        const varianceBlock = snap.closingDiff != null
            ? `<div class="bank-recon-kpi bank-recon-kpi--var${varianceDanger ? ' bank-recon-kpi--danger' : ''}">
                <span class="bank-recon-kpi__label">Variance</span>
                <span class="bank-recon-kpi__value">${snap.closingDiff >= 0 ? '+' : ''}${formatMoney(snap.closingDiff)}</span>
                <span class="bank-recon-kpi__sub">${varianceSub}</span>
              </div>`
            : '';
        const statusParts = [
            `<span class="bank-recon-stat"><strong>${lines.length}</strong> lines</span>`,
            `<span class="bank-recon-stat bank-recon-stat--danger"><strong>${unmatched.length}</strong> unmatched</span>`,
            `<span class="bank-recon-stat bank-recon-stat--success"><strong>${matched.length}</strong> matched</span>`,
        ];
        if (ignored.length) {
            statusParts.push(`<span class="bank-recon-stat"><strong>${ignored.length}</strong> ignored</span>`);
        }
        if (snap.workMismatchCount > 0) {
            statusParts.push(`<button type="button" class="bank-recon-stat bank-recon-stat--warn bank-recon-mismatch-jump" data-filter-scope="work"><strong>${snap.workMismatchCount}</strong> work mismatch${snap.workMismatchCount === 1 ? '' : 'es'}</button>`);
        }
        statsEl.innerHTML = `
          <div class="bank-recon-kpi-bar" role="group" aria-label="Reconciliation summary">
            <div class="bank-recon-kpi-cluster">
              <div class="bank-recon-kpi bank-recon-kpi--calc${ledgerBank.balance == null ? ' bank-recon-kpi--warn' : ''}">
                <span class="bank-recon-kpi__label">Calculated</span>
                <span class="bank-recon-kpi__value">${calcValue}</span>
                <span class="bank-recon-kpi__sub">${calcSub}</span>
              </div>
              ${passbookBlock}
              ${varianceBlock}
            </div>
            <div class="bank-recon-kpi bank-recon-kpi--progress">
              <span class="bank-recon-kpi__label">Statement</span>
              <span class="bank-recon-kpi__counts">${statusParts.join('<span class="bank-recon-stat-sep" aria-hidden="true">·</span>')}</span>
            </div>
          </div>`;
    }

    const ledgerTxns = getUnmatchedLedgerTxns();

    linesEl.innerHTML = renderStatementTable(unmatched, visibleColumns) + renderProcessedLinesSection(matched, ignored, visibleColumns);
    txnsEl.innerHTML = renderLedgerTable(ledgerTxns);
    wireLedgerTable(txnsEl);

    wireStatementTable(linesEl);
    wireProcessedLines(linesEl);
    ensureClassificationRulesLoaded({ force: true }).then(() => {
        linesEl.querySelectorAll('.bank-recon-table__row[data-line-id]').forEach((row) => {
            if (row.classList.contains('bank-recon-table__row--processed')) return;
            const line = fnFinances().bankStatementLines?.find((l) => l.id === row.dataset.lineId);
            if (!line || line.match_status !== 'UNMATCHED') return;
            const rule = findMatchingRule(line, getClassificationRules(), row);
            if (rule) applyRuleToClassifyRow(row, rule, { skipIfFilled: true });
        });
        syncBulkPostUi();
    }).catch(() => {});
};

export async function downloadBankStatementTemplate() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Date', 'Description', 'Debit', 'Credit', 'Balance']);
    ws.addRow(['2026-01-05', 'NEFT MAINTENANCE COLLECTION', '', '15000', '125000']);
    ws.addRow(['2026-01-08', 'UPI VENDOR PAYMENT', '8500', '', '116500']);
    ws.columns = [{ width: 12 }, { width: 36 }, { width: 12 }, { width: 12 }, { width: 14 }];
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Bank_Statement_Template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
}

export const initBankReconciliationUi = () => {
    if (document.documentElement.dataset.fnBankReconUiWired === '1') return;
    document.documentElement.dataset.fnBankReconUiWired = '1';
    wireBankReconFiltersOnce();
    wireBankReconSourceTabs();
    initBankReconTableHeightControls(document.getElementById('fn-bank-recon-lines'));
    const setPassbookStatus = (msg, isError = false) => {
        const el = document.getElementById('fn-bank-recon-passbook-status');
        if (!el) return;
        el.hidden = !msg;
        el.textContent = msg;
        el.classList.toggle('bank-recon-passbook-status--error', isError);
    };
    const getActiveApartmentId = () => portalState.access?.activeApartmentId;
    const passbookJobsModal = document.getElementById('passbook-jobs-modal');
    const passbookJobsListEl = document.getElementById('passbook-jobs-list');
    const passbookJobsEmptyEl = document.getElementById('passbook-jobs-empty');
    const passbookJobDetailModal = document.getElementById('passbook-job-detail-modal');
    const passbookJobDetailBody = document.getElementById('passbook-job-detail-body');
    const passbookJobDetailTitle = document.getElementById('passbook-job-detail-title');

    const importPassbookJobRows = async (btn, job, lines, { skipDedupe = false, confirmMessage } = {}) => {
        const apartmentId = getActiveApartmentId();
        if (!apartmentId) throw new Error('Select an apartment first.');
        if (!lines.length) throw new Error('No rows to import.');

        const { unique, skipped } = skipDedupe
            ? { unique: lines, skipped: 0 }
            : dedupeBankImportLines(lines);
        if (!unique.length) {
            alert(skipDedupe
                ? 'No rows selected to import.'
                : `All ${lines.length} row(s) are already present in bank reconciliation.`);
            return null;
        }

        const dupNote = skipped ? `\n\n${skipped} duplicate(s) will be skipped.` : '';
        const message = confirmMessage || `Import ${unique.length} statement row(s) from this passbook scan?`;
        if (!confirm(`${message}${dupNote}`)) return null;

        const result = await withButtonBusy(btn, 'Importing…', () => importBankStatement(null, unique, {
            fileLabel: passbookJobImportLabel(job),
            skipDedupe: true,
        }));

        const nextImportCount = (job.import_count || 0) + result.count;
        await markPassbookJobImported(apartmentId, job.id, {
            importId: result.importId,
            importCount: nextImportCount,
        });
        setPassbookStatus(`Imported ${result.count} line(s) from passbook scan.`);
        renderBankReconciliation();
        await loadPassbookJobs();
        return result;
    };

    const syncPassbookJobDetailImportBtn = (root) => {
        const btn = root?.querySelector('#passbook-job-detail-force-import, #fn-passbook-job-detail-force-import');
        const selected = root?.querySelectorAll('.passbook-job-detail-check:checked').length || 0;
        if (btn) btn.disabled = selected === 0;
    };

    const renderPassbookJobDetail = (filter = passbookJobDetailState.filter) => {
        if (!passbookJobDetailBody || !passbookJobDetailState.job || !passbookJobDetailState.analysis) return;
        passbookJobDetailState.filter = filter;
        passbookJobDetailBody.innerHTML = renderPassbookJobDetailModal(
            passbookJobDetailState.job,
            passbookJobDetailState.analysis,
            filter,
        );
        wirePassbookJobDetail(passbookJobDetailBody);
    };

    const openPassbookJobDetail = async (jobId) => {
        const apartmentId = getActiveApartmentId();
        if (!apartmentId || !passbookJobDetailModal) return;
        try {
            const job = await fetchPassbookJobs(apartmentId, jobId);
            if (!job) throw new Error('Passbook job not found.');
            const analysis = analyzePassbookJobLines(
                job,
                fnFinances().bankStatementLines || [],
                fnFinances().bankStatementImports || [],
            );
            passbookJobDetailState = { job, analysis, filter: 'all' };
            if (passbookJobDetailTitle) {
                passbookJobDetailTitle.textContent = passbookJobFileNames(job);
            }
            const defaultFilter = analysis.summary.duplicates > 0 ? 'duplicates' : 'all';
            renderPassbookJobDetail(defaultFilter);
            passbookJobDetailModal.classList.add('active');
        } catch (err) {
            alert(err?.message || 'Could not load passbook job details.');
        }
    };

    const closePassbookJobDetail = () => {
        passbookJobDetailModal?.classList.remove('active');
        passbookJobDetailState = { job: null, analysis: null, filter: 'all' };
        if (passbookJobDetailBody) passbookJobDetailBody.innerHTML = '';
    };

    const wirePassbookJobDetail = (root) => {
        root.querySelectorAll('.passbook-job-detail-filter').forEach((btn) => {
            btn.addEventListener('click', () => renderPassbookJobDetail(btn.dataset.filter || 'all'));
        });

        root.querySelectorAll('.passbook-job-detail-check').forEach((cb) => {
            cb.addEventListener('change', () => syncPassbookJobDetailImportBtn(root));
        });

        root.querySelector('#passbook-job-detail-select-all, #fn-passbook-job-detail-select-all')?.addEventListener('change', (e) => {
            const on = e.target.checked;
            root.querySelectorAll('.passbook-job-detail-check').forEach((cb) => { cb.checked = on; });
            syncPassbookJobDetailImportBtn(root);
        });

        root.querySelector('#passbook-job-detail-select-dupes, #fn-passbook-job-detail-select-dupes')?.addEventListener('click', () => {
            root.querySelectorAll('.passbook-job-detail-check').forEach((cb) => {
                const row = cb.closest('tr');
                const isDup = row?.classList.contains('passbook-job-detail-table__row--skipped_existing')
                    || row?.classList.contains('passbook-job-detail-table__row--skipped_batch');
                cb.checked = !!isDup;
            });
            syncPassbookJobDetailImportBtn(root);
        });

        root.querySelector('#passbook-job-detail-force-import, #fn-passbook-job-detail-force-import')?.addEventListener('click', async () => {
            const { job, analysis } = passbookJobDetailState;
            if (!job || !analysis) return;
            const selectedIndexes = new Set(
                [...root.querySelectorAll('.passbook-job-detail-check:checked')].map((cb) => parseInt(cb.dataset.rowIndex, 10)),
            );
            const lines = analysis.rows
                .filter((row) => selectedIndexes.has(row.index))
                .map((row) => row.line);
            const btn = root.querySelector('#passbook-job-detail-force-import, #fn-passbook-job-detail-force-import');
            try {
                const result = await importPassbookJobRows(btn, job, lines, {
                    skipDedupe: true,
                    confirmMessage: `Force-import ${lines.length} selected row(s) into bank reconciliation?`,
                });
                if (result) {
                    alert(importResultMessage(result));
                    const refreshedJob = await fetchPassbookJobs(getActiveApartmentId(), job.id);
                    passbookJobDetailState.job = refreshedJob;
                    passbookJobDetailState.analysis = analyzePassbookJobLines(
                        refreshedJob,
                        fnFinances().bankStatementLines || [],
                        fnFinances().bankStatementImports || [],
                    );
                    renderPassbookJobDetail(passbookJobDetailState.filter);
                }
            } catch (err) {
                alert(err?.message || 'Could not import selected rows.');
            }
        });

        syncPassbookJobDetailImportBtn(root);
    };

    const stopPassbookJobsPolling = () => {
        if (passbookJobsModalTimer) {
            clearInterval(passbookJobsModalTimer);
            passbookJobsModalTimer = null;
        }
    };
    const renderPassbookJobsLists = () => {
        const tableHtml = renderPassbookJobsTable(latestPassbookJobs);
        const hasJobs = latestPassbookJobs.length > 0;

        if (passbookJobsListEl && passbookJobsEmptyEl) {
            passbookJobsListEl.innerHTML = tableHtml;
            passbookJobsEmptyEl.hidden = hasJobs;
            wirePassbookJobButtons(passbookJobsListEl);
        }

        const inlineList = document.getElementById('fn-bank-recon-passbook-jobs-inline-list');
        const inlineEmpty = document.getElementById('fn-bank-recon-passbook-jobs-inline-empty');
        if (inlineList) {
            inlineList.innerHTML = tableHtml;
            if (inlineEmpty) inlineEmpty.hidden = hasJobs;
            wirePassbookJobButtons(inlineList);
        }
    };

    const wirePassbookJobButtons = (root) => {
        if (!root) return;
        root.querySelectorAll('.bank-recon-import-passbook-job').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const apartmentId = getActiveApartmentId();
                if (!apartmentId) return alert('Select an apartment first.');
                const jobId = btn.dataset.job;
                try {
                    const job = await fetchPassbookJobs(apartmentId, jobId);
                    const lines = Array.isArray(job?.mapped_lines) ? job.mapped_lines : [];
                    if (!lines.length) {
                        alert('This scan completed, but no transaction rows were mapped from the OCR response.');
                        return;
                    }
                    const result = await importPassbookJobRows(btn, job, lines);
                    if (result) alert(importResultMessage(result));
                } catch (err) {
                    alert(err?.message || 'Could not import passbook job.');
                }
            });
        });

        root.querySelectorAll('.passbook-job-detail-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                openPassbookJobDetail(btn.dataset.job).catch((err) => {
                    alert(err?.message || 'Could not open job details.');
                });
            });
        });
    };

    const renderPassbookJobsModal = () => {
        renderPassbookJobsLists();
    };
    const loadPassbookJobs = async () => {
        const apartmentId = getActiveApartmentId();
        if (!apartmentId) {
            latestPassbookJobs = [];
            updatePassbookJobsBadge([]);
            renderPassbookJobsModal();
            return [];
        }
        latestPassbookJobs = await fetchPassbookJobs(apartmentId);
        updatePassbookJobsBadge(latestPassbookJobs);
        renderPassbookJobsModal();
        return latestPassbookJobs;
    };
    const openPassbookJobsModal = async () => {
        if (!passbookJobsModal) return;
        passbookJobsModal.classList.add('active');
        try {
            await loadPassbookJobs();
        } catch (err) {
            setPassbookStatus(err?.message || 'Could not load passbook jobs.', true);
        }
        stopPassbookJobsPolling();
        passbookJobsModalTimer = window.setInterval(() => {
            loadPassbookJobs().catch(() => {});
        }, 8000);
    };
    const closePassbookJobsModal = () => {
        passbookJobsModal?.classList.remove('active');
        stopPassbookJobsPolling();
    };

    const manualWrap = document.getElementById('fn-bank-recon-manual-entry');
    const manualRowsEl = document.getElementById('fn-bank-recon-manual-rows');
    let manualEntryRowSeq = 0;

    const escapeManualAttr = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');

    const defaultManualDate = () => new Date().toISOString().slice(0, 10);

    const clearManualRowFields = (row) => {
        const dateInput = row.querySelector('.manual-row-date');
        const descInput = row.querySelector('.manual-row-desc');
        const debitInput = row.querySelector('.manual-row-debit');
        const creditInput = row.querySelector('.manual-row-credit');
        const balanceInput = row.querySelector('.manual-row-balance');
        if (dateInput) dateInput.value = defaultManualDate();
        if (descInput) descInput.value = '';
        if (debitInput) debitInput.value = '';
        if (creditInput) creditInput.value = '';
        if (balanceInput) balanceInput.value = '';
    };

    const addManualEntryRow = (defaults = {}) => {
        if (!manualRowsEl) return null;
        manualEntryRowSeq += 1;
        const row = document.createElement('tr');
        row.dataset.manualRow = String(manualEntryRowSeq);
        row.innerHTML = `
          <td><input type="date" class="expense-combobox manual-row-date" value="${escapeManualAttr(defaults.date ?? defaultManualDate())}" /></td>
          <td><input type="text" class="expense-combobox manual-row-desc" placeholder="Narration or particulars" value="${escapeManualAttr(defaults.description || '')}" /></td>
          <td class="bank-recon-manual-entry__cell--num"><input type="number" class="expense-combobox manual-row-debit" min="0" step="0.01" placeholder="0.00" value="${escapeManualAttr(defaults.debit ?? '')}" /></td>
          <td class="bank-recon-manual-entry__cell--num"><input type="number" class="expense-combobox manual-row-credit" min="0" step="0.01" placeholder="0.00" value="${escapeManualAttr(defaults.credit ?? '')}" /></td>
          <td class="bank-recon-manual-entry__cell--num"><input type="number" class="expense-combobox manual-row-balance" step="0.01" placeholder="Optional" value="${escapeManualAttr(defaults.balance ?? '')}" /></td>
          <td class="bank-recon-manual-entry__cell--actions">
            <button type="button" class="btn btn-outline btn--small btn--icon manual-row-remove" title="Remove row" aria-label="Remove row"><i class="fa-solid fa-xmark"></i></button>
          </td>
        `;
        row.querySelector('.manual-row-remove')?.addEventListener('click', () => {
            const rows = manualRowsEl.querySelectorAll('tr[data-manual-row]');
            if (rows.length <= 1) {
                clearManualRowFields(row);
                return;
            }
            row.remove();
        });
        manualRowsEl.appendChild(row);
        return row;
    };

    const collectManualEntryRows = () => {
        const lines = [];
        const errors = [];
        const rows = [...(manualRowsEl?.querySelectorAll('tr[data-manual-row]') || [])];
        rows.forEach((row, index) => {
            const rowNum = index + 1;
            const date = row.querySelector('.manual-row-date')?.value || '';
            const description = row.querySelector('.manual-row-desc')?.value?.trim() || '';
            const debitRaw = row.querySelector('.manual-row-debit')?.value?.trim() ?? '';
            const creditRaw = row.querySelector('.manual-row-credit')?.value?.trim() ?? '';
            const balanceRaw = row.querySelector('.manual-row-balance')?.value?.trim() ?? '';
            const debit = debitRaw === '' ? 0 : parseFloat(debitRaw);
            const credit = creditRaw === '' ? 0 : parseFloat(creditRaw);
            const balance = balanceRaw === '' ? null : parseFloat(balanceRaw);

            const hasContent = date || description || debitRaw || creditRaw || balanceRaw;
            if (!hasContent) return;

            if (!date) errors.push(`Row ${rowNum}: enter the statement date.`);
            if (!description) errors.push(`Row ${rowNum}: enter the description.`);
            if (!Number.isFinite(debit) || !Number.isFinite(credit) || (balance != null && !Number.isFinite(balance))) {
                errors.push(`Row ${rowNum}: enter valid numeric amounts.`);
            }
            if (debit > 0 && credit > 0) errors.push(`Row ${rowNum}: enter either debit or credit, not both.`);
            if (debit <= 0 && credit <= 0) errors.push(`Row ${rowNum}: enter either a debit or a credit amount.`);

            if (!date || !description) return;
            if (!Number.isFinite(debit) || !Number.isFinite(credit)) return;
            if (debit > 0 && credit > 0) return;
            if (debit <= 0 && credit <= 0) return;

            lines.push({ line_date: date, description, debit, credit, balance });
        });
        return { lines, errors };
    };

    const resetManualForm = () => {
        if (manualRowsEl) manualRowsEl.innerHTML = '';
        addManualEntryRow();
    };

    const toggleManualForm = (open) => {
        if (!manualWrap) return;
        manualWrap.hidden = !open;
        if (open) {
            setActiveBankReconTab('import');
            if (!manualRowsEl?.querySelector('tr[data-manual-row]')) addManualEntryRow();
            manualRowsEl?.querySelector('.manual-row-date')?.focus();
        }
    };

    const processBankStatementFile = async (file) => {
        const lines = await parseBankStatementFile(file);
        const { unique, skipped } = dedupeBankImportLines(lines);
        const dupNote = skipped ? `\n\n${skipped} duplicate(s) will be skipped.` : '';
        if (!unique.length) {
            alert(`All ${lines.length} line(s) are duplicates (same date, description, and amount). Nothing to import.`);
            return;
        }
        if (!confirm(`Import ${unique.length} new line(s) from ${file.name}?${dupNote}`)) return;
        const result = await importBankStatement(file, lines);
        alert(importResultMessage(result));
        renderBankReconciliation();
    };

    const queuePassbookScan = async (fileList, btn) => {
        if (!isPassbookOcrConfigured()) {
            alert('Passbook OCR is not configured. Go to Administration → Integrations to add your Evolyx API key.');
            return;
        }
        const files = validatePassbookFiles(fileList);
        if (!confirm(`Queue OCR for ${files.length} passbook file(s)? You can keep working while the scan runs in the background.`)) return;

        setPassbookStatus('Passbook scan queued. Track progress below and import rows once the run completes.');
        setActiveBankReconTab('passbook');

        const result = await withButtonBusy(btn, 'Queueing…', () => parsePassbookFiles(files));
        await loadPassbookJobs();
        if (result?.warning) {
            setPassbookStatus(result.warning, true);
            alert(result.warning);
        } else if (result?.job?.id) {
            setPassbookStatus(`Passbook scan queued. Job ${result.job.id.slice(0, 8)} is running — see Recent scans below.`);
        }
    };

    const wireDropzone = (el, { onFiles, onActivate }) => {
        if (!el) return;
        el.addEventListener('click', (e) => {
            if (e.target.closest('button, a, input, label')) return;
            onActivate?.();
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onActivate?.();
            }
        });
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            el.classList.add('bank-recon-dropzone--active');
        });
        el.addEventListener('dragleave', (e) => {
            if (!el.contains(e.relatedTarget)) el.classList.remove('bank-recon-dropzone--active');
        });
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            el.classList.remove('bank-recon-dropzone--active');
            const files = [...(e.dataTransfer?.files || [])];
            if (files.length) onFiles(files);
        });
    };

    document.getElementById('fn-bank-recon-import-btn')?.addEventListener('click', () => {
        setActiveBankReconTab('import');
        document.getElementById('fn-bank-recon-file')?.click();
    });
    wireDropzone(document.getElementById('fn-bank-recon-import-dropzone'), {
        onActivate: () => document.getElementById('fn-bank-recon-file')?.click(),
        onFiles: async (files) => {
            const file = files[0];
            if (!file) return;
            try {
                await processBankStatementFile(file);
            } catch (err) {
                alert(err?.message || 'Import failed.');
            }
        },
    });
    document.getElementById('fn-bank-recon-add-row-btn')?.addEventListener('click', () => {
        toggleManualForm(manualWrap?.hidden ?? true);
    });
    document.getElementById('fn-bank-recon-manual-add-row')?.addEventListener('click', () => {
        const row = addManualEntryRow();
        row?.querySelector('.manual-row-date')?.focus();
    });
    document.getElementById('fn-bank-recon-manual-cancel')?.addEventListener('click', () => {
        resetManualForm();
        toggleManualForm(false);
    });
    document.getElementById('fn-bank-recon-manual-save')?.addEventListener('click', async () => {
        const { lines, errors } = collectManualEntryRows();
        if (errors.length) return alert(errors.join('\n'));
        if (!lines.length) return alert('Add at least one row with date, description, and an amount.');

        const btn = document.getElementById('fn-bank-recon-manual-save');
        const fileLabel = `manual-entry:${defaultManualDate()}`;
        try {
            const result = await saveThenRecalculate(btn, 'Saving rows…', () => importBankStatement(null, lines, {
                fileLabel,
                pull: false,
            }));
            alert(importResultMessage(result));
            resetManualForm();
            toggleManualForm(false);
            renderBankReconciliation();
        } catch (err) {
            alert(err?.message || 'Could not save rows.');
        }
    });
    document.getElementById('fn-bank-recon-passbook-btn')?.addEventListener('click', () => {
        setActiveBankReconTab('passbook');
        document.getElementById('fn-bank-recon-passbook-files')?.click();
    });
    wireDropzone(document.getElementById('fn-bank-recon-passbook-dropzone'), {
        onActivate: () => document.getElementById('fn-bank-recon-passbook-files')?.click(),
        onFiles: async (files) => {
            const btn = document.getElementById('fn-bank-recon-passbook-btn');
            setPassbookStatus('');
            try {
                await queuePassbookScan(files, btn);
            } catch (err) {
                const msg = err?.message || 'Passbook scan failed.';
                setPassbookStatus(msg, true);
                alert(msg);
            }
        },
    });
    document.getElementById('fn-bank-recon-passbook-jobs-btn')?.addEventListener('click', () => {
        openPassbookJobsModal().catch((err) => alert(err?.message || 'Could not open passbook jobs.'));
    });
    document.getElementById('passbook-jobs-close')?.addEventListener('click', closePassbookJobsModal);
    document.getElementById('passbook-jobs-refresh')?.addEventListener('click', () => {
        loadPassbookJobs().catch((err) => alert(err?.message || 'Could not refresh passbook jobs.'));
    });
    document.getElementById('fn-bank-recon-passbook-jobs-refresh-inline')?.addEventListener('click', () => {
        loadPassbookJobs().catch((err) => alert(err?.message || 'Could not refresh passbook jobs.'));
    });
    document.getElementById('passbook-job-detail-close')?.addEventListener('click', closePassbookJobDetail);
    passbookJobDetailModal?.addEventListener('click', (e) => {
        if (e.target?.id === 'passbook-job-detail-modal') closePassbookJobDetail();
    });
    passbookJobsModal?.addEventListener('click', (e) => {
        if (e.target?.id === 'passbook-jobs-modal') closePassbookJobsModal();
    });
    document.getElementById('bank-recon-move-cancel')?.addEventListener('click', () => closeRowMoveConfirmModal('cancel'));
    document.getElementById('bank-recon-move-just')?.addEventListener('click', () => closeRowMoveConfirmModal('just'));
    document.getElementById('bank-recon-move-recalc')?.addEventListener('click', () => closeRowMoveConfirmModal('recalc'));
    document.getElementById('bank-recon-move-confirm-modal')?.addEventListener('click', (e) => {
        if (e.target?.id === 'bank-recon-move-confirm-modal') closeRowMoveConfirmModal('cancel');
    });

    const classificationRulesModal = document.getElementById('bank-recon-rules-modal');
    document.getElementById('fn-bank-recon-rules-btn')?.addEventListener('click', () => openClassificationRulesModal());
    document.getElementById('bank-recon-rules-close')?.addEventListener('click', closeClassificationRulesModal);
    classificationRulesModal?.addEventListener('click', (e) => {
        if (e.target?.id === 'bank-recon-rules-modal') closeClassificationRulesModal();
    });
    document.getElementById('bank-recon-rule-type')?.addEventListener('change', syncRuleFormExpenseFields);
    document.getElementById('bank-recon-rule-category')?.addEventListener('input', refreshRuleFormCategoryList);
    document.getElementById('bank-recon-rule-category')?.addEventListener('change', refreshRuleFormCategoryList);
    document.getElementById('bank-recon-rules-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('bank-recon-rule-save');
        const lineType = document.getElementById('bank-recon-rule-type')?.value === 'OUT' ? 'OUT' : 'IN';
        const payload = {
            description_match: document.getElementById('bank-recon-rule-match')?.value?.trim(),
            line_type: lineType,
            category: document.getElementById('bank-recon-rule-category')?.value?.trim(),
            sub_category: lineType === 'OUT' ? document.getElementById('bank-recon-rule-sub')?.value?.trim() : null,
            vendor_name: lineType === 'OUT' ? document.getElementById('bank-recon-rule-vendor')?.value?.trim() : null,
            priority: parseInt(document.getElementById('bank-recon-rule-priority')?.value, 10) || 0,
            exclude_from_reports: document.getElementById('bank-recon-rule-exclude-reports')?.checked === true,
        };
        try {
            await withButtonBusy(btn, 'Saving…', () => saveBankClassificationRule(payload));
            renderClassificationRulesList();
            prefillClassificationRuleForm({ line_type: lineType });
            document.getElementById('bank-recon-rule-match')?.focus();
        } catch (err) {
            alert(err?.message || 'Could not save rule.');
        }
    });
    document.getElementById('bank-recon-rules-list')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.bank-recon-rule-delete');
        if (!btn || btn.dataset.busy === '1') return;
        const id = btn.dataset.ruleId;
        if (!id || !confirm('Delete this classification rule?')) return;
        try {
            await withButtonBusy(btn, '…', () => deleteBankClassificationRule(id));
            renderClassificationRulesList();
        } catch (err) {
            alert(err?.message || 'Could not delete rule.');
        }
    });
    document.getElementById('bank-recon-rules-run')?.addEventListener('click', async () => {
        const btn = document.getElementById('bank-recon-rules-run');
        const autoPost = document.getElementById('bank-recon-rules-auto-post')?.checked;
        const onlyEmpty = document.getElementById('bank-recon-rules-only-empty')?.checked !== false;
        await ensureClassificationRulesLoaded({ force: true });
        if (!getClassificationRules().length) {
            alert('No classification rules found. Save a rule first, or run docs/scripts/sql/supabase_bank_classification_rules.sql in Supabase.');
            return;
        }
        try {
            const result = await withButtonBusy(btn, 'Running…', () => runClassificationRulesOnUnmatched({ autoPost, onlyEmpty }));
            const { applied, posted, examined, noRule, skippedFilled, ruleCount } = result;
            const postNote = autoPost && posted ? ` ${posted} posted automatically.` : '';
            const bulkHint = applied && !posted
                ? ' Use Post all ready above the table to save them in bulk.'
                : '';
            if (applied) {
                alert(`Applied rules to ${applied} row(s).${postNote}${bulkHint}`);
                return;
            }
            const parts = [`Checked ${examined} unmatched row(s) against ${ruleCount} rule(s) (stored line descriptions from database).`];
            if (noRule) {
                parts.push(`${noRule} had no match.`);
                parts.push('Rules use case-insensitive contains (not exact). Try a shorter phrase like "NEFT:Nobroker", or regex like /nobroker/i.');
            }
            if (skippedFilled) parts.push(`${skippedFilled} skipped because category was already set.`);
            if (result.sampleLineDescription) {
                parts.push(`Example line: "${result.sampleLineDescription}"`);
            }
            if (result.sampleRuleMatch) {
                parts.push(`Example rule: "${result.sampleRuleMatch}"`);
            }
            alert(parts.join('\n\n'));
        } catch (err) {
            alert(err?.message || 'Could not run rules.');
        }
    });

    document.getElementById('fn-bank-recon-recalc-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('fn-bank-recon-recalc-btn');
        try {
            await runBankReconRecalculate(btn);
        } catch (err) {
            alert(err?.message || 'Could not recalculate balances.');
        }
    });
    document.getElementById('fn-bank-recon-template-btn')?.addEventListener('click', () => {
        downloadBankStatementTemplate().catch((err) => alert(err?.message || 'Download failed.'));
    });
    document.getElementById('fn-bank-recon-clear-all-btn')?.addEventListener('click', async () => {
        const count = (fnFinances().bankStatementLines || []).length;
        if (!count) return alert('No statement imports to clear.');
        if (!confirm(`Delete all ${count} imported statement line(s)? Ledger transactions you posted are not deleted. Opening balance is kept.`)) return;
        const btn = document.getElementById('fn-bank-recon-clear-all-btn');
        try {
            const { deleted } = await withButtonBusy(btn, 'Clearing…', () => clearAllBankStatementData());
            alert(deleted ? `Cleared ${deleted} statement line(s).` : 'Nothing to clear.');
            renderBankReconciliation();
        } catch (err) {
            alert(err?.message || 'Could not clear statement data.');
        }
    });
    document.getElementById('fn-bank-recon-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            await processBankStatementFile(file);
        } catch (err) {
            alert(err?.message || 'Import failed.');
        } finally {
            e.target.value = '';
        }
    });

    document.getElementById('fn-bank-recon-passbook-files')?.addEventListener('change', async (e) => {
        const input = e.target;
        const fileList = input.files;
        if (!fileList?.length) return;
        const btn = document.getElementById('fn-bank-recon-passbook-btn');
        setPassbookStatus('');
        try {
            await queuePassbookScan(fileList, btn);
        } catch (err) {
            const msg = err?.message || 'Passbook scan failed.';
            setPassbookStatus(msg, true);
            alert(msg);
        } finally {
            input.value = '';
        }
    });
    ensureExternalConnectionsLoaded().then(() => renderBankReconciliation()).catch(() => {});
    loadPassbookJobs().catch(() => {});
};

bindFinanceNewWindow('renderBankReconciliation', renderBankReconciliation);
