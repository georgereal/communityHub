/**
 * Sync income & expenses from Google Sheets, Microsoft Excel Online, or uploaded file
 */
import './ledgerSync.css';
import ExcelJS from 'exceljs';
import { portalState, supabase, pullState } from './store.js';
import { logActivity } from './activityAudit.js';
import { hasClientPermission } from './rbac.js';
import {
    getOAuthApp,
    getMyOAuthConnectionMeta,
    getMicrosoftRedirectUri,
    getAppRedirectUri,
    saveOAuthApp,
    startGoogleConnect,
    startMicrosoftConnect,
    startMicrosoftWebConnect,
    disconnectOAuth,
    ensureOAuthConnected,
    getAccessTokenForProvider,
    handleOAuthRedirectIfPresent,
    oauthAppHasClientSecret,
} from './ledgerOAuth.js';
import { withButtonBusy, setButtonBusy, clearButtonBusy } from './buttonBusy.js';

let activeProvider = 'MICROSOFT';
let syncPanelForceOpen = false;
let autoSyncTimer = null;
let isSyncing = false;
let syncOpsCtx = { prefix: '', onRefresh: () => renderLedgerSyncPanel() };

function opsId(prefix, name) {
    return `${prefix}ledger-sync-${name}`;
}

function syncEl(name) {
    return document.getElementById(opsId(syncOpsCtx.prefix, name));
}

function startAutoSync() {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    const s = getSyncSettings();
    const interval = s?.sync_interval_minutes || 0;
    if (interval > 0) {
        console.log(`Starting auto-sync every ${interval} minutes.`);
        autoSyncTimer = setInterval(async () => {
            if (isSyncing) return;
            try {
                isSyncing = true;
                console.log('Running background auto-sync...');
                await runSync();
            } catch (err) {
                console.error('Auto-sync failed:', err);
            } finally {
                isSyncing = false;
            }
        }, interval * 60 * 1000);
    }
}

function initActiveProvider() {
    const s = portalState.finances?.ledgerSyncSettings;
    if (s?.provider && ['GOOGLE', 'MICROSOFT', 'FILE'].includes(s.provider)) {
        activeProvider = s.provider;
    }
}

function syncSummaryHint() {
    const s = getSyncSettings();
    if (s?.last_synced_at) {
        const failed = s.last_sync_status !== 'OK';
        const when = new Date(s.last_synced_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        return failed ? `Last sync failed · ${when}` : `Last synced ${when}`;
    }
    const google = getMyOAuthConnectionMeta('GOOGLE');
    const ms = getMyOAuthConnectionMeta('MICROSOFT');
    if (google?.account_email) return `Google: ${google.account_email}`;
    if (ms?.account_email) return `Microsoft: ${ms.account_email}`;
    return 'Import from Google Sheets, Excel, or file';
}

const parseDate = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map((x) => parseInt(x, 10));
        if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
        if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
    return null;
};

