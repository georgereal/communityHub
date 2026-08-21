import { getMongoDb } from '../../../../packages/server/mongoClient.js';
import { badRequest, serviceUnavailable } from './errors.js';
import { ensureIntegrationsIndexes } from './indexes.js';

export const EVOLYX_PROVIDER = 'EVOLYX';
export const EVOLYX_PASSBOOK_KEY = 'passbook_reader';

const nowIso = () => new Date().toISOString();

function publicRow(doc) {
    if (!doc) return null;
    return {
        id: doc.id,
        apartment_id: doc.apartment_id,
        provider: doc.provider,
        connection_key: doc.connection_key,
        display_name: doc.display_name || null,
        base_url: doc.base_url,
        client_id: doc.client_id || null,
        workflow_id: doc.workflow_id || null,
        webhook_base_url: doc.config?.webhook_base_url || '',
        enabled: doc.enabled !== false,
        api_key_set: Boolean(doc.api_key),
        updated_at: doc.updated_at || null,
    };
}

async function maybeMigrateFromSupabase(db, apartmentId) {
    const existing = await db.collection('external_connections').countDocuments({ apartment_id: apartmentId });
    if (existing > 0) return;

    try {
        const { createServiceClient } = await import('../../../../packages/server/serverSupabase.js');
        const service = createServiceClient();
        const { data, error } = await service
            .from('apartment_external_connections')
            .select('id, apartment_id, provider, connection_key, display_name, base_url, client_id, workflow_id, enabled, api_key, config, configured_by, created_at, updated_at')
            .eq('apartment_id', apartmentId);
        if (error || !data?.length) return;

        const now = nowIso();
        const docs = data.map((row) => ({
            id: row.id || crypto.randomUUID(),
            apartment_id: row.apartment_id,
            provider: row.provider,
            connection_key: row.connection_key,
            display_name: row.display_name || null,
            base_url: row.base_url,
            client_id: row.client_id || null,
            workflow_id: row.workflow_id || null,
            api_key: row.api_key || null,
            enabled: row.enabled !== false,
            config: row.config && typeof row.config === 'object' ? row.config : {},
            configured_by: row.configured_by || null,
            created_at: row.created_at || now,
            updated_at: row.updated_at || now,
            _migratedFrom: 'supabase',
            _schema: 'integrations_v1',
        }));
        if (docs.length) {
            await db.collection('external_connections').insertMany(docs, { ordered: false }).catch(() => {});
        }
    } catch {
        // Supabase optional during Mongo-first rollout
    }
}

export async function listExternalConnections(apartmentId, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    await maybeMigrateFromSupabase(db, apartmentId);
    const rows = await db.collection('external_connections')
        .find({ apartment_id: apartmentId })
        .sort({ provider: 1, connection_key: 1 })
        .toArray();
    return rows.map(publicRow);
}

export async function upsertExternalConnection(apartmentId, userId, payload, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);

    const provider = String(payload.provider || '').trim();
    const connection_key = String(payload.connection_key || '').trim();
    const base_url = String(payload.base_url || '').trim();
    if (provider !== EVOLYX_PROVIDER) throw badRequest('Unsupported provider.');
    if (!connection_key) throw badRequest('connection_key is required.');
    if (!base_url) throw badRequest('base_url is required.');

    const filter = { apartment_id: apartmentId, provider, connection_key };
    const existing = await db.collection('external_connections').findOne(filter);
    const api_key = String(payload.api_key || '').trim();
    if (!api_key && !existing?.api_key) throw badRequest('API key is required for a new connection.');

    const now = nowIso();
    const next = {
        id: existing?.id || crypto.randomUUID(),
        apartment_id: apartmentId,
        provider,
        connection_key,
        display_name: payload.display_name || null,
        base_url,
        client_id: payload.client_id || null,
        workflow_id: payload.workflow_id || null,
        enabled: payload.enabled !== false,
        config: {
            ...(existing?.config || {}),
            webhook_base_url: payload.webhook_base_url || '',
        },
        configured_by: userId || existing?.configured_by || null,
        updated_at: now,
        created_at: existing?.created_at || now,
        api_key: api_key || existing?.api_key || null,
        _schema: 'integrations_v1',
    };

    await db.collection('external_connections').updateOne(
        filter,
        { $set: next },
        { upsert: true },
    );
    return publicRow(next);
}

/**
 * Resolve Evolyx passbook OCR credentials for server-side workflow calls.
 */
export async function resolveEvolyxPassbookConfig(apartmentId, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    await maybeMigrateFromSupabase(db, apartmentId);

    const data = await db.collection('external_connections').findOne({
        apartment_id: apartmentId,
        provider: EVOLYX_PROVIDER,
        connection_key: EVOLYX_PASSBOOK_KEY,
    });

    if (data?.enabled !== false && data?.api_key) {
        const baseUrl = String(data.base_url || '').replace(/\/$/, '');
        if (!baseUrl) throw serviceUnavailable('Evolyx base URL is not configured.');
        return {
            baseUrl,
            apiKey: data.api_key,
            workflowId: data.workflow_id || '6a44f36f5ddde12aabd18023',
            clientId: data.client_id || 'communityhub',
            webhookBaseUrl: String(data.config?.webhook_base_url || '').trim(),
            source: 'mongo',
        };
    }
    return null;
}

export function requireEvolyxPassbookConfig(resolved) {
    if (!resolved?.apiKey) {
        throw serviceUnavailable(
            'Passbook OCR is not configured. Set it up under Administration → Integrations.',
        );
    }
    return resolved;
}
