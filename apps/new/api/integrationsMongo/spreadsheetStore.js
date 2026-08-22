/**
 * Ledger spreadsheet sync — Mongo stores (Integrations domain).
 * Migrated from Supabase ledger_sync_* / user_oauth_connections (*_temp preferred).
 */
import { getMongoDb } from '../../../../packages/server/mongoClient.js';
import { badRequest } from './errors.js';
import { ensureIntegrationsIndexes } from './indexes.js';

export const COL_SETTINGS = 'ledger_sync_settings';
export const COL_OAUTH_APPS = 'ledger_sync_oauth_apps';
export const COL_USER_OAUTH = 'user_oauth_connections';
export const COL_SERVICE_ACCOUNTS = 'ledger_sync_service_accounts';
export const COL_RUNS = 'ledger_sync_runs';

const SCHEMA = 'integrations_spreadsheet_v1';
const nowIso = () => new Date().toISOString();

function publicOAuthApp(doc) {
    if (!doc) return null;
    return {
        id: doc.id,
        apartment_id: doc.apartment_id,
        provider: doc.provider,
        client_id: doc.client_id || '',
        tenant_id: doc.tenant_id || 'common',
        redirect_uri: doc.redirect_uri || null,
        enabled: doc.enabled !== false,
        client_secret_set: Boolean(doc.client_secret) || doc.client_secret_set === true,
        updated_at: doc.updated_at || null,
    };
}

function publicUserConnection(doc) {
    if (!doc) return null;
    return {
        id: doc.id,
        provider: doc.provider,
        account_email: doc.account_email || null,
        token_expires_at: doc.token_expires_at || null,
        connected_at: doc.connected_at || null,
        provider_account_id: doc.provider_account_id || null,
        account_meta: doc.account_meta || {},
        has_refresh_token: Boolean(doc.refresh_token),
    };
}

function publicServiceAccount(doc) {
    if (!doc) return null;
    return {
        provider: doc.provider,
        account_email: doc.account_email || null,
        connected_at: doc.connected_at || doc.updated_at || null,
        token_expires_at: doc.token_expires_at || null,
        has_refresh_token: Boolean(doc.refresh_token),
        is_expired: doc.token_expires_at ? new Date(doc.token_expires_at) <= new Date() : false,
    };
}

async function trySupabaseTempThenLive(service, baseName, apartmentId) {
    for (const table of [`${baseName}_temp`, baseName]) {
        try {
            let q = service.from(table).select('*');
            if (apartmentId) q = q.eq('apartment_id', apartmentId);
            const { data, error } = await q;
            if (error) {
                if (/does not exist|Could not find|relation/i.test(error.message)) continue;
                throw error;
            }
            return { table, rows: data || [] };
        } catch (err) {
            if (/does not exist|Could not find|relation/i.test(err.message || '')) continue;
            throw err;
        }
    }
    return { table: null, rows: [] };
}

