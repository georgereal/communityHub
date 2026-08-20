/**
 * Spreadsheet table bounds — header row, footer/totals row, column range, absolute row numbers.
 */

import {
    buildMappingFromHeaders,
    colForField,
    normalizeMapping,
} from './ledgerColumnMapping.js';
import { isImportableDate } from './ledgerTransform.js';

const FOOTER_LABEL_RE = /\b(grand\s*)?total(s)?\b|\bsub\s*total\b|\bsum(mary)?\b/i;

export function colLettersToIndex(letters) {
    let n = 0;
    const s = String(letters || '').toUpperCase();
    for (let i = 0; i < s.length; i += 1) {
        n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n - 1;
}

export function colIndexToLetters(index) {
    let n = index;
    let letter = '';
    while (n >= 0) {
        letter = String.fromCharCode((n % 26) + 65) + letter;
        n = Math.floor(n / 26) - 1;
    }
    return letter;
}

/** Parse Graph / Sheets range address → 1-based Excel row/col bounds. */
export function parseRangeAddress(address) {
    const bare = String(address || '').replace(/^[^!]+!/, '');
    const m = bare.match(/^\$?([A-Za-z]+)\$?(\d+)(?::\$?([A-Za-z]+)\$?(\d+))?$/);
    if (!m) return { startRow: 1, endRow: null, startCol: 'A', endCol: 'J' };
    return {
        startCol: m[1].toUpperCase(),
        startRow: parseInt(m[2], 10),
        endCol: (m[3] || m[1]).toUpperCase(),
        endRow: m[4] ? parseInt(m[4], 10) : null,
    };
}

/** Extract column letters from range_a1 like A:J, B8:K500, A. */
export function parseColumnRange(rangeA1 = 'A:J') {
    const s = String(rangeA1 || 'A:J').trim().toUpperCase();
    const m = s.match(/^([A-Z]+)(\d+)?:([A-Z]+)(\d+)?$/);
    if (m) {
        return {
            startCol: m[1],
            endCol: m[3],
            startRowHint: m[2] ? parseInt(m[2], 10) : null,
            endRowHint: m[4] ? parseInt(m[4], 10) : null,
        };
    }
    const single = s.match(/^([A-Z]+)(\d+)?$/);
    if (single) {
        return {
            startCol: single[1],
            endCol: single[1],
            startRowHint: single[2] ? parseInt(single[2], 10) : null,
            endRowHint: null,
        };
    }
    return { startCol: 'A', endCol: 'J', startRowHint: null, endRowHint: null };
}

export function buildDataRangeAddress(rangeA1, headerRow, endRow = null) {
    const cols = parseColumnRange(rangeA1);
    const start = headerRow || cols.startRowHint || 1;
    const end = endRow || cols.endRowHint || Math.max(start + 999, 1000);
    return `${cols.startCol}${start}:${cols.endCol}${end}`;
}

export function scoreHeaderRow(headersRaw) {
    const m = buildMappingFromHeaders(headersRaw);
    return Object.values(m.fields).filter((f) => f.excelCol != null && f.excelCol >= 0).length;
}

/** Find best header row within the first maxScan rows of fetched data. */
export function detectHeaderRowIndex(aoa, maxScan = 30) {
    let best = { index: 0, score: 0, headers: (aoa[0] || []).map((h) => String(h ?? '').trim()) };
    const limit = Math.min(maxScan, aoa?.length || 0);
    for (let i = 0; i < limit; i += 1) {
        const headers = (aoa[i] || []).map((h) => String(h ?? '').trim());
        const score = scoreHeaderRow(headers);
        if (score > best.score) best = { index: i, score, headers };
    }
    return best.score >= 2 ? best : { ...best, index: 0 };
}

function parseAmountLoose(val) {
    if (val == null || val === '') return 0;
    const n = parseFloat(String(val).replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function cellStr(val) {
    return String(val ?? '').trim();
}

function cellLooksLikeFooterLabel(val) {
    const s = cellStr(val);
    return s.length > 0 && FOOTER_LABEL_RE.test(s);
}

/** Heuristic: totals / summary row below the data table. */
export function looksLikeFooterRow(row, mapping) {
    if (!row?.length) return false;
    const cells = row.map((c) => cellStr(c));
    const joined = cells.join(' ').toLowerCase();
    if (FOOTER_LABEL_RE.test(joined)) return true;
    if (cells.some(cellLooksLikeFooterLabel)) return true;

    const m = normalizeMapping(mapping);
    const dateCol = colForField(m, 'date');
    const dateVal = dateCol >= 0 ? cells[dateCol] : '';
    if (cellLooksLikeFooterLabel(dateVal)) return true;

    const amountCol = colForField(m, 'amount');
    const drCol = colForField(m, 'debit_dr');
    const crCol = colForField(m, 'credit_cr');
    const hasAmount = [amountCol, drCol, crCol].some((c) => c >= 0 && parseAmountLoose(row[c]) > 0);

    if (dateVal && isImportableDate(dateVal)) return false;
    if (dateVal && !isImportableDate(dateVal) && hasAmount) return true;

    const hasLabel = row.slice(0, 3).some((c) => cellStr(c).length > 0);
    return hasAmount && hasLabel;
}

export function detectFooterRowIndex(aoa, dataStartIndex, mapping) {
    if (!aoa?.length || dataStartIndex >= aoa.length) return null;
    for (let i = aoa.length - 1; i >= dataStartIndex; i -= 1) {
        if (looksLikeFooterRow(aoa[i], mapping)) return i;
    }
    return null;
}

function boundsFromRows(aoa, rangeStartRow, headerRowOffset, footerRowOffset, headersRaw, settings, rangeMeta) {
    const headerRow = rangeStartRow + headerRowOffset;
    const footerRow = footerRowOffset != null ? rangeStartRow + footerRowOffset : null;
    return {
        rangeStartRow,
        headerRowOffset,
        headerRow,
        headersRaw,
        dataStartIndex: headerRowOffset + 1,
        footerRowOffset,
        footerRow,
        rangeStartCol: rangeMeta.startCol || parseColumnRange(settings?.range_a1).startCol,
        rangeEndCol: rangeMeta.endCol || parseColumnRange(settings?.range_a1).endCol,
    };
}

/** 0-based aoa index → 1-based Excel row number (matches row labels in the sheet). */
export function aoaIndexToExcelRow(bounds, aoaIndex) {
    return (bounds?.rangeStartRow ?? 1) + aoaIndex;
}

/** True when excelRow is a data row (strictly between header and footer). */
export function isExcelRowInsideTable(bounds, excelRow) {
    if (!bounds) return true;
    if (bounds.headerRow != null && excelRow <= bounds.headerRow) return false;
    if (bounds.footerRow != null && excelRow >= bounds.footerRow) return false;
    return true;
}

/** True when excelRow is a data row (strictly between header and footer). */
export function isInsideDataTable(bounds, aoaIndex) {
    return isExcelRowInsideTable(bounds, aoaIndexToExcelRow(bounds, aoaIndex));
}

/** True when this aoa row is outside the table (above header, footer, or below footer). */
export function isOutsideDataTable(bounds, aoaIndex, row, mapping) {
    return skipReasonForRow(bounds, aoaIndex, row, mapping) != null;
}

/** Human-readable reason a row is skipped, or null if it is inside the data table. */
export function skipReasonForRow(bounds, aoaIndex, row, mapping) {
    const excelRow = aoaIndexToExcelRow(bounds, aoaIndex);
    if (bounds?.headerRow != null && excelRow <= bounds.headerRow) {
        return excelRow === bounds.headerRow ? 'header row' : 'above table';
    }
    if (bounds?.footerRow != null && excelRow >= bounds.footerRow) {
        return excelRow === bounds.footerRow ? 'totals row' : 'below table';
    }
    if (row?.length && looksLikeFooterRow(row, mapping)) return 'looks like totals';
    return null;
}

/**
 * Before each sync: auto-detect header/footer, compare with saved settings, update when needed.
 * Never blocks sync — returns warnings for last_sync_message when bounds shift or detection is weak.
 */
export function reconcileSheetBoundsForSync(aoa, settings = {}, rangeMeta = {}) {
    const rangeStartRow = rangeMeta.startRow ?? 1;
    const mapping = settings?.column_mapping || null;
    const warnings = [];
    const settingsPatch = {};

    const det = detectHeaderRowIndex(aoa);
    const detectedHeaderOffset = det.index;
    const detectedHeaderRow = rangeStartRow + detectedHeaderOffset;

    const savedHeader = settings?.header_row ?? null;
    let headerRowOffset = detectedHeaderOffset;
    let headersRaw = det.headers;

    if (savedHeader != null && savedHeader >= rangeStartRow) {
        const savedOffset = savedHeader - rangeStartRow;
        const savedHeaders = (aoa[savedOffset] || []).map((h) => String(h ?? '').trim());
        const savedScore = scoreHeaderRow(savedHeaders);

        if (savedHeader === detectedHeaderRow) {
            headerRowOffset = savedOffset;
            headersRaw = savedHeaders;
        } else if (savedScore >= 2 && savedScore >= det.score) {
            headerRowOffset = savedOffset;
            headersRaw = savedHeaders;
            warnings.push(`Header kept at row ${savedHeader} (also saw candidates at row ${detectedHeaderRow})`);
        } else if (det.score >= 2) {
            headerRowOffset = detectedHeaderOffset;
            headersRaw = det.headers;
            settingsPatch.header_row = detectedHeaderRow;
            if (savedHeader !== detectedHeaderRow) {
                warnings.push(`Header row auto-updated ${savedHeader} → ${detectedHeaderRow}`);
            }
        } else {
            headerRowOffset = savedOffset;
            headersRaw = savedHeaders;
            warnings.push(`Weak header detection (score ${det.score}) — kept saved row ${savedHeader}`);
        }
    } else if (det.score >= 2) {
        settingsPatch.header_row = detectedHeaderRow;
    } else {
        warnings.push(`Weak header detection (score ${det.score}) — review column mapping`);
    }

    const dataStartIndex = headerRowOffset + 1;
    const detectedFooterOffset = detectFooterRowIndex(aoa, dataStartIndex, mapping);
    const detectedFooterRow = detectedFooterOffset != null ? rangeStartRow + detectedFooterOffset : null;
    const savedFooter = settings?.footer_row ?? null;

    let footerRowOffset = detectedFooterOffset;
    if (savedFooter != null && savedFooter > rangeStartRow + headerRowOffset) {
        const savedFooterOffset = savedFooter - rangeStartRow;
        const savedInRange = savedFooterOffset < (aoa?.length || 0);
        const savedLooksFooter = savedInRange && looksLikeFooterRow(aoa[savedFooterOffset], mapping);

        if (detectedFooterRow === savedFooter) {
            footerRowOffset = savedFooterOffset;
        } else if (detectedFooterRow != null) {
            footerRowOffset = detectedFooterOffset;
            settingsPatch.footer_row = detectedFooterRow;
            if (savedFooter !== detectedFooterRow) {
                warnings.push(`Totals row auto-updated ${savedFooter} → ${detectedFooterRow}`);
            }
        } else if (savedInRange) {
            footerRowOffset = savedFooterOffset;
            warnings.push(savedLooksFooter
                ? `Totals kept at row ${savedFooter} (not re-detected)`
                : `Totals kept at saved row ${savedFooter}`);
        } else {
            footerRowOffset = null;
            settingsPatch.footer_row = null;
            warnings.push(`Saved totals row ${savedFooter} is outside fetched range`);
        }
    } else if (detectedFooterRow != null) {
        settingsPatch.footer_row = detectedFooterRow;
    }

    if (footerRowOffset == null && aoa.length > dataStartIndex) {
        const lastIdx = aoa.length - 1;
        if (looksLikeFooterRow(aoa[lastIdx], mapping)) {
            footerRowOffset = lastIdx;
            const autoFooterRow = rangeStartRow + lastIdx;
            if (settingsPatch.footer_row == null) settingsPatch.footer_row = autoFooterRow;
            warnings.push(`Totals row detected at row ${autoFooterRow}`);
        }
    }

    const bounds = boundsFromRows(
        aoa, rangeStartRow, headerRowOffset, footerRowOffset, headersRaw, settings, rangeMeta,
    );

    return {
        bounds,
        settingsPatch,
        warnings,
        headerScore: det.score,
        boundsChanged: Object.keys(settingsPatch).length > 0,
    };
}

/**
 * Resolve table bounds from fetched aoa + saved settings (manual / load-columns path).
 */
export function resolveSheetBounds(aoa, settings = {}, rangeMeta = {}) {
    return reconcileSheetBoundsForSync(aoa, settings, rangeMeta).bounds;
}

/** Wide column range from row 1 — used for background sync so header/footer can move. */
export function buildSyncFetchRange(rangeA1 = 'A:J') {
    const cols = parseColumnRange(rangeA1);
    return `${cols.startCol}1:${cols.endCol}1000`;
}

/** Count aoa rows strictly between header and footer (candidate data rows). */
export function dataRowsFromAoa(aoa, bounds) {
    let count = 0;
    for (let i = 0; i < (aoa?.length || 0); i += 1) {
        if (isInsideDataTable(bounds, i)) count += 1;
    }
    return { aoa, count };
}
