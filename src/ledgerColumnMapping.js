/**
 * Explicit DB ↔ Excel column mapping for public.transactions sync.
 * Mapping is stored in ledger_sync_settings.column_mapping as { v: 3, fields: { ... } }.
 * Each field may define importExpr (Excel→DB) and exportExpr (DB→Excel).
 */

import {
    getDefaultImportExpr,
    getDefaultExportExpr,
    runImportTransform,
    runExportTransform,
    BUILTIN_FUNCTIONS,
} from './ledgerTransform.js';
import {
    wireCodeEditors,
    renderSnippetRowHtml,
    CUSTOM_FN_SAMPLE,
    CUSTOM_FN_SAMPLE_EXPRESSION,
    CUSTOM_FN_IMPORT_SAMPLE,
    CUSTOM_FN_IMPORT_SAMPLE_EXPRESSION,
    FORMULA_REFERENCES,
} from './syncCodeEditor.js';

/** @typedef {'sync'|'db_only'|'internal'|'excel_import'|'excel_export'} FieldMode */

/**
 * Field catalog — single source of truth for mapping UI and sync engine.
 * dbColumn: null = virtual Excel helper (not a DB column).
 * role: default mode suggestion.
 */
export const TRANSACTION_FIELD_DEFS = [
    { key: 'date', dbColumn: 'date', label: 'Date', required: true, role: 'sync' },
    { key: 'type', dbColumn: 'type', label: 'Type (IN / OUT)', required: false, role: 'sync', hint: 'Use Import/Export formulas for IN/OUT ↔ DR/CR' },
    { key: 'amount', dbColumn: 'amount', label: 'Amount', required: false, role: 'sync', hint: 'Or map Debit/Cr columns with Dr/Cr formulas' },
    { key: 'debit_dr', dbColumn: null, label: 'Debit (Dr)', required: false, role: 'excel_import', hint: 'Default import: DR_COLUMN — sets OUT + amount' },
    { key: 'credit_cr', dbColumn: null, label: 'Credit (Cr)', required: false, role: 'excel_import', hint: 'Default import: CR_COLUMN — sets IN + amount' },
    { key: 'cat', dbColumn: 'cat', label: 'Category', required: false, role: 'sync' },
    { key: 'sub_category', dbColumn: 'sub_category', label: 'Sub-category', required: false, role: 'sync' },
    { key: 'description', dbColumn: 'description', label: 'Description', required: false, role: 'sync' },
    { key: 'wallet', dbColumn: 'wallet', label: 'Wallet / Ledger', required: false, role: 'sync' },
    { key: 'vendor_name', dbColumn: 'vendor_name', label: 'Vendor / Payee', required: false, role: 'sync' },
    { key: 'vendor_invoice', dbColumn: 'vendor_invoice', label: 'Reference / Invoice', required: false, role: 'sync' },
    { key: 'bank_payment_type', dbColumn: 'bank_payment_type', label: 'Bank payment type', required: false, role: 'sync', hint: 'cheque, upi, neft' },
    { key: 'bank_reference', dbColumn: 'bank_reference', label: 'Bank reference', required: false, role: 'sync', hint: 'Cheque no., UPI id, NEFT ref' },
    { key: 'external_sync_key', dbColumn: 'external_sync_key', label: 'Sync ID', required: false, role: 'sync', hint: 'Stable row identity across app and sheet' },
    { key: 'excel_sync_status', dbColumn: null, label: 'Sync status (sheet)', required: false, role: 'excel_export', hint: 'Push only — written on sync, not stored in DB' },
    { key: 'receipt_url', dbColumn: 'receipt_url', label: 'Receipt URL', required: false, role: 'db_only', hint: 'App attachments — not synced via sheet' },
    { key: 'receipt_urls', dbColumn: 'receipt_urls', label: 'Receipt files', required: false, role: 'db_only', hint: 'JSON in DB — not synced via sheet' },
    { key: 'bank_proof_urls', dbColumn: 'bank_proof_urls', label: 'Bank proof files', required: false, role: 'db_only', hint: 'JSON in DB — not synced via sheet' },
    { key: 'sync_hash', dbColumn: 'sync_hash', label: 'Content hash', required: false, role: 'internal', hint: 'System — change detection' },
    { key: 'id', dbColumn: 'id', label: 'Record ID', required: false, role: 'internal', hint: 'System — primary key' },
    { key: 'apartment_id', dbColumn: 'apartment_id', label: 'Society ID', required: false, role: 'internal', hint: 'System — tenant scope' },
    { key: 'created_at', dbColumn: 'created_at', label: 'Created at', required: false, role: 'internal' },
    { key: 'updated_at', dbColumn: 'updated_at', label: 'Updated at', required: false, role: 'internal' },
];

