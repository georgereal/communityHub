import { restMaybeSingle } from './supabaseRest.js';

export const EVOLYX_PROVIDER = 'EVOLYX';
export const EVOLYX_PASSBOOK_KEY = 'passbook_reader';

/**
 * Load Evolyx passbook OCR settings for this society from the DB.
 */
export async function resolveEvolyxPassbookConfig(authHeader, apartmentId) {
    const { data, error } = await restMaybeSingle(
        authHeader,
        'apartment_external_connections',
        {
            apartment_id: apartmentId,
            provider: EVOLYX_PROVIDER,
            connection_key: EVOLYX_PASSBOOK_KEY,
        },
        'base_url, client_id, api_key, workflow_id, enabled, api_key_set',
    );

    if (error) throw Object.assign(new Error(error), { status: 500 });

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
            source: 'database',
        };
    }

    return null;
}
