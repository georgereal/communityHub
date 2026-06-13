/**
 * Bulk maintenance invoice Excel template download + import
 */
import { portalState, pullState } from './store.js';
import {
    buildBillingPreview,
    getAllChargeHeads,
    saveChargeHead,
} from './billingHeads.js';

const normHeader = (v) =>
    String(v ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');

const normUnit = (v) => String(v ?? '').trim().toUpperCase();

const cellStr = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map((t) => t.text).join('').trim() || null;
        if (v.text) return String(v.text).trim() || null;
        if (v.result != null) return cellStr(v.result);
    }
    const s = String(v).trim();
    return s || null;
};

const parseNum = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'object' && v.result != null) return parseNum(v.result);
    const n = parseFloat(String(v).replace(/,/g, '').replace(/₹/g, ''));
    return Number.isFinite(n) ? n : null;
};

const readCellValue = (cell) => {
    if (!cell) return null;
    const v = cell.value;
    if (v != null && v !== '') return v;
    const t = cell.text;
    if (t != null && String(t).trim() !== '') return t;
    return null;
};

export const formatDateForInput = (v) => {
    const s = cellStr(v);
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = v instanceof Date ? v : new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return s;
};

const findUnit = (unitNumber) => {
    const needle = normUnit(unitNumber);
    return portalState.units.find((u) => normUnit(u.number) === needle);
};

const findHeadByName = (name) => {
    const key = normHeader(name);
    return getAllChargeHeads().find((h) => normHeader(h.name) === key);
};

const headColumnName = (head) => head.name;

export async function downloadBulkInvoiceTemplate({
    unitIds = [],
    headIds = [],
    periodLabel = '',
    dueDate = '',
    notes = '',
    manualAmounts = {},
}) {
    if (!unitIds.length) throw new Error('Select at least one flat.');
    if (!headIds.length) throw new Error('Select at least one charge head.');

    const preview = buildBillingPreview({ unitIds, headIds, manualAmounts });
    const heads = preview.heads;

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'CommunityHub';
    wb.created = new Date();

    const meta = wb.addWorksheet('Meta', { views: [{ state: 'frozen', ySplit: 1 }] });
    meta.addRow(['Field', 'Value']);
    meta.addRow(['Period_Label', periodLabel || '']);
    meta.addRow(['Due_Date', dueDate || '']);
    meta.addRow(['Notes', notes || '']);
    meta.columns = [{ width: 18 }, { width: 36 }];
    meta.getRow(1).font = { bold: true };

    const headers = ['Unit_Number', ...heads.map(headColumnName)];
    const ws = wb.addWorksheet('Invoices', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(headers);
    preview.rows.forEach((row) => {
        const amounts = row.lines.map((l) => (l.amount > 0 ? l.amount : ''));
        ws.addRow([row.unit.number, ...amounts]);
    });
    ws.columns = [{ width: 12 }, ...heads.map(() => ({ width: 16 }))];
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };

    const help = wb.addWorksheet('Instructions');
    [
        ['Bulk invoice template'],
        [''],
        ['Sheet "Meta": period label, due date (YYYY-MM-DD), and optional notes for this billing run.'],
        ['Sheet "Invoices": one row per flat. Unit_Number is required.'],
        ['Columns match your selected charge heads. Amounts are pre-filled where calculable.'],
        ['Edit amounts as needed. Blank cells = use calculated/default amount on import.'],
        ['Add a new column to create a new variable charge head (per-flat amounts).'],
        ['Re-download after changing charge head selection to refresh columns.'],
    ].forEach((line) => help.addRow(line));
    help.getColumn(1).width = 72;

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const base = (periodLabel || portalState.community?.name || 'invoices')
        .replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'invoices';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_invoice_template.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function mapHeaders(headerRow) {
    const map = {};
    headerRow.eachCell((cell, col) => {
        const h = normHeader(cell.value);
        if (col === 1 && (h === 'unit number' || h === 'unit_number' || h === 'flat')) {
            map.unitNumber = col;
            return;
        }
        if (h) map[h] = col;
    });
    if (!map.unitNumber) {
        const first = normHeader(headerRow.getCell(1).value);
        if (first) map.unitNumber = 1;
    }
    return map;
}

export async function parseBulkInvoiceExcel(file) {
    const ExcelJS = (await import('exceljs')).default;
    const buf = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    let periodLabel = '';
    let dueDate = '';
    let notes = '';
    const meta = wb.getWorksheet('Meta');
    if (meta) {
        meta.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            const field = cellStr(row.getCell(1).value)?.toUpperCase().replace(/[\s-]+/g, '_');
            const val = cellStr(row.getCell(2).value);
            if (field === 'PERIOD_LABEL') periodLabel = val || '';
            if (field === 'DUE_DATE') dueDate = formatDateForInput(row.getCell(2).value) || val || '';
            if (field === 'NOTES') notes = val || '';
        });
    }

    const ws = wb.getWorksheet('Invoices') || wb.worksheets.find((s) => s.name !== 'Meta' && s.name !== 'Instructions') || wb.worksheets[0];
    if (!ws) throw new Error('Workbook has no invoice sheet.');

    const colMap = mapHeaders(ws.getRow(1));
    if (!colMap.unitNumber) throw new Error('Invoices sheet: missing Unit_Number column.');

    const headerRow = ws.getRow(1);
    const headColumns = [];
    headerRow.eachCell((cell, col) => {
        if (col === colMap.unitNumber) return;
        const name = cellStr(cell.value);
        if (name) headColumns.push({ name, col });
    });

    if (!headColumns.length) throw new Error('No charge head columns found. Add columns or re-download the template.');

    const rows = [];
    ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const unitNumber = cellStr(row.getCell(colMap.unitNumber).value);
        if (!unitNumber) return;
        const amounts = {};
        headColumns.forEach((hc) => {
            const val = parseNum(readCellValue(row.getCell(hc.col)));
            if (val != null) amounts[hc.name] = val;
        });
        rows.push({ unitNumber, amounts });
    });

    if (!rows.length) throw new Error('No flat rows on Invoices sheet.');

    return { periodLabel, dueDate, notes, rows, headColumns: headColumns.map((h) => h.name) };
}