const parseAmount = (val) => {
    if (val == null || val === '') return 0;
    const n = parseFloat(String(val).replace(/[,₹]/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : 0;
};

const normType = (raw) => {
    const s = String(raw || '').trim().toUpperCase();
    if (['IN', 'INCOME', 'CREDIT', 'CR'].includes(s)) return 'IN';
    if (['OUT', 'EXPENSE', 'DEBIT', 'DR'].includes(s)) return 'OUT';
    return null;
};

const normWallet = (raw) => {
    const s = String(raw || '').trim().toUpperCase();
    if (s === 'BANK') return 'BANK';
    return 'CASH';
};

const normCat = (raw, type) => {
    const s = String(raw || '').trim();
    if (!s) return type === 'IN' ? 'Other Income' : 'Other';
    return s;
};

function detectProviderFromUrl(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('docs.google.com') || u.includes('google.com/spreadsheets')) return 'GOOGLE';
    if (u.includes('sharepoint') || u.includes('onedrive') || u.includes('1drv') || u.includes('office.com')) return 'MICROSOFT';
    return null;
}

async function listGoogleWorksheets(spreadsheetUrl) {
    const sheetId = parseGoogleSheetId(spreadsheetUrl);
    if (!sheetId) throw new Error('Paste a valid Google Sheets URL.');
    const token = await getAccessTokenForProvider('GOOGLE');
    const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Failed to list Google worksheets.');
    return (json.sheets || []).map((sh) => sh.properties?.title).filter(Boolean);
}

function encodeMicrosoftShareId(url) {
    const raw = String(url || '').trim();
    const bytes = new TextEncoder().encode(raw);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    const b64 = btoa(bin);
    return `u!${b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

/**
 * Safe Base64 encoding for strings with non-Latin1 characters (like ₹)
 */
function safeHash(str) {
    try {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        return btoa(bin);
    } catch (e) {
        console.error('Hash encoding failed:', e);
        return 'hash-err';
    }
}

async function graphGet(path, token, extraHeaders = {}, suppressError = false) {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            ...extraHeaders,
        },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (suppressError) return null;
        const msg = json.error?.message || json.error?.code || `Microsoft Graph error (${res.status})`;
        throw new Error(msg);
    }
    return json;
}

async function resolveMicrosoftDriveItem(spreadsheetUrl, token) {
    try {
        const url = new URL(spreadsheetUrl);
        const driveId = url.searchParams.get('driveId');
        const docId = url.searchParams.get('docId');
        
        if (driveId && docId) {
            // Format: driveId!itemId
            const itemId = docId.includes('!') ? docId.split('!')[1] : docId;
            return await graphGet(`/drives/${driveId}/items/${itemId}`, token);
        }
    } catch (e) {
        // Fallback
    }

    const shareId = encodeMicrosoftShareId(spreadsheetUrl);
    return graphGet(`/shares/${shareId}/driveItem`, token, {
        Prefer: 'redeemSharingLink',
    });
}

export async function listMicrosoftWorksheets(spreadsheetUrl) {
    const token = await getAccessTokenForProvider('MICROSOFT');
    const item = await resolveMicrosoftDriveItem(spreadsheetUrl, token);
    const driveId = item.parentReference?.driveId;
    const itemId = item.id;
    if (!driveId || !itemId) {
        throw new Error('Could not resolve Excel file from sharing link. Use a direct OneDrive or SharePoint link.');
    }
    const data = await graphGet(`/drives/${driveId}/items/${itemId}/workbook/worksheets`, token);
    return (data.value || []).map((ws) => ws.name);
}

async function fetchMicrosoftRows({ spreadsheetUrl, sheetName }) {
    if (!spreadsheetUrl?.trim()) throw new Error('Paste a Microsoft Excel sharing link (OneDrive or SharePoint).');
    const token = await getAccessTokenForProvider('MICROSOFT');
    const item = await resolveMicrosoftDriveItem(spreadsheetUrl, token);
    const driveId = item.parentReference?.driveId;
    const itemId = item.id;
    const etag = item.eTag;
    if (!driveId || !itemId) {
        throw new Error('Could not resolve Excel file. Ensure the link is a sharing URL to an .xlsx file.');
    }
    const safeSheet = sheetName.replace(/'/g, "''");
    const data = await graphGet(
        `/drives/${driveId}/items/${itemId}/workbook/worksheets('${safeSheet}')/usedRange(valuesOnly=true)`,
        token,
    );
    const shareId = encodeMicrosoftShareId(spreadsheetUrl);
    return { 
        rows: data.values || [], 
        sourceKey: `microsoft:${shareId.slice(0, 32)}`,
        etag,
        driveId,
        itemId,
        shareId,
        useSharesApi: !(() => {
            try {
                const u = new URL(spreadsheetUrl);
                return !!(u.searchParams.get('driveId') && u.searchParams.get('docId'));
            } catch {
                return false;
            }
        })(),
    };
}

async function pushMicrosoftRows({ driveId, itemId, shareId, useSharesApi, sheetName, rowsToPush, columnMapping = {} }) {
    if (!rowsToPush.length) return 0;
    const token = await getAccessTokenForProvider('MICROSOFT');
    const sharesBase = useSharesApi && shareId ? `/shares/${shareId}/driveItem` : null;
    const driveBase = `/drives/${driveId}/items/${itemId}`;
    let base = sharesBase || driveBase;
    
    // 1. Find the used range to know where to append
    const safeSheet = sheetName.replace(/'/g, "''");
    let usedRange = await graphGet(
        `${base}/workbook/worksheets('${safeSheet}')/usedRange`,
        token,
        {},
        true // Suppress error for MSA fallback
    );

    if (!usedRange && sharesBase) {
        base = driveBase;
        usedRange = await graphGet(
            `${base}/workbook/worksheets('${safeSheet}')/usedRange`,
            token
        );
    } else if (!usedRange) {
        throw new Error('Could not read Excel workbook used range.');
    }
    
    // Address format is usually "Sheet1!A1:H10"
    const address = usedRange.address || '';
    const lastRowMatch = address.match(/\d+$/);
    const lastRowIndex = lastRowMatch ? parseInt(lastRowMatch[0]) : 1;
    const nextRowIndex = lastRowIndex + 1;
    
    // 2. Prepare the data for Excel respecting the mapping
    const mapping = columnMapping || {};
    const mappedIndices = Object.values(mapping).filter(v => v >= 0);
    const maxCol = mappedIndices.length > 0 ? Math.max(...mappedIndices) : 9;
    
    const values = rowsToPush.map(r => {
        const rowData = new Array(maxCol + 1).fill('');
        const syncKey = `app:txn:${r.id}`;
        
        const setVal = (key, val) => {
            const idx = mapping[key];
            if (idx >= 0) rowData[idx] = val;
        };

        setVal('date', r.date);
        setVal('type', r.type === 'OUT' ? 'DR' : 'CR');
        setVal('amount', r.amount);
        setVal('category', r.cat);
        setVal('description', r.description || '');
        setVal('wallet', r.wallet);
        setVal('vendor', r.vendor_name || '');
        setVal('reference', r.vendor_invoice || '');
        setVal('sync_id', syncKey);
        setVal('sync_status', 'SYNCED');
        
        return rowData;
    });
    
    const colLetter = (n) => {
        let letter = '';
        while (n >= 0) {
            letter = String.fromCharCode((n % 26) + 65) + letter;
            n = Math.floor(n / 26) - 1;
        }
        return letter;
    };

    const rangeAddress = `A${nextRowIndex}:${colLetter(maxCol)}${nextRowIndex + values.length - 1}`;
    
    let res = await fetch(`https://graph.microsoft.com/v1.0${base}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values })
    });

    if (!res.ok && base === sharesBase) {
        const json = await res.json().catch(() => ({}));
        const msg = json?.error?.message || '';
        if (String(msg).includes('not supported for MSA')) {
            // Retry via drive endpoints for MSA accounts
            base = driveBase;
            res = await fetch(`https://graph.microsoft.com/v1.0${base}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ values })
            });
        } else {
            // put body back into the usual error handler below
            // eslint-disable-next-line no-param-reassign
            res = new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers: res.headers });
        }
    }
    
    if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        const code = json?.error?.code ? ` (${json.error.code})` : '';
        const msg = json?.error?.message || `Failed to push rows to Excel (${res.status})`;
        throw new Error(`${msg}${code}`);
    }
    
    return values.length;
}

function getSyncSettings() {
    return portalState.finances?.ledgerSyncSettings || null;
}

async function saveSyncSettings(patch) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!supabase || !apartment_id) return;
    
    // 1. Get existing settings to know which columns we can safely send
    // This helps avoid 400 errors if the user hasn't run the latest SQL
    const { data: existing } = await supabase
        .from('ledger_sync_settings')
        .select('*')
        .eq('apartment_id', apartment_id)
        .maybeSingle();

    const row = {
        apartment_id,
        ...patch,
        updated_at: new Date().toISOString(),
    };

    // If we have existing data, we can filter out keys that don't exist in the table
    // but for now, we'll just try the upsert and let the caller handle the error.
    const { error } = await supabase.from('ledger_sync_settings').upsert(row, { onConflict: 'apartment_id' });
    
    if (error) {
        console.error('saveSyncSettings error:', error);
        // If it's a 400 or constraint violation, try a "safe" subset.
        if (error.code === '23514' || error.code === 'PGRST204' || error.message.includes('column') || error.status === 400) {
            console.log('Attempting safe fallback for sync settings...');
            const safePatch = {
                apartment_id,
                provider: patch.provider,
                spreadsheet_url: patch.spreadsheet_url,
                sheet_name: patch.sheet_name,
                range_a1: patch.range_a1,
                sync_interval_minutes: patch.sync_interval_minutes,
                last_synced_at: patch.last_synced_at,
                last_synced_by: patch.last_synced_by,
                // Fallback to 'OK' if 'WARN' is not allowed by constraint
                last_sync_status: (error.code === '23514' && patch.last_sync_status === 'WARN') ? 'OK' : patch.last_sync_status,
                last_sync_message: patch.last_sync_message,
                updated_at: new Date().toISOString()
            };
            await supabase.from('ledger_sync_settings').upsert(safePatch, { onConflict: 'apartment_id' });
        } else {
            throw new Error(error.message);
        }
    }
    await pullState();
}

function formatSyncInterval(mins) {
    if (!mins) return 'Manual only';
    if (mins === 15) return 'Every 15 minutes';
    if (mins === 60) return 'Every hour';
    if (mins === 360) return 'Every 6 hours';
    if (mins === 1440) return 'Daily';
    return `Every ${mins} minutes`;
}

function getBackgroundSyncReadiness(s) {
    const provider = s?.provider === 'GOOGLE' ? 'GOOGLE' : 'MICROSOFT';
    const conn = getMyOAuthConnectionMeta(provider);
    const appReady = oauthAppConfigured(provider);
    const items = [
        {
            ok: !!s?.spreadsheet_url,
            label: 'Spreadsheet URL saved',
            hint: 'Set the workbook link under Target Spreadsheet.',
        },
        {
            ok: appReady,
            label: `${provider === 'GOOGLE' ? 'Google' : 'Microsoft'} OAuth app configured`,
            hint: 'Add the Client ID from your cloud console.',
        },
    ];

    if (provider === 'MICROSOFT') {
        items.push({
            ok: oauthAppHasClientSecret('MICROSOFT'),
            label: 'Microsoft client secret saved',
            hint: 'Create a secret in Azure → App registrations → Certificates & secrets.',
        });
        items.push({
            ok: !!(conn?.account_email && conn?.background_capable),
            label: 'Microsoft connected for background sync',
            hint: 'Click Connect Microsoft below. Sign in with the personal account that owns the Excel file.',
        });
    } else {
        items.push({
            ok: oauthAppHasClientSecret('GOOGLE'),
            label: 'Google client secret saved',
            hint: 'Add a client secret in Google Cloud Console.',
        });
        items.push({
            ok: !!(conn?.account_email && conn?.background_capable),
            label: 'Google connected for background sync',
            hint: 'Click Connect Google below.',
        });
    }

    items.push({
        ok: (s?.sync_interval_minutes || 0) > 0,
        label: 'Auto-sync schedule enabled',
        hint: 'Choose Daily (or another interval) in the dropdown above and click Save schedule.',
    });

    return { provider, items, ready: items.every((i) => i.ok), conn };
}

export function renderAdminSyncPanel() {
    const el = document.getElementById('admin-sync-panel-container');
    if (!el) return;
    initActiveProvider();
    const s = getSyncSettings();
    const microsoft = getOAuthApp('MICROSOFT');
    const google = getOAuthApp('GOOGLE');
    const msConfigured = !!microsoft?.client_id;
    const googleConfigured = !!google?.client_id;
    const urlValue = s?.spreadsheet_url || '';
    const savedProvider = s?.provider === 'GOOGLE' ? 'GOOGLE' : 'MICROSOFT';
    const hasUrl = !!urlValue;
    const msAppReady = oauthAppConfigured('MICROSOFT');
    const googleAppReady = oauthAppConfigured('GOOGLE');
    const canConnect = (activeProvider === 'MICROSOFT' && msAppReady) || (activeProvider === 'GOOGLE' && googleAppReady);
    const bgSync = getBackgroundSyncReadiness(s);
    const msSecretSaved = oauthAppHasClientSecret('MICROSOFT');
    const googleSecretSaved = oauthAppHasClientSecret('GOOGLE');

    el.innerHTML = `
      <div class="ledger-sync-admin-page">
        <header class="admin-panel-header" style="margin-bottom: 2rem;">
          <div>
            <h3 class="admin-panel-title">Spreadsheet Integration Configuration</h3>
            <p class="admin-panel-desc">Configure Microsoft Excel Online or Google Sheets sync for your society's income &amp; expenses.</p>
          </div>
        </header>

        <div class="ledger-sync-admin-grid">
          <!-- 1. Microsoft App Registration -->
          <div class="ledger-sync-card">
            <div class="ledger-sync-card__header">
              <div class="ledger-sync-card__title">
                <i class="fa-brands fa-microsoft"></i>
                <span>Microsoft Azure App</span>
              </div>
              <span class="ledger-sync-card__status ${msConfigured ? 'ledger-sync-card__status--ok' : 'ledger-sync-card__status--pending'}">
                ${msConfigured ? 'Configured' : 'Pending'}
              </span>
            </div>
            
            <p class="gate-wizard__hint">Register CommunityHub in your Azure Portal to enable Excel Online sync.</p>

            <div class="ledger-sync-section">
              <span class="ledger-sync-section-label">Redirect URI</span>
              <div class="ledger-sync-uri-box">
                <code>${getMicrosoftRedirectUri()}</code>
                <button type="button" class="btn btn-outline btn--small" id="admin-oauth-copy-redirect">Copy</button>
              </div>
              <p class="gate-wizard__hint" style="margin-top: 0.5rem;">Add as <strong>Web</strong> redirect URI (for background sync with client secret). SPA redirect is only needed if you skip the secret.</p>
            </div>

            <div class="ledger-sync-form" style="display: flex; flex-direction: column; gap: 1rem;">
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                <div class="ledger-sync-form__field">
                  <label class="ledger-sync-form__label">Client ID</label>
                  <input type="text" id="admin-oauth-ms-client" class="expense-combobox" value="${microsoft?.client_id || ''}" placeholder="Application ID" />
                </div>
                <div class="ledger-sync-form__field">
                  <label class="ledger-sync-form__label">Tenant ID</label>
                  <input type="text" id="admin-oauth-ms-tenant" class="expense-combobox" value="${microsoft?.tenant_id || 'common'}" placeholder="common or GUID" />
                </div>
              </div>
              <div class="ledger-sync-form__field">
                <label class="ledger-sync-form__label">Client Secret</label>
                <input type="password" id="admin-oauth-ms-secret" class="expense-combobox" value="" placeholder="${msSecretSaved ? 'Saved — leave blank to keep' : 'Required for background sync'}" autocomplete="new-password" />
                <p class="gate-wizard__hint" style="margin-top:0.35rem;">Used only on the server to refresh tokens during the Vercel cron job. Never shown in the browser after save.</p>
              </div>
              <button type="button" class="btn btn-primary" id="admin-oauth-save-ms" style="margin-top: 0.5rem;">
                <i class="fa-solid fa-floppy-disk"></i> Save Microsoft Settings
              </button>
            </div>
          </div>

          <!-- 2. Google Cloud OAuth -->
          <div class="ledger-sync-card">
            <div class="ledger-sync-card__header">
              <div class="ledger-sync-card__title">
                <i class="fa-brands fa-google"></i>
                <span>Google Cloud OAuth</span>
              </div>
              <span class="ledger-sync-card__status ${googleConfigured ? 'ledger-sync-card__status--ok' : 'ledger-sync-card__status--pending'}">
                ${googleConfigured ? 'Configured' : 'Pending'}
              </span>
            </div>

            <p class="gate-wizard__hint">Create an OAuth client in Google Cloud Console to enable Google Sheets sync.</p>

            <div class="ledger-sync-section">
              <span class="ledger-sync-section-label">Redirect URI</span>
              <div class="ledger-sync-uri-box">
                <code>${getAppRedirectUri()}</code>
                <button type="button" class="btn btn-outline btn--small" id="admin-oauth-copy-google-redirect">Copy</button>
              </div>
              <p class="gate-wizard__hint" style="margin-top: 0.5rem;">Add this under <strong>Authorized redirect URIs</strong> for a Web application OAuth client.</p>
            </div>

            <div class="ledger-sync-form" style="display: flex; flex-direction: column; gap: 1rem;">
              <div class="ledger-sync-form__field">
                <label class="ledger-sync-form__label">Client ID</label>
                <input type="text" id="admin-oauth-google-client" class="expense-combobox" value="${google?.client_id || ''}" placeholder="OAuth 2.0 Client ID" />
              </div>
              <div class="ledger-sync-form__field">
                <label class="ledger-sync-form__label">Client Secret</label>
                <input type="password" id="admin-oauth-google-secret" class="expense-combobox" value="" placeholder="${googleSecretSaved ? 'Saved — leave blank to keep' : 'Optional (web client type)'}" autocomplete="new-password" />
              </div>
              <button type="button" class="btn btn-primary" id="admin-oauth-save-google" style="margin-top: 0.25rem;">
                <i class="fa-solid fa-floppy-disk"></i> Save Google Settings
              </button>
            </div>
          </div>

          <!-- 3. Target Spreadsheet Settings -->
          <div class="ledger-sync-card ledger-sync-card--full">
            <div class="ledger-sync-card__header">
              <div class="ledger-sync-card__title">
                <i class="fa-solid fa-table"></i>
                <span>Target Spreadsheet</span>
              </div>
              <span class="ledger-sync-card__status ${urlValue ? 'ledger-sync-card__status--ok' : 'ledger-sync-card__status--pending'}">
                ${urlValue ? 'Linked' : 'Not Linked'}
              </span>
            </div>

            <p class="gate-wizard__hint">Specify the Excel or Google Sheet where transactions should be synced.</p>

            <div class="ledger-sync-form" style="display: flex; flex-direction: column; gap: 1.25rem;">
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                <div class="ledger-sync-form__field">
                  <label class="ledger-sync-form__label">Provider</label>
                  <select id="admin-ledger-sync-provider" class="expense-combobox">
                    <option value="MICROSOFT" ${savedProvider === 'MICROSOFT' ? 'selected' : ''}>Microsoft Excel Online</option>
                    <option value="GOOGLE" ${savedProvider === 'GOOGLE' ? 'selected' : ''}>Google Sheets</option>
                  </select>
                </div>
                <div class="ledger-sync-form__field">
                  <label class="ledger-sync-form__label">Auto-Sync</label>
                  <select id="admin-ledger-sync-interval" class="expense-combobox">
                    <option value="0" ${s?.sync_interval_minutes === 0 ? 'selected' : ''}>Manual only</option>
                    <option value="15" ${s?.sync_interval_minutes === 15 ? 'selected' : ''}>Every 15 mins</option>
                    <option value="60" ${s?.sync_interval_minutes === 60 ? 'selected' : ''}>Every 1 hour</option>
                    <option value="360" ${s?.sync_interval_minutes === 360 ? 'selected' : ''}>Every 6 hours</option>
                    <option value="1440" ${s?.sync_interval_minutes === 1440 ? 'selected' : ''}>Daily</option>
                  </select>
                </div>
              </div>

              <div class="ledger-sync-form__field">
                <label class="ledger-sync-form__label">Spreadsheet URL</label>
                <input type="url" id="admin-ledger-sync-url" class="expense-combobox"
                  placeholder="${savedProvider === 'GOOGLE' ? 'https://docs.google.com/spreadsheets/d/...' : 'https://...sharepoint.com/... or OneDrive link'}"
                  value="${urlValue}" />
              </div>
              
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                <div class="ledger-sync-form__field">
                  <label class="ledger-sync-form__label">Sheet / Tab Name</label>
                  <input type="text" id="admin-ledger-sync-sheet" class="expense-combobox" value="${s?.sheet_name || 'Transactions'}" />
                </div>
                <div class="ledger-sync-form__field" id="admin-ledger-sync-range-wrap" style="${savedProvider === 'GOOGLE' ? '' : 'display:none;'}">
                  <label class="ledger-sync-form__label">Column Range (Google)</label>
                  <input type="text" id="admin-ledger-sync-range" class="expense-combobox" value="${s?.range_a1 || 'A:J'}" placeholder="A:J" />
                </div>
              </div>

              <button type="button" class="btn btn-primary" id="admin-ledger-save-settings" style="margin-top: 0.25rem;">
                <i class="fa-solid fa-link"></i> Save Spreadsheet Settings
              </button>
            </div>
            
            <div style="margin-top: auto; padding-top: 1rem; border-top: 1px solid var(--border);">
              <p class="gate-wizard__hint">
                <i class="fa-solid fa-circle-info"></i> 
                Changes here affect all society members. Ensure the spreadsheet has the correct column headers.
              </p>
            </div>
          </div>

          <!-- 4. Background sync job -->
          <div class="ledger-sync-card ledger-sync-card--full">
            <div class="ledger-sync-card__header">
              <div class="ledger-sync-card__title">
                <i class="fa-solid fa-clock"></i>
                <span>Background Sync Job</span>
              </div>
              <span class="ledger-sync-card__status ${bgSync.ready ? 'ledger-sync-card__status--ok' : 'ledger-sync-card__status--pending'}">
                ${bgSync.ready ? 'Ready' : 'Setup needed'}
              </span>
            </div>

            <p class="gate-wizard__hint">
              When auto-sync is enabled, a Vercel cron calls <code>/api/sync</code> daily.
              Societies due for sync are processed server-side using your Microsoft connection below
              (refresh token + client secret — no browser login needed on each run).
            </p>

            <div class="ledger-sync-bg-job-meta">
              <div><strong>Schedule:</strong> ${formatSyncInterval(s?.sync_interval_minutes || 0)} (Vercel cron checks daily)</div>
              <div><strong>Provider:</strong> ${bgSync.provider === 'GOOGLE' ? 'Google Sheets' : 'Microsoft Excel'}</div>
              <div><strong>Background connection:</strong> ${bgSync.conn?.account_email || 'Not connected'}</div>
              ${s?.last_synced_at ? `<div><strong>Last run:</strong> ${new Date(s.last_synced_at).toLocaleString('en-IN')}${s.last_sync_message ? ` — ${s.last_sync_message}` : ''}</div>` : ''}
              ${s?.last_sync_status === 'ERROR' ? `<div class="ledger-sync-bg-job-meta__error"><i class="fa-solid fa-triangle-exclamation"></i> ${s.last_sync_message || 'Last background sync failed.'}</div>` : ''}
            </div>

            <div class="ledger-sync-form" style="margin-top: 1rem; padding: 1rem; border: 1px solid var(--border); border-radius: 8px; background: #fff;">
              <label class="ledger-sync-form__label" for="admin-bg-sync-interval">Auto-sync interval</label>
              <p class="gate-wizard__hint" style="margin: 0.25rem 0 0.75rem;">
                Cron runs once daily on Vercel; societies sync when this interval has elapsed since the last run.
              </p>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
                <select id="admin-bg-sync-interval" class="expense-combobox" style="min-width: 12rem;">
                  <option value="0" ${(s?.sync_interval_minutes || 0) === 0 ? 'selected' : ''}>Manual only (cron skips)</option>
                  <option value="15" ${s?.sync_interval_minutes === 15 ? 'selected' : ''}>Every 15 minutes</option>
                  <option value="60" ${s?.sync_interval_minutes === 60 ? 'selected' : ''}>Every 1 hour</option>
                  <option value="360" ${s?.sync_interval_minutes === 360 ? 'selected' : ''}>Every 6 hours</option>
                  <option value="1440" ${s?.sync_interval_minutes === 1440 ? 'selected' : ''}>Daily</option>
                </select>
                <button type="button" class="btn btn-primary btn--small" id="admin-bg-save-schedule">
                  <i class="fa-solid fa-floppy-disk"></i> Save schedule
                </button>
              </div>
            </div>

            <div class="ledger-sync-service-account" style="margin-top: 1rem; padding: 1rem; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-alt);">
              <p class="gate-wizard__hint" style="margin-top: 0;">
                Sign in once with the <strong>personal Microsoft account</strong> that owns the Excel file
                (e.g. your hotmail/outlook login). Requires client secret saved above.
                The server stores a refresh token and renews access automatically.
              </p>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top: 0.75rem;">
                <button type="button" class="btn btn-primary btn--small" id="admin-bg-connect-microsoft" ${savedProvider === 'MICROSOFT' && msSecretSaved ? '' : 'disabled'}>
                  <i class="fa-brands fa-microsoft"></i> Connect Microsoft (background sync)
                </button>
              </div>
            </div>

            <ul class="ledger-sync-readiness">
              ${bgSync.items.map((item) => `
                <li class="ledger-sync-readiness__item ${item.ok ? 'ledger-sync-readiness__item--ok' : 'ledger-sync-readiness__item--pending'}">
                  <i class="fa-solid ${item.ok ? 'fa-circle-check' : 'fa-circle'}"></i>
                  <div>
                    <strong>${item.label}</strong>
                    ${item.ok ? '' : `<span class="ledger-sync-readiness__hint">${item.hint}</span>`}
                  </div>
                </li>
              `).join('')}
            </ul>

            <div style="margin-top: 1rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button type="button" class="btn btn-outline btn--small" id="admin-bg-sync-run" ${bgSync.ready ? '' : 'disabled'}>
                <i class="fa-solid fa-bolt"></i> Run server sync now
              </button>
              <span class="gate-wizard__hint" style="margin:0.25rem 0 0;">
                Runs a one-off sync on the server for this society and updates the status above.
              </span>
            </div>

            <p class="gate-wizard__hint" style="margin-top: 1rem;">
              <strong>Token refresh:</strong>
              Access tokens expire hourly; the client secret lets the server use your stored refresh token automatically on each cron run.
            </p>
          </div>
        </div>

        <div class="ledger-sync-card ledger-sync-card--ops" style="margin-top: 1.5rem;">
          <div class="ledger-sync-card__header">
            <div class="ledger-sync-card__title">
              <i class="fa-solid fa-rotate"></i>
              <span>Connect &amp; Sync</span>
            </div>
          </div>
          <div id="admin-sync-ops-root">
            ${buildSyncOpsHtml('admin-', s, hasUrl, canConnect)}
          </div>
        </div>
      </div>
    `;

    // Wire events
    document.getElementById('admin-oauth-copy-redirect')?.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(getMicrosoftRedirectUri());
            alert('Redirect URI copied.');
        } catch {
            alert(getMicrosoftRedirectUri());
        }
    });

    document.getElementById('admin-oauth-copy-google-redirect')?.addEventListener('click', async () => {
        const uri = getAppRedirectUri();
        try {
            await navigator.clipboard.writeText(uri);
            alert('Redirect URI copied.');
        } catch {
            alert(uri);
        }
    });

    document.getElementById('admin-oauth-save-ms')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-oauth-save-ms');
        await withButtonBusy(btn, 'Saving…', async () => {
            await saveOAuthApp({
                provider: 'MICROSOFT',
                client_id: document.getElementById('admin-oauth-ms-client')?.value,
                tenant_id: document.getElementById('admin-oauth-ms-tenant')?.value,
                client_secret: document.getElementById('admin-oauth-ms-secret')?.value,
            });
            alert('Microsoft OAuth settings saved.');
            renderAdminSyncPanel();
        }).catch((e) => alert(e.message));
    });

    document.getElementById('admin-oauth-save-google')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-oauth-save-google');
        await withButtonBusy(btn, 'Saving…', async () => {
            await saveOAuthApp({
                provider: 'GOOGLE',
                client_id: document.getElementById('admin-oauth-google-client')?.value,
                tenant_id: '',
                client_secret: document.getElementById('admin-oauth-google-secret')?.value,
            });
            alert('Google OAuth settings saved.');
            renderAdminSyncPanel();
        }).catch((e) => alert(e.message));
    });

    // Show/hide Google-specific range field when provider changes
    document.getElementById('admin-ledger-sync-provider')?.addEventListener('change', (e) => {
        const rangeWrap = document.getElementById('admin-ledger-sync-range-wrap');
        if (rangeWrap) rangeWrap.style.display = e.target.value === 'GOOGLE' ? '' : 'none';
    });

    document.getElementById('admin-ledger-save-settings')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-ledger-save-settings');
        const url = document.getElementById('admin-ledger-sync-url')?.value?.trim();
        const sheet = document.getElementById('admin-ledger-sync-sheet')?.value?.trim();
        const interval = parseInt(document.getElementById('admin-ledger-sync-interval')?.value, 10);
        const providerSelect = document.getElementById('admin-ledger-sync-provider')?.value;
        const rangeA1 = document.getElementById('admin-ledger-sync-range')?.value?.trim() || 'A:J';
        const provider = providerSelect || detectProviderFromUrl(url) || 'MICROSOFT';

        await withButtonBusy(btn, 'Saving…', async () => {
            await saveSyncSettings({
                spreadsheet_url: url,
                sheet_name: sheet,
                sync_interval_minutes: interval,
                provider,
                range_a1: rangeA1,
            });
            startAutoSync();
            alert('Spreadsheet settings saved.');
            renderAdminSyncPanel();
        }).catch((e) => alert(e.message));
    });

    document.getElementById('admin-bg-connect-microsoft')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-bg-connect-microsoft');
        const snapshot = setButtonBusy(btn, 'Redirecting to Microsoft…');
        try {
            await startMicrosoftWebConnect();
        } catch (e) {
            clearButtonBusy(btn, snapshot);
            alert(e.message);
        }
    });

    document.getElementById('admin-bg-save-schedule')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-bg-save-schedule');
        const interval = parseInt(document.getElementById('admin-bg-sync-interval')?.value, 10);
        if (Number.isNaN(interval)) return alert('Choose a valid interval.');
        await withButtonBusy(btn, 'Saving schedule…', async () => {
            await saveSyncSettings({ sync_interval_minutes: interval });
            startAutoSync();
            alert(interval === 0
                ? 'Schedule saved: manual only (background cron will skip this society).'
                : `Schedule saved: ${formatSyncInterval(interval)}.`);
            renderAdminSyncPanel();
        }).catch((e) => alert(e.message || 'Could not save schedule.'));
    });

    document.getElementById('admin-bg-sync-run')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-bg-sync-run');
        await withButtonBusy(btn, 'Running server sync…', async () => {
            const apartment_id = portalState.access?.activeApartmentId;
            if (!apartment_id || apartment_id === 'apt-default') throw new Error('Select a society first.');
            const { data: s } = await supabase.auth.getSession();
            const token = s?.session?.access_token;
            if (!token) throw new Error('Sign in again to run the server sync.');

            const res = await fetch('/api/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ apartment_id }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Server sync failed.');

            await pullState();
            renderAdminSyncPanel();

            const r = json.result || {};
            alert(`Server sync complete.\n\nPulled: ${r.imported ?? 0} new, ${r.updated ?? 0} updated.\nPushed: ${r.pushed ?? 0} new.`);
        }).catch((err) => alert(err.message || String(err)));
    });

    const opsRoot = document.getElementById('admin-sync-ops-root');
    if (opsRoot) {
        wireSyncOps(opsRoot, 'admin-', renderAdminSyncPanel);
        if (hasUrl) void refreshMappingUI();
    }
}

async function fetchGoogleRows({ spreadsheetUrl, sheetName, rangeA1 }) {
    const sheetId = parseGoogleSheetId(spreadsheetUrl);
    if (!sheetId) throw new Error('Paste a valid Google Sheets URL.');
    const token = await getAccessTokenForProvider('GOOGLE');
    const range = encodeURIComponent(`${sheetName}!${rangeA1}`);
    const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Google Sheets request failed.');
    return { rows: json.values || [], sourceKey: `google:${sheetId}` };
}

export function parseLedgerRowsFromAoA(aoa, sourceKey, customMapping = null) {
    if (!aoa?.length) return [];
    const headersRaw = (aoa[0] || []).map((h) => String(h || '').trim());
    const headers = headersRaw.map(h => h.toLowerCase());
    
    const findCol = (names) => headers.findIndex((h) => names.some((n) => h.includes(n)));

    const mapping = customMapping || {
        date: findCol(['date']),
        type: findCol(['type', 'in/out', 'direction']),
        amount: findCol(['amount', 'value']),
        dr: findCol(['debit', 'dr', 'withdraw']),
        cr: findCol(['credit', 'cr', 'deposit']),
        category: findCol(['category', 'cat']),
        description: findCol(['description', 'narration', 'particular', 'notes']),
        wallet: findCol(['wallet', 'ledger']),
        vendor: findCol(['vendor', 'payee']),
        reference: findCol(['reference', 'invoice', 'ref']),
        sync_id: findCol(['syncid', 'sync_id', 'internal_id']),
        sync_status: findCol(['status', 'sync_status', 'sync_state']),
    };

    const dateCol = mapping.date;
    const typeCol = mapping.type;
    const amtCol = mapping.amount;
    const debitCol = mapping.dr;
    const creditCol = mapping.cr;
    const catCol = mapping.category;
    const descCol = mapping.description;
    const walletCol = mapping.wallet;
    const vendorCol = mapping.vendor;
    const refCol = mapping.reference;
    const syncIdCol = mapping.sync_id;
    const syncStatusCol = mapping.sync_status;

    if (dateCol < 0) throw new Error('Sheet must have a Date column. Download the template for the expected format.');

    const parsed = [];
    console.log(`Parsing ${aoa.length - 1} rows from sheet...`);
    for (let i = 1; i < aoa.length; i += 1) {
        const row = aoa[i] || [];
        const rowNum = i + 1;
        const date = parseDate(row[dateCol]);
        
        if (!date) {
            console.warn(`Row ${rowNum}: Skipped - Invalid or missing Date in column ${dateCol + 1} (${row[dateCol]})`);
            continue;
        }

        let type = typeCol >= 0 ? normType(row[typeCol]) : null;
        let amount = amtCol >= 0 ? parseAmount(row[amtCol]) : 0;
        
        if (!type && debitCol >= 0 && parseAmount(row[debitCol]) > 0) {
            type = 'OUT';
            amount = parseAmount(row[debitCol]);
        }
        if (!type && creditCol >= 0 && parseAmount(row[creditCol]) > 0) {
            type = 'IN';
            amount = parseAmount(row[creditCol]);
        }
        
        if (!type) {
            console.warn(`Row ${rowNum}: Skipped - Could not determine Type (IN/OUT or Dr/Cr)`);
            continue;
        }
        if (amount <= 0) {
            console.warn(`Row ${rowNum}: Skipped - Amount is 0 or invalid (${amount})`);
            continue;
        }

        const syncId = syncIdCol >= 0 ? String(row[syncIdCol] || '').trim() : null;

        // Content hash for change detection
        const hashBase = `${date}|${type}|${amount}|${String(row[catCol] || '')}|${String(row[descCol] || '')}`;
        const syncHash = safeHash(hashBase);

        parsed.push({
            row_index: rowNum,
            external_sync_key: syncId || `${sourceKey}:row:${rowNum}`,
            sync_hash: syncHash,
            date,
            type,
            amount,
            cat: normCat(catCol >= 0 ? row[catCol] : '', type),
            description: descCol >= 0 ? String(row[descCol] || '').trim() : '',
            wallet: walletCol >= 0 ? normWallet(row[walletCol]) : 'CASH',
            vendor_name: vendorCol >= 0 ? String(row[vendorCol] || '').trim() || null : null,
            vendor_invoice: refCol >= 0 ? String(row[refCol] || '').trim() || null : null,
        });
    }
    console.log(`Parsing complete. ${parsed.length} / ${aoa.length - 1} rows valid.`);
    return parsed;
}

function validateLedgerHeaderMapping(aoa, customMapping = null) {
    const headersRaw = (aoa?.[0] || []).map((h) => String(h || '').trim());
    const headers = headersRaw.map((h) => h.toLowerCase());
    const findCol = (names) => headers.findIndex((h) => names.some((n) => h.includes(n)));

    const mapping = customMapping || {
        date: findCol(['date']),
        type: findCol(['type', 'in/out', 'direction']),
        amount: findCol(['amount', 'value']),
        dr: findCol(['debit', 'dr', 'withdraw']),
        cr: findCol(['credit', 'cr', 'deposit']),
        category: findCol(['category', 'cat']),
        description: findCol(['description', 'narration', 'particular', 'notes']),
        wallet: findCol(['wallet', 'ledger']),
        vendor: findCol(['vendor', 'payee']),
        reference: findCol(['reference', 'invoice', 'ref']),
        sync_id: findCol(['syncid', 'sync_id', 'internal_id']),
        sync_status: findCol(['status', 'sync_status', 'sync_state']),
    };

    const errors = [];
    const warnings = [];

    if (mapping.date < 0) errors.push('Missing required column: Date');

    const hasDrCr = mapping.dr >= 0 || mapping.cr >= 0;
    const hasTypeAmount = mapping.type >= 0 && mapping.amount >= 0;
    const hasSingleAmount = mapping.amount >= 0;

    if (!hasTypeAmount && !hasDrCr) {
        errors.push('Missing required columns: either (Type + Amount) OR (Dr and/or Cr).');
    } else if (hasDrCr && hasSingleAmount) {
        warnings.push('Both Amount and Dr/Cr columns exist. Dr/Cr will be used only if Type is missing.');
    }

    // “New / extra” columns: not used by our parser
    const usedIdx = new Set(Object.values(mapping).filter((i) => i >= 0));
    const extras = headersRaw
        .map((h, idx) => ({ h, idx }))
        .filter(({ h, idx }) => h && !usedIdx.has(idx))
        .map(({ h }) => h);
    if (extras.length) warnings.push(`Extra columns will be ignored: ${extras.join(', ')}`);

    const nameAt = (idx) => (idx >= 0 ? headersRaw[idx] : '—');
    const pretty = [
        ['Date', nameAt(mapping.date)],
        ['Type', nameAt(mapping.type)],
        ['Amount', nameAt(mapping.amount)],
        ['Dr', nameAt(mapping.dr)],
        ['Cr', nameAt(mapping.cr)],
        ['Category', nameAt(mapping.category)],
        ['Description', nameAt(mapping.description)],
        ['Wallet', nameAt(mapping.wallet)],
        ['Vendor', nameAt(mapping.vendor)],
        ['Reference', nameAt(mapping.reference)],
    ];

    return { mapping, pretty, errors, warnings };
}

function renderLedgerMappingResult({ mapping, pretty, errors, warnings }, headersRaw = []) {
    const fields = [
        { key: 'date', label: 'Date', db: 'date' },
        { key: 'type', label: 'Type', db: 'type' },
        { key: 'amount', label: 'Amount', db: 'amount' },
        { key: 'dr', label: 'Debit (Dr)', db: 'amount' },
        { key: 'cr', label: 'Credit (Cr)', db: 'amount' },
        { key: 'category', label: 'Category', db: 'cat' },
        { key: 'description', label: 'Description', db: 'description' },
        { key: 'wallet', label: 'Wallet/Ledger', db: 'wallet' },
        { key: 'vendor', label: 'Vendor/Payee', db: 'vendor_name' },
        { key: 'reference', label: 'Reference/Invoice', db: 'vendor_invoice' },
        { key: 'sync_id', label: 'Sync ID (Internal)', db: 'external_sync_key' },
        { key: 'sync_status', label: 'Sync Status', db: '(visual only)' },
    ];

    const rows = fields
        .map((f) => {
            const current = mapping[f.key];
            return `
                <div class="ledger-sync-map__row">
                    <div class="ledger-sync-map__field-info">
                        <span class="ledger-sync-map__label">${f.label}</span>
                        <code class="ledger-sync-map__db-name">${f.db}</code>
                    </div>
                    <select class="ledger-sync-map__select" data-field="${f.key}">
                        <option value="-1">— Not mapped —</option>
                        ${headersRaw.map((h, i) => `<option value="${i}" ${current === i ? 'selected' : ''}>${h || `Column ${i + 1}`}</option>`).join('')}
                    </select>
                </div>`;
        })
        .join('');
    const errHtml = errors?.length
        ? `<div class="ledger-sync-status ledger-sync-status--error" style="margin:0.5rem 0;">
            <strong>Sheet mapping errors</strong><br/>
            ${errors.map((e) => `• ${e}`).join('<br/>')}
           </div>`
        : '';
    const warnHtml = warnings?.length
        ? `<div class="ledger-sync-status ledger-sync-status--warn" style="margin:0.5rem 0;">
            <strong>Mapping warnings</strong><br/>
            ${warnings.map((w) => `• ${w}`).join('<br/>')}
           </div>`
        : '';

    return `
      ${errHtml}
      ${warnHtml}
      <div class="ledger-sync-map">
        <div class="ledger-sync-map__row ledger-sync-map__head"><span>Database Field</span><span>Excel Column</span></div>
        ${rows}
      </div>
      <div style="margin-top:0.5rem; text-align:right;">
        <button type="button" class="btn btn-primary btn--small" id="ledger-sync-save-map">Save mapping</button>
      </div>
    `;
}

export async function parseLedgerFile(file) {
    const wb = new ExcelJS.Workbook();
    const buf = await file.arrayBuffer();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('No worksheet found.');
    const aoa = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cell.value; });
        aoa.push(cells);
    });
    return parseLedgerRowsFromAoA(aoa, `file:${file.name}`);
}

export async function importLedgerRows(rows, last_sync_at = null) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!supabase || !apartment_id) throw new Error('Supabase required.');

    const allLocalTxns = portalState.finances.txns || [];
    const existingMap = new Map(
        allLocalTxns
            .filter((t) => t.external_sync_key)
            .map((t) => [t.external_sync_key, t]),
    );

    let imported = 0;
    let skipped = 0;
    let updated = 0;
    const conflicts = [];
    const batchInsert = [];
    const updatePromises = [];

    // Track which local transactions were seen in Excel
    const seenKeys = new Set();

    if (rows && rows.length > 0) {
        for (const row of rows) {
            seenKeys.add(row.external_sync_key);
            const existing = existingMap.get(row.external_sync_key);
            
            if (existing) {
                // Check if content changed (via hash)
                if (existing.sync_hash !== row.sync_hash) {
                    console.log(`Sync Change Found: Row ${row.row_index} (Key: ${row.external_sync_key})`);
                    console.log(`  Excel Hash: ${row.sync_hash}`);
                    console.log(`  App Hash:   ${existing.sync_hash}`);
                    
                    // Potential conflict: Did DB change locally since last sync?
                    const dbChangedLocally = last_sync_at && existing.updated_at && new Date(existing.updated_at) > new Date(last_sync_at);
                    
                    if (dbChangedLocally) {
                        console.warn(`  CONFLICT: App version was updated locally at ${existing.updated_at} (Last sync was ${last_sync_at})`);
                        conflicts.push({
                            type: 'UPDATE_CONFLICT',
                            existing,
                            incoming: row
                        });
                    } else {
                        console.log(`  Updating DB record ${existing.id} with Excel changes.`);
                        updatePromises.push(
                            supabase.from('transactions').update({
                                amount: row.amount,
                                cat: row.cat,
                                description: row.description || null,
                                wallet: row.wallet,
                                type: row.type,
                                date: row.date,
                                vendor_name: row.vendor_name,
                                vendor_invoice: row.vendor_invoice,
                                sync_hash: row.sync_hash,
                                updated_at: new Date().toISOString(),
                            }).eq('id', existing.id)
                        );
                        updated += 1;
                    }
                } else {
                    skipped += 1;
                }
                continue;
            }

            // If it has an app:txn key but isn't in our DB, it was deleted in the App
            if (String(row.external_sync_key).startsWith('app:txn:')) {
                conflicts.push({
                    type: 'DELETED_IN_APP',
                    incoming: row
                });
                continue;
            }

            console.log(`Sync New Row: Row ${row.row_index} (Key: ${row.external_sync_key}) - Importing to DB.`);
            batchInsert.push({
                id: crypto.randomUUID(),
                apartment_id,
                amount: row.amount,
                cat: row.cat,
                description: row.description || null,
                wallet: row.wallet,
                type: row.type,
                date: row.date,
                vendor_name: row.vendor_name,
                vendor_invoice: row.vendor_invoice,
                external_sync_key: row.external_sync_key,
                sync_hash: row.sync_hash,
            });
            imported += 1;
        }
    }

    // Check for "Deleted in Excel" (Keys in DB but missing from Excel)
    // ONLY if we actually pulled some data or had a successful connection
    for (const [key, txn] of existingMap.entries()) {
        if (!seenKeys.has(key)) {
            console.log(`Sync Deletion: Key ${key} missing from Excel. Adding to conflicts.`);
            conflicts.push({
                type: 'DELETED_IN_EXCEL',
                existing: txn
            });
        }
    }

    if (batchInsert.length) {
        const { error } = await supabase.from('transactions').insert(batchInsert);
        if (error) throw new Error(error.message);
    }
    if (updatePromises.length) {
        await Promise.all(updatePromises);
    }

    if (imported > 0 || updated > 0) {
        await logActivity({
            entityType: 'LEDGER_SYNC',
            entityId: apartment_id,
            action: 'IMPORT',
            summary: `Spreadsheet sync: ${imported} imported, ${updated} updated, ${skipped} skipped`,
        });
        await pullState();
    }

    return { imported, skipped, updated, conflicts };
}

async function updateMicrosoftRow({ driveId, itemId, shareId, useSharesApi, sheetName, rowIndex, values, rangeAddress }) {
    const token = await getAccessTokenForProvider('MICROSOFT');
    const sharesBase = useSharesApi && shareId ? `/shares/${shareId}/driveItem` : null;
    const driveBase = `/drives/${driveId}/items/${itemId}`;
    let base = sharesBase || driveBase;
    
    const safeSheet = sheetName.replace(/'/g, "''");
    const addr = rangeAddress || `A${rowIndex}:J${rowIndex}`;
    
    let res = await fetch(`https://graph.microsoft.com/v1.0${base}/workbook/worksheets('${safeSheet}')/range(address='${addr}')`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [values] })
    });

    if (!res.ok && base === sharesBase) {
        const json = await res.json().catch(() => ({}));
        if (String(json?.error?.message).includes('not supported for MSA')) {
            base = driveBase;
            res = await fetch(`https://graph.microsoft.com/v1.0${base}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ values: [values] })
            });
        }
    }
    
    if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message || `Failed to update Excel row ${rowIndex}`);
    }
    return true;
}

async function resolveConflict(idx, winner) {
    const conflict = window._ledgerSyncConflicts?.[idx];
    if (!conflict) return;

    const apartment_id = portalState.access?.activeApartmentId;
    const settings = getSyncSettings();

    try {
        if (conflict.type === 'DELETED_IN_APP') {
            if (winner === 'excel') {
                // Restore to App: Re-insert into DB
                const { error } = await supabase.from('transactions').insert({
                    id: crypto.randomUUID(),
                    apartment_id,
                    amount: conflict.incoming.amount,
                    cat: conflict.incoming.cat,
                    description: conflict.incoming.description || null,
                    wallet: conflict.incoming.wallet,
                    type: conflict.incoming.type,
                    date: conflict.incoming.date,
                    vendor_name: conflict.incoming.vendor_name,
                    vendor_invoice: conflict.incoming.vendor_invoice,
                    external_sync_key: conflict.incoming.external_sync_key,
                    sync_hash: conflict.incoming.sync_hash,
                });
                if (error) throw error;
            } else {
                // Delete from Excel: Clear the row in Excel
                if (settings?.provider === 'MICROSOFT') {
                    const token = await getAccessTokenForProvider('MICROSOFT');
                    const item = await resolveMicrosoftDriveItem(settings.spreadsheet_url, token);
                    
                    // Prepare empty values to "clear" the row
                    const mapping = settings.column_mapping || {};
                    const maxCol = Math.max(...Object.values(mapping), 9);
                    const emptyValues = new Array(maxCol + 1).fill('');
                    
                    await updateMicrosoftRow({
                        driveId: item.parentReference?.driveId,
                        itemId: item.id,
                        shareId: encodeMicrosoftShareId(settings.spreadsheet_url),
                        useSharesApi: !settings.spreadsheet_url.includes('driveId='),
                        sheetName: settings.sheet_name || 'Transactions',
                        rowIndex: conflict.incoming.row_index,
                        values: emptyValues
                    });
                } else {
                    alert('Excel deletion is currently only supported for Microsoft Excel.');
                    return;
                }
            }
        } else if (conflict.type === 'DELETED_IN_EXCEL') {
            if (winner === 'excel') {
                // Delete from App: Remove from DB
                const { error } = await supabase.from('transactions').delete().eq('id', conflict.existing.id);
                if (error) throw error;
            } else {
                // Restore to Excel: Push back to Excel (will append as a new row)
                if (settings?.provider === 'MICROSOFT') {
                    const token = await getAccessTokenForProvider('MICROSOFT');
                    const item = await resolveMicrosoftDriveItem(settings.spreadsheet_url, token);
                    await pushMicrosoftRows({
                        driveId: item.parentReference?.driveId,
                        itemId: item.id,
                        shareId: encodeMicrosoftShareId(settings.spreadsheet_url),
                        useSharesApi: !settings.spreadsheet_url.includes('driveId='),
                        sheetName: settings.sheet_name || 'Transactions',
                        rowsToPush: [conflict.existing],
                        columnMapping: settings.column_mapping
                    });

                    // Update DB hash to match what we just pushed
                    const syncHash = safeHash(`${conflict.existing.date}|${conflict.existing.type}|${conflict.existing.amount}|${conflict.existing.cat}|${conflict.existing.description || ''}`);
                    await supabase.from('transactions').update({ 
                        sync_hash: syncHash,
                        updated_at: new Date().toISOString()
                    }).eq('id', conflict.existing.id);
                } else {
                    alert('Excel restoration is currently only supported for Microsoft Excel.');
                    return;
                }
            }
        } else {
            // Standard UPDATE_CONFLICT
            if (winner === 'excel') {
                // Keep Excel version: Update DB with incoming data
                const { error } = await supabase.from('transactions').update({
                    amount: conflict.incoming.amount,
                    cat: conflict.incoming.cat,
                    description: conflict.incoming.description || null,
                    wallet: conflict.incoming.wallet,
                    type: conflict.incoming.type,
                    date: conflict.incoming.date,
                    vendor_name: conflict.incoming.vendor_name,
                    vendor_invoice: conflict.incoming.vendor_invoice,
                    sync_hash: conflict.incoming.sync_hash,
                    updated_at: new Date().toISOString(),
                }).eq('id', conflict.existing.id);
                if (error) throw error;
            } else {
                // Keep App version: Update Excel with existing DB data
                if (settings?.provider === 'MICROSOFT') {
                    const token = await getAccessTokenForProvider('MICROSOFT');
                    const item = await resolveMicrosoftDriveItem(settings.spreadsheet_url, token);
                    
                    // Prepare values for Excel (respecting user's mapping)
                    const mapping = settings.column_mapping || {};
                    const maxCol = Math.max(...Object.values(mapping), 9); // At least 10 columns (0-9)
                    const excelValues = new Array(maxCol + 1).fill('');
                    
                    const setVal = (key, val) => {
                        const idx = mapping[key];
                        if (idx >= 0) excelValues[idx] = val;
                    };

                    setVal('date', conflict.existing.date);
                    setVal('type', conflict.existing.type === 'OUT' ? 'DR' : 'CR');
                    setVal('amount', conflict.existing.amount);
                    setVal('category', conflict.existing.cat);
                    setVal('description', conflict.existing.description || '');
                    setVal('wallet', conflict.existing.wallet);
                    setVal('vendor', conflict.existing.vendor_name || '');
                    setVal('reference', conflict.existing.vendor_invoice || '');
                    setVal('sync_id', conflict.existing.external_sync_key);
                    setVal('sync_status', 'SYNCED');

                    const syncHash = safeHash(`${conflict.existing.date}|${conflict.existing.type}|${conflict.existing.amount}|${conflict.existing.cat}|${conflict.existing.description || ''}`);

                    const colLetter = (n) => {
                        let letter = '';
                        while (n >= 0) {
                            letter = String.fromCharCode((n % 26) + 65) + letter;
                            n = Math.floor(n / 26) - 1;
                        }
                        return letter;
                    };
                    const rangeAddress = `A${conflict.incoming.row_index}:${colLetter(maxCol)}${conflict.incoming.row_index}`;

                    await updateMicrosoftRow({
                        driveId: item.parentReference?.driveId,
                        itemId: item.id,
                        shareId: encodeMicrosoftShareId(settings.spreadsheet_url),
                        useSharesApi: !settings.spreadsheet_url.includes('driveId='),
                        sheetName: settings.sheet_name || 'Transactions',
                        rowIndex: conflict.incoming.row_index,
                        values: excelValues,
                        rangeAddress
                    });

                    // Update DB hash to match what we just pushed
                    await supabase.from('transactions').update({ 
                        sync_hash: syncHash,
                        updated_at: new Date().toISOString()
                    }).eq('id', conflict.existing.id);
                } else {
                    alert('Conflict resolution for App version is currently only supported for Microsoft Excel.');
                    return;
                }
            }
        }

        // Remove from conflicts list
        window._ledgerSyncConflicts.splice(idx, 1);
        
        // If all resolved, update status
        if (window._ledgerSyncConflicts.length === 0) {
            await saveSyncSettings({
                last_sync_status: 'OK',
                last_sync_message: 'All conflicts resolved.'
            });
        }

        await pullState();
        window.renderCashLedger?.();
        syncOpsCtx.onRefresh();
    } catch (err) {
        alert(`Resolution failed: ${err.message}`);
    }
}

async function runSync() {
    const settings = getSyncSettings();
    const apartment_id = portalState.access?.activeApartmentId;
    console.log(`Sync starting for Apartment: ${apartment_id}`);
    
    const provider = activeProvider;
    const spreadsheetUrl = document.getElementById('ledger-sync-url')?.value?.trim() || settings?.spreadsheet_url || '';
    const sheetName = document.getElementById('ledger-sync-sheet')?.value?.trim() || settings?.sheet_name || 'Transactions';
    const rangeA1 = document.getElementById('ledger-sync-range')?.value?.trim() || settings?.range_a1 || 'A:H';

    let rows = [];
    let sourceKey = '';
    let pushed = 0;
    let etag = null;

    const customMapping = settings?.column_mapping;

    if (provider === 'GOOGLE') {
        const result = await fetchGoogleRows({ spreadsheetUrl, sheetName, rangeA1 });
        rows = parseLedgerRowsFromAoA(result.rows, result.sourceKey, customMapping);
        sourceKey = result.sourceKey;
    } else     if (provider === 'MICROSOFT') {
        // 1. PULL
        const result = await fetchMicrosoftRows({ spreadsheetUrl, sheetName });
        console.log(`Excel Pull: Found ${result.rows.length} rows in sheet.`);
        if (result.rows.length > 0) {
            console.log(`  Header row found:`, result.rows[0]);
        }
        
        // Version check
        if (settings?.last_sync_etag && settings.last_sync_etag !== result.etag) {
            console.log('Excel has changed externally. Pulling latest changes.');
        }
        
        rows = parseLedgerRowsFromAoA(result.rows, result.sourceKey, customMapping);
        console.log(`Excel Parse: Parsed ${rows.length} valid ledger rows.`);
        sourceKey = result.sourceKey;
        etag = result.etag;

        // 2. PUSH (Bidirectional)
        // Find local transactions that are NOT synced (no external_sync_key)
        const allTxns = portalState.finances.txns || [];
        const localTxns = allTxns.filter(t => !t.external_sync_key);
        
        console.log(`Excel Push Diagnostic:`);
        console.log(`  Total transactions in App: ${allTxns.length}`);
        console.log(`  Transactions without sync key: ${localTxns.length}`);
        if (allTxns.length > 0 && localTxns.length === 0) {
            console.log(`  Sample keys from first 3 txns:`, allTxns.slice(0, 3).map(t => t.external_sync_key));
        }

        if (localTxns.length > 0) {
            console.log(`Pushing ${localTxns.length} local transactions to Excel...`);
            pushed = await pushMicrosoftRows({
                driveId: result.driveId,
                itemId: result.itemId,
                shareId: result.shareId,
                useSharesApi: result.useSharesApi,
                sheetName,
                rowsToPush: localTxns,
                columnMapping: customMapping
            });
            
            // Mark pushed transactions in DB with a sync key and hash
            for (const txn of localTxns) {
                const syncKey = `app:txn:${txn.id}`;
                const hashBase = `${txn.date}|${txn.type}|${txn.amount}|${txn.cat}|${txn.description || ''}`;
                const syncHash = safeHash(hashBase);
                await supabase.from('transactions').update({ 
                    external_sync_key: syncKey,
                    sync_hash: syncHash 
                }).eq('id', txn.id);
            }
            
            // Re-fetch eTag after push
            const finalItem = await resolveMicrosoftDriveItem(spreadsheetUrl, await getAccessTokenForProvider('MICROSOFT'));
            etag = finalItem.eTag;
        }
    } else {
        throw new Error('Choose Google Sheets or Microsoft Excel, or upload a file.');
    }

    const { imported, skipped, updated, conflicts } = await importLedgerRows(rows, settings?.last_synced_at);
    const { data: { user } } = await supabase.auth.getUser();
    
    const statusMsg = conflicts.length > 0 
        ? `Pulled: ${imported} new, ${updated} updated. Pushed: ${pushed} new. ${conflicts.length} CONFLICTS.`
        : `Pulled: ${imported} new, ${updated} updated. Pushed: ${pushed} new.`;

    window.renderCashLedger?.();
    
    // Store conflicts in a global-ish state BEFORE saving settings
    // This ensures they show up even if the DB save fails
    window._ledgerSyncConflicts = conflicts;
    console.log(`runSync: Stored ${conflicts.length} conflicts in global state.`);
    
    try {
        await saveSyncSettings({
            provider,
            spreadsheet_url: spreadsheetUrl,
            sheet_name: sheetName,
            range_a1: rangeA1,
            last_synced_at: new Date().toISOString(),
            last_sync_status: conflicts.length > 0 ? 'WARN' : 'OK',
            last_sync_message: statusMsg,
            last_sync_imported: imported,
            last_sync_pushed: pushed,
            last_sync_etag: etag,
            last_synced_by: user?.id,
        });
    } catch (e) {
        console.error('Failed to save sync settings (likely missing columns):', e);
    }

    renderLedgerSyncPanel();
    return { imported, skipped, updated, pushed, conflicts, sourceKey };
}

async function runFileImport(file) {
    const rows = await parseLedgerFile(file);
    const { imported, skipped } = await importLedgerRows(rows);
    await saveSyncSettings({
        provider: 'FILE',
        spreadsheet_url: file.name,
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'OK',
        last_sync_message: `${imported} new from ${file.name}, ${skipped} skipped`,
        last_sync_imported: imported,
    });
    window.renderCashLedger?.();
    renderLedgerSyncPanel();
}

function connectionLabel() {
    const meta = getMyOAuthConnectionMeta(activeProvider);
    if (!meta) return '';
    const icon = activeProvider === 'GOOGLE' ? 'fa-google' : 'fa-microsoft';
    const brand = activeProvider === 'GOOGLE' ? 'Google' : 'Microsoft';
    const expired = meta.is_expired ? ' (session expired — reconnect)' : '';
    return `<span class="ledger-sync-connected"><i class="fa-brands ${icon}"></i> ${brand}: ${meta.account_email || 'connected'}${expired}</span>`;
}

function oauthAppConfigured(provider) {
    return !!getOAuthApp(provider)?.client_id;
}

/**
 * Returns { connected: bool, label: string, expired: bool }
 * Used by the summary bar dot and tooltip.
 */
function connectionStatus() {
    if (activeProvider === 'FILE') return { connected: true, label: 'File import', expired: false };
    const appReady = oauthAppConfigured(activeProvider);
    if (!appReady) return { connected: false, label: 'Not configured', expired: false };
    const meta = getMyOAuthConnectionMeta(activeProvider);
    if (!meta) return { connected: false, label: 'Not connected', expired: false };
    if (meta.is_expired) return { connected: false, label: 'Session expired — reconnect', expired: true };
    const brand = activeProvider === 'GOOGLE' ? 'Google' : 'Microsoft';
    return { connected: true, label: `${brand}: ${meta.account_email || 'connected'}`, expired: false };
}

function renderConnectBanner() {
    if (activeProvider === 'FILE' || !oauthAppConfigured(activeProvider)) return '';
    const meta = getMyOAuthConnectionMeta(activeProvider);
    if (meta) return '';
    const brand = activeProvider === 'GOOGLE' ? 'Google' : 'Microsoft';
    return `<div class="ledger-sync-status ledger-sync-status--warn">
      <i class="fa-solid fa-circle-exclamation"></i>
      Not signed in — click <strong>Connect ${brand}</strong> below before Sync now.
    </div>`;
}

function renderStatus() {
    const s = getSyncSettings();
    const conflicts = window._ledgerSyncConflicts || [];
    console.log(`Render Status: Found ${conflicts.length} conflicts in memory.`);
    
    if (!s?.last_synced_at && conflicts.length === 0) return '';
    
    let statusHtml = '';
    if (s?.last_synced_at) {
        const cls = s.last_sync_status === 'OK' ? 'ledger-sync-status--ok' : (s.last_sync_status === 'WARN' ? 'ledger-sync-status--warn' : 'ledger-sync-status--error');
        statusHtml = `<div class="ledger-sync-status ${cls}">
          Last sync: ${new Date(s.last_synced_at).toLocaleString('en-IN')}
          ${s.last_sync_message ? ` · ${s.last_sync_message}` : ''}
        </div>`;
    }

    let conflictsHtml = '';
    if (conflicts.length > 0) {
        conflictsHtml = `
            <div class="ledger-sync-conflicts">
                <div class="ledger-sync-status ledger-sync-status--warn">
                    <strong><i class="fa-solid fa-triangle-exclamation"></i> ${conflicts.length} Sync Conflicts</strong><br/>
                    Changes were made in both Excel and the App. Choose which version to keep.
                </div>
                ${conflicts.map((c, i) => {
                    let title = '';
                    let leftLabel = 'Excel Version';
                    let rightLabel = 'App Version';
                    let leftBtn = 'Keep Excel';
                    let rightBtn = 'Keep App';
                    let leftData = '';
                    let rightData = '';

                    if (c.type === 'DELETED_IN_APP') {
                        title = `Deleted in App: ${c.incoming.date} - ${c.incoming.description}`;
                        leftLabel = 'Excel Version (Exists)';
                        rightLabel = 'App Version (Deleted)';
                        leftBtn = 'Restore to App';
                        rightBtn = 'Delete from Excel';
                        leftData = `₹${c.incoming.amount} (${c.incoming.type})<br/>${c.incoming.cat}<br/>${c.incoming.description || ''}`;
                        rightData = `<span style="color: var(--error);">This transaction was deleted from the app.</span>`;
                    } else if (c.type === 'DELETED_IN_EXCEL') {
                        title = `Deleted in Excel: ${c.existing.date} - ${c.existing.description}`;
                        leftLabel = 'Excel Version (Deleted)';
                        rightLabel = 'App Version (Exists)';
                        leftBtn = 'Delete from App';
                        rightBtn = 'Restore to Excel';
                        leftData = `<span style="color: var(--error);">This row was removed from your spreadsheet.</span>`;
                        rightData = `₹${c.existing.amount} (${c.existing.type})<br/>${c.existing.cat}<br/>${c.existing.description || ''}`;
                    } else {
                        title = `Conflict: ${c.existing.date} - ${c.existing.description}`;
                        leftData = `₹${c.incoming.amount} (${c.incoming.type})<br/>${c.incoming.cat}<br/>${c.incoming.description || ''}`;
                        rightData = `₹${c.existing.amount} (${c.existing.type})<br/>${c.existing.cat}<br/>${c.existing.description || ''}`;
                    }

                    return `
                        <div class="ledger-sync-conflict-card">
                            <div class="ledger-sync-conflict-card__header">${title}</div>
                            <div class="ledger-sync-conflict-card__body">
                                <div class="ledger-sync-conflict-side">
                                    <div class="ledger-sync-conflict-side__label">${leftLabel}</div>
                                    <div class="ledger-sync-conflict-side__data">${leftData}</div>
                                    <button type="button" class="btn btn-outline btn--small resolve-conflict" data-idx="${i}" data-winner="excel">${leftBtn}</button>
                                </div>
                                <div class="ledger-sync-conflict-side">
                                    <div class="ledger-sync-conflict-side__label">${rightLabel}</div>
                                    <div class="ledger-sync-conflict-side__data">${rightData}</div>
                                    <button type="button" class="btn btn-primary btn--small resolve-conflict" data-idx="${i}" data-winner="app">${rightBtn}</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    return statusHtml + conflictsHtml;
}

async function refreshMappingUI() {
    const mapEl = syncEl('mapping');
    if (!mapEl) return;

    const settings = getSyncSettings();
    const url = settings?.spreadsheet_url;
    const sheetName = settings?.sheet_name || 'Transactions';
    const p = syncOpsCtx.prefix;

    if (!url) {
        mapEl.innerHTML = '<p class="gate-wizard__hint">Save a spreadsheet URL above, then click <strong>Load columns</strong>.</p>';
        return;
    }

    mapEl.innerHTML = '<p class="gate-wizard__hint"><i class="fa-solid fa-circle-notch ledger-sync-spinner"></i> Loading headers...</p>';

    try {
        await ensureOAuthConnected(activeProvider);
        let headersRaw = [];

        if (activeProvider === 'MICROSOFT') {
            const pull = await fetchMicrosoftRows({ spreadsheetUrl: url, sheetName });
            headersRaw = pull.rows?.[0] || [];
        } else if (activeProvider === 'GOOGLE') {
            const rangeA1 = settings?.range_a1 || 'A:J';
            const pull = await fetchGoogleRows({ spreadsheetUrl: url, sheetName, rangeA1 });
            headersRaw = pull.rows?.[0] || [];
        } else {
            mapEl.innerHTML = '<p class="gate-wizard__hint">Column mapping applies to Microsoft Excel or Google Sheets.</p>';
            return;
        }

        const check = validateLedgerHeaderMapping([headersRaw], settings?.column_mapping);
        mapEl.innerHTML = renderLedgerMappingResult(check, headersRaw);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'ledger-sync-map__actions';
        actionsDiv.innerHTML = `
            <button type="button" class="btn btn-outline btn--small" id="${opsId(p, 'refresh-cols')}">
                <i class="fa-solid fa-arrows-rotate"></i> Refresh columns
            </button>
            <button type="button" class="btn btn-primary btn--small" id="${opsId(p, 'save-map')}">Save mapping</button>
        `;

        mapEl.querySelector(`#${opsId(p, 'save-map')}`)?.closest('div')?.querySelector(`#${opsId(p, 'save-map')}`);
        const oldSave = mapEl.querySelector(`#${opsId(p, 'save-map')}`);
        if (oldSave && oldSave.parentElement?.classList.contains('ledger-sync-map__actions') === false) {
            const dup = mapEl.querySelectorAll(`#${opsId(p, 'save-map')}`);
            if (dup.length > 1) dup[0].parentElement?.remove();
        }

        mapEl.appendChild(actionsDiv);

        mapEl.querySelector(`#${opsId(p, 'refresh-cols')}`)?.addEventListener('click', () => {
            void withButtonBusy(mapEl.querySelector(`#${opsId(p, 'refresh-cols')}`), 'Loading columns…', () => refreshMappingUI());
        });
        mapEl.querySelector(`#${opsId(p, 'save-map')}`)?.addEventListener('click', async () => {
            const saveBtn = mapEl.querySelector(`#${opsId(p, 'save-map')}`);
            await withButtonBusy(saveBtn, 'Saving…', async () => {
                const newMap = {};
                mapEl.querySelectorAll('.ledger-sync-map__select').forEach((sel) => {
                    newMap[sel.dataset.field] = parseInt(sel.value, 10);
                });
                await saveSyncSettings({ column_mapping: newMap });
                alert('Column mapping saved.');
                syncOpsCtx.onRefresh();
            }).catch((e) => alert(e.message));
        });
    } catch (err) {
        mapEl.innerHTML = `
            <p class="gate-wizard__hint" style="color: var(--error);">Failed to load headers: ${err.message}</p>
            <button type="button" class="btn btn-outline btn--small" id="${opsId(p, 'refresh-cols-retry')}" style="margin-top:0.5rem;">
                <i class="fa-solid fa-arrows-rotate"></i> Try again
            </button>`;
        mapEl.querySelector(`#${opsId(p, 'refresh-cols-retry')}`)?.addEventListener('click', () => {
            void withButtonBusy(mapEl.querySelector(`#${opsId(p, 'refresh-cols-retry')}`), 'Loading columns…', () => refreshMappingUI());
        });
    }
}

async function listAndRenderWorksheets() {
    const settings = getSyncSettings();
    const url = settings?.spreadsheet_url;
    const listEl = syncEl('sheet-list');
    if (!listEl) return;
    if (!url) {
        listEl.textContent = 'Save a spreadsheet URL above first.';
        return;
    }

    listEl.innerHTML = '<span class="gate-wizard__hint"><i class="fa-solid fa-circle-notch ledger-sync-spinner"></i> Loading worksheets...</span>';

    try {
        await ensureOAuthConnected(activeProvider);
        let sheets = [];
        if (activeProvider === 'MICROSOFT') {
            sheets = await listMicrosoftWorksheets(url);
        } else if (activeProvider === 'GOOGLE') {
            sheets = await listGoogleWorksheets(url);
        } else {
            listEl.textContent = 'Worksheet listing requires Microsoft Excel or Google Sheets.';
            return;
        }

        const current = settings?.sheet_name || 'Transactions';
        if (!sheets.length) {
            listEl.textContent = 'No worksheets found in this workbook.';
            return;
        }

        listEl.innerHTML = `
            <span class="ledger-sync-section-label">Worksheets</span>
            <div class="ledger-sync-sheet-picks">
                ${sheets.map((n) => `
                    <button type="button" class="ledger-sync-sheet-pick${n === current ? ' ledger-sync-sheet-pick--active' : ''}"
                      data-sheet="${n.replace(/"/g, '&quot;')}">${n}</button>
                `).join('')}
            </div>`;

        listEl.querySelectorAll('.ledger-sync-sheet-pick').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const sheet = btn.dataset.sheet;
                try {
                    await saveSyncSettings({ sheet_name: sheet });
                    const sheetInput = document.getElementById('admin-ledger-sync-sheet');
                    if (sheetInput) sheetInput.value = sheet;
                    await refreshMappingUI();
                    syncOpsCtx.onRefresh();
                } catch (e) {
                    alert(e.message);
                }
            });
        });
    } catch (err) {
        listEl.innerHTML = `<span class="gate-wizard__hint" style="color:var(--error);">${err.message}</span>`;
    }
}

