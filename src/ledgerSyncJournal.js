/**
 * Sync run journal — log reversible DB changes per sync for rollback.
 */

const SYNC_FIELDS = ['external_sync_key', 'sync_hash', 'sync_anchor_hash', 'excel_row_index'];

export function snapshotTxn(txn) {
    if (!txn) return null;
    return JSON.parse(JSON.stringify(txn));
}

function syncFieldsMatch(current, snapshot) {
    if (!current || !snapshot) return false;
    return SYNC_FIELDS.every((k) => (current[k] ?? null) === (snapshot[k] ?? null));
}

function txnContentMatches(current, snapshot) {
    if (!current || !snapshot) return false;
    if (snapshot.sync_hash && current.sync_hash === snapshot.sync_hash) return true;
    return current.date === snapshot.date
        && current.type === snapshot.type
        && Number(current.amount) === Number(snapshot.amount)
        && (current.description || '') === (snapshot.description || '');
}

/** @returns {Promise<import('./ledgerSyncJournal.js').SyncRunJournal>} */
export async function createSyncRunJournal(supabase, apartment_id, { bounds = null, created_by = null } = {}) {
    const noop = {
        runId: null,
        enabled: false,
        async logChange() {},
        async complete() {},
        async fail() {},
    };

    if (!supabase || !apartment_id) return noop;

    const runId = crypto.randomUUID();
    const { error } = await supabase.from('ledger_sync_runs').insert({
        id: runId,
        apartment_id,
        status: 'running',
        bounds_snapshot: bounds ? {
            header_row: bounds.headerRow ?? null,
            footer_row: bounds.footerRow ?? null,
        } : null,
        created_by,
    });

    if (error) {
        if (/ledger_sync_runs/i.test(error.message)) {
            console.warn('[sync journal] ledger_sync_runs missing — run supabase_ledger_sync_journal.sql');
            return noop;
        }
        throw new Error(error.message);
    }

    let seq = 0;

    return {
        runId,
        enabled: true,

        async logChange({ action, transaction_id, before, after }) {
            seq += 1;
            const { error: logErr } = await supabase.from('ledger_sync_run_changes').insert({
                id: crypto.randomUUID(),
                run_id: runId,
                seq,
                action,
                transaction_id,
                before_data: before ?? null,
                after_data: after ?? null,
            });
            if (logErr) throw new Error(logErr.message);
        },

        async complete({
            imported = 0,
            updated = 0,
            deleted = 0,
            skipped = 0,
            pushed = 0,
            status = 'OK',
            message = null,
            bounds = null,
        } = {}) {
            const patch = {
                completed_at: new Date().toISOString(),
                status,
                imported,
                updated,
                deleted,
                skipped,
                pushed,
                message,
            };
            if (bounds) {
                patch.bounds_snapshot = {
                    header_row: bounds.headerRow ?? null,
                    footer_row: bounds.footerRow ?? null,
                };
            }
            const { error: updErr } = await supabase.from('ledger_sync_runs').update(patch).eq('id', runId);
            if (updErr) throw new Error(updErr.message);

            await supabase.from('ledger_sync_settings').update({
                last_sync_run_id: runId,
            }).eq('apartment_id', apartment_id);
        },

        async fail(message) {
            await supabase.from('ledger_sync_runs').update({
                completed_at: new Date().toISOString(),
                status: 'FAILED',
                message: message || 'Sync failed',
            }).eq('id', runId);
        },
    };
}

export async function fetchLastRollbackableRun(supabase, apartment_id) {
    if (!supabase || !apartment_id) return null;
    const { data, error } = await supabase
        .from('ledger_sync_runs')
        .select('id, completed_at, status, imported, updated, deleted, pushed, skipped, message')
        .eq('apartment_id', apartment_id)
        .in('status', ['OK', 'WARN'])
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        if (/ledger_sync_runs/i.test(error.message)) return null;
        throw new Error(error.message);
    }
    return data;
}

export async function fetchSyncRunChangeSummary(supabase, runId) {
    const { data, error } = await supabase
        .from('ledger_sync_run_changes')
        .select('action')
        .eq('run_id', runId);
    if (error) throw new Error(error.message);
    const counts = { insert: 0, update: 0, delete: 0, push_mark: 0 };
    for (const row of data || []) {
        if (counts[row.action] != null) counts[row.action] += 1;
    }
    return counts;
}