const FIELD_BY_KEY = Object.fromEntries(TRANSACTION_FIELD_DEFS.map((f) => [f.key, f]));

const V1_KEY_MAP = {
    date: 'date',
    type: 'type',
    amount: 'amount',
    dr: 'debit_dr',
    cr: 'credit_cr',
    category: 'cat',
    description: 'description',
    wallet: 'wallet',
    vendor: 'vendor_name',
    reference: 'vendor_invoice',
    sync_id: 'external_sync_key',
    sync_status: 'excel_sync_status',
};

const HEADER_ALIASES = {
    date: ['date'],
    type: ['type', 'in/out', 'direction'],
    amount: ['amount', 'value'],
    debit_dr: ['debit', 'dr', 'withdraw'],
    credit_cr: ['credit', 'cr', 'deposit'],
    cat: ['category', 'cat'],
    sub_category: ['sub-category', 'subcategory', 'sub category', 'sub_cat'],
    description: ['description', 'narration', 'particular', 'notes'],
    wallet: ['wallet', 'ledger'],
    vendor_name: ['vendor', 'payee'],
    vendor_invoice: ['reference', 'invoice', 'ref', 'bill'],
    bank_payment_type: ['bank type', 'payment type', 'bank_payment'],
    bank_reference: ['bank ref', 'bank reference', 'cheque', 'upi', 'neft'],
    external_sync_key: ['syncid', 'sync_id', 'internal_id', 'sync key'],
    excel_sync_status: ['status', 'sync_status', 'sync_state'],
};

export { getDefaultImportExpr, getDefaultExportExpr } from './ledgerTransform.js';

function defaultFieldConfig(def) {
    return {
        mode: def.role,
        excelCol: null,
        importExpr: getDefaultImportExpr(def.key),
        exportExpr: getDefaultExportExpr(def.key),
    };
}

export function defaultFieldModes() {
    const fields = {};
    for (const def of TRANSACTION_FIELD_DEFS) {
        fields[def.key] = defaultFieldConfig(def);
    }
    return fields;
}

function enrichField(key, val = {}) {
    const def = FIELD_BY_KEY[key];
    if (!def) return val;
    return {
        mode: val.mode || def.role,
        excelCol: typeof val.excelCol === 'number' ? val.excelCol : null,
        importExpr: val.importExpr ?? getDefaultImportExpr(key),
        exportExpr: val.exportExpr ?? getDefaultExportExpr(key),
    };
}

/** Build placeholder header labels from mapped column indices when live headers are unavailable. */
export function buildHeadersFromMapping(mapping) {
    const m = normalizeMapping(mapping);
    let maxCol = -1;
    for (const cfg of Object.values(m.fields)) {
        if (typeof cfg.excelCol === 'number' && cfg.excelCol >= 0) {
            maxCol = Math.max(maxCol, cfg.excelCol);
        }
    }
    if (maxCol < 0) return [];
    return Array.from({ length: maxCol + 1 }, (_, i) => `Column ${i + 1}`);
}

/** @returns {{ v: 3, fields: Record<string, object>, formulaSnippets: Record<string, string>, excelHeaders: string[] }} */
export function normalizeMapping(stored) {
    const fields = defaultFieldModes();
    const formulaSnippets = (stored?.formulaSnippets && typeof stored.formulaSnippets === 'object')
        ? { ...stored.formulaSnippets }
        : {};
    const excelHeaders = Array.isArray(stored?.excelHeaders)
        ? stored.excelHeaders.map((h) => String(h ?? ''))
        : [];

    if (stored?.v >= 2 && stored.fields) {
        for (const [key, val] of Object.entries(stored.fields)) {
            if (!FIELD_BY_KEY[key]) continue;
            fields[key] = enrichField(key, val);
        }
        return { v: 3, fields, formulaSnippets, excelHeaders };
    }

    // Legacy v1: { date: 0, type: 1, category: 3, ... }
    if (stored && typeof stored === 'object' && !stored.v) {
        for (const [oldKey, colIdx] of Object.entries(stored)) {
            const newKey = V1_KEY_MAP[oldKey];
            if (!newKey || typeof colIdx !== 'number' || colIdx < 0) continue;
            const def = FIELD_BY_KEY[newKey];
            fields[newKey] = enrichField(newKey, {
                mode: def.role === 'excel_import' || def.role === 'excel_export' ? def.role : 'sync',
                excelCol: colIdx,
            });
        }
    }
    return { v: 3, fields, formulaSnippets, excelHeaders };
}

