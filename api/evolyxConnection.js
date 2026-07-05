import { createServiceClient, createUserClient } from './serverSupabase.js';

export const EVOLYX_PROVIDER = 'EVOLYX';
export const EVOLYX_PASSBOOK_KEY = 'passbook_reader';

function connectionClient(authHeader = '') {
    try {
        return createServiceClient();
    } catch (err) {
        if (authHeader && /SUPABASE_SERVICE_ROLE_KEY/i.test(err?.message || '')) {
            return createUserClient(authHeader);
        }
        throw err;
    }
}

/**
 * Load Evolyx passbook OCR settings for this society from the DB using server-side service credentials.
 */
export async function resolveEvolyxPassbookConfig(apartmentId, { authHeader = '' } = {}) {
    const service = connectionClient(authHeader);
    const { data, error } = await service
        .from('apartment_external_connections')
        .select('base_url, client_id, api_key, workflow_id, enabled, config')
        .eq('apartment_id', apartmentId)
        .eq('provider', EVOLYX_PROVIDER)
        .eq('connection_key', EVOLYX_PASSBOOK_KEY)
        .maybeSingle();

    if (error) throw Object.assign(new Error(error.message || String(error)), { status: 500 });

    if (data?.enabled !== false && data?.api_key) {
        const baseUrl = String(data.base_url || '').replace(/\/$/, '');
        if (!baseUrl) {
            throw Object.assign(new Error('Evolyx base URL is not configured.'), { status: 503 });
        }
        return {
            baseUrl,
            apiKey: data.api_key,
            workflowId: data.workflow_id || '6a44f36f5ddde12aabd18023',
            clientId: data.client_id || 'communityhub',
            webhookBaseUrl: String(data.config?.webhook_base_url || '').trim(),
            source: 'database',
        };
    }

    return null;
}