/** Soft-migrate settings + oauth apps for one apartment when Mongo is empty. */
export async function maybeMigrateSpreadsheetFromSupabase(apartmentId, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    const existing = await db.collection(COL_SETTINGS).countDocuments({ apartment_id: apartmentId });
    if (existing > 0) return { migrated: false };

    try {
        const { createServiceClient } = await import('../../../../packages/server/serverSupabase.js');
        const service = createServiceClient();
        const now = nowIso();
        const migratedAt = now;

        const settings = await trySupabaseTempThenLive(service, 'ledger_sync_settings', apartmentId);
        const apps = await trySupabaseTempThenLive(service, 'ledger_sync_oauth_apps', apartmentId);
        const users = await trySupabaseTempThenLive(service, 'user_oauth_connections', apartmentId);
        const services = await trySupabaseTempThenLive(service, 'ledger_sync_service_accounts', apartmentId);

        const ops = [];
        for (const row of settings.rows) {
            if (!row.apartment_id) continue;
            ops.push({
                collection: COL_SETTINGS,
                filter: { apartment_id: row.apartment_id },
                doc: mapSettingsDoc(row, migratedAt),
            });
        }
        for (const row of apps.rows) {
            if (!row.apartment_id || !row.provider) continue;
            ops.push({
                collection: COL_OAUTH_APPS,
                filter: { apartment_id: row.apartment_id, provider: row.provider },
                doc: mapOAuthAppDoc(row, migratedAt),
            });
        }
        for (const row of users.rows) {
            if (!row.user_id || !row.apartment_id || !row.provider) continue;
            ops.push({
                collection: COL_USER_OAUTH,
                filter: {
                    user_id: row.user_id,
                    apartment_id: row.apartment_id,
                    provider: row.provider,
                },
                doc: mapUserOAuthDoc(row, migratedAt),
            });
        }
        for (const row of services.rows) {
            if (!row.apartment_id || !row.provider) continue;
            ops.push({
                collection: COL_SERVICE_ACCOUNTS,
                filter: { apartment_id: row.apartment_id, provider: row.provider },
                doc: mapServiceAccountDoc(row, migratedAt),
            });
        }

        for (const op of ops) {
            await db.collection(op.collection).updateOne(
                op.filter,
                { $set: op.doc },
                { upsert: true },
            );
        }
        return {
            migrated: ops.length > 0,
            sources: {
                settings: settings.table,
                oauth_apps: apps.table,
                user_oauth: users.table,
                service_accounts: services.table,
            },
            count: ops.length,
        };
    } catch {
        return { migrated: false };
    }
}

export function mapSettingsDoc(row, migratedAt = nowIso()) {
    return {
        apartment_id: row.apartment_id,
        provider: row.provider || 'NONE',
        spreadsheet_url: row.spreadsheet_url || null,
        sheet_name: row.sheet_name || 'Transactions',
        range_a1: row.range_a1 || 'A:H',
        header_row: row.header_row ?? null,
        footer_row: row.footer_row ?? null,
        column_mapping: row.column_mapping && typeof row.column_mapping === 'object' ? row.column_mapping : {},
        sync_interval_minutes: row.sync_interval_minutes ?? 0,
        sync_deletions: row.sync_deletions === true,
        last_synced_at: row.last_synced_at || null,
        last_sync_status: row.last_sync_status || null,
        last_sync_message: row.last_sync_message || null,
        last_sync_imported: row.last_sync_imported || 0,
        last_sync_pushed: row.last_sync_pushed || 0,
        last_sync_etag: row.last_sync_etag || null,
        last_sync_hash_version: row.last_sync_hash_version || null,
        last_sync_run_id: row.last_sync_run_id || null,
        last_synced_by: row.last_synced_by || null,
        updated_at: row.updated_at || migratedAt,
        _schema: SCHEMA,
        _migratedFrom: row._migratedFrom || 'supabase',
        _migratedAt: migratedAt,
    };
}

export function mapOAuthAppDoc(row, migratedAt = nowIso()) {
    return {
        id: row.id || crypto.randomUUID(),
        apartment_id: row.apartment_id,
        provider: row.provider,
        client_id: row.client_id || '',
        client_secret: row.client_secret || null,
        client_secret_set: Boolean(row.client_secret) || row.client_secret_set === true,
        tenant_id: row.tenant_id || 'common',
        redirect_uri: row.redirect_uri || null,
        enabled: row.enabled !== false,
        configured_by: row.configured_by || null,
        created_at: row.created_at || migratedAt,
        updated_at: row.updated_at || migratedAt,
        _schema: SCHEMA,
        _migratedFrom: row._migratedFrom || 'supabase',
        _migratedAt: migratedAt,
    };
}

