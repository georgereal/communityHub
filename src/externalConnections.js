/**
 * External API connections — per-society credentials (Evolyx passbook OCR, etc.)
 */
import { portalState, supabase, pullState } from './store.js';
import { withButtonBusy } from './buttonBusy.js';

export const EVOLYX_PROVIDER = 'EVOLYX';
export const EVOLYX_PASSBOOK_KEY = 'passbook_reader';

export const CONNECTION_CATALOG = [
    {
        provider: EVOLYX_PROVIDER,
        connectionKey: EVOLYX_PASSBOOK_KEY,
        label: 'Evolyx — Passbook Reader',
        description: 'Scan passbook photos or PDFs into bank statement lines for reconciliation.',
        defaults: {
            base_url: 'http://localhost:3000',
            client_id: 'communityhub',
            workflow_id: '6a44f36f5ddde12aabd18023',
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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const fieldId = (provider, connectionKey, field) =>
    `ext-conn-${provider}-${connectionKey}-${field}`.toLowerCase();

export const renderExternalConnectionsAdmin = () => {
    const root = document.getElementById('admin-connections-root');
    if (!root) return;

    root.innerHTML = CONNECTION_CATALOG.map((def) => {
        const row = getConnectionRow(def.provider, def.connectionKey);
        const enabled = row?.enabled !== false;
        const statusClass = row?.api_key_set && enabled ? 'ext-conn-status--ok' : 'ext-conn-status--warn';
        const statusText = row?.api_key_set
            ? (enabled ? 'Configured' : 'Disabled')
            : 'Not configured';

        return `
      <article class="ext-conn-card" data-provider="${def.provider}" data-connection-key="${def.connectionKey}">
        <header class="ext-conn-card__head">
          <div>
            <h3 class="ext-conn-card__title">${esc(def.label)}</h3>
            <p class="ext-conn-card__desc">${esc(def.description)}</p>
          </div>
          <span class="ext-conn-status ${statusClass}">${statusText}</span>
        </header>
        <div class="ext-conn-form">
          <label class="ext-conn-field">
            <span class="ext-conn-label">API base URL</span>
            <input type="url" class="expense-combobox" id="${fieldId(def.provider, def.connectionKey, 'base_url')}"
              value="${esc(row?.base_url || def.defaults.base_url)}" placeholder="https://api.example.com" autocomplete="off" />
          </label>
          <label class="ext-conn-field">
            <span class="ext-conn-label">Client ID</span>
            <input type="text" class="expense-combobox" id="${fieldId(def.provider, def.connectionKey, 'client_id')}"
              value="${esc(row?.client_id || def.defaults.client_id)}" autocomplete="off" />
          </label>
          <label class="ext-conn-field">
            <span class="ext-conn-label">Workflow ID</span>
            <input type="text" class="expense-combobox" id="${fieldId(def.provider, def.connectionKey, 'workflow_id')}"
              value="${esc(row?.workflow_id || def.defaults.workflow_id)}" autocomplete="off" />
          </label>
          <label class="ext-conn-field ext-conn-field--wide">
            <span class="ext-conn-label">API key</span>
            <input type="password" class="expense-combobox" id="${fieldId(def.provider, def.connectionKey, 'api_key')}"
              placeholder="${row?.api_key_set ? '••••••••  (leave blank to keep current)' : 'evx_…'}" autocomplete="new-password" />
          </label>
          <label class="ext-conn-check">
            <input type="checkbox" id="${fieldId(def.provider, def.connectionKey, 'enabled')}" ${enabled ? 'checked' : ''} />
            <span>Enabled</span>
          </label>
        </div>
        <footer class="ext-conn-card__foot">
          <p class="ext-conn-hint">Keys are stored per society in the database. They are never shown again after save — only used server-side for passbook scans.</p>
          <button type="button" class="btn btn-primary btn--small ext-conn-save"
            data-provider="${def.provider}" data-connection-key="${def.connectionKey}">
            Save connection
          </button>
        </footer>
      </article>`;
    }).join('');

    root.querySelectorAll('.ext-conn-save').forEach((btn) => {
        btn.addEventListener('click', () => {
            void withButtonBusy(btn, 'Saving…', async () => {
                try {
                    await saveExternalConnection(btn.dataset.provider, btn.dataset.connectionKey);
                } catch (err) {
                    alert(err?.message || 'Save failed.');
                }
            });
        });
    });
};

export async function saveExternalConnection(provider, connectionKey) {
    if (!supabase) throw new Error('Supabase is required.');
    const apt = apartmentId();
    if (!apt) throw new Error('Select a society first.');

    const def = CONNECTION_CATALOG.find((d) => d.provider === provider && d.connectionKey === connectionKey);
    if (!def) throw new Error('Unknown connection type.');

    const base_url = document.getElementById(fieldId(provider, connectionKey, 'base_url'))?.value?.trim();
    const client_id = document.getElementById(fieldId(provider, connectionKey, 'client_id'))?.value?.trim() || null;
    const workflow_id = document.getElementById(fieldId(provider, connectionKey, 'workflow_id'))?.value?.trim() || null;
    const api_key_input = document.getElementById(fieldId(provider, connectionKey, 'api_key'))?.value?.trim();
    const enabled = document.getElementById(fieldId(provider, connectionKey, 'enabled'))?.checked !== false;

    if (!base_url) throw new Error('API base URL is required.');

    const existing = getConnectionRow(provider, connectionKey);
    const { data: { user } } = await supabase.auth.getUser();

    const row = {
        id: existing?.id || crypto.randomUUID(),
        apartment_id: apt,
        provider,
        connection_key: connectionKey,
        display_name: def.label,
        base_url,
        client_id,
        workflow_id,
        enabled,
        configured_by: user?.id || null,
        updated_at: new Date().toISOString(),
    };

    if (api_key_input) {
        row.api_key = api_key_input;
        row.api_key_set = true;
    } else if (!existing?.api_key_set) {
        throw new Error('API key is required for a new connection.');
    }

    const { error } = await supabase
        .from('apartment_external_connections')
        .upsert(row, { onConflict: 'apartment_id,provider,connection_key' });
    if (error) throw new Error(error.message);

    await pullState();
    renderExternalConnectionsAdmin();
}
