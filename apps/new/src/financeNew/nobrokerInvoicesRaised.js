/** Finance-New clone (nobrokerInvoicesRaised.js) */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
/**
 * NoBroker "invoices raised" monthly export → DB + finance report stacks.
 * Current-period charge heads only (no arrears / DPC). Month from Start Period Date.
 * Reads .xls and .xlsx via SheetJS (NoBroker often exports legacy .xls).
 */
import { portalState } from '../store.js';
import { pullState } from './pull.js';
import { mongoInsert, mongoDelete } from './mongoWrite.js';

const MONTH_NAMES = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const cellValueToText = (v) => {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) {
      return v.richText.map((t) => t?.text ?? '').join('').trim();
    }
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return cellValueToText(v.result);
  }
  return String(v).trim();
};

const normHeader = (v) =>
  cellValueToText(v)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .toLowerCase()
    .replace(/[#./\\()%]+/g, ' ')
    .replace(/[\s_]+/g, ' ')
    .trim();

const parseAmount = (val) => {
  if (val == null || val === '') return 0;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'object' && val.result != null) return parseAmount(val.result);
  const n = parseFloat(String(val).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const parseDate = (val) => {
  if (!val && val !== 0) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  // Excel serial date (SheetJS raw)
  if (typeof val === 'number' && Number.isFinite(val) && val > 20000 && val < 80000) {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof val === 'object' && val.result != null) return parseDate(val.result);

  const s = cellValueToText(val);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const mon = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (mon) {
    const day = Number(mon[1]);
    const month = MONTH_NAMES[mon[2].toLowerCase()];
    const year = Number(mon[3]);
    if (month != null && day >= 1 && day <= 31) {
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const parts = s.split(/[\/\-.]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map((x) => parseInt(x, 10));
    if (c > 1000 && b >= 1 && b <= 12) {
      return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    }
    if (a > 1000 && b >= 1 && b <= 12) {
      return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
  }

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
};

/** First calendar day of the billing month from start period date. */
export const billingMonthFromStart = (startIso) => {
  if (!startIso || startIso.length < 7) return null;
  return `${startIso.slice(0, 7)}-01`;
};

/** Parse Start Period Date or Invoice Month ("Jun-2026", "June 2026", Date) → YYYY-MM-01. */
const billingMonthFromCell = (val) => {
  const asDate = parseDate(val);
  if (asDate) return billingMonthFromStart(asDate);

  const s = cellValueToText(val).trim();
  if (!s) return null;

  const monYear = s.match(/^([A-Za-z]{3,9})[-\s\/]+(\d{4})$/);
  if (monYear) {
    const monRaw = monYear[1].toLowerCase().slice(0, 3);
    const month = MONTH_NAMES[monRaw];
    const year = Number(monYear[2]);
    if (month != null) {
      return `${year}-${String(month + 1).padStart(2, '0')}-01`;
    }
  }

  const yearMon = s.match(/^(\d{4})[-\s\/]+([A-Za-z]{3,9}|\d{1,2})$/);
  if (yearMon) {
    const year = Number(yearMon[1]);
    const second = yearMon[2];
    const month = /^\d+$/.test(second)
      ? Number(second) - 1
      : MONTH_NAMES[second.toLowerCase().slice(0, 3)];
    if (month != null && month >= 0 && month <= 11) {
      return `${year}-${String(month + 1).padStart(2, '0')}-01`;
    }
  }

  return null;
};

/**
 * Charge-head discovery is positional, not a fixed column whitelist:
 *   [meta… Invoice#] → charge heads (any new columns here are auto-picked) → [SGST/CGST/totals…]
 * Long format (Head + Value columns) is also supported.
 */
const META_HEADERS = new Set([
  's no', 'sno', 'unit id', 'unit', 'unit number', 'unit no', 'unit name', 'flat',
  'start period date', 'end period date', 'invoice month', 'billing month',
  'invoice date', 'due date', 'actual due date', 'display due date',
  'resident name', 'user full name', 'occupancy status',
  'invoice', 'invoice no', 'invoice number', 'no of days', 'days',
  'unit category name', 'primary phone no', 'email id', 'address', 'billing type',
  'unit address', 'amount in words', 'previous date',
  'major head', 'head', 'value', 'description', 'ref no', 'payment mode',
  'payment status', 'payment date', 'transaction id', 'payment description', 'remarks',
  // NoBroker "bills raised" export
  'bill id', 'bill number', 'bill date', 'bill area', 'bill type', 'bill status',
  'society name', 'block', 'wing', 'floor', 'owner name', 'tenant name',
]);

const TAX_OR_TOTAL_HEADERS = new Set([
  'sgst', 'cgst', 'igst', 'cess', 'current bill', 'dpc/lpc arrears', 'dpc', 'lpc',
  'interest arrears', 'rebate', 'total arrears', 'total payable amount',
  'arrears', 'total tax', 'bill amount', 'net amount', 'arrears amount',
  'interest balance', 'advance balance', 'total balance', 'interest charges',
  'total invoice amount', 'net payable amount', 'gst on maintenance',
  'total invoice value', 'total amount paid', 'balance amount', 'gross amount',
  'total bill amount', 'amount payable', 'grand total',
]);

const isTaxOrTotalHeader = (norm) => {
  if (TAX_OR_TOTAL_HEADERS.has(norm)) return true;
  if (norm.startsWith('sgst') || norm.startsWith('cgst') || norm.startsWith('igst')) return true;
  if (norm.includes('arrears') || norm.includes('payable') || norm.includes('balance')) return true;
  if (norm.startsWith('total ') || norm.startsWith('net ')) return true;
  if (norm.startsWith('gst ')) return true;
  return false;
};

/** Ordering hints only — new heads are still imported when they have amounts. */
const PREFERRED_HEAD_LABELS = [
  'Maintenance charges',
  'Common water consumption charges',
  'Water Meter Rent',
  'Car Parking',
  'Home water consumption charges',
  'Non Occupancy Charges',
];

const preferredLabelFor = (norm) => {
  const hit = PREFERRED_HEAD_LABELS.find((l) => normHeader(l) === norm);
  return hit || null;
};

const displayLabelForHeader = (raw) => {
  const preferred = preferredLabelFor(normHeader(raw));
  return preferred || cellValueToText(raw) || String(raw || '').trim();
};

const ARREARS_HEAD_RE = /arrears|dpc|lpc|interest|rebate|advance|payable|balance|tax|sgst|cgst|igst|cess|gross|net amount|total /i;

const isChargeHeadName = (name) => {
  const n = normHeader(name);
  if (!n) return false;
  if (META_HEADERS.has(n) || isTaxOrTotalHeader(n)) return false;
  if (ARREARS_HEAD_RE.test(n)) return false;
  return true;
};

const rowLooksLikeHeader = (texts) => {
  const hasUnit = texts.some((t) =>
    t === 'unit' || t === 'flat' || t.includes('unit id') || t.includes('unit no')
    || t.includes('unit number') || t.includes('unit name') || t.startsWith('unit')
    || t === 'bill area');
  const hasInvoice = texts.some((t) => t.includes('invoice'));
  const hasBillNumber = texts.some((t) => t === 'bill number' || t.includes('bill number'));
  const hasBillId = texts.some((t) => t === 'bill id');
  const hasPeriod = texts.some((t) =>
    t.includes('start period') || t.includes('invoice month') || t.includes('billing month'));
  // Classic invoice export OR NoBroker bills export (bill_id / Bill Number / Start Period Date)
  return (hasUnit && (hasInvoice || hasBillNumber || hasPeriod))
    || ((hasBillNumber || hasBillId) && hasPeriod)
    || (hasBillNumber && hasInvoice);
};

const readHeaderMapFromGridRow = (row) => {
  const headersByCol = {};
  const texts = [];
  (row || []).forEach((cell, idx) => {
    const raw = cellValueToText(cell);
    const h = normHeader(raw);
    if (!h || h === '[object object]') return;
    const col = idx + 1; // 1-based
    texts.push(h);
    headersByCol[col] = raw;
  });
  return { headersByCol, texts };
};

const gridCell = (row, col1) => {
  if (col1 == null || !row) return null;
  return row[col1 - 1] ?? null;
};

const gridCellText = (row, col1) => cellValueToText(gridCell(row, col1));

const serializeRawValue = (val) => {
  if (val == null || val === '') return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) return val.toISOString().slice(0, 10);
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'boolean') return val;
  const asDate = parseDate(val);
  if (asDate && (val instanceof Date || /^\d{1,2}[\/\-.]/.test(String(val).trim()))) return asDate;
  const s = cellValueToText(val);
  return s || null;
};

/** Full Excel row keyed by original header labels. */
const buildRawRow = (row, headersByCol) => {
  const raw = {};
  Object.entries(headersByCol).forEach(([colStr, header]) => {
    const key = String(header || '').trim();
    if (!key) return;
    const v = serializeRawValue(gridCell(row, Number(colStr)));
    if (v != null && v !== '') raw[key] = v;
  });
  return raw;
};

const looksLikeUnitValue = (s) => {
  const t = String(s || '').trim();
  if (!t || t === '-' || t === '—') return false;
  if (/^[A-Za-z]+[-\s]?\d/.test(t)) return true; // A-101, B 204
  if (/^\d{2,}[A-Za-z]?$/.test(t)) return true;
  if (/[A-Za-z].*\d|\d.*[A-Za-z]/.test(t) && t.length <= 12) return true;
  return false;
};

const RESIDENT_ALIASES = [
  'resident name', 'user full name', 'owner name', 'tenant name', 'resident',
  'primary owner', 'member name', 'customer name', 'bill to name', 'occupant name',
  'owner', 'tenant', 'name of resident', 'resident full name', 'primary resident',
  'bill to', 'customer', 'account name',
];

const OCCUPANCY_ALIASES = [
  'occupancy status', 'occupancy', 'residing status', 'occupant type',
  'owner tenant', 'occupancy type', 'unit occupancy',
];

const UNIT_ALIASES_PREFERRED = [
  'unit number', 'unit name', 'unit id', 'unit no', 'flat no', 'flat number',
  'flat', 'apartment name', 'apartment', 'unit',
];

const pickFromRawByAliases = (raw, aliases) => {
  if (!raw || typeof raw !== 'object') return null;
  const entries = Object.entries(raw);
  for (const a of aliases) {
    const na = normHeader(a);
    for (const [k, v] of entries) {
      if (v == null || v === '') continue;
      if (normHeader(k) === na) return String(v).trim();
    }
  }
  for (const a of aliases) {
    const na = normHeader(a);
    if (na.length < 4) continue;
    for (const [k, v] of entries) {
      if (v == null || v === '') continue;
      const nk = normHeader(k);
      if (nk.includes(na) || na.includes(nk)) return String(v).trim();
    }
  }
  return null;
};

/** Prefer real flat labels over Bill Area (= "1"). */
const pickBestUnitCol = (headersByCol, gridRows, headerRowIdx, colFor) => {
  const preferred = colFor(...UNIT_ALIASES_PREFERRED);
  const billArea = colFor('bill area');
  const candidates = [];
  Object.entries(headersByCol).forEach(([colStr, header]) => {
    const norm = normHeader(header);
    if (
      UNIT_ALIASES_PREFERRED.some((a) => norm === normHeader(a) || norm.includes(normHeader(a)))
      || norm === 'bill area'
      || norm.includes('unit')
      || norm.includes('flat')
    ) {
      candidates.push({ col: Number(colStr), norm, header });
    }
  });
  if (!candidates.length) return preferred || billArea;

  let best = null;
  let bestScore = -Infinity;
  const sampleTo = Math.min(gridRows.length, headerRowIdx + 40);
  candidates.forEach(({ col, norm }) => {
    let score = 0;
    if (norm === 'unit number' || norm === 'unit name') score += 40;
    else if (norm.includes('unit') || norm.includes('flat')) score += 25;
    if (norm === 'bill area') score -= 15;
    for (let r = headerRowIdx + 1; r < sampleTo; r++) {
      const v = gridCellText(gridRows[r], col);
      if (!v) continue;
      if (looksLikeUnitValue(v)) score += 4;
      if (v === '1' || v === '0') score -= 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = col;
    }
  });
  return best || preferred || billArea;
};

const pickFirstMatchingCol = (colFor, aliases) => {
  for (const a of aliases) {
    const c = colFor(a);
    if (c != null) return c;
  }
  return null;
};

/** Read .xls / .xlsx / HTML-as-xls into array-of-arrays sheets. */
async function loadSheetGrids(file) {
  const name = String(file?.name || '').toLowerCase();
  if (name.endsWith('.csv')) {
    throw new Error('CSV is not supported — upload the NoBroker export as .xls or .xlsx.');
  }

  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {
    type: 'array',
    cellDates: true,
    raw: true,
  });
  if (!wb.SheetNames?.length) throw new Error('Workbook has no worksheets.');

  return wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    // Keep blank rows so header index stays aligned; strip only trailing empties later.
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
      raw: true,
      blankrows: true,
    });
    return { name: sheetName, rows: Array.isArray(rows) ? rows : [] };
  });
}