/**
 * Reverse all changes from a sync run (newest change first).
 * Skips rows that were edited after the sync (no longer match after_data).
 */
export async function rollbackSyncRun(supabase, runId) {
    const { data: run, error: runErr } = await supabase
        .from('ledger_sync_runs')
        .select('*')
        .eq('id', runId)
        .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    if (!run) throw new Error('Sync run not found.');
    if (run.status === 'ROLLED_BACK') throw new Error('This sync run was already rolled back.');
    if (run.status === 'running' || run.status === 'FAILED') {
        throw new Error('Only completed sync runs can be rolled back.');
    }

    const { data: changes, error: chErr } = await supabase
        .from('ledger_sync_run_changes')
        .select('*')
        .eq('run_id', runId)
        .order('seq', { ascending: false });
    if (chErr) throw new Error(chErr.message);

    const result = { reverted: 0, skipped: 0, errors: [] };

    for (const ch of changes || []) {
        const { data: current } = await supabase
            .from('transactions')
            .select('*')
            .eq('id', ch.transaction_id)
            .maybeSingle();

        try {
            if (ch.action === 'insert') {
                if (!current) {
                    result.skipped += 1;
                    continue;
                }
                if (!txnContentMatches(current, ch.after_data)) {
                    result.skipped += 1;
                    result.errors.push(`Insert ${ch.transaction_id}: row was edited — skipped`);
                    continue;
                }
                const { error } = await supabase.from('transactions').delete().eq('id', ch.transaction_id);
                if (error) throw error;
                result.reverted += 1;
            } else if (ch.action === 'update') {
                if (!current) {
                    result.skipped += 1;
                    result.errors.push(`Update ${ch.transaction_id}: row missing — skipped`);
                    continue;
                }
                if (ch.after_data?.sync_hash && current.sync_hash !== ch.after_data.sync_hash) {
                    result.skipped += 1;
                    result.errors.push(`Update ${ch.transaction_id}: row changed since sync — skipped`);
                    continue;
                }
                const restore = { ...(ch.before_data || {}) };
                delete restore.id;
                const { error } = await supabase.from('transactions').update(restore).eq('id', ch.transaction_id);
                if (error) throw error;
                result.reverted += 1;
            } else if (ch.action === 'delete') {
                if (current) {
                    result.skipped += 1;
                    result.errors.push(`Delete ${ch.transaction_id}: row already exists — skipped`);
                    continue;
                }
                const row = ch.before_data;
                if (!row?.id) {
                    result.skipped += 1;
                    continue;
                }
                const { error } = await supabase.from('transactions').insert(row);
                if (error) throw error;
                result.reverted += 1;
            } else if (ch.action === 'push_mark') {
                if (!current) {
                    result.skipped += 1;
                    continue;
                }
                if (!syncFieldsMatch(current, ch.after_data)) {
                    result.skipped += 1;
                    result.errors.push(`Push ${ch.transaction_id}: sync fields changed — skipped`);
                    continue;
                }
                const before = ch.before_data || {};
                const { error } = await supabase.from('transactions').update({
                    external_sync_key: before.external_sync_key ?? null,
                    sync_hash: before.sync_hash ?? null,
                    sync_anchor_hash: before.sync_anchor_hash ?? null,
                    excel_row_index: before.excel_row_index ?? null,
                }).eq('id', ch.transaction_id);
                if (error) throw error;
                result.reverted += 1;
            }
        } catch (e) {
            result.errors.push(`${ch.action} ${ch.transaction_id}: ${e.message}`);
        }
    }

    await supabase.from('ledger_sync_runs').update({
        status: 'ROLLED_BACK',
        rolled_back_at: new Date().toISOString(),
        message: `${run.message || ''} [Rolled back: ${result.reverted} reverted, ${result.skipped} skipped]`.trim(),
    }).eq('id', runId);

    return result;
}

/** Log a push_mark change after Excel push updates sync fields on a txn. */
export async function journalPushMark(journal, txnBefore, txnAfter) {
    if (!journal?.enabled || !txnBefore?.id) return;
    await journal.logChange({
        action: 'push_mark',
        transaction_id: txnBefore.id,
        before: snapshotTxn(txnBefore),
        after: snapshotTxn(txnAfter),
    });
}
