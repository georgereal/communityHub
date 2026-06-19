/**
 * Excel → DB reconciliation using DB-only hashes (nothing stored in Excel).
 *
 * Phase 1 — exact sync_hash match → skip (backfill excel_row_index if row moved)
 * Phase 2 — unique anchor_hash among leftovers → update (content changed in Excel)
 * Phase 2b — one Excel row, multiple DB rows same anchor → update one, delete duplicate DB rows
 * Phase 3 — remaining Excel rows → insert
 * Phase 4 — remaining Excel-sourced DB rows → delete
 *
 * Row position (excel_row_index) is metadata only — never used to pair rows.
 */

import { computeAnchorHash } from './ledgerColumnMapping.js';

export function newExcelRowId() {
    return `xls:${crypto.randomUUID()}`;
}

function dbAnchorHash(txn, columnMapping) {
    return txn.sync_anchor_hash || (columnMapping ? computeAnchorHash(txn, columnMapping) : null);
}

function needsMetaBackfill(txn, row) {
    return txn.excel_row_index == null || txn.excel_row_index !== row.row_index;
}

function isExcelSourced(txn) {
    return txn.external_sync_key?.startsWith('xls:') || txn.sync_hash != null;
}

export function syncMetaFromRow(row, existingKey = null) {
    return {
        external_sync_key: existingKey || newExcelRowId(),
        sync_hash: row.sync_hash,
        sync_anchor_hash: row.sync_anchor_hash,
        excel_row_index: row.row_index,
    };
}

function buildAnchorBuckets(excel, db, columnMapping) {
    const buckets = new Map();
    const add = (key, kind, entry) => {
        if (!key) return;
        if (!buckets.has(key)) buckets.set(key, { excel: [], db: [] });
        buckets.get(key)[kind].push(entry);
    };
    for (const e of excel) {
        if (!e.used && e.row.sync_anchor_hash) add(e.row.sync_anchor_hash, 'excel', e);
    }
    for (const d of db) {
        if (!d.used) add(dbAnchorHash(d.txn, columnMapping), 'db', d);
    }
    return buckets;
}

export function reconcileExcelRows(excelRows, dbTxns, { columnMapping = null } = {}) {
    const actions = [];
    const excel = (excelRows || []).map((row) => ({ row, used: false }));
    const db = (dbTxns || []).map((txn) => ({ txn, used: false }));

    const useExcel = (entry) => { entry.used = true; };
    const useDb = (entry) => { entry.used = true; };

    // Phase 1 — unchanged content (hash match)
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

    const anchorBuckets = buildAnchorBuckets(excel, db, columnMapping);

    // Phase 2 — unique anchor match (hash changed, identity unchanged)
    for (const [, bucket] of anchorBuckets) {
        const unmatchedExcel = bucket.excel.filter((e) => !e.used);
        const unmatchedDb = bucket.db.filter((d) => !d.used);
        if (unmatchedExcel.length !== 1 || unmatchedDb.length !== 1) continue;
        const e = unmatchedExcel[0];
        const d = unmatchedDb[0];
        useExcel(e);
        useDb(d);
        actions.push({ action: 'update', row: e.row, db: d.txn, reason: 'anchor' });
    }

    // Phase 2b — one Excel row, duplicate DB rows (e.g. after bad sync) → keep one, drop rest
    for (const [, bucket] of anchorBuckets) {
        const unmatchedExcel = bucket.excel.filter((e) => !e.used);
        const unmatchedDb = bucket.db.filter((d) => !d.used);
        if (unmatchedExcel.length !== 1 || unmatchedDb.length <= 1) continue;
        const e = unmatchedExcel[0];
        const sortedDb = [...unmatchedDb].sort((a, b) => {
            const aHit = a.txn.excel_row_index === e.row.row_index ? 0 : 1;
            const bHit = b.txn.excel_row_index === e.row.row_index ? 0 : 1;
            return aHit - bHit;
        });
        const keeper = sortedDb[0];
        useExcel(e);
        useDb(keeper);
        actions.push({ action: 'update', row: e.row, db: keeper.txn, reason: 'dedupe_anchor' });
        for (const extra of sortedDb.slice(1)) {
            useDb(extra);
            actions.push({ action: 'delete', db: extra.txn, reason: 'duplicate_anchor' });
        }
    }

    // Legacy app:txn reference still in Excel Sync ID column
    for (const e of excel) {
        if (e.used) continue;
        if (e.row.excel_app_ref) {
            useExcel(e);
            actions.push({ action: 'deleted_in_app', row: e.row });
        }
    }

    // Phase 3 — new Excel rows
    for (const e of excel) {
        if (e.used) continue;
        useExcel(e);
        actions.push({ action: 'insert', row: e.row });
    }

    // Phase 4 — Excel-sourced DB rows no longer in sheet
    for (const d of db) {
        if (d.used) continue;
        if (isExcelSourced(d.txn)) {
            actions.push({ action: 'delete', db: d.txn, reason: 'missing_in_excel' });
        }
    }

    return actions;
}