export function mapUserOAuthDoc(row, migratedAt = nowIso()) {
    return {
        id: row.id || crypto.randomUUID(),
        user_id: row.user_id,
        apartment_id: row.apartment_id,
        provider: row.provider,
        account_email: row.account_email || null,
        access_token: row.access_token || null,
        refresh_token: row.refresh_token || null,
        token_expires_at: row.token_expires_at || null,
        scopes: row.scopes || null,
        provider_account_id: row.provider_account_id || null,
        account_meta: row.account_meta && typeof row.account_meta === 'object' ? row.account_meta : {},
        connected_at: row.connected_at || migratedAt,
        updated_at: row.updated_at || migratedAt,
        _schema: SCHEMA,
        _migratedFrom: row._migratedFrom || 'supabase',
        _migratedAt: migratedAt,
    };
}

export function mapServiceAccountDoc(row, migratedAt = nowIso()) {
    return {
        id: row.id || crypto.randomUUID(),
        apartment_id: row.apartment_id,
        provider: row.provider,
        account_email: row.account_email || null,
        access_token: row.access_token || null,
        refresh_token: row.refresh_token || null,
        token_expires_at: row.token_expires_at || null,
        scopes: row.scopes || null,
        connected_by: row.connected_by || null,
        account_meta: row.account_meta && typeof row.account_meta === 'object' ? row.account_meta : {},
        connected_at: row.connected_at || migratedAt,
        updated_at: row.updated_at || migratedAt,
        _schema: SCHEMA,
        _migratedFrom: row._migratedFrom || 'supabase',
        _migratedAt: migratedAt,
    };
}

export async function getSpreadsheetBoot(apartmentId, userId, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    await maybeMigrateSpreadsheetFromSupabase(apartmentId, { db });

    const [settings, apps, myConn, serviceRows] = await Promise.all([
        db.collection(COL_SETTINGS).findOne({ apartment_id: apartmentId }),
        db.collection(COL_OAUTH_APPS).find({ apartment_id: apartmentId }).toArray(),
        userId
            ? db.collection(COL_USER_OAUTH).find({ apartment_id: apartmentId, user_id: userId }).toArray()
            : Promise.resolve([]),
        db.collection(COL_SERVICE_ACCOUNTS).find({ apartment_id: apartmentId }).toArray(),
    ]);

    return {
        ledgerSyncSettings: settings
            ? {
                apartment_id: settings.apartment_id,
                provider: settings.provider,
                spreadsheet_url: settings.spreadsheet_url,
                sheet_name: settings.sheet_name,
                range_a1: settings.range_a1,
                header_row: settings.header_row,
                footer_row: settings.footer_row,
                column_mapping: settings.column_mapping || {},
                sync_interval_minutes: settings.sync_interval_minutes,
                sync_deletions: settings.sync_deletions,
                last_synced_at: settings.last_synced_at,
                last_sync_status: settings.last_sync_status,
                last_sync_message: settings.last_sync_message,
                last_sync_imported: settings.last_sync_imported,
                last_sync_pushed: settings.last_sync_pushed,
                last_sync_etag: settings.last_sync_etag,
                last_sync_hash_version: settings.last_sync_hash_version,
                last_sync_run_id: settings.last_sync_run_id,
                last_synced_by: settings.last_synced_by,
                updated_at: settings.updated_at,
            }
            : null,
        ledgerOAuthApps: apps.map(publicOAuthApp).filter(Boolean),
        myOAuthConnections: myConn.map(publicUserConnection).filter(Boolean),
        syncServiceAccounts: serviceRows.map(publicServiceAccount).filter(Boolean),
    };
}

export async function upsertSpreadsheetSettings(apartmentId, userId, patch, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    if (!apartmentId) throw badRequest('apartment_id is required.');

    const existing = await db.collection(COL_SETTINGS).findOne({ apartment_id: apartmentId });
    const now = nowIso();
    const next = mapSettingsDoc({
        ...(existing || {}),
        ...patch,
        apartment_id: apartmentId,
        updated_at: now,
        _migratedFrom: existing?._migratedFrom || 'api',
    }, existing?._migratedAt || now);
    if (userId && patch.last_synced_by === undefined && patch.last_synced_at) {
        next.last_synced_by = userId;
    }

    await db.collection(COL_SETTINGS).updateOne(
        { apartment_id: apartmentId },
        { $set: next },
        { upsert: true },
    );
    return next;
}