function headerMatches(header, alias) {
    const h = String(header || '').trim().toLowerCase();
    const a = String(alias || '').trim().toLowerCase();
    if (!h || !a) return false;
    if (h === a) return true;
    // Multi-word aliases (e.g. "bank ref") may match inside longer headers.
    if (a.includes(' ') && h.includes(a)) return true;
    // Short tokens (dr, cr, cat) must match the whole header — avoids "description" → cr.
    if (a.length <= 3) return false;
    return h.includes(a);
}

function findHeaderIndex(headers, aliases) {
    return headers.findIndex((h) => aliases.some((a) => headerMatches(h, a)));
}

/** Auto-detect mapping from spreadsheet header row. */
export function buildMappingFromHeaders(headersRaw) {
    const headers = (headersRaw || []).map((h) => String(h || '').trim().toLowerCase());
    const mapping = normalizeMapping(null);

    for (const def of TRANSACTION_FIELD_DEFS) {
        if (!['sync', 'excel_import', 'excel_export'].includes(def.role)) continue;
        const aliases = HEADER_ALIASES[def.key];
        if (!aliases) continue;
        const idx = findHeaderIndex(headers, aliases);
        if (idx >= 0) {
            mapping.fields[def.key] = enrichField(def.key, {
                mode: def.role === 'excel_import' ? 'excel_import' : def.role === 'excel_export' ? 'excel_export' : 'sync',
                excelCol: idx,
            });
        }
    }
    return mapping;
}

export function getFieldConfig(mapping, fieldKey) {
    const m = normalizeMapping(mapping);
    return m.fields[fieldKey] || enrichField(fieldKey, {});
}

export function colForField(mapping, fieldKey) {
    const cfg = getFieldConfig(mapping, fieldKey);
    if (cfg.mode === 'sync' || cfg.mode === 'excel_import' || cfg.mode === 'excel_export') {
        return typeof cfg.excelCol === 'number' && cfg.excelCol >= 0 ? cfg.excelCol : -1;
    }
    return -1;
}

export function validateMapping(mapping, headersRaw = []) {
    const m = normalizeMapping(mapping);
    const errors = [];
    const warnings = [];

    const dateCol = colForField(m, 'date');
    if (dateCol < 0) errors.push('Map Date to an Excel column (sync mode), or mark as DB-only only if you never import from the sheet.');

    const typeCol = colForField(m, 'type');
    const amtCol = colForField(m, 'amount');
    const drCol = colForField(m, 'debit_dr');
    const crCol = colForField(m, 'credit_cr');
    const hasTypeAmount = typeCol >= 0 && amtCol >= 0;
    const hasDrCr = drCol >= 0 || crCol >= 0;
    const hasAmountOnly = amtCol >= 0;

    if (!hasTypeAmount && !hasDrCr && !hasAmountOnly) {
        errors.push('Map Amount (with Type) or Debit/Cr columns for import.');
    }
    if (hasDrCr && hasTypeAmount) {
        warnings.push('Both Type+Amount and Debit/Cr are mapped. Debit/Cr apply only when Type is empty on a row.');
    }

    // Duplicate excel column assignments
    const colUsers = {};
    for (const [key, cfg] of Object.entries(m.fields)) {
        if (!['sync', 'excel_import', 'excel_export'].includes(cfg.mode)) continue;
        if (cfg.excelCol == null || cfg.excelCol < 0) continue;
        if (!colUsers[cfg.excelCol]) colUsers[cfg.excelCol] = [];
        colUsers[cfg.excelCol].push(FIELD_BY_KEY[key]?.label || key);
    }
    for (const [col, labels] of Object.entries(colUsers)) {
        if (labels.length > 1) {
            errors.push(`Excel column ${Number(col) + 1} is mapped to multiple fields: ${labels.join(', ')}`);
        }
    }

    // Unmapped excel columns
    const usedCols = new Set(Object.keys(colUsers).map(Number));
    const extras = (headersRaw || [])
        .map((h, i) => ({ h: String(h || '').trim(), i }))
        .filter(({ h, i }) => h && !usedCols.has(i))
        .map(({ h }) => h);
    if (extras.length) {
        warnings.push(`Excel columns not mapped (will be ignored on import): ${extras.join(', ')}`);
    }

    return { mapping: m, errors, warnings };
}

function cellStr(val) {
    if (val == null) return '';
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    return String(val).trim();
}

