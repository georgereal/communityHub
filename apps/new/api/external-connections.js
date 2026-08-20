import { requireApartmentPermission } from '../../../packages/server/serverAuth.js';

const ALLOWED_PROVIDER = 'EVOLYX';

function mapConnectionRow(row) {
    if (!row) return row;
    return {
        id: row.id,
        apartment_id: row.apartment_id,
        provider: row.provider,
        connection_key: row.connection_key,
        display_name: row.display_name,
        base_url: row.base_url,
        client_id: row.client_id,
        workflow_id: row.workflow_id,
        webhook_base_url: row.config?.webhook_base_url || '',
        enabled: row.enabled,
        api_key_set: Boolean(row.api_key),
        updated_at: row.updated_at,
    };
}

export default async function handler(req, res) {
    const apartmentIdRaw = req.method === 'GET'
        ? req.query?.apartment_id || new URL(req.url, 'http://localhost').searchParams.get('apartment_id')
        : req.body?.apartment_id;

    try {
        const { apartmentId, service, user } = await requireApartmentPermission(req, apartmentIdRaw, 'accounts.edit');

        if (req.method === 'GET') {
            const { data, error } = await service
                .from('apartment_external_connections')
                .select('id, apartment_id, provider, connection_key, display_name, base_url, client_id, workflow_id, enabled, api_key, config, updated_at')
                .eq('apartment_id', apartmentId)
                .order('provider');
            if (error) throw Object.assign(new Error(error.message), { status: 500 });
            return res.status(200).json({ ok: true, rows: (data || []).map(mapConnectionRow) });
        }

        if (req.method === 'POST') {
            const {
                provider,
                connection_key,
                display_name,
                base_url,
                client_id = null,
                webhook_base_url = null,
                workflow_id = null,
                enabled = true,
                api_key = '',
            } = req.body || {};

            if (provider !== ALLOWED_PROVIDER) {
                return res.status(400).json({ error: 'Unsupported provider.' });
            }
            if (!connection_key) {
                return res.status(400).json({ error: 'connection_key is required.' });
            }
            if (!base_url) {
                return res.status(400).json({ error: 'base_url is required.' });
            }

            const { data: existing, error: existingErr } = await service
                .from('apartment_external_connections')
                .select('id, api_key, config')
                .eq('apartment_id', apartmentId)
                .eq('provider', provider)
                .eq('connection_key', connection_key)
                .maybeSingle();
            if (existingErr) throw Object.assign(new Error(existingErr.message), { status: 500 });

            if (!api_key && !existing?.api_key) {
                return res.status(400).json({ error: 'API key is required for a new connection.' });
            }

            const row = {
                id: existing?.id || crypto.randomUUID(),
                apartment_id: apartmentId,
                provider,
                connection_key,
                display_name: display_name || null,
                base_url,
                client_id,
                workflow_id,
                enabled: enabled !== false,
                config: {
                    ...(existing?.config || {}),
                    webhook_base_url: webhook_base_url || '',
                },
                configured_by: user.id,
                updated_at: new Date().toISOString(),
            };
            if (api_key) {
                row.api_key = api_key;
            }

            const { data, error } = await service
                .from('apartment_external_connections')
                .upsert(row, { onConflict: 'apartment_id,provider,connection_key' })
                .select('id, apartment_id, provider, connection_key, display_name, base_url, client_id, workflow_id, enabled, api_key, config, updated_at')
                .single();
            if (error) throw Object.assign(new Error(error.message), { status: 500 });

            return res.status(200).json({ ok: true, row: mapConnectionRow(data) });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'External connections request failed.' });
    }
}