export async function upsertOAuthApp(apartmentId, userId, payload, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    const provider = String(payload.provider || '').trim().toUpperCase();
    if (!['GOOGLE', 'MICROSOFT'].includes(provider)) throw badRequest('provider must be GOOGLE or MICROSOFT.');
    const client_id = String(payload.client_id || '').trim();
    if (!client_id) throw badRequest('client_id is required.');

    const filter = { apartment_id: apartmentId, provider };
    const existing = await db.collection(COL_OAUTH_APPS).findOne(filter);
    const now = nowIso();
    const secret = String(payload.client_secret || '').trim();
    const doc = mapOAuthAppDoc({
        id: existing?.id || payload.id || crypto.randomUUID(),
        apartment_id: apartmentId,
        provider,
        client_id,
        tenant_id: payload.tenant_id || existing?.tenant_id || 'common',
        redirect_uri: payload.redirect_uri || existing?.redirect_uri || null,
        enabled: payload.enabled !== false,
        configured_by: userId || existing?.configured_by || null,
        created_at: existing?.created_at || now,
        updated_at: now,
        client_secret: secret || existing?.client_secret || null,
        client_secret_set: Boolean(secret || existing?.client_secret),
        _migratedFrom: existing?._migratedFrom || 'api',
    }, existing?._migratedAt || now);

    await db.collection(COL_OAUTH_APPS).updateOne(filter, { $set: doc }, { upsert: true });
    return publicOAuthApp(doc);
}

export async function upsertUserOAuthConnection(apartmentId, userId, payload, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    const provider = String(payload.provider || '').trim().toUpperCase();
    if (!userId) throw badRequest('Sign in required.');
    if (!['GOOGLE', 'MICROSOFT'].includes(provider)) throw badRequest('Invalid provider.');
    if (!payload.access_token) throw badRequest('access_token is required.');

    const filter = { user_id: userId, apartment_id: apartmentId, provider };
    const existing = await db.collection(COL_USER_OAUTH).findOne(filter);
    const now = nowIso();
    const doc = mapUserOAuthDoc({
        id: existing?.id || crypto.randomUUID(),
        user_id: userId,
        apartment_id: apartmentId,
        provider,
        account_email: payload.account_email || null,
        access_token: payload.access_token,
        refresh_token: payload.refresh_token ?? existing?.refresh_token ?? null,
        token_expires_at: payload.token_expires_at || null,
        scopes: payload.scopes || null,
        provider_account_id: payload.provider_account_id || null,
        account_meta: payload.account_meta || {},
        connected_at: existing?.connected_at || now,
        updated_at: now,
        _migratedFrom: existing?._migratedFrom || 'api',
    }, existing?._migratedAt || now);

    await db.collection(COL_USER_OAUTH).updateOne(filter, { $set: doc }, { upsert: true });
    return publicUserConnection(doc);
}

export async function getUserOAuthConnectionWithTokens(apartmentId, userId, provider, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    return db.collection(COL_USER_OAUTH).findOne({
        apartment_id: apartmentId,
        user_id: userId,
        provider: String(provider || '').toUpperCase(),
    });
}

export async function deleteUserOAuthConnection(apartmentId, userId, provider, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    await db.collection(COL_USER_OAUTH).deleteOne({
        apartment_id: apartmentId,
        user_id: userId,
        provider: String(provider || '').toUpperCase(),
    });
    return { deleted: true };
}

export async function getOAuthAppSecret(apartmentId, provider, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    return db.collection(COL_OAUTH_APPS).findOne({
        apartment_id: apartmentId,
        provider: String(provider || '').toUpperCase(),
    });
}

