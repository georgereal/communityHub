/**
 * Excel → DB reconciliation using DB-only hashes (nothing stored in Excel).
 *
 * sync_hash        — all mapped sync columns; unchanged → skip
 * sync_anchor_hash — pre-selected identity columns; match → same transaction (update)
 * excel_row_index  — last known Excel row number; same position + changed hash → in-place edit
 */

import { computeAnchorHash, computeSyncHash } from './ledgerColumnMapping.js';

export function newExcelRowId() {
    return `xls:${crypto.randomUUID()}`;
}

function isLocallyChanged(txn, columnMapping) {
    if (!txn?.sync_hash || !columnMapping) return false;
    return computeSyncHash(txn, columnMapping) !== txn.sync_hash;
}

function dbAnchorHash(txn, columnMapping) {
    return txn.sync_anchor_hash || (columnMapping ? computeAnchorHash(txn, columnMapping) : null);
}

function needsMetaBackfill(txn, row) {
    return !txn.sync_anchor_hash || txn.excel_row_index == null || txn.excel_row_index !== row.row_index;
}

export function syncMetaFromRow(row, existingKey = null) {
    return {
        external_sync_key: existingKey || newExcelRowId(),
        sync_hash: row.sync_hash,
        sync_anchor_hash: row.sync_anchor_hash,
        excel_row_index: row.row_index,
    };
}

/**
 * Match Excel rows to DB transactions without reading IDs from the sheet.
 *
 * Pass order:
 *  1. Exact sync_hash → skip (optionally reindex if row moved)
 *  2. Unique sync_anchor_hash → update (handles row moves + non-anchor edits)
 *  3. Same excel_row_index → update (in-place edit when anchor columns changed)
 *  4. Remaining Excel → insert
 *  5. Unmatched excel-sourced DB → deleted_in_excel
 */
export function reconcileExcelRows(excelRows, dbTxns, { last_sync_at = null, columnMapping = null } = {}) {
    const actions = [];
    const excel = (excelRows || []).map((row) => ({ row, used: false }));
    const db = (dbTxns || []).map((txn) => ({ txn, used: false }));

    const useExcel = (entry) => { entry.used = true; };
    const useDb = (entry) => { entry.used = true; };

    // 1. Unchanged content
    for (const e of excel) {
        if (e.used) continue;
        const match = db.find((d) => !d.used && d.txn.sync_hash && d.txn.sync_hash === e.row.sync_hash);
        if (!match) continue;
        useExcel(e);
        useDb(match);
        if (needsMetaBackfill(match.txn, e.row)) {
            actions.push({ action: 'backfill', row: e.row, db: match.txn });
        } else {
            actions.push({ action: 'skip', row: e.row, db: match.txn });
        }
    }

    // 2. Unique anchor match
    const anchorBuckets = new Map();
    for (const e of excel) {
        if (e.used || !e.row.sync_anchor_hash) continue;
        const k = e.row.sync_anchor_hash;
        if (!anchorBuckets.has(k)) anchorBuckets.set(k, { excel: [], db: [] });
        anchorBuckets.get(k).excel.push(e);
    }
    for (const d of db) {
        if (d.used) continue;
        const k = dbAnchorHash(d.txn, columnMapping);
        if (!k) continue;
        if (!anchorBuckets.has(k)) anchorBuckets.set(k, { excel: [], db: [] });
        anchorBuckets.get(k).db.push(d);
    }
    for (const [, bucket] of anchorBuckets) {
        if (bucket.excel.length !== 1 || bucket.db.length !== 1) continue;
        const e = bucket.excel[0];
        const d = bucket.db[0];
        if (e.used || d.used) continue;
        useExcel(e);
        useDb(d);
        if (isLocallyChanged(d.txn, columnMapping)) {
            actions.push({ action: 'conflict', row: e.row, db: d.txn, reason: 'anchor' });
        } else {
            actions.push({ action: 'update', row: e.row, db: d.txn, reason: 'anchor' });
        }
    }

    // 3. Same Excel row position (edited in place; anchor may have changed)
    for (const e of excel) {
        if (e.used) continue;
        const match = db.find((d) => !d.used && d.txn.excel_row_index === e.row.row_index);
        if (!match) continue;
        useExcel(e);
        useDb(match);
        if (isLocallyChanged(match.txn, columnMapping)) {
            actions.push({ action: 'conflict', row: e.row, db: match.txn, reason: 'position' });
        } else {
            actions.push({ action: 'update', row: e.row, db: match.txn, reason: 'position' });
        }
    }

    // 4. Legacy app:txn reference still in Excel Sync ID column
    for (const e of excel) {
        if (e.used) continue;
        if (e.row.excel_app_ref) {
            useExcel(e);
            actions.push({ action: 'deleted_in_app', row: e.row });
        }
    }

    // 5. New Excel rows
    for (const e of excel) {
        if (e.used) continue;
        useExcel(e);
        actions.push({ action: 'insert', row: e.row });
    }

    // 6. Excel-sourced DB rows no longer in sheet
    for (const d of db) {
        if (d.used) continue;
        const t = d.txn;
        if (t.external_sync_key?.startsWith('xls:') || t.excel_row_index != null) {
            actions.push({ action: 'deleted_in_excel', db: t });
        }
    }

    return actions;
}