const summarizeRowsForError = (sheets) => {
  const bits = [];
  for (const sheet of sheets.slice(0, 2)) {
    const sample = (sheet.rows || []).slice(0, 3).map((row, i) => {
      const cells = (row || [])
        .map((c) => cellValueToText(c))
        .filter(Boolean)
        .slice(0, 8);
      return `r${i + 1}: ${cells.join(' | ') || '(empty)'}`;
    });
    bits.push(`[${sheet.name}] ${sample.join(' · ')}`);
  }
  return bits.join(' ') || '(no rows readable)';
};

const finalizeRows = (parsedRows, candidateChargeCols, sumsByNorm) => {
  const activeHeads = candidateChargeCols
    .filter((c) => preferredLabelFor(c.norm) || (sumsByNorm.get(c.norm) || 0) > 0.001)
    .map((c) => c.label);

  const orderedHeads = [
    ...PREFERRED_HEAD_LABELS.filter((l) => activeHeads.includes(l)),
    ...activeHeads.filter((l) => !PREFERRED_HEAD_LABELS.includes(l)),
  ];

  const rows = parsedRows.map((row) => {
    const charges = {};
    let total = 0;
    orderedHeads.forEach((label) => {
      const amt = parseAmount(row.charges[label]);
      charges[label] = amt;
      total += amt;
    });
    return {
      ...row,
      charges,
      raw: row.raw && typeof row.raw === 'object' ? row.raw : {},
      total_raised: Math.round(total * 100) / 100,
    };
  });

  return {
    rows,
    chargeHeads: orderedHeads,
    billingMonths: [...new Set(rows.map((r) => r.billing_month))].sort(),
    rowCount: rows.length,
  };
};