function publicRun(doc) {
    if (!doc) return null;
    return {
        id: doc.id || doc._id,
        apartment_id: doc.apartment_id,
        started_at: doc.started_at,
        completed_at: doc.completed_at || null,
        status: doc.status || null,
        imported: doc.imported || 0,
        updated: doc.updated || 0,
        deleted: doc.deleted || 0,
        skipped: doc.skipped || 0,
        pushed: doc.pushed || 0,
        message: doc.message || null,
        rolled_back_at: doc.rolled_back_at || null,
        created_by: doc.created_by || null,
    };
}

export function mapRunDoc(row, migratedAt = nowIso()) {
    const id = row.id || crypto.randomUUID();
    return {
        _id: id,
        id,
        apartment_id: row.apartment_id,
        started_at: row.started_at || migratedAt,
        completed_at: row.completed_at || null,
        status: row.status || 'running',
        imported: row.imported || 0,
        updated: row.updated || 0,
        deleted: row.deleted || 0,
        skipped: row.skipped || 0,
        pushed: row.pushed || 0,
        message: row.message || null,
        bounds_snapshot: row.bounds_snapshot ?? null,
        rolled_back_at: row.rolled_back_at || null,
        created_by: row.created_by || null,
        _schema: SCHEMA,
        _migratedFrom: row._migratedFrom || 'supabase',
        _migratedAt: migratedAt,
    };
}

/** Soft-migrate sync runs when Mongo has none for this apartment. */
export async function maybeMigrateSpreadsheetRunsFromSupabase(apartmentId, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    const existing = await db.collection(COL_RUNS).countDocuments({ apartment_id: apartmentId });
    if (existing > 0) return { migrated: false };

    try {
        const { createServiceClient } = await import('../../../../packages/server/serverSupabase.js');
        const service = createServiceClient();
        const migratedAt = nowIso();
        let table = null;
        let rows = [];
        for (const name of ['ledger_sync_runs_temp', 'ledger_sync_runs']) {
            try {
                const { data, error } = await service
                    .from(name)
                    .select('*')
                    .eq('apartment_id', apartmentId)
                    .order('started_at', { ascending: false })
                    .limit(200);
                if (error) {
                    if (/does not exist|Could not find|relation|schema cache/i.test(error.message)) continue;
                    throw error;
                }
                table = name;
                rows = data || [];
                break;
            } catch (err) {
                if (/does not exist|Could not find|relation|schema cache/i.test(err.message || '')) continue;
                throw err;
            }
        }
        const ops = rows
            .filter((r) => r.apartment_id && r.id)
            .map((row) => {
                const doc = mapRunDoc(row, migratedAt);
                return {
                    replaceOne: {
                        filter: { _id: doc._id },
                        replacement: doc,
                        upsert: true,
                    },
                };
            });
        if (ops.length) {
            await db.collection(COL_RUNS).bulkWrite(ops, { ordered: false });
        }
        return { migrated: ops.length > 0, table, count: ops.length };
    } catch {
        return { migrated: false };
    }
}

export async function listSpreadsheetRuns(apartmentId, { limit = 100, db: injected } = {}) {
    if (!apartmentId) throw badRequest('apartment_id is required.');
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    await maybeMigrateSpreadsheetRunsFromSupabase(apartmentId, { db });

    const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
    const rows = await db.collection(COL_RUNS)
        .find({ apartment_id: apartmentId })
        .sort({ started_at: -1 })
        .limit(lim)
        .toArray();

    const failed = rows.filter((r) => String(r.status || '').toUpperCase() === 'FAILED').length;
    return {
        runs: rows.map(publicRun),
        counts: {
            total: rows.length,
            failed,
            ok: rows.filter((r) => String(r.status || '').toUpperCase() === 'OK').length,
        },
    };
}