async function testSpreadsheetLink() {
    const settings = getSyncSettings();
    const url = settings?.spreadsheet_url;
    if (!url) {
        alert('Save a spreadsheet URL above first.');
        return;
    }

    try {
        await ensureOAuthConnected(activeProvider);
        if (activeProvider === 'MICROSOFT') {
            const sheets = await listMicrosoftWorksheets(url);
            await listAndRenderWorksheets();
            const sheetName = settings?.sheet_name || 'Transactions';
            const pull = await fetchMicrosoftRows({ spreadsheetUrl: url, sheetName });
            const rowCount = Math.max(0, (pull.rows?.length || 0) - 1);
            alert(`Link OK. Found ${sheets.length} worksheet(s), ${rowCount} data row(s) on "${sheetName}".`);
            await refreshMappingUI();
        } else if (activeProvider === 'GOOGLE') {
            const sheetName = settings?.sheet_name || 'Transactions';
            const rangeA1 = settings?.range_a1 || 'A:J';
            const pull = await fetchGoogleRows({ spreadsheetUrl: url, sheetName, rangeA1 });
            const rowCount = Math.max(0, (pull.rows?.length || 0) - 1);
            alert(`Link OK. Found ${rowCount} data row(s) on "${sheetName}".`);
            await refreshMappingUI();
        } else {
            alert('Spreadsheet provider is not set. Save settings above.');
        }
    } catch (err) {
        alert(err.message);
    }
}

