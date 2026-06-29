/**
 * Legacy owner / tenant import — Excel (.xlsx) or CSV, single file or delta uploads.
 */
import { importResidentsFromSheet } from './residents.js';
import { withButtonBusy } from './buttonBusy.js';

const normHeader = (v) =>
    String(v ?? '').trim().toLowerCase().replace(/[\s_/]+/g, ' ');

const cellStr = (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    return s || null;
};

const UNIT_COL_ALIASES = ['apartment name', 'apartment_name', 'unit number', 'unit_number', 'unit', 'flat', 'flat no'];

const OWNER_NAME_ALIASES = ['owner name', 'owner_name', 'full name', 'full_name', 'name'];
const TENANT_NAME_ALIASES = ['tenant name', 'tenant_name', 'full name', 'full_name', 'name'];

const PRIMARY_ALIASES = [
    'primary secondary owner',
    'primary secondary tenant',
    'primary secondary',
    'owner type',
    'tenant type',
    'primary',
];

const RESIDING_ALIASES = ['residing status', 'residing_status', 'residing'];

const OWNER_SHEET_NAMES = ['owner details', 'owner_details', 'owners', 'owner'];
const TENANT_SHEET_NAMES = ['tenant details', 'tenant_details', 'tenants', 'tenant'];

const isCsvFile = (file) => {
    const name = String(file?.name || '').toLowerCase();
    const type = String(file?.type || '').toLowerCase();
    return name.endsWith('.csv') || type.includes('csv') || type === 'text/plain';
};

const headerMatches = (header, aliases) => {
    const h = normHeader(header);
    return aliases.some((a) => h === normHeader(a) || h.includes(normHeader(a)));
};

const mapLegacyHeaderRow = (headers, { nameAliases, includeResiding }) => {
    const map = {};
    headers.forEach((raw, idx) => {
        const h = String(raw ?? '');
        if (headerMatches(h, UNIT_COL_ALIASES)) map.unitNumber = idx;
        else if (headerMatches(h, nameAliases)) map.fullName = idx;
        else if (headerMatches(h, PRIMARY_ALIASES)) map.primaryFlag = idx;
        else if (includeResiding && headerMatches(h, RESIDING_ALIASES)) map.residingStatus = idx;
    });
    return map;
};

const parsePrimaryFlag = (raw) => {
    const s = cellStr(raw)?.toLowerCase();
    if (!s) return false;
    if (s === 'primary' || s.startsWith('primary')) return true;
    if (s === 'secondary' || s.startsWith('secondary')) return false;
    throw new Error(`Invalid primary/secondary value "${raw}" — use primary or secondary`);
};

const parseResidingStatus = (raw) => {
    const s = cellStr(raw)?.toLowerCase().replace(/[\s-]+/g, ' ');
    if (!s) return true;
    if (s === 'residing' || s === 'yes' || s === 'y') return true;
    if (s === 'non residing' || s === 'nonresiding' || s === 'no' || s === 'n') return false;
    throw new Error(`Invalid residing status "${raw}" — use Residing or Non-Residing`);
};

const rowVal = (row, idx) => {
    if (idx == null || idx < 0) return null;
    const val = row[idx];
    if (val && typeof val === 'object' && val.text != null) return val.text;
    return val;
};

const parseLegacyDataRows = (dataRows, headerRow, { kind, nameAliases, includeResiding }) => {
    const colMap = mapLegacyHeaderRow(headerRow, { nameAliases, includeResiding });
    if (colMap.unitNumber == null || colMap.fullName == null) return [];

    const residents = [];
    dataRows.forEach((row, rowIndex) => {
        const unitNumber = cellStr(rowVal(row, colMap.unitNumber));
        const fullName = cellStr(rowVal(row, colMap.fullName));
        if (!unitNumber || !fullName) return;

        try {
            let is_primary = false;
            let is_residing = true;
            if (colMap.primaryFlag != null) {
                is_primary = parsePrimaryFlag(rowVal(row, colMap.primaryFlag));
            }
            if (includeResiding && colMap.residingStatus != null) {
                is_residing = parseResidingStatus(rowVal(row, colMap.residingStatus));
            }
            residents.push({ unitNumber, kind, fullName, is_primary, is_residing });
        } catch (err) {
            throw new Error(`Row ${rowIndex + 2}: ${err.message}`);
        }
    });
    return residents;
};

const detectKindFromFilename = (filename) => {
    const n = String(filename || '').toLowerCase();
    if (/tenant/.test(n)) return 'TENANT';
    if (/owner/.test(n)) return 'OWNER';
    return null;
};

const detectKindFromHeaders = (headerRow) => {
    const headers = (headerRow || []).map((h) => normHeader(h));
    const has = (aliases) => headers.some((h) => aliases.some((a) => h === normHeader(a) || h.includes(normHeader(a))));
    if (has(TENANT_NAME_ALIASES.filter((a) => a.includes('tenant')))) return 'TENANT';
    if (has(OWNER_NAME_ALIASES.filter((a) => a.includes('owner')))) return 'OWNER';
    if (headers.some((h) => h.includes('tenant') && h.includes('primary'))) return 'TENANT';
    if (headers.some((h) => h.includes('owner') && h.includes('primary'))) return 'OWNER';
    return null;
};

const parseCsvLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                cur += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    out.push(cur);
    return out;
};

const parseCsvText = (text) => {
    const normalized = String(text || '').replace(/^\uFEFF/, '');
    return normalized
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseCsvLine);
};

const worksheetToRows = (ws) => {
    const rows = [];
    ws.eachRow((row) => {
        const arr = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => {
            arr[col - 1] = cell.value;
        });
        rows.push(arr);
    });
    return rows;
};

const findWorksheet = (wb, namePatterns) => {
    for (const ws of wb.worksheets) {
        const n = normHeader(ws.name);
        if (namePatterns.some((p) => n === normHeader(p) || n.includes(normHeader(p)))) return ws;
    }
    return null;
};

const parseLegacySheetRows = (allRows, { kind, nameAliases, includeResiding }) => {
    if (!allRows?.length) return [];
    const [headerRow, ...dataRows] = allRows;
    return parseLegacyDataRows(dataRows, headerRow, { kind, nameAliases, includeResiding });
};

const summarizeParse = (residents, { ownerCount, tenantCount, sheetNames = [], fileLabel = '' }) => {
    const unitCount = new Set(residents.map((r) => r.unitNumber)).size;
    return {
        residents,
        ownerCount,
        tenantCount,
        unitCount,
        sheetNames,
        fileLabel,
    };
};

/** Parse a single CSV (owner or tenant export). */
export async function parseLegacyResidentCsv(file) {
    const text = await file.text();
    const rows = parseCsvText(text);
    if (rows.length < 2) {
        throw new Error('CSV has no data rows. Expected a header row plus owner/tenant records.');
    }

    const headerRow = rows[0];
    const kind = detectKindFromFilename(file.name) || detectKindFromHeaders(headerRow);
    if (!kind) {
        throw new Error(
            'Could not tell if this CSV is owner or tenant data. '
            + 'Name the file with "owner" or "tenant", or include owner_name / tenant_name columns.',
        );
    }

    const nameAliases = kind === 'TENANT' ? TENANT_NAME_ALIASES : OWNER_NAME_ALIASES;
    const residents = parseLegacyDataRows(rows.slice(1), headerRow, {
        kind,
        nameAliases,
        includeResiding: kind === 'OWNER',
    });

    if (!residents.length) {
        throw new Error('No resident rows found in CSV. Check apartment_name and name columns.');
    }

    return summarizeParse(residents, {
        ownerCount: kind === 'OWNER' ? residents.length : 0,
        tenantCount: kind === 'TENANT' ? residents.length : 0,
        sheetNames: [`CSV (${kind.toLowerCase()})`],
        fileLabel: file.name,
    });
}

/** Parse legacy owner-details + tenant-details Excel workbook. */
export async function parseLegacyResidentExcel(file) {
    const ExcelJS = (await import('exceljs')).default;
    const buf = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const ownerWs = findWorksheet(wb, OWNER_SHEET_NAMES);
    const tenantWs = findWorksheet(wb, TENANT_SHEET_NAMES);

    const owners = parseLegacySheetRows(worksheetToRows(ownerWs), {
        kind: 'OWNER',
        nameAliases: OWNER_NAME_ALIASES,
        includeResiding: true,
    });
    const tenants = parseLegacySheetRows(worksheetToRows(tenantWs), {
        kind: 'TENANT',
        nameAliases: TENANT_NAME_ALIASES,
        includeResiding: false,
    });

    const residents = [...owners, ...tenants];
    if (!residents.length) {
        throw new Error(
            'No owner or tenant rows found. Expected sheets named "owner details" and/or "tenant details" '
            + 'with columns apartment_name, owner_name / tenant_name, primary/secondary, and residing_status (owners).',
        );
    }

    return summarizeParse(residents, {
        ownerCount: owners.length,
        tenantCount: tenants.length,
        sheetNames: [ownerWs?.name, tenantWs?.name].filter(Boolean),
        fileLabel: file.name,
    });
}

/** Parse Excel or CSV legacy owner/tenant export. */
export async function parseLegacyResidentFile(file) {
    if (!file) throw new Error('No file selected.');
    if (isCsvFile(file)) return parseLegacyResidentCsv(file);
    return parseLegacyResidentExcel(file);
}

/** Merge legacy sheets into unit-directory parse result when present. */
export function mergeLegacyResidentsFromWorkbook(wb, existingResidents = []) {
    const ownerWs = findWorksheet(wb, OWNER_SHEET_NAMES);
    const tenantWs = findWorksheet(wb, TENANT_SHEET_NAMES);
    const legacy = [
        ...parseLegacySheetRows(worksheetToRows(ownerWs), { kind: 'OWNER', nameAliases: OWNER_NAME_ALIASES, includeResiding: true }),
        ...parseLegacySheetRows(worksheetToRows(tenantWs), { kind: 'TENANT', nameAliases: TENANT_NAME_ALIASES, includeResiding: false }),
    ];
    if (!legacy.length) return existingResidents;
    return legacy;
}

