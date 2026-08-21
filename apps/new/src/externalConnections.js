/**
 * External API connections — New UI client for /api/integrations (Mongo).
 */
import { portalState } from './store.js';
import { readApiJson } from './apiJson.js';

export const EVOLYX_PROVIDER = 'EVOLYX';
export const EVOLYX_PASSBOOK_KEY = 'passbook_reader';

export const CONNECTION_CATALOG = [
    {
        provider: EVOLYX_PROVIDER,
        connectionKey: EVOLYX_PASSBOOK_KEY,
        label: 'Evolyx — Passbook Reader',
        description: 'Scan passbook photos or PDFs into bank statement lines for reconciliation.',
        defaults: {
            base_url: 'https://ai.evolyx.in',
            client_id: 'communityhub',
            workflow_id: '6a44f36f5ddde12aabd18023',
            webhook_base_url: '',
        },
    },
];

const apartmentId = () => portalState.access?.activeApartmentId;

export const getExternalConnections = () => portalState.admin?.externalConnections || [];

export const getConnectionRow = (provider, connectionKey) =>
    getExternalConnections().find((r) => r.provider === provider && r.connection_key === connectionKey);

export const isPassbookOcrConfigured = () => {
    const row = getConnectionRow(EVOLYX_PROVIDER, EVOLYX_PASSBOOK_KEY);
    return Boolean(row?.enabled !== false && row?.api_key_set);
};

export const getPassbookWebhookBaseUrl = () => {
    const row = getConnectionRow(EVOLYX_PROVIDER, EVOLYX_PASSBOOK_KEY);
    return String(row?.webhook_base_url || '').trim();
};

let loadingConnections = null;
let loadedApartmentId = null;

async function loadExternalConnections() {
    const apt = apartmentId();
    if (!apt) return [];
    const res = await fetch(`/api/integrations/connections?apartment_id=${encodeURIComponent(apt)}`, {
        credentials: 'include',
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Could not load integrations.');
    portalState.admin = portalState.admin || {};
    portalState.admin.externalConnections = json.rows || [];
    loadedApartmentId = apt;
    return portalState.admin.externalConnections;
}

export async function ensureExternalConnectionsLoaded({ force = false } = {}) {
    const apt = apartmentId();
    if (!apt) return [];
    if (!force && loadedApartmentId === apt && Array.isArray(portalState.admin?.externalConnections)) {
        return portalState.admin.externalConnections;
    }
    if (!loadingConnections) {
        loadingConnections = loadExternalConnections().finally(() => {
            loadingConnections = null;
        });
    }
    return loadingConnections;
}

export async function upsertExternalConnectionRow(row) {
    const res = await fetch('/api/integrations/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(row),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Save failed.');

    portalState.admin = portalState.admin || {};
    portalState.admin.externalConnections = [
        ...getExternalConnections().filter((item) => !(item.provider === row.provider && item.connection_key === row.connection_key)),
        json.row,
    ];
    loadedApartmentId = row.apartment_id;
    return json.row;
}

/** Classic admin HTML renderer is unused on Admin-New; keep no-op for imports. */
export const renderExternalConnectionsAdmin = () => {};

export async function saveExternalConnection(provider, connectionKey, form) {
    const apt = apartmentId();
    if (!apt) throw new Error('Select a society first.');
    const def = CONNECTION_CATALOG.find((d) => d.provider === provider && d.connectionKey === connectionKey);
    if (!def) throw new Error('Unknown connection type.');
    const existing = getConnectionRow(provider, connectionKey);
    if (!form.api_key && !existing?.api_key_set) throw new Error('API key is required for a new connection.');
    if (!form.base_url?.trim()) throw new Error('API base URL is required.');
    return upsertExternalConnectionRow({
        apartment_id: apt,
        provider,
        connection_key: connectionKey,
        display_name: def.label,
        base_url: form.base_url.trim(),
        client_id: form.client_id?.trim() || null,
        webhook_base_url: form.webhook_base_url?.trim() || null,
        workflow_id: form.workflow_id?.trim() || null,
        enabled: form.enabled !== false,
        api_key: form.api_key || '',
    });
}