function parseAmount(val) {
    const n = parseFloat(String(val ?? '').replace(/[,₹\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function normType(val) {
    const s = String(val || '').toUpperCase();
    if (s.includes('IN') || s.includes('CR') || s.includes('CREDIT') || s.includes('INCOME')) return 'IN';
    if (s.includes('OUT') || s.includes('DR') || s.includes('DEBIT') || s.includes('EXPENSE')) return 'OUT';
    return null;
}

function normWallet(val) {
    const s = String(val || '').toUpperCase();
    return s.includes('BANK') ? 'BANK' : 'CASH';
}

function normCat(val, type) {
    const s = String(val || '').trim();
    return s || (type === 'IN' ? 'Other Income' : 'Other');
}

export function safeHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i += 1) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return `h${Math.abs(h).toString(36)}`;
}

export function computeSyncHash(record, mapping) {
    const m = normalizeMapping(mapping);
    const parts = TRANSACTION_FIELD_DEFS
        .filter((def) => def.dbColumn && m.fields[def.key]?.mode === 'sync')
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((def) => String(record[def.dbColumn] ?? ''));
    return safeHash(parts.join('|'));
}

/** DB insert/update payload — only fields explicitly marked sync in mapping. */
export function buildDbSyncPayload(row, mapping, { includeHash = true } = {}) {
    const m = normalizeMapping(mapping);
    const payload = {};
    for (const def of TRANSACTION_FIELD_DEFS) {
        if (!def.dbColumn) continue;
        if (m.fields[def.key]?.mode !== 'sync') continue;
        if (row[def.dbColumn] !== undefined) payload[def.dbColumn] = row[def.dbColumn];
    }
    if (includeHash && row.sync_hash) payload.sync_hash = row.sync_hash;
    return payload;
}

/** Import insert payload — mapped sync fields plus required row fields from parse. */
export function buildImportTxnPayload(row, mapping) {
    const payload = buildDbSyncPayload(row, mapping);
    for (const key of ['date', 'type', 'amount', 'cat', 'wallet', 'description']) {
        if (row[key] !== undefined && row[key] !== null && payload[key] === undefined) {
            payload[key] = row[key];
        }
    }
    return payload;
}

export function parseLedgerSheet(aoa, sourceKey, customMapping = null) {
    if (!aoa?.length) return { parsed: [], excelDataRows: 0, skipped: 0 };
    const headersRaw = (aoa[0] || []).map((h) => String(h || '').trim());
    const mapping = customMapping
        ? normalizeMapping(customMapping)
        : buildMappingFromHeaders(headersRaw);

    const parsed = [];
    for (let i = 1; i < aoa.length; i += 1) {
        const row = aoa[i] || [];
        const item = parseRowFromSheet(row, i + 1, mapping, sourceKey);
        if (item) parsed.push(item);
    }
    const excelDataRows = Math.max(0, aoa.length - 1);
    return { parsed, excelDataRows, skipped: excelDataRows - parsed.length, mapping };
}

function fieldImportsFromExcel(cfg) {
    if (cfg.excelCol == null || cfg.excelCol < 0) return false;
    return cfg.mode === 'sync' || cfg.mode === 'excel_import';
}

function fieldExportsToExcel(cfg) {
    if (cfg.excelCol == null || cfg.excelCol < 0) return false;
    if (cfg.mode === 'sync' || cfg.mode === 'excel_export') return true;
    if (cfg.mode === 'excel_import' && cfg.exportExpr) return true;
    return false;
}

function readMappedCell(row, mapping, fieldKey) {
    const col = colForField(mapping, fieldKey);
    if (col < 0) return { col: -1, raw: undefined };
    return { col, raw: row[col] };
}

/**
 * Parse one spreadsheet row using mapping formulas (importExpr per field).
 */
export function parseRowFromSheet(row, rowIndex, mapping, sourceKey) {
    const m = normalizeMapping(mapping);
    const record = {};

    for (const def of TRANSACTION_FIELD_DEFS) {
        const cfg = m.fields[def.key];
        if (!cfg) continue;
        if (!fieldImportsFromExcel(cfg)) continue;
        const { raw } = readMappedCell(row, m, def.key);
        if (raw === undefined && cfg.excelCol == null) continue;

        const { value, patch } = runImportTransform(cfg.importExpr, {
            value: raw,
            row,
            record,
            fieldKey: def.key,
            mapping: m,
        });
        if (patch) Object.assign(record, patch);
        if (def.dbColumn && value !== undefined && value !== null && value !== '') {
            record[def.dbColumn] = value;
        }
    }

    let type = record.type || null;
    let amount = record.amount != null ? parseAmount(record.amount) : 0;
    if (!type && amount > 0) type = 'OUT';

    const date = record.date;
    if (!date) return null;
    if (!type || amount <= 0) return null;

    record.type = type;
    record.amount = amount;
    record.cat = normCat(record.cat, type);
    record.wallet = record.wallet || 'CASH';
    record.description = record.description || '';

    const syncIdCol = colForField(m, 'external_sync_key');
    const syncId = syncIdCol >= 0 ? cellStr(row[syncIdCol]) : '';
    record.external_sync_key = syncId || `${sourceKey}:row:${rowIndex}`;

    record.sync_hash = computeSyncHash(record, m);

    return {
        row_index: rowIndex,
        ...record,
    };
}

export function parseLedgerRowsFromAoA(aoa, sourceKey, customMapping = null) {
    return parseLedgerSheet(aoa, sourceKey, customMapping).parsed;
}

/** Build a sparse Excel row from a DB transaction using mapping exportExpr formulas. */
export function transactionToExcelRow(txn, mapping) {
    const m = normalizeMapping(mapping);
    const mappedCols = [];
    for (const def of TRANSACTION_FIELD_DEFS) {
        const cfg = m.fields[def.key];
        if (!cfg) continue;
        if (!fieldExportsToExcel(cfg)) continue;
        mappedCols.push(cfg.excelCol);
    }
    const maxCol = mappedCols.length ? Math.max(...mappedCols) : 9;
    const rowData = new Array(maxCol + 1).fill('');

    for (const def of TRANSACTION_FIELD_DEFS) {
        const cfg = m.fields[def.key];
        if (!cfg) continue;
        if (!fieldExportsToExcel(cfg)) continue;

        const rawVal = def.dbColumn ? txn[def.dbColumn] : null;
        const cellVal = runExportTransform(cfg.exportExpr, {
            value: rawVal,
            txn,
            fieldKey: def.key,
            mapping: m,
        });
        rowData[cfg.excelCol] = cellVal ?? '';
    }

    if (colForField(m, 'external_sync_key') < 0) {
        // no-op — only mapped fields are written
    } else if (!txn.external_sync_key && txn.id) {
        const col = colForField(m, 'external_sync_key');
        if (col >= 0 && !rowData[col]) rowData[col] = `app:txn:${txn.id}`;
    }

    return { rowData, maxCol };
}

export function maxMappedColumn(mapping) {
    const m = normalizeMapping(mapping);
    let max = -1;
    for (const cfg of Object.values(m.fields)) {
        if ((fieldImportsFromExcel(cfg) || fieldExportsToExcel(cfg)) && cfg.excelCol >= 0) {
            max = Math.max(max, cfg.excelCol);
        }
    }
    return max < 0 ? 9 : max;
}

/** Build Excel value matrix for push — uniform row width for Graph API. */
export function rowsToExcelValues(rowsToPush, mapping) {
    const excelRows = rowsToPush.map((r) => transactionToExcelRow(r, mapping));
    const maxCol = excelRows.reduce((hi, r) => Math.max(hi, r.maxCol), maxMappedColumn(mapping));
    const width = Math.max(maxCol, 0) + 1;
    const values = excelRows.map((r) => {
        const out = r.rowData.slice(0, width);
        while (out.length < width) out.push('');
        return out;
    });
    return { values, maxCol: Math.max(maxCol, 0) };
}

export function collectMappingFromForm(rootEl) {
    const fields = defaultFieldModes();
    rootEl.querySelectorAll('[data-map-field]').forEach((row) => {
        const key = row.dataset.mapField;
        if (!FIELD_BY_KEY[key]) return;
        const mode = row.querySelector('[data-map-mode]')?.value || FIELD_BY_KEY[key].role;
        const colRaw = row.querySelector('[data-map-col]')?.value;
        const excelCol = colRaw === '' || colRaw == null ? null : parseInt(colRaw, 10);
        const importExpr = row.querySelector('[data-map-import-expr]')?.value?.trim()
            || getDefaultImportExpr(key);
        const exportExpr = row.querySelector('[data-map-export-expr]')?.value?.trim()
            || getDefaultExportExpr(key);
        fields[key] = {
            mode,
            excelCol: Number.isNaN(excelCol) ? null : excelCol,
            importExpr,
            exportExpr,
        };
    });

    const formulaSnippets = {};
    rootEl.querySelectorAll('[data-snippet-row]').forEach((row) => {
        const name = row.querySelector('[data-snippet-name]')?.value?.trim();
        const body = row.querySelector('[data-snippet-body]')?.value?.trim();
        if (name && body) formulaSnippets[name] = body;
    });

    const excelHeaders = rootEl.dataset.excelHeaders
        ? JSON.parse(rootEl.dataset.excelHeaders)
        : [];
    return { v: 3, fields, formulaSnippets, excelHeaders };
}

const MODE_OPTIONS = [
    { value: 'sync', label: '↔ Sync both ways', help: 'Maps to an Excel column. Import and export formulas both run.' },
    { value: 'excel_import', label: '→ Import only', help: 'Excel → app only. Export formula is ignored.' },
    { value: 'excel_export', label: '← Export only', help: 'App → Excel only. Import formula is ignored.' },
    { value: 'db_only', label: 'App only', help: 'Stored in the database only — no Excel column.' },
    { value: 'internal', label: 'System', help: 'Managed by the app (ids, hashes). Not synced.' },
];

function modeHelpText(mode) {
    return MODE_OPTIONS.find((o) => o.value === mode)?.help || '';
}

function renderFormulaFieldRefList() {
    const refs = TRANSACTION_FIELD_DEFS
        .filter((d) => d.dbColumn && d.role !== 'internal')
        .map((d) => `<li><code>{field:${d.key}}</code> — ${d.label}${d.dbColumn !== d.key ? ` (<code>${d.dbColumn}</code>)` : ''}</li>`)
        .join('');
    return `<ul class="sync-fn-ref-fields">${refs}</ul>`;
}

function renderFormulaRefTable() {
    const rows = FORMULA_REFERENCES.map((r) => `
      <tr>
        <td><code>${r.token}</code></td>
        <td>${r.importDesc}</td>
        <td>${r.exportDesc}</td>
      </tr>`).join('');
    return `
      <table class="sync-fn-ref-table">
        <thead>
          <tr><th>Reference</th><th>Excel → DB (import)</th><th>DB → Excel (export)</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
}

function renderSnippetLibrary(snippets) {
    const rows = Object.entries(snippets || {}).map(([name, body]) => renderSnippetRowHtml(name, body)).join('');

    return `
      <details class="sync-formula-library" open>
        <summary class="sync-formula-library__summary">
          <span>Custom functions <span class="sync-formula-library__sub">(use as <code>@name</code> in formulas)</span></span>
          <a href="#sync-fn-help" class="sync-fn-help-link">How to create a function</a>
        </summary>
        <div class="sync-fn-help" id="sync-fn-help">
          <p class="sync-formula-library__hint">
            Custom functions are <strong>reusable expressions</strong>, not full JavaScript. Give a name, paste the
            <code>return</code> expression in the editor, then call it as <code>@name</code> from any field formula.
            References always refer to the <strong>same Excel row</strong> (import) or <strong>same DB transaction</strong> (export).
          </p>
          ${renderFormulaRefTable()}
          <details class="sync-fn-ref-fields-wrap">
            <summary>Available <code>{field:…}</code> names</summary>
            <p class="sync-formula-library__hint">Use the field key from the mapping cards below. On import, only fields parsed earlier in the row are available.</p>
            ${renderFormulaFieldRefList()}
          </details>
          <div class="sync-code-sample">
            <span class="sync-code-sample__label">Export example — combine DB fields</span>
            <pre class="sync-code-sample__pre"><code>${escapeText(CUSTOM_FN_SAMPLE)}</code></pre>
          </div>
          <p class="sync-formula-library__hint sync-fn-help__store">
            Store only the expression for <code>bank_line</code>:
            <code class="sync-fn-help__expr">${escapeText(CUSTOM_FN_SAMPLE_EXPRESSION)}</code>
          </p>
          <div class="sync-code-sample">
            <span class="sync-code-sample__label">Import example — read another Excel column on the same row</span>
            <pre class="sync-code-sample__pre"><code>${escapeText(CUSTOM_FN_IMPORT_SAMPLE)}</code></pre>
          </div>
          <p class="sync-formula-library__hint sync-fn-help__store">
            Store only:
            <code class="sync-fn-help__expr">${escapeText(CUSTOM_FN_IMPORT_SAMPLE_EXPRESSION)}</code>
            — <code>{col:10}</code> is column 11 in Excel (0-based). Match the index from <em>Excel columns</em> below.
          </p>
        </div>
        <div class="sync-snippet-list" data-snippet-list>${rows}</div>
        <button type="button" class="btn btn-outline btn--small" data-snippet-add><i class="fa-solid fa-plus"></i> Add function</button>
      </details>
      <details class="sync-formula-library">
        <summary>Built-in functions</summary>
        <ul class="sync-fn-list">${BUILTIN_FUNCTIONS.map((f) => `<li><code>${f.name}</code> ${f.desc}</li>`).join('')}</ul>
      </details>`;
}

function renderFieldCard(def, cfg, headersRaw, colOptions) {
    const modes = modesForField(def);
    const colDisabled = !['sync', 'excel_import', 'excel_export'].includes(cfg.mode);
    const syncable = !colDisabled && def.role !== 'internal';
    const importExpr = cfg.importExpr ?? getDefaultImportExpr(def.key);
    const exportExpr = cfg.exportExpr ?? getDefaultExportExpr(def.key);
    const dbName = def.dbColumn || def.key;
    const excelHeader = (cfg.excelCol != null && cfg.excelCol >= 0 && headersRaw[cfg.excelCol])
        ? headersRaw[cfg.excelCol]
        : (cfg.excelCol != null && cfg.excelCol >= 0 ? `Column ${cfg.excelCol + 1}` : '—');

    return `
      <article class="sync-map-card" data-map-field="${def.key}">
        <header class="sync-map-card__head">
          <div class="sync-map-card__identity">
            <strong class="sync-map-card__title">${def.label}</strong>
            <input type="text" class="sync-map-card__db" data-map-db-label value="${escapeAttr(dbName)}" readonly title="DB column" />
          </div>
          <div class="sync-map-card__excel">
            <label>Excel</label>
            <select class="sync-map-card__excel-select" data-map-col ${colDisabled ? 'disabled' : ''}>
              ${colOptions(colDisabled ? null : cfg.excelCol)}
            </select>
          </div>
          <select class="sync-map-card__mode" data-map-mode ${def.role === 'internal' ? 'disabled' : ''} title="Participation">
            ${modes.map((o) => `<option value="${o.value}" ${cfg.mode === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </header>
        ${syncable ? `
        <div class="sync-map-card__flows" data-map-formulas>
          <div class="sync-flow sync-flow--ltr" data-map-export-row>
            <span class="sync-flow__dir">DB → Excel</span>
            <code class="sync-flow__db">${dbName}</code>
            <span class="sync-flow__arrow" aria-hidden="true">→</span>
            <span class="sync-flow__excel" data-map-excel-display>${escapeAttr(excelHeader)}</span>
            <span class="sync-flow__fn">ƒ</span>
            <input type="text" class="sync-flow__formula" data-map-export-expr value="${escapeAttr(exportExpr)}" spellcheck="false" placeholder="{value}" />
          </div>
          <div class="sync-flow sync-flow--rtl" data-map-import-row>
            <span class="sync-flow__dir">Excel → DB</span>
            <input type="text" class="sync-flow__formula" data-map-import-expr value="${escapeAttr(importExpr)}" spellcheck="false" placeholder="NORM_TYPE({value})" />
            <span class="sync-flow__fn">ƒ</span>
            <span class="sync-flow__excel" data-map-excel-display>${escapeAttr(excelHeader)}</span>
            <span class="sync-flow__arrow" aria-hidden="true">←</span>
            <code class="sync-flow__db">${dbName}</code>
          </div>
        </div>` : `
        <p class="sync-map-card__muted">${modeHelpText(cfg.mode)}</p>`}
      </article>`;
}

function modesForField(def) {
    if (def.role === 'internal') return MODE_OPTIONS.filter((o) => o.value === 'internal');
    if (def.role === 'db_only') return MODE_OPTIONS.filter((o) => ['db_only', 'sync'].includes(o.value));
    if (def.role === 'excel_import') return MODE_OPTIONS.filter((o) => ['excel_import', 'db_only'].includes(o.value));
    if (def.role === 'excel_export') return MODE_OPTIONS.filter((o) => ['excel_export', 'db_only'].includes(o.value));
    return MODE_OPTIONS.filter((o) => o.value !== 'excel_import' && o.value !== 'excel_export');
}

export function renderLedgerMappingUI(mapping, headersRaw = []) {
    const { mapping: m, errors } = validateMapping(mapping, headersRaw);
    const colOptions = (selected) => `
      <option value="">—</option>
      ${headersRaw.map((h, i) => `<option value="${i}" ${selected === i ? 'selected' : ''}>${h || `Col ${i + 1}`}</option>`).join('')}
    `;

    const primaryFields = TRANSACTION_FIELD_DEFS.filter((d) => d.role !== 'internal' && d.role !== 'db_only');
    const otherFields = TRANSACTION_FIELD_DEFS.filter((d) => d.role === 'internal' || d.role === 'db_only');

    const primaryCards = primaryFields.map((def) => {
        const cfg = m.fields[def.key] || enrichField(def.key, {});
        return renderFieldCard(def, cfg, headersRaw, colOptions);
    }).join('');

    const otherCards = otherFields.map((def) => {
        const cfg = m.fields[def.key] || enrichField(def.key, {});
        return renderFieldCard(def, cfg, headersRaw, colOptions);
    }).join('');

    const assignment = new Map();
    for (const def of TRANSACTION_FIELD_DEFS) {
        const cfg = m.fields[def.key];
        if (!cfg || !['sync', 'excel_import', 'excel_export'].includes(cfg.mode)) continue;
        if (cfg.excelCol == null || cfg.excelCol < 0) continue;
        assignment.set(cfg.excelCol, def.label);
    }

    const excelOverview = headersRaw.length
        ? headersRaw.map((h, i) => {
            const mapped = assignment.get(i);
            return `
              <div class="sync-excel-col${mapped ? ' sync-excel-col--mapped' : ''}">
                <span class="sync-excel-col__letter">${i + 1}</span>
                <strong class="sync-excel-col__header">${h || '(empty)'}</strong>
                ${mapped ? `<span class="sync-excel-col__mapped">${mapped}</span>` : ''}
              </div>`;
        }).join('')
        : '';

    const errHtml = errors.length
        ? `<div class="ledger-sync-status ledger-sync-status--error"><strong>Mapping errors</strong><br/>${errors.map((e) => `• ${e}`).join('<br/>')}</div>`
        : '';

    return `
      ${errHtml}
      ${renderSnippetLibrary(m.formulaSnippets)}
      <div class="sync-map-grid">${primaryCards}</div>
      ${otherFields.length ? `<details class="sync-map-advanced"><summary>System &amp; app-only fields (${otherFields.length})</summary><div class="sync-map-grid">${otherCards}</div></details>` : ''}
      ${excelOverview ? `<details class="sync-excel-overview"><summary>Excel columns (${headersRaw.length})</summary><div class="sync-excel-overview__grid">${excelOverview}</div></details>` : ''}`;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(s) {
    return escapeAttr(s);
}

export function wireMappingFormInteractions(rootEl) {
    const updateExcelLabels = (block) => {
        const colSel = block.querySelector('[data-map-col]');
        const labels = block.querySelectorAll('[data-map-excel-display]');
        if (!colSel || !labels.length) return;
        const opt = colSel.options[colSel.selectedIndex];
        const text = opt?.value === '' ? '—' : (opt?.text || '—');
        labels.forEach((el) => { el.textContent = text; });
    };

    const syncFieldBlock = (block) => {
        const modeSel = block.querySelector('[data-map-mode]');
        const colSel = block.querySelector('[data-map-col]');
        const formulas = block.querySelector('[data-map-formulas]');
        const importRow = block.querySelector('[data-map-import-row]');
        const exportRow = block.querySelector('[data-map-export-row]');
        const mode = modeSel?.value;
        const syncable = modeSel && ['sync', 'excel_import', 'excel_export'].includes(mode);

        if (colSel) {
            colSel.disabled = !syncable;
            if (!syncable) colSel.value = '';
        }
        if (formulas) formulas.hidden = !syncable;
        if (importRow) importRow.hidden = mode === 'excel_export';
        if (exportRow) exportRow.hidden = mode === 'excel_import';
        updateExcelLabels(block);
    };

    rootEl.querySelectorAll('[data-map-field]').forEach((block) => {
        syncFieldBlock(block);
        block.querySelector('[data-map-mode]')?.addEventListener('change', () => syncFieldBlock(block));
        block.querySelector('[data-map-col]')?.addEventListener('change', () => syncFieldBlock(block));
    });

    rootEl.querySelector('[data-snippet-add]')?.addEventListener('click', () => {
        const list = rootEl.querySelector('[data-snippet-list]');
        if (!list) return;
        const wrap = document.createElement('div');
        wrap.innerHTML = renderSnippetRowHtml();
        const row = wrap.firstElementChild;
        list.appendChild(row);
        wireCodeEditors(row);
        row.querySelector('[data-snippet-del]')?.addEventListener('click', () => row.remove());
    });

    rootEl.querySelectorAll('[data-snippet-del]').forEach((btn) => {
        btn.addEventListener('click', () => btn.closest('[data-snippet-row]')?.remove());
    });

    wireCodeEditors(rootEl);

    rootEl.querySelector('.sync-fn-help-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        const help = rootEl.querySelector('#sync-fn-help');
        help?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        help?.classList.add('sync-fn-help--flash');
        window.setTimeout(() => help?.classList.remove('sync-fn-help--flash'), 1200);
    });
}

export const TEMPLATE_HEADERS = [
    'Date', 'Type', 'Amount', 'Dr', 'Cr', 'Category', 'Sub-category', 'Description',
    'Wallet', 'Vendor', 'Reference', 'Bank type', 'Bank ref', 'Sync ID', 'Sync status',
];