const formatSummaryHtml = (parsed) => {
    const sheetNote = parsed.sheetNames?.length
        ? `<br><span style="font-size:0.78rem;color:var(--text-dim);">${parsed.sheetNames.join(', ')}</span>`
        : '';
    return `<strong>${parsed.ownerCount}</strong> owner row(s)
      · <strong>${parsed.tenantCount}</strong> tenant row(s)
      · <strong>${parsed.unitCount}</strong> flat(s)${sheetNote}`;
};

export const initResidentImport = () => {
    const fileInput = document.getElementById('resident-import-file');
    const modal = document.getElementById('resident-import-modal');
    const stepPick = document.getElementById('resident-import-pick');
    const stepPreview = document.getElementById('resident-import-preview');
    const stepDone = document.getElementById('resident-import-done');
    const summaryEl = document.getElementById('resident-import-summary');
    const logEl = document.getElementById('resident-import-log');
    const errorEl = document.getElementById('resident-import-error');
    let pendingImport = null;
    let importSessionLog = [];

    const showError = (msg) => {
        if (!errorEl) return;
        errorEl.textContent = msg || '';
        errorEl.hidden = !msg;
    };

    const showStep = (step) => {
        if (stepPick) stepPick.hidden = step !== 'pick';
        if (stepPreview) stepPreview.hidden = step !== 'preview';
        if (stepDone) stepDone.hidden = step !== 'done';
    };

    const renderSessionLog = () => {
        if (!logEl) return;
        if (!importSessionLog.length) {
            logEl.innerHTML = '';
            return;
        }
        logEl.innerHTML = `
          <p style="font-size:0.75rem;font-weight:800;color:var(--text-dim);margin:0 0 0.5rem;text-transform:uppercase;">This session</p>
          <ul style="margin:0;padding-left:1.1rem;font-size:0.82rem;line-height:1.5;">
            ${importSessionLog.map((entry) => `<li><strong>${entry.file}</strong> — ${entry.summary} <span style="color:var(--text-dim);">(${entry.mode})</span></li>`).join('')}
          </ul>`;
    };

    const openImportModal = () => {
        pendingImport = null;
        importSessionLog = [];
        showError('');
        showStep('pick');
        if (fileInput) fileInput.value = '';
        renderSessionLog();
        modal?.classList.add('active');
    };

    const closeImportModal = () => {
        modal?.classList.remove('active');
        pendingImport = null;
    };

    const previewFile = async (file) => {
        showError('');
        pendingImport = await parseLegacyResidentFile(file);
        pendingImport.fileName = file.name;
        if (summaryEl) summaryEl.innerHTML = formatSummaryHtml(pendingImport);
        document.getElementById('resident-import-filename').textContent = file.name;
        showStep('preview');
    };

    document.getElementById('resident-import-btn')?.addEventListener('click', openImportModal);
    document.getElementById('resident-import-close')?.addEventListener('click', closeImportModal);
    document.getElementById('resident-import-cancel')?.addEventListener('click', closeImportModal);
    document.getElementById('resident-import-choose')?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            await previewFile(file);
        } catch (err) {
            showError(err?.message || 'Could not read file.');
        } finally {
            if (fileInput) fileInput.value = '';
        }
    });

    document.getElementById('resident-import-back')?.addEventListener('click', () => {
        pendingImport = null;
        showError('');
        showStep(importSessionLog.length ? 'done' : 'pick');
    });

    document.getElementById('resident-import-another')?.addEventListener('click', () => {
        pendingImport = null;
        showError('');
        showStep('pick');
        fileInput?.click();
    });

    document.getElementById('resident-import-done-btn')?.addEventListener('click', closeImportModal);

    document.getElementById('resident-import-apply')?.addEventListener('click', async () => {
        if (!pendingImport) return;
        const mode = document.querySelector('input[name="resident-legacy-import-mode"]:checked')?.value || 'update_listed';
        if (mode === 'full_replace' && !confirm('This will delete ALL residents for this apartment before importing. Continue?')) return;
        const btn = document.getElementById('resident-import-apply');
        await withButtonBusy(btn, 'Importing…', async () => {
            const { count } = await importResidentsFromSheet(pendingImport.residents, mode);
            const modeLabel = {
                update_listed: 'delta merge',
                replace_listed: 'replace flats',
                full_replace: 'full replace',
            }[mode] || mode;
            importSessionLog.push({
                file: pendingImport.fileName || 'file',
                summary: `${count} row(s) applied`,
                mode: modeLabel,
            });
            pendingImport = null;
            renderSessionLog();
            if (typeof window.renderResidents === 'function') await window.renderResidents();
            window.refreshUnitDetailIfOpen?.();
            showStep('done');
        }).catch((err) => showError(err?.message || 'Import failed.'));
    });

    modal?.addEventListener('click', (e) => {
        if (e.target.id === 'resident-import-modal') closeImportModal();
    });
};