function buildSyncOpsHtml(prefix, s, hasUrl, canConnect) {
    const id = (n) => opsId(prefix, n);
    const isAdmin = prefix === 'admin-';
    const noUrlHint = isAdmin
        ? 'Save the spreadsheet URL above before connecting or syncing.'
        : 'No spreadsheet linked yet. Set the workbook URL under <strong>Administration → Spreadsheet Sync</strong>.';
    const noMapHint = isAdmin
        ? 'Save spreadsheet settings above first.'
        : 'Configure a spreadsheet in Administration first.';
    const noConnectHint = isAdmin
        ? 'Save the Microsoft or Google Client ID above to enable Connect.'
        : 'OAuth app not configured — set it in Administration → Spreadsheet Sync.';
    return `
      <div class="ledger-sync-ops-block">
        <div class="ledger-sync-panel__head" style="margin-top:0;">
          <p>Connect your account, verify the workbook, map columns, then sync.</p>
          <button type="button" class="btn btn-outline btn--small" id="${id('template')}">
            <i class="fa-solid fa-download"></i> Template
          </button>
        </div>

        ${hasUrl ? `
          <div class="ledger-sync-status" style="margin-bottom: 1rem; background: var(--surface-alt);">
            <i class="fa-solid fa-file-excel" style="color: #16a34a; margin-right: 0.5rem;"></i>
            <strong>Sheet:</strong> ${s.sheet_name || 'Transactions'}
            <span style="color:var(--text-dim); margin: 0 0.35rem;">·</span>
            <a href="${s.spreadsheet_url}" target="_blank" rel="noopener" style="font-size: 0.75rem;">Open workbook</a>
          </div>
        ` : `
          <div class="ledger-sync-status ledger-sync-status--warn">
            <i class="fa-solid fa-circle-exclamation"></i>
            ${noUrlHint}
          </div>
        `}

        ${renderConnectBanner()}

        <div class="ledger-sync-ops-toolbar">
          ${connectionLabel()}
          ${canConnect ? `
            <button type="button" class="btn btn-outline btn--small" id="${id('connect')}">
              <i class="fa-solid fa-link"></i> Connect ${activeProvider === 'GOOGLE' ? 'Google' : 'Microsoft'}
            </button>
            <button type="button" class="btn btn-outline btn--small" id="${id('disconnect')}">Disconnect</button>
          ` : `
            <span class="gate-wizard__hint">${noConnectHint}</span>
          `}
          ${hasUrl ? `
            <button type="button" class="btn btn-outline btn--small" id="${id('test-ms')}">
              <i class="fa-solid fa-plug"></i> Test link
            </button>
            ${activeProvider === 'MICROSOFT' || activeProvider === 'GOOGLE' ? `
            <button type="button" class="btn btn-outline btn--small" id="${id('list-sheets')}">
              <i class="fa-solid fa-table-list"></i> List sheets
            </button>` : ''}
            <button type="button" class="btn btn-outline btn--small" id="${id('refresh-cols-top')}">
              <i class="fa-solid fa-arrows-rotate"></i> Load columns
            </button>
          ` : ''}
          <button type="button" class="btn btn-primary btn--small" id="${id('run')}" ${hasUrl ? '' : 'disabled'}>
            <i class="fa-solid fa-rotate"></i> Sync now
          </button>
        </div>

        <div id="${id('sheet-list')}" class="ledger-sync-sheet-list"></div>

        <details class="ledger-sync-mapping-section" id="${id('mapping-details')}" style="margin-top: 1rem;">
          <summary>Column mapping</summary>
          <div id="${id('mapping')}" style="padding: 0.5rem 0;">
            <p class="gate-wizard__hint">${hasUrl
              ? 'Click <strong>Load columns</strong> or <strong>Test link</strong> to fetch headers, then map each field.'
              : noMapHint}</p>
          </div>
        </details>

        <div id="${id('status')}">${renderStatus()}</div>

        <details class="ledger-sync-advanced" style="margin-top: 1rem;">
          <summary style="font-size:0.75rem; color:var(--text-dim); cursor:pointer;">Advanced / troubleshooting</summary>
          <div style="margin-top:0.5rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn btn-outline btn--small" id="${id('reset-ms')}">
              <i class="fa-solid fa-trash-can"></i> Reset Microsoft state
            </button>
            <button type="button" class="btn btn-outline btn--small" id="${id('clear-keys')}" style="color: var(--error);">
              <i class="fa-solid fa-eraser"></i> Clear Sync IDs
            </button>
          </div>
        </details>
      </div>`;
}

