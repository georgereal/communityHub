import { reconcileExcelRows, syncMetaFromRow } from './ledgerSyncImport.js';
import { buildDbSyncPayload, buildImportTxnPayload } from './ledgerColumnMapping.js';

/** Run reconciled import actions against Supabase. */
export async function executeImportActions(supabase, apartment_id, actions, columnMapping) {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const conflicts = [];

    for (const act of actions) {
        if (act.action === 'skip') {
            skipped += 1;
            continue;
        }

        if (act.action === 'backfill') {
            const meta = syncMetaFromRow(act.row, act.db.external_sync_key || undefined);
            const { error } = await supabase.from('transactions').update({
                sync_anchor_hash: meta.sync_anchor_hash,
                excel_row_index: meta.excel_row_index,
                updated_at: new Date().toISOString(),
            }).eq('id', act.db.id);
            if (error) throw new Error(error.message);
            skipped += 1;
            continue;
        }

        if (act.action === 'conflict') {
            conflicts.push({ type: 'UPDATE_CONFLICT', existing: act.db, incoming: act.row });
            continue;
        }

        if (act.action === 'deleted_in_app') {
            conflicts.push({ type: 'DELETED_IN_APP', incoming: act.row });
            continue;
        }

        if (act.action === 'deleted_in_excel') {
            conflicts.push({ type: 'DELETED_IN_EXCEL', existing: act.db });
            continue;
        }

        if (act.action === 'insert') {
            const meta = syncMetaFromRow(act.row);
            const { error } = await supabase.from('transactions').insert({
                id: crypto.randomUUID(),
                apartment_id,
                ...buildImportTxnPayload(act.row, columnMapping),
                ...meta,
            });
            if (error) throw new Error(`Import row ${act.row.row_index}: ${error.message}`);
            imported += 1;
            continue;
        }

        if (act.action === 'update') {
            const meta = syncMetaFromRow(act.row, act.db.external_sync_key || undefined);
            const { error } = await supabase.from('transactions').update({
                ...buildDbSyncPayload(act.row, columnMapping),
                ...meta,
                updated_at: new Date().toISOString(),
            }).eq('id', act.db.id);
            if (error) throw new Error(`Update row ${act.row.row_index}: ${error.message}`);
            updated += 1;
        }
    }

    return { imported, updated, skipped, conflicts };
}

export async function importExcelRows(supabase, apartment_id, excelRows, dbTxns, columnMapping, { last_sync_at = null } = {}) {
    const actions = reconcileExcelRows(excelRows, dbTxns, { last_sync_at, columnMapping });
    const result = await executeImportActions(supabase, apartment_id, actions, columnMapping);
    return { ...result, actions };
}
