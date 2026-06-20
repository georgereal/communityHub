import { reconcileExcelRows, syncMetaFromRow } from './ledgerSyncImport.js';
import { buildDbSyncPayload, buildImportTxnPayload } from './ledgerColumnMapping.js';
import { isImportableDate } from './ledgerTransform.js';
import { snapshotTxn } from './ledgerSyncJournal.js';
import { syncLog } from './ledgerSyncLog.js';

function payloadHasImportableDate(payload) {
    return payload?.date != null && isImportableDate(payload.date);
}

/** Run reconciled import actions against Supabase. */
export async function executeImportActions(supabase, apartment_id, actions, columnMapping, journal = null) {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let deleted = 0;
    const conflicts = [];

    for (const act of actions) {
        const excelRow = act.row?.row_index;
        if (act.action === 'skip') {
            syncLog('db', `Excel row ${excelRow}: skip (unchanged)`);
            skipped += 1;
            continue;
        }

        if (act.action === 'backfill') {
            syncLog('db', `Excel row ${excelRow}: backfill row index`);
            const before = snapshotTxn(act.db);
            const meta = syncMetaFromRow(act.row, act.db.external_sync_key || undefined);
            const { error } = await supabase.from('transactions').update({
                sync_anchor_hash: meta.sync_anchor_hash,
                excel_row_index: meta.excel_row_index,
            }).eq('id', act.db.id);
            if (error) throw new Error(error.message);
            if (journal?.enabled) {
                const { data: afterRow } = await supabase.from('transactions').select('*').eq('id', act.db.id).maybeSingle();
                await journal.logChange({
                    action: 'update',
                    transaction_id: act.db.id,
                    before,
                    after: afterRow,
                });
            }
            skipped += 1;
            continue;
        }

        if (act.action === 'conflict') {
            syncLog('warn', `Excel row ${excelRow}: update conflict`);
            conflicts.push({ type: 'UPDATE_CONFLICT', existing: act.db, incoming: act.row });
            continue;
        }

        if (act.action === 'deleted_in_app') {
            syncLog('warn', `Excel row ${excelRow}: deleted in app`);
            conflicts.push({ type: 'DELETED_IN_APP', incoming: act.row });
            continue;
        }

        if (act.action === 'delete') {
            syncLog('db', `DB delete txn ${act.db.id} (Excel row ${act.db.excel_row_index ?? '?'})`);
            const before = snapshotTxn(act.db);
            const { error } = await supabase.from('transactions').delete().eq('id', act.db.id);
            if (error) throw new Error(`Delete txn ${act.db.id}: ${error.message}`);
            if (journal?.enabled) {
                await journal.logChange({
                    action: 'delete',
                    transaction_id: act.db.id,
                    before,
                    after: null,
                });
            }
            deleted += 1;
            continue;
        }

        if (act.action === 'insert') {
            const payload = buildImportTxnPayload(act.row, columnMapping);
            if (!payloadHasImportableDate(payload)) {
                syncLog('warn', `Excel row ${excelRow}: blocked insert — invalid date ${JSON.stringify(payload.date ?? act.row?.date)}`);
                skipped += 1;
                continue;
            }
            const id = crypto.randomUUID();
            const meta = syncMetaFromRow(act.row);
            const insertPayload = {
                id,
                apartment_id,
                ...payload,
                ...meta,
            };
            syncLog('db', `Excel row ${excelRow}: insert`, { date: insertPayload.date, amount: insertPayload.amount, type: insertPayload.type });
            const { error } = await supabase.from('transactions').insert(insertPayload);
            if (error) {
                syncLog('error', `Excel row ${excelRow}: insert failed — ${error.message}`);
                throw new Error(`Import Excel row ${excelRow}: ${error.message}`);
            }
            if (journal?.enabled) {
                await journal.logChange({
                    action: 'insert',
                    transaction_id: id,
                    before: null,
                    after: insertPayload,
                });
            }
            imported += 1;
            continue;
        }

        if (act.action === 'update') {
            const updatePayload = buildDbSyncPayload(act.row, columnMapping);
            if (!payloadHasImportableDate({ ...act.row, ...updatePayload })) {
                syncLog('warn', `Excel row ${excelRow}: blocked update — invalid date ${JSON.stringify(act.row?.date)}`);
                skipped += 1;
                continue;
            }
            const before = snapshotTxn(act.db);
            const meta = syncMetaFromRow(act.row, act.db.external_sync_key || undefined);
            const dbPayload = { ...updatePayload, ...meta };
            syncLog('db', `Excel row ${excelRow}: update txn ${act.db.id}`, { date: dbPayload.date, amount: dbPayload.amount });
            const { error } = await supabase.from('transactions').update(dbPayload).eq('id', act.db.id);
            if (error) throw new Error(`Update Excel row ${excelRow}: ${error.message}`);
            if (journal?.enabled) {
                const { data: afterRow } = await supabase.from('transactions').select('*').eq('id', act.db.id).maybeSingle();
                await journal.logChange({
                    action: 'update',
                    transaction_id: act.db.id,
                    before,
                    after: afterRow,
                });
            }
            updated += 1;
        }
    }

    return { imported, updated, skipped, deleted, conflicts };
}

function isImportableExcelRow(row) {
    return row && isImportableDate(row.date) && row.type && row.amount > 0;
}

export async function importExcelRows(supabase, apartment_id, excelRows, dbTxns, columnMapping, { journal = null } = {}) {
    const allRows = excelRows || [];
    const validRows = allRows.filter(isImportableExcelRow);
    const dropped = allRows.length - validRows.length;
    if (dropped > 0) {
        syncLog('warn', `Dropped ${dropped} row(s) with invalid date, type, or amount before DB import`);
        allRows.filter((r) => !isImportableExcelRow(r)).forEach((r) => {
            syncLog('skip', `Excel row ${r.row_index ?? '?'}: rejected before import`, {
                date: r.date ?? null, type: r.type ?? null, amount: r.amount ?? null,
            });
        });
    }
    syncLog('info', `Reconcile ${validRows.length} Excel row(s) vs ${dbTxns?.length ?? 0} DB txn(s)`);
    const actions = reconcileExcelRows(validRows, dbTxns, { columnMapping });
    syncLog('info', `Reconciled to ${actions.length} action(s)`, {
        insert: actions.filter((a) => a.action === 'insert').length,
        update: actions.filter((a) => a.action === 'update').length,
        skip: actions.filter((a) => a.action === 'skip').length,
        delete: actions.filter((a) => a.action === 'delete').length,
    });
    const result = await executeImportActions(supabase, apartment_id, actions, columnMapping, journal);
    return { ...result, actions };
}