function wireSyncOps(rootEl, prefix, onRefresh) {
    syncOpsCtx = { prefix, onRefresh };
    const id = (n) => opsId(prefix, n);
    const q = (n) => rootEl.querySelector(`#${id(n)}`);

    q('connect')?.addEventListener('click', async () => {
        const btn = q('connect');
        const snapshot = setButtonBusy(btn, 'Connecting…');
        try {
            if (activeProvider === 'GOOGLE') await startGoogleConnect();
            else await startMicrosoftConnect();
        } catch (err) {
            clearButtonBusy(btn, snapshot);
            alert(err.message || String(err));
        }
    });

    q('disconnect')?.addEventListener('click', async () => {
        if (!confirm('Disconnect your account from spreadsheet sync?')) return;
        const btn = q('disconnect');
        await withButtonBusy(btn, 'Disconnecting…', async () => {
            await disconnectOAuth(activeProvider);
            onRefresh();
        }).catch((err) => alert(err.message));
    });

    q('test-ms')?.addEventListener('click', () => {
        void withButtonBusy(q('test-ms'), 'Testing link…', () => testSpreadsheetLink());
    });
    q('list-sheets')?.addEventListener('click', () => {
        void withButtonBusy(q('list-sheets'), 'Loading sheets…', () => listAndRenderWorksheets());
    });
    q('refresh-cols-top')?.addEventListener('click', () => {
        void withButtonBusy(q('refresh-cols-top'), 'Loading columns…', () => refreshMappingUI());
    });

    q('reset-ms')?.addEventListener('click', () => {
        if (!confirm('This will clear all pending Microsoft sign-in state from your browser. Continue?')) return;
        Object.keys(sessionStorage).forEach((key) => {
            if (key.includes('msal') || key.includes('ms_oauth')) sessionStorage.removeItem(key);
        });
        alert('Microsoft sync state cleared. Please hard-refresh (Cmd+Shift+R) and try again.');
        onRefresh();
    });

    q('clear-keys')?.addEventListener('click', async () => {
        if (!confirm('This will remove all Sync IDs from transactions in the App for this society. Continue?')) return;
        const btn = q('clear-keys');
        const apartment_id = portalState.access?.activeApartmentId;
        await withButtonBusy(btn, 'Clearing…', async () => {
            await supabase.from('transactions').update({ external_sync_key: null, sync_hash: null }).eq('apartment_id', apartment_id);
            await pullState();
            alert('Sync IDs cleared.');
            onRefresh();
        }).catch((err) => alert(`Failed to clear keys: ${err.message}`));
    });

    q('run')?.addEventListener('click', async () => {
        const btn = q('run');
        if (!btn || isSyncing) return;

        await withButtonBusy(btn, 'Syncing…', async () => {
            isSyncing = true;
            try {
                if (activeProvider !== 'FILE') await ensureOAuthConnected(activeProvider);
                const { imported, skipped, updated, pushed, conflicts } = await runSync();
                let msg = `Sync complete: ${imported} pulled, ${updated} updated, ${skipped} skipped.`;
                if (pushed > 0) msg += ` ${pushed} pushed.`;
                if (conflicts?.length) msg += ` ${conflicts.length} conflict(s) — open panel to review.`;
                alert(msg);
                onRefresh();
            } finally {
                isSyncing = false;
            }
        }).catch((err) => {
            isSyncing = false;
            alert(err.message);
        });
    });

    q('template')?.addEventListener('click', () => void downloadLedgerTemplate());

    rootEl.querySelectorAll('.resolve-conflict').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const winner = btn.dataset.winner;
            await withButtonBusy(btn, 'Resolving…', () => resolveConflict(idx, winner));
        });
    });
}

