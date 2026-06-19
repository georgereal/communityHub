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
    FORMULA_PRESETS,
    detectPreset,
    presetById,
} from './ledgerTransform.js';

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

export { FORMULA_PRESETS, getDefaultImportExpr, getDefaultExportExpr } from './ledgerTransform.js';

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

/** @returns {{ v: 3, fields: Record<string, object> }} */
export function normalizeMapping(stored) {
    const fields = defaultFieldModes();

    if (stored?.v >= 2 && stored.fields) {
        for (const [key, val] of Object.entries(stored.fields)) {
            if (!FIELD_BY_KEY[key]) continue;
            fields[key] = enrichField(key, val);
        }
        return { v: 3, fields };
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
    return { v: 3, fields };
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
    if (!aoa?.length) return [];
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
    return parsed;
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
    return { v: 3, fields };
}

function formulaPresetOptions(direction, currentExpr, fieldKey) {
    const key = direction === 'import' ? 'importExpr' : 'exportExpr';
    const defaultExpr = direction === 'import' ? getDefaultImportExpr(fieldKey) : getDefaultExportExpr(fieldKey);
    const selected = detectPreset(currentExpr || defaultExpr, direction, fieldKey);
    const opts = FORMULA_PRESETS.filter((p) => p.id === 'default' || p[key] != null || p.id === 'custom');
    return opts.map((p) => {
        const label = p.id === 'default' ? `Default (${defaultExpr || '—'})` : p.label;
        return `<option value="${p.id}" ${selected === p.id ? 'selected' : ''}>${label}</option>`;
    }).join('') + `<option value="custom" ${selected === 'custom' ? 'selected' : ''}>Custom formula…</option>`;
}

const MODE_OPTIONS = [
    { value: 'sync', label: 'Sync with Excel' },
    { value: 'db_only', label: 'DB only (ignore sheet)' },
    { value: 'internal', label: 'Internal (system)' },
    { value: 'excel_import', label: 'Import only (Excel → app)' },
    { value: 'excel_export', label: 'Export only (app → Excel)' },
];

function modesForField(def) {
    if (def.role === 'internal') return MODE_OPTIONS.filter((o) => o.value === 'internal');
    if (def.role === 'db_only') return MODE_OPTIONS.filter((o) => ['db_only', 'sync'].includes(o.value));
    if (def.role === 'excel_import') return MODE_OPTIONS.filter((o) => ['excel_import', 'db_only'].includes(o.value));
    if (def.role === 'excel_export') return MODE_OPTIONS.filter((o) => ['excel_export', 'db_only'].includes(o.value));
    return MODE_OPTIONS.filter((o) => o.value !== 'excel_import' && o.value !== 'excel_export');
}

export function renderLedgerMappingUI(mapping, headersRaw = []) {
    const { mapping: m, errors, warnings } = validateMapping(mapping, headersRaw);
    const colOptions = (selected) => `
      <option value="">— Not mapped —</option>
      ${headersRaw.map((h, i) => `<option value="${i}" ${selected === i ? 'selected' : ''}>${h || `Column ${i + 1}`}</option>`).join('')}
    `;

    const dbRows = TRANSACTION_FIELD_DEFS.map((def) => {
        const cfg = m.fields[def.key] || enrichField(def.key, {});
        const modes = modesForField(def);
        const colDisabled = !['sync', 'excel_import', 'excel_export'].includes(cfg.mode);
        const showFormulas = !colDisabled && def.role !== 'internal';
        const importExpr = cfg.importExpr ?? getDefaultImportExpr(def.key);
        const exportExpr = cfg.exportExpr ?? getDefaultExportExpr(def.key);
        const importPreset = detectPreset(importExpr, 'import', def.key);
        const exportPreset = detectPreset(exportExpr, 'export', def.key);
        return `
          <div class="ledger-sync-map__block" data-map-field="${def.key}">
            <div class="ledger-sync-map__row">
              <div class="ledger-sync-map__field-info">
                <span class="ledger-sync-map__label">${def.label}</span>
                <code class="ledger-sync-map__db-name">${def.dbColumn || '(excel helper)'}</code>
                ${def.hint ? `<span class="ledger-sync-map__hint">${def.hint}</span>` : ''}
              </div>
              <div class="ledger-sync-map__controls">
                <select class="ledger-sync-map__mode" data-map-mode ${def.role === 'internal' ? 'disabled' : ''}>
                  ${modes.map((o) => `<option value="${o.value}" ${cfg.mode === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
                </select>
                <select class="ledger-sync-map__select" data-map-col ${colDisabled ? 'disabled' : ''}>
                  ${colOptions(colDisabled ? null : cfg.excelCol)}
                </select>
              </div>
            </div>
            ${showFormulas ? `
            <div class="ledger-sync-map__formulas" data-map-formulas>
              <div class="ledger-sync-map__formula-row">
                <span class="ledger-sync-map__formula-label">Excel → DB</span>
                <select class="ledger-sync-map__preset" data-map-import-preset>
                  ${formulaPresetOptions('import', importExpr, def.key)}
                </select>
                <input type="text" class="ledger-sync-map__formula" data-map-import-expr
                  value="${escapeAttr(importExpr)}"
                  placeholder="e.g. NORM_TYPE({value})"
                  ${importPreset !== 'custom' ? 'hidden' : ''} />
              </div>
              <div class="ledger-sync-map__formula-row">
                <span class="ledger-sync-map__formula-label">DB → Excel</span>
                <select class="ledger-sync-map__preset" data-map-export-preset>
                  ${formulaPresetOptions('export', exportExpr, def.key)}
                </select>
                <input type="text" class="ledger-sync-map__formula" data-map-export-expr
                  value="${escapeAttr(exportExpr)}"
                  placeholder="e.g. TO_DR_CR({value})"
                  ${exportPreset !== 'custom' ? 'hidden' : ''} />
              </div>
            </div>` : ''}
          </div>`;
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
            const status = mapped
                ? `<span class="sync-excel-col__mapped"><i class="fa-solid fa-link"></i> ${mapped}</span>`
                : '<span class="sync-excel-col__ignore">Ignored on import</span>';
            return `
              <div class="sync-excel-col">
                <span class="sync-excel-col__letter">Col ${i + 1}</span>
                <strong class="sync-excel-col__header">${h || '(empty header)'}</strong>
                ${status}
              </div>`;
        }).join('')
        : '<p class="gate-wizard__hint">Load columns from your spreadsheet to see all Excel headers here.</p>';

    const errHtml = errors.length
        ? `<div class="ledger-sync-status ledger-sync-status--error"><strong>Mapping errors</strong><br/>${errors.map((e) => `• ${e}`).join('<br/>')}</div>`
        : '';
    const warnHtml = warnings.length
        ? `<div class="ledger-sync-status ledger-sync-status--warn"><strong>Notes</strong><br/>${warnings.map((w) => `• ${w}`).join('<br/>')}</div>`
        : '';

    return `
      ${errHtml}
      ${warnHtml}
      <p class="sync-map-table-label">Database table: <code>public.transactions</code></p>
      <div class="ledger-sync-map">
        <div class="ledger-sync-map__row ledger-sync-map__head ledger-sync-map__head--wide">
          <span>Field</span><span>Mode, column &amp; directional formulas</span>
        </div>
        ${dbRows}
      </div>
      <div class="sync-formula-help">
        <strong>Formula reference</strong>
        <code>{value}</code> this cell · <code>{field:amount}</code> another DB field · <code>{col:3}</code> Excel column (import)
        · <code>NORM_TYPE</code> <code>TO_DR_CR</code> <code>PARSE_AMOUNT</code> <code>IF(a,b,c)</code> <code>CONCAT(a,b)</code>
      </div>
      <div class="sync-excel-overview">
        <p class="sync-map-table-label">Excel columns in your sheet</p>
        <div class="sync-excel-overview__grid">${excelOverview}</div>
      </div>`;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function wireMappingFormInteractions(rootEl) {
    const syncFormulaRow = (block) => {
        const key = block.dataset.mapField;
        const modeSel = block.querySelector('[data-map-mode]');
        const colSel = block.querySelector('[data-map-col]');
        const formulas = block.querySelector('[data-map-formulas]');
        const syncable = modeSel && ['sync', 'excel_import', 'excel_export'].includes(modeSel.value);
        if (colSel) {
            colSel.disabled = !syncable;
            if (!syncable) colSel.value = '';
        }
        if (formulas) formulas.hidden = !syncable || colSel?.disabled;
    };

    const wirePreset = (block, direction) => {
        const key = block.dataset.mapField;
        const presetSel = block.querySelector(`[data-map-${direction}-preset]`);
        const exprInput = block.querySelector(`[data-map-${direction}-expr]`);
        if (!presetSel || !exprInput) return;
        const applyPreset = () => {
            const id = presetSel.value;
            const exprKey = direction === 'import' ? 'importExpr' : 'exportExpr';
            if (id === 'custom') {
                exprInput.hidden = false;
                return;
            }
            exprInput.hidden = true;
            const preset = presetById(id);
            const expr = id === 'default'
                ? (direction === 'import' ? getDefaultImportExpr(key) : getDefaultExportExpr(key))
                : (preset?.[exprKey] ?? exprInput.value);
            exprInput.value = expr || '';
        };
        presetSel.addEventListener('change', applyPreset);
        applyPreset();
    };

    rootEl.querySelectorAll('[data-map-field]').forEach((block) => {
        syncFormulaRow(block);
        block.querySelector('[data-map-mode]')?.addEventListener('change', () => syncFormulaRow(block));
        block.querySelector('[data-map-col]')?.addEventListener('change', () => syncFormulaRow(block));
        wirePreset(block, 'import');
        wirePreset(block, 'export');
    });
}

export const TEMPLATE_HEADERS = [
    'Date', 'Type', 'Amount', 'Dr', 'Cr', 'Category', 'Sub-category', 'Description',
    'Wallet', 'Vendor', 'Reference', 'Bank type', 'Bank ref', 'Sync ID', 'Sync status',
];