/**
 * @returns {{
 *   rows: Array<object>,
 *   chargeHeads: string[],
 *   billingMonths: string[],
 *   rowCount: number,
 * }}
 */
export async function parseNoBrokerInvoicesRaisedFile(file) {
  const sheets = await loadSheetGrids(file);

  let headerRowIdx = -1; // 0-based
  let headersByCol = {};
  let gridRows = null;

  for (const sheet of sheets) {
    const scanTo = Math.min(sheet.rows.length, 40);
    for (let r = 0; r < scanTo; r++) {
      const { headersByCol: map, texts } = readHeaderMapFromGridRow(sheet.rows[r]);
      if (rowLooksLikeHeader(texts)) {
        gridRows = sheet.rows;
        headerRowIdx = r;
        headersByCol = map;
        break;
      }
    }
    if (headerRowIdx >= 0) break;
  }

  if (headerRowIdx < 0 || !gridRows) {
    throw new Error(
      'Header row not found. Expected Bill Number (or Invoice#) with Start Period Date '
      + `(or Unit Id). Saw: ${summarizeRowsForError(sheets)}`,
    );
  }

  const normToCol = new Map();
  Object.entries(headersByCol).forEach(([col, raw]) => {
    const n = normHeader(raw);
    if (n && !normToCol.has(n)) normToCol.set(n, Number(col));
  });

  const colFor = (...aliases) => {
    for (const a of aliases) {
      const c = normToCol.get(normHeader(a));
      if (c != null) return c;
    }
    for (const a of aliases) {
      const na = normHeader(a);
      if (na.length < 5) continue;
      for (const [norm, col] of normToCol.entries()) {
        if (norm === na) return col;
        if (norm.startsWith(`${na} `) || norm.endsWith(` ${na}`)) return col;
      }
    }
    return null;
  };

  const billIdCol = colFor('bill id');
  const unitCol = pickBestUnitCol(headersByCol, gridRows, headerRowIdx, colFor);
  const startCol = colFor(
    'start period date',
    'start period',
    'invoice month',
    'billing month',
    'period start',
  );
  const endCol = colFor('end period date', 'end period', 'period end');
  const invoiceDateCol = colFor('bill date', 'invoice date');
  const dueCol = colFor('actual due date', 'display due date', 'due date');
  const residentCol = pickFirstMatchingCol(colFor, RESIDENT_ALIASES);
  const occupancyCol = pickFirstMatchingCol(colFor, OCCUPANCY_ALIASES);
  const invoiceCol = colFor('bill number', 'invoice no', 'invoice number')
    || normToCol.get('invoice')
    || null;
  const headCol = colFor('head');
  const valueCol = colFor('value');
  const longFormat = headCol != null && valueCol != null;

  if (invoiceCol == null || startCol == null || (unitCol == null && billIdCol == null)) {
    const found = Object.values(headersByCol).slice(0, 20).join(', ');
    throw new Error(
      `Required columns missing: Bill Number (or Invoice#), Start Period Date, and Unit / Bill Area. `
      + `Found headers: ${found || '(none)'}.`,
    );
  }

  const enrichFromRaw = (entry, raw) => {
    entry.raw = raw;
    if (!entry.resident_name) {
      entry.resident_name = pickFromRawByAliases(raw, RESIDENT_ALIASES);
    }
    if (!entry.occupancy_status) {
      entry.occupancy_status = pickFromRawByAliases(raw, OCCUPANCY_ALIASES);
    }
    // If unit looks like bill-area "1", prefer a better value from raw.
    if (!entry.unit_number || !looksLikeUnitValue(entry.unit_number)) {
      const better = pickFromRawByAliases(raw, UNIT_ALIASES_PREFERRED);
      if (better && looksLikeUnitValue(better)) entry.unit_number = better;
    }
    return entry;
  };

  const resolveUnit = (row) => {
    const fromUnit = unitCol ? gridCellText(row, unitCol) : '';
    const fromBillId = billIdCol ? gridCellText(row, billIdCol) : '';
    return {
      unit_number: fromUnit || fromBillId || null,
      unit_id_external: fromBillId || fromUnit || null,
    };
  };

  // --- Long format: one row per charge head (Head + Value) ---
  if (longFormat) {
    const byKey = new Map();
    const sumsByNorm = new Map();
    const headLabels = new Map(); // norm → display label

    for (let r = headerRowIdx + 1; r < gridRows.length; r++) {
      const row = gridRows[r];
      const invoiceNumber = gridCellText(row, invoiceCol);
      const { unit_number: unitNumber, unit_id_external: unitExternal } = resolveUnit(row);
      if (!invoiceNumber && !unitNumber && !unitExternal) continue;

      const startRaw = gridCell(row, startCol);
      const billingMonth = billingMonthFromCell(startRaw);
      if (!billingMonth) continue;
      const startPeriod = parseDate(startRaw) || billingMonth;

      const headRaw = gridCellText(row, headCol);
      if (!isChargeHeadName(headRaw)) continue;
      const label = displayLabelForHeader(headRaw);
      const norm = normHeader(headRaw);
      const amt = parseAmount(gridCell(row, valueCol));
      if (!headLabels.has(norm)) headLabels.set(norm, label);
      sumsByNorm.set(norm, (sumsByNorm.get(norm) || 0) + Math.abs(amt));

      const key = `${billingMonth}||${invoiceNumber || unitNumber || unitExternal}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = enrichFromRaw({
          unit_id_external: unitExternal,
          unit_number: unitNumber,
          invoice_number: invoiceNumber || `${unitNumber || unitExternal}-${billingMonth}`,
          start_period_date: startPeriod,
          end_period_date: endCol ? parseDate(gridCell(row, endCol)) : null,
          invoice_date: invoiceDateCol ? parseDate(gridCell(row, invoiceDateCol)) : null,
          due_date: dueCol ? parseDate(gridCell(row, dueCol)) : null,
          resident_name: residentCol ? gridCellText(row, residentCol) || null : null,
          occupancy_status: occupancyCol ? gridCellText(row, occupancyCol) || null : null,
          billing_month: billingMonth,
          charges: {},
        }, buildRawRow(row, headersByCol));
        byKey.set(key, entry);
      } else {
        // Merge raw keys from later charge lines (same invoice).
        Object.assign(entry.raw, buildRawRow(row, headersByCol));
      }
      entry.charges[label] = (entry.charges[label] || 0) + amt;
    }

    const parsedRows = [...byKey.values()];
    if (!parsedRows.length) {
      throw new Error('No invoice rows found under the header (Head/Value format).');
    }

    const candidateChargeCols = [...headLabels.entries()].map(([norm, label]) => ({
      norm,
      label,
    }));
    const finalized = finalizeRows(parsedRows, candidateChargeCols, sumsByNorm);
    return { ...finalized, fileName: file.name || 'nobroker-invoices.xls' };
  }

  // --- Wide format: charge columns between Invoice# and tax/totals ---
  const invoiceColNum = invoiceCol;
  let stopCol = null;
  for (const [norm, col] of normToCol.entries()) {
    if (norm === 'sgst' || norm === 'cgst' || norm.startsWith('sgst') || norm.startsWith('cgst')) {
      if (stopCol == null || col < stopCol) stopCol = col;
    }
  }
  if (stopCol == null) {
    for (const [norm, col] of normToCol.entries()) {
      if (isTaxOrTotalHeader(norm) && col > invoiceColNum) {
        if (stopCol == null || col < stopCol) stopCol = col;
      }
    }
  }

  const candidateChargeCols = [];
  Object.entries(headersByCol).forEach(([colStr, raw]) => {
    const col = Number(colStr);
    const norm = normHeader(raw);
    if (col <= invoiceColNum) return;
    if (stopCol != null && col >= stopCol) return;
    if (META_HEADERS.has(norm)) return;
    if (isTaxOrTotalHeader(norm)) return;
    if (norm.includes('day')) return;
    candidateChargeCols.push({ col, raw, norm, label: displayLabelForHeader(raw) });
  });

  const sumsByNorm = new Map(candidateChargeCols.map((c) => [c.norm, 0]));
  const parsedRows = [];

  for (let r = headerRowIdx + 1; r < gridRows.length; r++) {
    const row = gridRows[r];
    const invoiceNumber = gridCellText(row, invoiceCol);
    const { unit_number: unitNumber, unit_id_external: unitExternal } = resolveUnit(row);
    if (!invoiceNumber && !unitNumber && !unitExternal) continue;

    const startRaw = gridCell(row, startCol);
    const billingMonth = billingMonthFromCell(startRaw);
    if (!billingMonth) continue;
    const startPeriod = parseDate(startRaw) || billingMonth;

    const charges = {};
    candidateChargeCols.forEach(({ col, norm, label }) => {
      const amt = parseAmount(gridCell(row, col));
      charges[label] = amt;
      sumsByNorm.set(norm, (sumsByNorm.get(norm) || 0) + Math.abs(amt));
    });

    parsedRows.push(enrichFromRaw({
      unit_id_external: unitExternal,
      unit_number: unitNumber,
      invoice_number: invoiceNumber || `${unitNumber || unitExternal}-${billingMonth}`,
      start_period_date: startPeriod,
      end_period_date: endCol ? parseDate(gridCell(row, endCol)) : null,
      invoice_date: invoiceDateCol ? parseDate(gridCell(row, invoiceDateCol)) : null,
      due_date: dueCol ? parseDate(gridCell(row, dueCol)) : null,
      resident_name: residentCol ? gridCellText(row, residentCol) || null : null,
      occupancy_status: occupancyCol ? gridCellText(row, occupancyCol) || null : null,
      billing_month: billingMonth,
      charges,
    }, buildRawRow(row, headersByCol)));
  }

  if (!parsedRows.length) {
    throw new Error('No invoice rows found under the header.');
  }

  const finalized = finalizeRows(parsedRows, candidateChargeCols, sumsByNorm);
  return { ...finalized, fileName: file.name || 'nobroker-invoices.xls' };
}

/**
 * Replace invoices for the billing month(s) in the file, then insert.
 */
export async function applyNoBrokerInvoicesRaisedImport(parsed) {
  const apartmentId = portalState.access?.activeApartmentId;
  if (!apartmentId) throw new Error('No active apartment selected.');
  if (!parsed?.rows?.length) throw new Error('Nothing to import.');

  const months = parsed.billingMonths?.length
    ? parsed.billingMonths
    : [...new Set(parsed.rows.map((r) => r.billing_month))];

  for (const month of months) {
    await mongoDelete(
      'nobroker_invoices_raised',
      { apartment_id: apartmentId, billing_month: month },
      { rehydrate: false },
    );
  }

  const payload = parsed.rows.map((r) => ({
    apartment_id: apartmentId,
    billing_month: r.billing_month,
    unit_id_external: r.unit_id_external,
    unit_number: r.unit_number,
    invoice_number: r.invoice_number,
    start_period_date: r.start_period_date,
    end_period_date: r.end_period_date,
    invoice_date: r.invoice_date,
    due_date: r.due_date,
    resident_name: r.resident_name,
    occupancy_status: r.occupancy_status,
    charges: r.charges,
    raw: r.raw && typeof r.raw === 'object' ? r.raw : {},
    total_raised: r.total_raised,
    source_file: parsed.fileName || null,
  }));

  const chunkSize = 200;
  const inserted = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const result = await mongoInsert('nobroker_invoices_raised', chunk, { rehydrate: false });
    if (Array.isArray(result?.data)) inserted.push(...result.data);
    else inserted.push(...chunk);
  }

  // Refresh Finance-New Mongo state; seed local if needed.
  await pullState({ packs: ['nobroker'] });
  ensureFnClassicShape();
  if (!fnFinances().nobrokerInvoicesRaised?.length && inserted.length) {
    fnFinances().nobrokerInvoicesRaised = inserted;
  } else if (inserted.length) {
    // Prefer DB rows for the months we just wrote.
    const monthSet = new Set(months.map((m) => String(m).slice(0, 10)));
    const keep = (fnFinances().nobrokerInvoicesRaised || [])
      .filter((r) => !monthSet.has(String(r.billing_month || '').slice(0, 10)));
    fnFinances().nobrokerInvoicesRaised = [...inserted, ...keep];
  }

  return {
    importedCount: inserted.length || payload.length,
    billingMonths: months,
    chargeHeads: parsed.chargeHeads,
    totalRaised: (inserted.length ? inserted : payload)
      .reduce((s, r) => s + (parseFloat(r.total_raised) || 0), 0),
  };
}

export const getNoBrokerInvoicesRaised = () =>
  fnFinances()?.nobrokerInvoicesRaised || [];

/**
 * Aggregate charge heads by month for stacked charts.
 * @returns {{ heads: string[], series: Record<string, number[]>, monthTotals: number[] }}
 */
export function buildRaisedInvoicesStack(months, invoices = getNoBrokerInvoicesRaised()) {
  const headTotals = new Map();
  const perMonth = months.map(() => new Map());

  invoices.forEach((inv) => {
    const bm = String(inv.billing_month || '').slice(0, 7);
    const mi = months.findIndex((m) => {
      const key = `${m.y}-${String(m.m + 1).padStart(2, '0')}`;
      return key === bm;
    });
    if (mi < 0) return;

    const charges = inv.charges && typeof inv.charges === 'object' ? inv.charges : {};
    Object.entries(charges).forEach(([head, raw]) => {
      const amt = parseAmount(raw);
      if (Math.abs(amt) < 0.001) return;
      perMonth[mi].set(head, (perMonth[mi].get(head) || 0) + amt);
      headTotals.set(head, (headTotals.get(head) || 0) + Math.abs(amt));
    });
  });

  const preferred = PREFERRED_HEAD_LABELS.filter((h) => (headTotals.get(h) || 0) > 0);
  const extras = [...headTotals.keys()]
    .filter((h) => !PREFERRED_HEAD_LABELS.includes(h))
    .sort((a, b) => (headTotals.get(b) || 0) - (headTotals.get(a) || 0));
  const heads = [...preferred, ...extras];

  const series = {};
  heads.forEach((head) => {
    series[head] = perMonth.map((map) => Math.round((map.get(head) || 0) * 100) / 100);
  });
  const monthTotals = perMonth.map((map) =>
    Math.round([...map.values()].reduce((s, v) => s + v, 0) * 100) / 100,
  );

  return { heads, series, monthTotals };
}