export function renderLedgerSyncPanel() {
    const el = document.getElementById('ledger-sync-panel');
    if (!el) return;
    initActiveProvider();
    const s = getSyncSettings();
    const wasOpen = el.querySelector('details.ledger-sync-panel')?.open ?? false;
    const hasUrl = !!s?.spreadsheet_url;
    const msAppReady = oauthAppConfigured('MICROSOFT');
    const googleAppReady = oauthAppConfigured('GOOGLE');
    const canConnect = (activeProvider === 'MICROSOFT' && msAppReady) || (activeProvider === 'GOOGLE' && googleAppReady);
    const connStatus = connectionStatus();
    const shouldOpen = wasOpen || syncPanelForceOpen;

    el.innerHTML = `
      <details class="ledger-sync-panel" id="ledger-sync-details"${shouldOpen ? ' open' : ''}>
        <summary class="ledger-sync-panel__summary">
          <span class="ledger-sync-panel__summary-main">
            <i class="fa-solid fa-table-columns ledger-sync-panel__icon"></i>
            <span>
              <strong>Spreadsheet sync</strong>
              <span class="ledger-sync-panel__hint">${syncSummaryHint()}</span>
            </span>
          </span>
          <span class="ledger-sync-panel__summary-right">
            <span class="ledger-sync-dot ledger-sync-dot--${connStatus.connected ? 'ok' : 'err'}" title="${connStatus.label}"></span>
            ${hasUrl && connStatus.connected ? `
              <button type="button" class="btn btn-primary btn--small ledger-sync-panel__sync-btn" id="ledger-sync-summary-run">
                <i class="fa-solid fa-rotate"></i> Sync
              </button>
            ` : ''}
            <i class="fa-solid fa-chevron-down ledger-sync-panel__chevron" aria-hidden="true"></i>
          </span>
        </summary>
        <div class="ledger-sync-panel__body">
          ${buildSyncOpsHtml('', s, hasUrl, canConnect)}
        </div>
      </details>`;

    syncPanelForceOpen = false;

    // Summary-level sync button (does not expand the panel, stops click from toggling details)
    el.querySelector('#ledger-sync-summary-run')?.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const btn = el.querySelector('#ledger-sync-summary-run');
        if (!btn || isSyncing) return;
        await withButtonBusy(btn, 'Syncing…', async () => {
            isSyncing = true;
            try {
                if (activeProvider !== 'FILE') await ensureOAuthConnected(activeProvider);
                const { imported, skipped, updated, pushed, conflicts } = await runSync();
                let msg = `Sync complete: ${imported} pulled, ${updated} updated, ${skipped} skipped.`;
                if (pushed > 0) msg += ` ${pushed} pushed.`;
                if (conflicts?.length) msg += ` ${conflicts.length} conflict(s) — open panel to review.`;
                alert(msg);
                renderLedgerSyncPanel();
            } finally {
                isSyncing = false;
            }
        }).catch((err) => {
            isSyncing = false;
            alert(err.message);
        });
    });

    const opsRoot = el.querySelector('.ledger-sync-ops-block');
    if (opsRoot) {
        wireSyncOps(opsRoot, '', renderLedgerSyncPanel);
        if (hasUrl) void refreshMappingUI();
    }
}