/**
 * Resolve heads (create MANUAL heads for new columns), return headIds + lineOverrides
 */
export async function resolveImportHeads(headColumnNames) {
    const headIds = [];
    const headByName = new Map();

    for (const rawName of headColumnNames) {
        const name = String(rawName || '').trim();
        if (!name) continue;
        let head = findHeadByName(name);
        if (!head) {
            await saveChargeHead({
                name,
                calc_type: 'MANUAL',
                default_amount: 0,
                sort_order: (getAllChargeHeads().length + 1) * 10,
            });
            await pullState();
            head = findHeadByName(name);
        }
        if (head && !headIds.includes(head.id)) {
            headIds.push(head.id);
            headByName.set(normHeader(head.name), head);
        }
    }
    return { headIds, headByName };
}

export function buildLineOverridesFromImport(parsed, headByName) {
    const overrides = {};
    const unitIds = [];
    const errors = [];

    parsed.rows.forEach((row) => {
        const unit = findUnit(row.unitNumber);
        if (!unit) {
            errors.push(`${row.unitNumber}: flat not found`);
            return;
        }
        unitIds.push(unit.id);
        overrides[unit.id] = overrides[unit.id] || {};
        Object.entries(row.amounts).forEach(([headName, amount]) => {
            const head = headByName.get(normHeader(headName))
                || [...headByName.values()].find((h) => normHeader(h.name) === normHeader(headName));
            if (head) overrides[unit.id][head.id] = amount;
        });
    });

    return { unitIds: [...new Set(unitIds)], lineOverrides: overrides, errors };
}