async function downloadLedgerTemplate() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Transactions');
    ws.addRow(['Date', 'Dr', 'Cr', 'Category', 'Description', 'Wallet', 'Vendor', 'Reference']);
    ws.addRow(['2026-06-01', 1500, '', 'Maintenance', 'Lift AMC', 'BANK', 'Otis', 'INV-001']);
    ws.addRow(['2026-06-02', '', 25000, 'Maintenance Collection', 'Flat A-101 June', 'BANK', '', '']);
    ws.getRow(1).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf]));
    a.download = 'Income_Expenses_Sync_Template.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
}

export async function initLedgerSpreadsheetSync() {
    initActiveProvider();
    console.log('initLedgerSpreadsheetSync: checking for redirect...');
    try {
        const handled = await handleOAuthRedirectIfPresent();
        const justConnected = sessionStorage.getItem('ms_oauth_just_connected') || localStorage.getItem('ms_oauth_just_connected');
        console.log('initLedgerSpreadsheetSync: handled=', handled, 'justConnected=', justConnected);
        if (handled || justConnected) {
            if (justConnected) {
                sessionStorage.removeItem('ms_oauth_just_connected');
                localStorage.removeItem('ms_oauth_just_connected');
            }
            syncPanelForceOpen = true;
            await pullState(); // Force one more pull to be absolutely sure
            renderLedgerSyncPanel();
            const ms = getMyOAuthConnectionMeta('MICROSOFT');
            if (ms?.account_email) {
                alert(`Microsoft connected as ${ms.account_email}. You can sync now.`);
            } else {
                alert('Microsoft account connected. You can sync now.');
            }
        }
    } catch (err) {
        console.error('initLedgerSpreadsheetSync error:', err);
        alert(err.message);
    }
}
