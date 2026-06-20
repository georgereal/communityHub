/**
 * Sync income & expenses from Google Sheets, Microsoft Excel Online, or uploaded file
 */
import './ledgerSync.css';
import ExcelJS from 'exceljs';
import { portalState, supabase, pullState } from './store.js';
import { processFinances, renderCashLedger } from './finances.js';
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
import {
    TRANSACTION_FIELD_DEFS,
    normalizeMapping,
    buildMappingFromHeaders,
    validateMapping,
    parseLedgerRowsFromAoA,
    parseLedgerSheet,
    transactionToExcelRow,
    maxMappedColumn,
    collectMappingFromForm,
    renderLedgerMappingUI,
    wireMappingFormInteractions,
    computeSyncHash,
    computeAnchorHash,
    colForField,
    buildDbSyncPayload,
    buildHeadersFromMapping,
    TEMPLATE_HEADERS,
} from './ledgerColumnMapping.js';
import { pushMicrosoftRows as pushMicrosoftRowsGraph } from './microsoftExcelPush.js';
import { importExcelRows } from './ledgerSyncApply.js';
import {
    clearSyncLog,
    mountSyncLogDrawer,
    openSyncLogDrawer,
    setRunLogSink,
    syncLog,
    syncLogBounds,
    teardownSyncLogDrawer,
} from './ledgerSyncLog.js';
import { renderSyncRunAuditPanel } from './ledgerSyncRunAudit.js';
import {
    buildSyncFetchRange,
    parseRangeAddress,
    reconcileSheetBoundsForSync,
} from './ledgerSheetRegion.js';
import {
    createSyncRunJournal,
    fetchLastRollbackableRun,
    fetchSyncRunChangeSummary,
    journalPushMark,
    rollbackSyncRun,
    snapshotTxn,
} from './ledgerSyncJournal.js';

export { parseLedgerRowsFromAoA };

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

/** Read sync form field from admin wizard or finances panel. */
function syncFormField(name) {
    const map = {
        url: ['admin-ledger-sync-url', 'ledger-sync-url'],
        sheet: ['admin-ledger-sync-sheet', 'ledger-sync-sheet'],
        range: ['admin-ledger-sync-range', 'ledger-sync-range'],
        header_row: ['admin-ledger-sync-header-row', 'ledger-sync-header-row'],
        footer_row: ['admin-ledger-sync-footer-row', 'ledger-sync-footer-row'],
    };
    for (const id of map[name] || []) {
        const v = document.getElementById(id)?.value?.trim();
        if (v) return v;
    }
    return '';
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

async function fetchMicrosoftRows({ spreadsheetUrl, sheetName, syncSettings = null }) {
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
    const settings = syncSettings || {};

    const data = await graphGet(
        `/drives/${driveId}/items/${itemId}/workbook/worksheets('${safeSheet}')/usedRange(valuesOnly=true)`,
        token,
    );
    const rows = data.values || [];
    const rangeMeta = data.address ? parseRangeAddress(data.address) : { startRow: 1, endRow: null, startCol: 'A', endCol: 'J' };
    const reconciled = reconcileSheetBoundsForSync(rows, settings, rangeMeta);
    const shareId = encodeMicrosoftShareId(spreadsheetUrl);
    return {
        rows,
        sourceKey: `microsoft:${shareId.slice(0, 32)}`,
        etag,
        driveId,
        itemId,
        shareId,
        useSharesApi: false,
        bounds: reconciled.bounds,
        rangeMeta,
        boundsPatch: reconciled.settingsPatch,
        boundsWarnings: reconciled.warnings,
    };
}

async function pushMicrosoftRows({ driveId, itemId, shareId, useSharesApi, sheetName, rowsToPush, columnMapping = {}, rangeA1, headerRow, footerRow }) {
    const token = await getAccessTokenForProvider('MICROSOFT');
    return pushMicrosoftRowsGraph({
        accessToken: token,
        driveId,
        itemId,
        shareId,
        useSharesApi,
        sheetName,
        rowsToPush,
        columnMapping,
        rangeA1,
        headerRow,
        footerRow,
    });
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
                header_row: patch.header_row,
                footer_row: patch.footer_row,
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

/** Clear DB sync linkage so the next sync can run from a clean slate (testing). */
function refreshFinancesView() {
    processFinances();
    renderCashLedger();
}

async function resetSyncState() {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!supabase || !apartment_id || apartment_id === 'apt-default') {
        throw new Error('Select a society first.');
    }

    const { count, error: countErr } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('apartment_id', apartment_id)
        .not('external_sync_key', 'is', null);
    if (countErr) throw new Error(countErr.message);

    const { error: txnErr } = await supabase
        .from('transactions')
        .update({
            external_sync_key: null,
            sync_hash: null,
            sync_anchor_hash: null,
            excel_row_index: null,
        })
        .eq('apartment_id', apartment_id);
    if (txnErr) throw new Error(txnErr.message);

    await saveSyncSettings({
        last_synced_at: null,
        last_sync_status: null,
        last_sync_message: null,
        last_sync_imported: 0,
        last_sync_pushed: 0,
        last_sync_etag: null,
    });

    window._ledgerSyncConflicts = [];
    await pullState();

    return { clearedKeys: count ?? 0 };
}

function formatSyncInterval(mins) {
    if (!mins) return 'Manual only';
    if (mins === 15) return 'Every 15 minutes';
    if (mins === 60) return 'Every hour';
    if (mins === 360) return 'Every 6 hours';
    if (mins === 1440) return 'Daily';
    return `Every ${mins} minutes`;
}

function getBackgroundSyncReadiness(s, providerOverride) {
    const provider = providerOverride || (s?.provider === 'GOOGLE' ? 'GOOGLE' : 'MICROSOFT');
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

const ADMIN_SYNC_TAB_KEY = 'admin_sync_provider_tab';
const ADMIN_SYNC_VIEW_KEY = 'admin_sync_view';

function getAdminSyncView() {
    const v = sessionStorage.getItem(ADMIN_SYNC_VIEW_KEY);
    return v === 'history' ? 'history' : 'setup';
}

function renderAdminViewTabs(activeView) {
    return `
      <nav class="sync-admin-view-tabs" role="tablist" aria-label="Spreadsheet sync sections">
        <button type="button" class="sync-admin-view-tab${activeView === 'setup' ? ' sync-admin-view-tab--active' : ''}"
          data-sync-view="setup" role="tab" aria-selected="${activeView === 'setup'}">
          <i class="fa-solid fa-sliders"></i> Setup
        </button>
        <button type="button" class="sync-admin-view-tab${activeView === 'history' ? ' sync-admin-view-tab--active' : ''}"
          data-sync-view="history" role="tab" aria-selected="${activeView === 'history'}">
          <i class="fa-solid fa-clock-rotate-left"></i> Run history
        </button>
      </nav>`;
}

function getAdminWizardProvider(s) {
    const tab = sessionStorage.getItem(ADMIN_SYNC_TAB_KEY);
    if (tab === 'GOOGLE' || tab === 'MICROSOFT') return tab;
    return s?.provider === 'GOOGLE' ? 'GOOGLE' : 'MICROSOFT';
}

function hasSavedColumnMapping(s) {
    const m = normalizeMapping(s?.column_mapping);
    return Object.entries(m.fields).some(([, cfg]) => cfg.mode === 'sync' && cfg.excelCol != null && cfg.excelCol >= 0);
}

function buildAdminWizardSteps(provider, s, microsoft, google) {
    const hasUrl = !!s?.spreadsheet_url;
    const mapped = hasSavedColumnMapping(s);
    const conn = getMyOAuthConnectionMeta(provider);
    const connected = !!conn?.account_email;
    const appOk = provider === 'GOOGLE'
        ? !!(google?.client_id)
        : !!(microsoft?.client_id);
    const secretOk = oauthAppHasClientSecret(provider);
    const scheduleOk = (s?.sync_interval_minutes || 0) > 0;
    const bgOk = provider === 'MICROSOFT'
        ? !!(conn?.background_capable && conn?.account_email)
        : connected;

    return [
        {
            id: 'oauth',
            label: provider === 'GOOGLE' ? 'Google OAuth' : 'Azure app',
            done: appOk && (provider === 'GOOGLE' ? true : secretOk),
        },
        { id: 'workbook', label: 'Workbook', done: hasUrl && s?.provider === provider },
        { id: 'mapping', label: 'Column map', done: mapped },
        { id: 'connect', label: 'Connect & sync', done: connected },
        {
            id: 'schedule',
            label: 'Auto-sync',
            done: scheduleOk && (provider !== 'MICROSOFT' || bgOk),
        },
    ];
}

function firstOpenStepIndex(steps) {
    const idx = steps.findIndex((st) => !st.done);
    return idx === -1 ? steps.length - 1 : idx;
}

function renderWizardRail(steps, openIdx) {
    return `
      <nav class="sync-wizard-rail" aria-label="Setup steps">
        ${steps.map((st, i) => `
          <button type="button"
            class="sync-wizard-rail__item${i === openIdx ? ' sync-wizard-rail__item--active' : ''}${st.done ? ' sync-wizard-rail__item--done' : ''}"
            data-sync-step="${st.id}">
            <span class="sync-wizard-rail__num" aria-hidden="true">
              ${st.done ? '<i class="fa-solid fa-check"></i>' : i + 1}
            </span>
            <span class="sync-wizard-rail__label">${st.label}</span>
          </button>
        `).join('')}
      </nav>`;
}

function renderSyncStepCard(stepNum, title, status, bodyHtml, { open = false, id = '' } = {}) {
    const statusCls = status === 'done' ? 'sync-step-card__badge--done'
        : status === 'current' ? 'sync-step-card__badge--current'
            : 'sync-step-card__badge--pending';
    const statusLabel = status === 'done' ? 'Complete' : status === 'current' ? 'In progress' : 'Pending';
    return `
      <details class="sync-step-card" id="${id}"${open ? ' open' : ''}>
        <summary class="sync-step-card__summary">
          <span class="sync-step-card__num">${stepNum}</span>
          <span class="sync-step-card__title">${title}</span>
          <span class="sync-step-card__badge ${statusCls}">${statusLabel}</span>
          <i class="fa-solid fa-chevron-down sync-step-card__chevron" aria-hidden="true"></i>
        </summary>
        <div class="sync-step-card__body">${bodyHtml}</div>
      </details>`;
}

export function renderAdminSyncPanel() {
    const el = document.getElementById('admin-sync-panel-container');
    if (!el) return;

    const s = getSyncSettings();
    const wizardProvider = getAdminWizardProvider(s);
    activeProvider = wizardProvider;
    syncOpsCtx = { prefix: 'admin-', onRefresh: renderAdminSyncPanel };

    const microsoft = getOAuthApp('MICROSOFT');
    const google = getOAuthApp('GOOGLE');
    const msSecretSaved = oauthAppHasClientSecret('MICROSOFT');
    const googleSecretSaved = oauthAppHasClientSecret('GOOGLE');
    const urlValue = s?.spreadsheet_url || '';
    const hasUrl = !!urlValue && s?.provider === wizardProvider;
    const msAppReady = oauthAppConfigured('MICROSOFT');
    const googleAppReady = oauthAppConfigured('GOOGLE');
    const canConnect = (wizardProvider === 'MICROSOFT' && msAppReady) || (wizardProvider === 'GOOGLE' && googleAppReady);
    const bgSync = getBackgroundSyncReadiness(s, wizardProvider);
    const steps = buildAdminWizardSteps(wizardProvider, s, microsoft, google);
    const openIdx = firstOpenStepIndex(steps);
    const isMicrosoft = wizardProvider === 'MICROSOFT';
    const connMeta = getMyOAuthConnectionMeta(wizardProvider);
    const adminView = getAdminSyncView();
    const isSetupView = adminView === 'setup';

    const stepStatus = (idx) => {
        if (steps[idx].done) return 'done';
        if (idx === openIdx) return 'current';
        return 'pending';
    };

    const oauthStepBody = isMicrosoft ? `
      <p class="sync-step-hint">Register CommunityHub in Azure Portal. Use a <strong>Web</strong> redirect URI (not SPA) so the server can store a refresh token for auto-sync.</p>
      <div class="sync-uri-row">
        <code>${getMicrosoftRedirectUri()}</code>
        <button type="button" class="btn btn-outline btn--small" id="admin-oauth-copy-redirect">Copy</button>
      </div>
      <div class="sync-form-grid sync-form-grid--2">
        <label class="sync-field">
          <span>Client ID</span>
          <input type="text" id="admin-oauth-ms-client" class="expense-combobox" value="${microsoft?.client_id || ''}" placeholder="Application ID" />
        </label>
        <label class="sync-field">
          <span>Tenant ID</span>
          <input type="text" id="admin-oauth-ms-tenant" class="expense-combobox" value="${microsoft?.tenant_id || 'common'}" placeholder="common" />
        </label>
        <label class="sync-field sync-field--full">
          <span>Client secret</span>
          <input type="password" id="admin-oauth-ms-secret" class="expense-combobox" value="" placeholder="${msSecretSaved ? 'Saved — leave blank to keep' : 'Required for background sync'}" autocomplete="new-password" />
          <small>Stored server-side only — used by the cron job to refresh tokens.</small>
        </label>
      </div>
      <button type="button" class="btn btn-primary btn--small" id="admin-oauth-save-ms">
        <i class="fa-solid fa-floppy-disk"></i> Save Azure settings
      </button>
    ` : `
      <p class="sync-step-hint">Create a <strong>Web application</strong> OAuth client in Google Cloud Console.</p>
      <div class="sync-uri-row">
        <code>${getAppRedirectUri()}</code>
        <button type="button" class="btn btn-outline btn--small" id="admin-oauth-copy-google-redirect">Copy</button>
      </div>
      <div class="sync-form-grid">
        <label class="sync-field">
          <span>Client ID</span>
          <input type="text" id="admin-oauth-google-client" class="expense-combobox" value="${google?.client_id || ''}" placeholder="OAuth 2.0 Client ID" />
        </label>
        <label class="sync-field">
          <span>Client secret</span>
          <input type="password" id="admin-oauth-google-secret" class="expense-combobox" value="" placeholder="${googleSecretSaved ? 'Saved — leave blank to keep' : 'Optional'}" autocomplete="new-password" />
        </label>
      </div>
      <button type="button" class="btn btn-primary btn--small" id="admin-oauth-save-google">
        <i class="fa-solid fa-floppy-disk"></i> Save Google settings
      </button>
    `;

    const workbookStepBody = `
      <p class="sync-step-hint">Paste the ${isMicrosoft ? 'OneDrive / SharePoint Excel' : 'Google Sheets'} link your society uses for income &amp; expenses.
        If the sheet has a title block above the table, set <strong>Header row</strong> (or leave blank to auto-detect on Load columns).
        If you have a totals row at the bottom, set <strong>Totals row</strong> — new rows from the app insert above it and Excel shifts totals down.</p>
      <div class="sync-form-grid sync-form-grid--2">
        <label class="sync-field sync-field--full">
          <span>Spreadsheet URL</span>
          <input type="url" id="admin-ledger-sync-url" class="expense-combobox"
            placeholder="${isMicrosoft ? 'https://...sharepoint.com/... or OneDrive link' : 'https://docs.google.com/spreadsheets/d/...'}"
            value="${s?.provider === wizardProvider ? urlValue : ''}" />
        </label>
        <label class="sync-field">
          <span>Sheet / tab name</span>
          <input type="text" id="admin-ledger-sync-sheet" class="expense-combobox" value="${s?.sheet_name || 'Transactions'}" />
        </label>
        <label class="sync-field">
          <span>Header row</span>
          <input type="number" min="1" id="admin-ledger-sync-header-row" class="expense-combobox"
            value="${s?.header_row || ''}" placeholder="Auto-detect" title="Excel row number for column headers (e.g. 3)" />
        </label>
        <label class="sync-field">
          <span>Totals row</span>
          <input type="number" min="1" id="admin-ledger-sync-footer-row" class="expense-combobox"
            value="${s?.footer_row || ''}" placeholder="Auto-detect" title="Excel row number for totals (e.g. 27). Data rows must be above this." />
        </label>
        <label class="sync-field">
          <span>Column range</span>
          <input type="text" id="admin-ledger-sync-range" class="expense-combobox" value="${s?.range_a1 || 'A:J'}" placeholder="A:J" />
        </label>
      </div>
      <input type="hidden" id="admin-ledger-sync-provider" value="${wizardProvider}" />
      <button type="button" class="btn btn-primary btn--small" id="admin-ledger-save-settings">
        <i class="fa-solid fa-link"></i> Save workbook
      </button>
    `;

    const mappingStepBody = `
      <p class="sync-step-hint">
        Match each <strong>CommunityHub field</strong> (database) to a column in your spreadsheet.
        Saved mapping loads from the database automatically. Use <strong>Load columns</strong> to refresh Excel headers.
      </p>
      <div class="sync-mapping-toolbar">
        <button type="button" class="btn btn-outline btn--small" id="admin-ledger-sync-load-cols" ${hasUrl ? '' : 'disabled'}>
          <i class="fa-solid fa-arrows-rotate"></i> Load columns from spreadsheet
        </button>
        <button type="button" class="btn btn-outline btn--small" id="admin-ledger-sync-template">
          <i class="fa-solid fa-download"></i> Download template
        </button>
      </div>
      <div id="admin-ledger-sync-mapping" class="sync-mapping-panel">
        <p class="gate-wizard__hint">${hasUrl
        ? '<i class="fa-solid fa-circle-notch ledger-sync-spinner"></i> Loading saved mapping…'
        : 'Complete step 2 to enable column mapping.'}</p>
      </div>
    `;

    const connectStepBody = `
      <div id="admin-sync-ops-root">
        ${buildSyncOpsHtml('admin-', s, hasUrl, canConnect, { includeMapping: false, compact: true })}
      </div>
    `;

    const scheduleStepBody = isMicrosoft ? `
      <p class="sync-step-hint">Vercel cron calls <code>/api/sync</code> on the deployed site. Use <strong>Sync now (browser)</strong> for live logs, or <strong>Test server sync</strong> to exercise the same API path as cron.</p>
      <div class="sync-schedule-row">
        <select id="admin-bg-sync-interval" class="expense-combobox">
          <option value="0" ${(s?.sync_interval_minutes || 0) === 0 ? 'selected' : ''}>Manual only</option>
          <option value="15" ${s?.sync_interval_minutes === 15 ? 'selected' : ''}>Every 15 minutes</option>
          <option value="60" ${s?.sync_interval_minutes === 60 ? 'selected' : ''}>Every hour</option>
          <option value="360" ${s?.sync_interval_minutes === 360 ? 'selected' : ''}>Every 6 hours</option>
          <option value="1440" ${s?.sync_interval_minutes === 1440 ? 'selected' : ''}>Daily</option>
        </select>
        <button type="button" class="btn btn-primary btn--small" id="admin-bg-save-schedule">
          <i class="fa-solid fa-floppy-disk"></i> Save schedule
        </button>
      </div>
      <div class="sync-bg-connect">
        <p class="sync-step-hint" style="margin:0;">
          Sign in with the <strong>personal Microsoft account</strong> that owns the Excel file (requires client secret in step 1).
        </p>
        <button type="button" class="btn btn-primary btn--small" id="admin-bg-connect-microsoft" ${msSecretSaved ? '' : 'disabled'}>
          <i class="fa-brands fa-microsoft"></i> Connect for background sync
        </button>
        ${connMeta?.account_email ? `<span class="sync-connected-chip"><i class="fa-solid fa-circle-check"></i> ${connMeta.account_email}</span>` : ''}
      </div>
      <ul class="sync-checklist">
        ${bgSync.items.map((item) => `
          <li class="sync-checklist__item${item.ok ? ' sync-checklist__item--ok' : ''}">
            <i class="fa-solid ${item.ok ? 'fa-circle-check' : 'fa-circle'}"></i>
            <span>${item.label}${item.ok ? '' : ` — <em>${item.hint}</em>`}</span>
          </li>
        `).join('')}
      </ul>
      <div class="sync-schedule-actions">
        <button type="button" class="btn btn-outline btn--small" id="admin-bg-sync-run" ${bgSync.ready ? '' : 'disabled'}>
          <i class="fa-solid fa-bolt"></i> Sync now (browser)
        </button>
        <button type="button" class="btn btn-outline btn--small" id="admin-bg-server-sync" ${bgSync.ready ? '' : 'disabled'} title="POST /api/sync — same path as Vercel cron">
          <i class="fa-solid fa-server"></i> Test server sync
        </button>
        <button type="button" class="btn btn-outline btn--small" id="admin-reset-sync-state" title="Testing — clear sync keys and last-run metadata">
          <i class="fa-solid fa-rotate-left"></i> Reset sync state
        </button>
        <button type="button" class="btn btn-outline btn--small" id="admin-rollback-sync" title="Undo the last completed sync in the database">
          <i class="fa-solid fa-clock-rotate-left"></i> Rollback last sync
        </button>
        ${s?.last_synced_at ? `<span class="gate-wizard__hint">Last run: ${new Date(s.last_synced_at).toLocaleString('en-IN')}</span>` : ''}
        ${renderSyncLogToolbarButton()}
      </div>
    ` : `
      <p class="sync-step-hint">Choose how often the server should pull/push changes. Cron runs once daily on Vercel.</p>
      <div class="sync-schedule-row">
        <select id="admin-bg-sync-interval" class="expense-combobox">
          <option value="0" ${(s?.sync_interval_minutes || 0) === 0 ? 'selected' : ''}>Manual only</option>
          <option value="15" ${s?.sync_interval_minutes === 15 ? 'selected' : ''}>Every 15 minutes</option>
          <option value="60" ${s?.sync_interval_minutes === 60 ? 'selected' : ''}>Every hour</option>
          <option value="360" ${s?.sync_interval_minutes === 360 ? 'selected' : ''}>Every 6 hours</option>
          <option value="1440" ${s?.sync_interval_minutes === 1440 ? 'selected' : ''}>Daily</option>
        </select>
        <button type="button" class="btn btn-primary btn--small" id="admin-bg-save-schedule">
          <i class="fa-solid fa-floppy-disk"></i> Save schedule
        </button>
      </div>
      <div class="sync-schedule-actions">
        <button type="button" class="btn btn-outline btn--small" id="admin-bg-sync-run" ${bgSync.ready ? '' : 'disabled'}>
          <i class="fa-solid fa-bolt"></i> Sync now (browser)
        </button>
        <button type="button" class="btn btn-outline btn--small" id="admin-bg-server-sync" ${bgSync.ready ? '' : 'disabled'} title="POST /api/sync — same path as Vercel cron">
          <i class="fa-solid fa-server"></i> Test server sync
        </button>
        <button type="button" class="btn btn-outline btn--small" id="admin-reset-sync-state" title="Testing — clear sync keys and last-run metadata">
          <i class="fa-solid fa-rotate-left"></i> Reset sync state
        </button>
        <button type="button" class="btn btn-outline btn--small" id="admin-rollback-sync" title="Undo the last completed sync in the database">
          <i class="fa-solid fa-clock-rotate-left"></i> Rollback last sync
        </button>
        ${renderSyncLogToolbarButton()}
      </div>
    `;

    el.innerHTML = `
      <div class="sync-wizard-page">
        <header class="sync-wizard-header">
          <div>
            <h3 class="sync-wizard-header__title">Spreadsheet sync</h3>
            <p class="sync-wizard-header__desc">${isSetupView
        ? `Set up ${isMicrosoft ? 'Microsoft Excel Online' : 'Google Sheets'} in five steps — OAuth, workbook, column mapping, connect, and schedule.`
        : 'Audit trail for browser sync, server API, and Vercel cron — status and row-by-row logs per run.'}</p>
          </div>
          ${isSetupView ? `
          <div class="sync-provider-tabs" role="tablist" aria-label="Spreadsheet provider">
            <button type="button" class="sync-provider-tab${isMicrosoft ? ' sync-provider-tab--active' : ''}" data-sync-provider="MICROSOFT" role="tab" aria-selected="${isMicrosoft}">
              <i class="fa-brands fa-microsoft"></i> Excel Online
            </button>
            <button type="button" class="sync-provider-tab${!isMicrosoft ? ' sync-provider-tab--active' : ''}" data-sync-provider="GOOGLE" role="tab" aria-selected="${!isMicrosoft}">
              <i class="fa-brands fa-google"></i> Google Sheets
            </button>
          </div>` : ''}
        </header>

        ${renderAdminViewTabs(adminView)}

        ${isSetupView ? `
        ${renderWizardRail(steps, openIdx)}

        <div class="sync-wizard-steps">
          ${renderSyncStepCard(1, isMicrosoft ? 'Azure app registration' : 'Google Cloud OAuth', stepStatus(0), oauthStepBody, { open: openIdx === 0, id: 'admin-sync-step-oauth' })}
          ${renderSyncStepCard(2, 'Link workbook', stepStatus(1), workbookStepBody, { open: openIdx === 1, id: 'admin-sync-step-workbook' })}
          ${renderSyncStepCard(3, 'Column mapping', stepStatus(2), mappingStepBody, { open: openIdx === 2, id: 'admin-sync-step-mapping' })}
          ${renderSyncStepCard(4, 'Connect & sync', stepStatus(3), connectStepBody, { open: openIdx === 3, id: 'admin-sync-step-connect' })}
          ${renderSyncStepCard(5, 'Auto-sync schedule', stepStatus(4), scheduleStepBody, { open: openIdx === 4, id: 'admin-sync-step-schedule' })}
        </div>
        <div id="admin-sync-log-host" class="admin-sync-log-host"></div>
        ` : `
        <div class="sync-history-page">
          <div id="admin-sync-run-audit"></div>
        </div>`}
      </div>
    `;

    el.querySelectorAll('[data-sync-view]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.syncView;
            if (!view || view === getAdminSyncView()) return;
            sessionStorage.setItem(ADMIN_SYNC_VIEW_KEY, view);
            renderAdminSyncPanel();
        });
    });

    if (!isSetupView) {
        void renderSyncRunAuditPanel('admin-sync-run-audit');
        return;
    }

    // Provider tabs
    el.querySelectorAll('[data-sync-provider]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const p = btn.dataset.syncProvider;
            if (!p || p === wizardProvider) return;
            sessionStorage.setItem(ADMIN_SYNC_TAB_KEY, p);
            activeProvider = p;
            renderAdminSyncPanel();
        });
    });

    // Step rail navigation
    el.querySelectorAll('[data-sync-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = document.getElementById(`admin-sync-step-${btn.dataset.syncStep}`);
            if (!target) return;
            target.open = true;
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

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

    document.getElementById('admin-ledger-save-settings')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-ledger-save-settings');
        const url = document.getElementById('admin-ledger-sync-url')?.value?.trim();
        const sheet = document.getElementById('admin-ledger-sync-sheet')?.value?.trim();
        const provider = document.getElementById('admin-ledger-sync-provider')?.value || wizardProvider;
        const rangeA1 = document.getElementById('admin-ledger-sync-range')?.value?.trim() || 'A:J';
        const headerRowRaw = document.getElementById('admin-ledger-sync-header-row')?.value?.trim();
        const footerRowRaw = document.getElementById('admin-ledger-sync-footer-row')?.value?.trim();
        const header_row = headerRowRaw ? parseInt(headerRowRaw, 10) : null;
        const footer_row = footerRowRaw ? parseInt(footerRowRaw, 10) : null;
        if (!url) return alert('Enter a spreadsheet URL.');

        await withButtonBusy(btn, 'Saving…', async () => {
            await saveSyncSettings({
                spreadsheet_url: url,
                sheet_name: sheet,
                provider,
                range_a1: rangeA1,
                header_row: Number.isFinite(header_row) ? header_row : null,
                footer_row: Number.isFinite(footer_row) ? footer_row : null,
            });
            startAutoSync();
            alert('Workbook saved.');
            renderAdminSyncPanel();
        }).catch((e) => alert(e.message));
    });

    document.getElementById('admin-ledger-sync-load-cols')?.addEventListener('click', () => {
        void withButtonBusy(
            document.getElementById('admin-ledger-sync-load-cols'),
            'Loading…',
            () => refreshMappingUI(),
        );
    });

    document.getElementById('admin-ledger-sync-template')?.addEventListener('click', () => void downloadLedgerTemplate());

    document.getElementById('admin-bg-connect-microsoft')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-bg-connect-microsoft');
        const snapshot = setButtonBusy(btn, 'Redirecting…');
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
                ? 'Schedule saved: manual only.'
                : `Schedule saved: ${formatSyncInterval(interval)}.`);
            renderAdminSyncPanel();
        }).catch((e) => alert(e.message || 'Could not save schedule.'));
    });

    document.getElementById('admin-bg-sync-run')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-bg-sync-run');
        if (isSyncing) return;
        await withButtonBusy(btn, 'Syncing…', async () => {
            isSyncing = true;
            try {
                syncOpsCtx = { prefix: 'admin-', onRefresh: renderAdminSyncPanel };
                if (activeProvider !== 'FILE') await ensureOAuthConnected(activeProvider);
                const { imported, skipped, updated, pushed, conflicts, boundsWarnings } = await runSync();
                let msg = `Sync complete: ${imported} pulled, ${updated} updated, ${skipped} skipped.`;
                if (pushed > 0) msg += ` ${pushed} pushed.`;
                if (conflicts?.length) msg += ` ${conflicts.length} conflict(s).`;
                if (boundsWarnings?.length) msg += `\n\nSheet bounds:\n• ${boundsWarnings.join('\n• ')}`;
                alert(msg);
                renderAdminSyncPanel();
            } finally {
                isSyncing = false;
            }
        }).catch((err) => {
            isSyncing = false;
            syncLog('error', err.message);
            alert(`${err.message}\n\nClick Sync log in step 4 or 5 to view row-by-row details.`);
        });
    });

    document.getElementById('admin-bg-server-sync')?.addEventListener('click', async () => {
        const btn = document.getElementById('admin-bg-server-sync');
        await withButtonBusy(btn, 'Running…', async () => {
            const apartment_id = portalState.access?.activeApartmentId;
            if (!apartment_id || apartment_id === 'apt-default') throw new Error('Select a society first.');
            const { data: sess } = await supabase.auth.getSession();
            const token = sess?.session?.access_token;
            if (!token) throw new Error('Sign in again to run the server sync.');

            syncLog('info', 'Manual server sync requested', { apartment_id });

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
            refreshFinancesView();
            renderAdminSyncPanel();

            const r = json.result || {};
            alert(`Server sync complete.\n\nPulled: ${r.imported ?? 0} new, ${r.updated ?? 0} updated.\nPushed: ${r.pushed ?? 0} new.\n\nOpen the Run history tab for the full audit log.`);
        }).catch((err) => {
            syncLog('error', err.message);
            alert(`${err.message || String(err)}\n\nOpen the Run history tab for persisted server run logs.`);
        });
    });

    document.getElementById('admin-reset-sync-state')?.addEventListener('click', () => {
        void confirmResetSyncState('admin-reset-sync-state', renderAdminSyncPanel);
    });

    document.getElementById('admin-rollback-sync')?.addEventListener('click', () => {
        void confirmRollbackLastSync('admin-rollback-sync', renderAdminSyncPanel);
    });

    const opsRoot = document.getElementById('admin-sync-ops-root');
    if (opsRoot) {
        wireSyncOps(opsRoot, 'admin-', renderAdminSyncPanel);
    }

    if (hasUrl) {
        void refreshMappingUI();
    }

    teardownSyncLogDrawer();
    document.getElementById('sync-log-root')?.remove();
    mountSyncLogDrawer();
    el.querySelectorAll('[data-sync-log-open]').forEach((btn) => {
        btn.addEventListener('click', () => openSyncLogDrawer());
    });
}

async function fetchGoogleRows({ spreadsheetUrl, sheetName, rangeA1, syncSettings = null }) {
    const sheetId = parseGoogleSheetId(spreadsheetUrl);
    if (!sheetId) throw new Error('Paste a valid Google Sheets URL.');
    const token = await getAccessTokenForProvider('GOOGLE');
    const settings = syncSettings || {};
    const cols = rangeA1 || settings.range_a1 || 'A:J';
    const fetchRange = buildSyncFetchRange(cols);
    const range = encodeURIComponent(`${sheetName}!${fetchRange}`);
    const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Google Sheets request failed.');
    const rows = json.values || [];
    const rangeMeta = parseRangeAddress(fetchRange);
    const reconciled = reconcileSheetBoundsForSync(rows, settings, rangeMeta);
    return {
        rows,
        sourceKey: `google:${sheetId}`,
        bounds: reconciled.bounds,
        rangeMeta,
        boundsPatch: reconciled.settingsPatch,
        boundsWarnings: reconciled.warnings,
    };
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

export async function importLedgerRows(rows, last_sync_at = null, journal = null) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!supabase || !apartment_id) throw new Error('Supabase required.');
    const columnMapping = getSyncSettings()?.column_mapping;

    const allLocalTxns = portalState.finances.txns || [];
    const { imported, updated, skipped, deleted, conflicts } = await importExcelRows(
        supabase, apartment_id, rows, allLocalTxns, columnMapping, { journal },
    );

    if (imported > 0 || updated > 0 || deleted > 0) {
        await logActivity({
            entityType: 'LEDGER_SYNC',
            entityId: apartment_id,
            action: 'IMPORT',
            summary: `Spreadsheet sync: ${imported} imported, ${updated} updated, ${deleted} removed, ${skipped} skipped`,
        });
        await pullState();
    }

    return { imported, skipped, updated, deleted, conflicts };
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
                    ...buildDbSyncPayload(conflict.incoming, settings.column_mapping),
                    external_sync_key: conflict.incoming.external_sync_key,
                });
                if (error) throw error;
            } else {
                // Delete from Excel: Clear the row in Excel
                if (settings?.provider === 'MICROSOFT') {
                    const token = await getAccessTokenForProvider('MICROSOFT');
                    const item = await resolveMicrosoftDriveItem(settings.spreadsheet_url, token);
                    
                    // Prepare empty values to "clear" the row
                    const maxCol = Math.max(maxMappedColumn(settings.column_mapping), 9);
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
                        columnMapping: settings.column_mapping,
                        rangeA1: settings.range_a1 || 'A:J',
                        headerRow: settings.header_row ?? null,
                        footerRow: settings.footer_row ?? null,
                    });

                    // Update DB hash to match what we just pushed
                    const syncHash = computeSyncHash(conflict.existing, settings.column_mapping);
                    await supabase.from('transactions').update({ 
                        sync_hash: syncHash,
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
                    ...buildDbSyncPayload(conflict.incoming, settings.column_mapping),
                }).eq('id', conflict.existing.id);
                if (error) throw error;
            } else {
                // Keep App version: Update Excel with existing DB data
                if (settings?.provider === 'MICROSOFT') {
                    const token = await getAccessTokenForProvider('MICROSOFT');
                    const item = await resolveMicrosoftDriveItem(settings.spreadsheet_url, token);
                    
                    const { rowData: excelValues, maxCol } = transactionToExcelRow(conflict.existing, settings.column_mapping);
                    const syncHash = computeSyncHash(conflict.existing, settings.column_mapping);

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
        refreshFinancesView();
        syncOpsCtx.onRefresh();
    } catch (err) {
        alert(`Resolution failed: ${err.message}`);
    }
}

async function runSync() {
    let settings = getSyncSettings();
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    const journal = await createSyncRunJournal(supabase, apartment_id, {
        created_by: user?.id || null,
        source: 'browser',
    });
    setRunLogSink((level, message, detail) => journal.log(level, message, detail));

    try {
    clearSyncLog();
    syncLog('info', 'Sync started (browser)', { provider: activeProvider, apartment_id, runId: journal.runId });
    console.log(`Sync starting for Apartment: ${apartment_id}`);

    const headerRowRaw = syncFormField('header_row');
    const footerRowRaw = syncFormField('footer_row');
    const boundsPatch = {};
    if (headerRowRaw) boundsPatch.header_row = parseInt(headerRowRaw, 10);
    if (footerRowRaw) boundsPatch.footer_row = parseInt(footerRowRaw, 10);
    if (Object.keys(boundsPatch).length) {
        syncLog('info', 'Using sheet bounds from form', boundsPatch);
        try {
            await saveSyncSettings(boundsPatch);
            settings = { ...settings, ...boundsPatch };
        } catch {
            const fin = portalState.finances ??= {};
            const sync = fin.ledgerSyncSettings ??= { apartment_id };
            Object.assign(sync, boundsPatch);
            settings = { ...settings, ...boundsPatch };
        }
    }
    
    const provider = activeProvider;
    const spreadsheetUrl = syncFormField('url') || settings?.spreadsheet_url || '';
    const sheetName = syncFormField('sheet') || settings?.sheet_name || 'Transactions';
    const rangeA1 = syncFormField('range') || settings?.range_a1 || 'A:H';

    let rows = [];
    let sourceKey = '';
    let pushed = 0;
    let etag = null;

    const customMapping = settings?.column_mapping;

    let boundsWarnings = [];
    let sheetBoundsForJournal = null;

    if (provider === 'GOOGLE') {
        const result = await fetchGoogleRows({ spreadsheetUrl, sheetName, rangeA1, syncSettings: settings });
        boundsWarnings = await persistBoundsFromPull(result);
        sheetBoundsForJournal = result.bounds;
        syncLogBounds(result.bounds, boundsWarnings);
        syncLog('info', `Pulled ${result.rows.length} aoa row(s) from Google Sheets`);
        rows = parseLedgerSheet(result.rows, result.sourceKey, customMapping, result.bounds).parsed;
        sourceKey = result.sourceKey;
    } else if (provider === 'MICROSOFT') {
        const result = await fetchMicrosoftRows({ spreadsheetUrl, sheetName, syncSettings: settings });
        boundsWarnings = await persistBoundsFromPull(result);
        sheetBoundsForJournal = result.bounds;
        syncLogBounds(result.bounds, boundsWarnings);
        syncLog('info', `Pulled ${result.rows.length} aoa row(s) from Excel`, { address: result.rangeMeta });
        console.log(`Excel Pull: Found ${result.rows.length} rows (header row ${result.bounds?.headerRow}, footer ${result.bounds?.footerRow ?? 'none'}).`);
        if (result.rows.length > 0) {
            console.log(`  Header row:`, result.bounds?.headersRaw);
        }

        if (settings?.last_sync_etag && settings.last_sync_etag !== result.etag) {
            console.log('Excel has changed externally. Pulling latest changes.');
        }

        rows = parseLedgerSheet(result.rows, result.sourceKey, customMapping, result.bounds).parsed;
        console.log(`Excel Parse: Parsed ${rows.length} valid ledger rows.`);
        sourceKey = result.sourceKey;
        etag = result.etag;

        // 2. PUSH (Bidirectional)
        const allTxns = portalState.finances.txns || [];
        const localTxns = allTxns.filter(t => !t.external_sync_key);

        if (localTxns.length > 0) {
            console.log(`Pushing ${localTxns.length} local transactions to Excel (one row at a time)...`);
            pushed = await pushMicrosoftRows({
                driveId: result.driveId,
                itemId: result.itemId,
                shareId: result.shareId,
                useSharesApi: result.useSharesApi,
                sheetName,
                rowsToPush: localTxns,
                columnMapping: customMapping,
                rangeA1: settings?.range_a1 || 'A:J',
                headerRow: result.bounds?.headerRow ?? settings?.header_row ?? null,
                footerRow: result.bounds?.footerRow ?? settings?.footer_row ?? null,
                onRowPushed: async (txn, excelRowIndex) => {
                    const before = snapshotTxn(txn);
                    const syncKey = `app:txn:${txn.id}`;
                    const withKey = { ...txn, external_sync_key: syncKey };
                    const syncHash = computeSyncHash(withKey, customMapping);
                    const syncAnchorHash = computeAnchorHash(withKey, customMapping);
                    const { error } = await supabase.from('transactions').update({
                        external_sync_key: syncKey,
                        sync_hash: syncHash,
                        sync_anchor_hash: syncAnchorHash,
                        excel_row_index: excelRowIndex,
                    }).eq('id', txn.id);
                    if (error) throw new Error(error.message);
                    await journalPushMark(journal, before, {
                        ...before,
                        external_sync_key: syncKey,
                        sync_hash: syncHash,
                        sync_anchor_hash: syncAnchorHash,
                        excel_row_index: excelRowIndex,
                    });
                },
            });
            
            // Re-fetch eTag after push
            const finalItem = await resolveMicrosoftDriveItem(spreadsheetUrl, await getAccessTokenForProvider('MICROSOFT'));
            etag = finalItem.eTag;
        }
    } else {
        throw new Error('Choose Google Sheets or Microsoft Excel, or upload a file.');
    }

    const { imported, skipped, updated, deleted, conflicts } = await importLedgerRows(rows, settings?.last_synced_at, journal);

    const syncStatus = conflicts.length > 0 || boundsWarnings.length > 0 ? 'WARN' : 'OK';
    const statusMsg = conflicts.length > 0 
        ? `Pulled: ${imported} new, ${updated} updated, ${deleted} removed. Pushed: ${pushed} new. ${conflicts.length} CONFLICTS.${boundsWarnings.length ? ` ${boundsWarnings.join('; ')}` : ''}`
        : `Pulled: ${imported} new, ${updated} updated, ${deleted} removed. Pushed: ${pushed} new.${boundsWarnings.length ? ` ${boundsWarnings.join('; ')}` : ''}`;

    await journal.complete({
        imported,
        updated,
        deleted,
        skipped,
        pushed,
        status: syncStatus,
        message: statusMsg,
        bounds: sheetBoundsForJournal,
    });

    refreshFinancesView();
    
    // Store conflicts in a global-ish state BEFORE saving settings
    window._ledgerSyncConflicts = conflicts;
    window._ledgerSyncBoundsWarnings = boundsWarnings;
    console.log(`runSync: Stored ${conflicts.length} conflicts in global state.`);
    
    try {
        await saveSyncSettings({
            provider,
            spreadsheet_url: spreadsheetUrl,
            sheet_name: sheetName,
            range_a1: rangeA1,
            last_synced_at: new Date().toISOString(),
            last_sync_status: syncStatus,
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
    syncOpsCtx.onRefresh?.();
    return { imported, skipped, updated, deleted, pushed, conflicts, sourceKey, syncRunId: journal.runId, boundsWarnings };
    } catch (syncErr) {
        syncLog('error', syncErr.message);
        await journal.fail(syncErr.message);
        throw syncErr;
    } finally {
        setRunLogSink(null);
        try {
            await journal.flushLogs?.();
        } catch (flushErr) {
            console.warn('[sync] log flush failed:', flushErr);
        }
    }
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
    refreshFinancesView();
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

function mountMappingUI(mapEl, storedMapping, headersRaw, noticeHtml = '') {
    const p = syncOpsCtx.prefix;
    const hasLiveHeaders = Array.isArray(headersRaw) && headersRaw.length > 0;
    const resolvedHeaders = hasLiveHeaders
        ? headersRaw
        : (storedMapping?.excelHeaders?.length
            ? storedMapping.excelHeaders
            : buildHeadersFromMapping(storedMapping));

    const mappingForRender = normalizeMapping({
        ...storedMapping,
        excelHeaders: hasLiveHeaders ? headersRaw : (storedMapping?.excelHeaders || resolvedHeaders),
    });

    mapEl.dataset.excelHeaders = JSON.stringify(resolvedHeaders);
    mapEl.innerHTML = `${noticeHtml}${renderLedgerMappingUI(mappingForRender, resolvedHeaders)}`;
    wireMappingFormInteractions(mapEl);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'ledger-sync-map__actions';
    actionsDiv.innerHTML = `
        <button type="button" class="btn btn-outline btn--small" id="${opsId(p, 'refresh-cols')}">
            <i class="fa-solid fa-arrows-rotate"></i> Refresh columns
        </button>
        <button type="button" class="btn btn-primary btn--small" id="${opsId(p, 'save-map')}">Save mapping</button>
    `;
    mapEl.appendChild(actionsDiv);

    mapEl.querySelector(`#${opsId(p, 'refresh-cols')}`)?.addEventListener('click', () => {
        void withButtonBusy(mapEl.querySelector(`#${opsId(p, 'refresh-cols')}`), 'Loading columns…', () => refreshMappingUI());
    });
    mapEl.querySelector(`#${opsId(p, 'save-map')}`)?.addEventListener('click', async () => {
        const saveBtn = mapEl.querySelector(`#${opsId(p, 'save-map')}`);
        await withButtonBusy(saveBtn, 'Saving…', async () => {
            const newMap = collectMappingFromForm(mapEl);
            const headersForValidation = JSON.parse(mapEl.dataset.excelHeaders || '[]');
            const { errors } = validateMapping(newMap, headersForValidation);
            if (errors.length) throw new Error(errors.join('\n'));
            await saveSyncSettings({ column_mapping: newMap });
            alert('Column mapping saved.');
            syncOpsCtx.onRefresh();
        }).catch((e) => alert(e.message));
    });
}

async function applyDetectedBounds(prefix, pull) {
    return prepareSheetBoundsBeforeSync(pull, getSyncSettings(), prefix);
}

/** Detect header/totals rows on pull, update UI, persist to DB before import. */
async function prepareSheetBoundsBeforeSync(pull, currentSettings, prefix = '') {
    const warnings = [...(pull?.boundsWarnings || [])];
    const bounds = pull?.bounds;
    if (!bounds) return warnings;

    const p = prefix || syncOpsCtx?.prefix || '';
    const headerEl = document.getElementById(p ? `${p}ledger-sync-header-row` : 'admin-ledger-sync-header-row')
        || document.getElementById('admin-ledger-sync-header-row');
    const footerEl = document.getElementById(p ? `${p}ledger-sync-footer-row` : 'admin-ledger-sync-footer-row')
        || document.getElementById('admin-ledger-sync-footer-row');
    if (headerEl && bounds.headerRow) headerEl.value = String(bounds.headerRow);
    if (footerEl) footerEl.value = bounds.footerRow ? String(bounds.footerRow) : '';

    const saved = currentSettings || {};
    const patch = { ...(pull.boundsPatch || {}) };
    if (bounds.headerRow != null && bounds.headerRow !== saved.header_row) {
        patch.header_row = bounds.headerRow;
    }
    if (bounds.footerRow != null && bounds.footerRow !== saved.footer_row) {
        patch.footer_row = bounds.footerRow;
    }

    if (!Object.keys(patch).length) return warnings;

    try {
        await saveSyncSettings(patch);
    } catch (err) {
        warnings.push(
            `Could not save sheet bounds (${err.message}). `
            + `Using detected header row ${bounds.headerRow ?? '—'}, totals row ${bounds.footerRow ?? '—'} for this sync only.`,
        );
        const fin = portalState.finances ??= {};
        const sync = fin.ledgerSyncSettings ??= { apartment_id: portalState.access?.activeApartmentId };
        Object.assign(sync, patch);
    }

    return warnings;
}

async function persistBoundsFromPull(pull) {
    return prepareSheetBoundsBeforeSync(pull, getSyncSettings());
}

async function refreshMappingUI() {
    const mapEl = syncEl('mapping');
    if (!mapEl) return;

    const settings = getSyncSettings();
    const url = settings?.spreadsheet_url;
    const sheetName = settings?.sheet_name || 'Transactions';
    const p = syncOpsCtx.prefix;

    if (!url) {
        mapEl.innerHTML = '<p class="gate-wizard__hint">Save a spreadsheet URL above, then column mapping will load automatically.</p>';
        return;
    }

    const hasSaved = hasSavedColumnMapping(settings);
    const storedMapping = settings?.column_mapping
        ? normalizeMapping(settings.column_mapping)
        : null;

    if (hasSaved && storedMapping) {
        const cachedHeaders = storedMapping.excelHeaders?.length
            ? storedMapping.excelHeaders
            : buildHeadersFromMapping(storedMapping);
        mountMappingUI(
            mapEl,
            storedMapping,
            cachedHeaders,
            '<p class="gate-wizard__hint sync-mapping-notice"><i class="fa-solid fa-circle-notch ledger-sync-spinner"></i> Refreshing Excel headers…</p>',
        );
    } else {
        mapEl.innerHTML = '<p class="gate-wizard__hint"><i class="fa-solid fa-circle-notch ledger-sync-spinner"></i> Loading headers...</p>';
    }

    try {
        await ensureOAuthConnected(activeProvider);
        let headersRaw = [];

        if (activeProvider === 'MICROSOFT') {
            const pull = await fetchMicrosoftRows({ spreadsheetUrl: url, sheetName, syncSettings: settings });
            headersRaw = pull.bounds?.headersRaw || pull.rows?.[pull.bounds?.headerRowOffset ?? 0] || [];
            await applyDetectedBounds(p, pull);
        } else if (activeProvider === 'GOOGLE') {
            const rangeA1 = settings?.range_a1 || 'A:J';
            const pull = await fetchGoogleRows({ spreadsheetUrl: url, sheetName, rangeA1, syncSettings: settings });
            headersRaw = pull.bounds?.headersRaw || pull.rows?.[0] || [];
            await applyDetectedBounds(p, pull);
        } else if (hasSaved && storedMapping) {
            return;
        } else {
            mapEl.innerHTML = '<p class="gate-wizard__hint">Column mapping applies to Microsoft Excel or Google Sheets.</p>';
            return;
        }

        const mapping = storedMapping || buildMappingFromHeaders(headersRaw);
        mountMappingUI(mapEl, mapping, headersRaw);
    } catch (err) {
        if (hasSaved && storedMapping) {
            const fallback = storedMapping.excelHeaders?.length
                ? storedMapping.excelHeaders
                : buildHeadersFromMapping(storedMapping);
            mountMappingUI(
                mapEl,
                storedMapping,
                fallback,
                `<p class="gate-wizard__hint" style="color: var(--error);">Could not refresh Excel headers: ${err.message}. Showing saved mapping from the database — connect in step 4 and click <strong>Load columns</strong> to retry.</p>`,
            );
        } else {
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

function renderSyncLogToolbarButton() {
    return `
      <button type="button" class="btn btn-outline btn--small sync-log-open-btn" data-sync-log-open>
        <i class="fa-solid fa-terminal"></i> Sync log
      </button>`;
}

function buildSyncOpsHtml(prefix, s, hasUrl, canConnect, options = {}) {
    const { includeMapping = true, compact = false } = options;
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
      <div class="ledger-sync-ops-block${compact ? ' ledger-sync-ops-block--compact' : ''}">
        ${compact ? '' : `
        <div class="ledger-sync-panel__head" style="margin-top:0;">
          <p>Connect your account, verify the workbook, map columns, then sync.</p>
          <button type="button" class="btn btn-outline btn--small" id="${id('template')}">
            <i class="fa-solid fa-download"></i> Template
          </button>
        </div>`}

        ${hasUrl ? `
          <div class="ledger-sync-status" style="margin-bottom: 1rem; background: var(--surface-alt);">
            <i class="fa-solid fa-file-excel" style="color: #16a34a; margin-right: 0.5rem;"></i>
            <strong>Sheet:</strong> ${s.sheet_name || 'Transactions'}
            ${s.header_row ? `<span style="color:var(--text-dim); margin: 0 0.35rem;">· header row ${s.header_row}</span>` : ''}
            ${s.footer_row ? `<span style="color:var(--text-dim);">· totals row ${s.footer_row}</span>` : ''}
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
          ${isAdmin ? renderSyncLogToolbarButton() : ''}
        </div>

        <div id="${id('sheet-list')}" class="ledger-sync-sheet-list"></div>

        ${includeMapping ? `
        <details class="ledger-sync-mapping-section" id="${id('mapping-details')}" style="margin-top: 1rem;">
          <summary>Column mapping</summary>
          <div id="${id('mapping')}" style="padding: 0.5rem 0;">
            <p class="gate-wizard__hint">${hasUrl
              ? 'Click <strong>Load columns</strong> or <strong>Test link</strong> to fetch headers, then map each field.'
              : noMapHint}</p>
          </div>
        </details>` : ''}

        <div id="${id('status')}">${renderStatus()}</div>

        <details class="ledger-sync-advanced" style="margin-top: 1rem;">
          <summary style="font-size:0.75rem; color:var(--text-dim); cursor:pointer;">Advanced / troubleshooting</summary>
          <p class="gate-wizard__hint" style="margin:0.35rem 0 0.5rem;">
            <strong>Reset sync state</strong> clears sync keys on all transactions plus last-sync metadata.<br>
            <strong>Rollback last sync</strong> reverses DB changes from the most recent completed sync (inserts deleted, updates restored). Excel is not changed — use OneDrive Version History for the sheet.
          </p>
          <div style="margin-top:0.5rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button type="button" class="btn btn-outline btn--small" id="${id('reset-ms')}">
              <i class="fa-solid fa-trash-can"></i> Reset Microsoft state
            </button>
            <button type="button" class="btn btn-outline btn--small" id="${id('reset-sync-state')}" style="color: var(--error);">
              <i class="fa-solid fa-rotate-left"></i> Reset sync state
            </button>
            <button type="button" class="btn btn-outline btn--small" id="${id('rollback-sync')}" style="color: var(--error);">
              <i class="fa-solid fa-clock-rotate-left"></i> Rollback last sync
            </button>
          </div>
        </details>
      </div>`;
}

function confirmRollbackLastSync(buttonId, onRefresh) {
    const btn = buttonId ? document.getElementById(buttonId) : null;
    return withButtonBusy(btn, 'Loading…', async () => {
        const apartment_id = portalState.access?.activeApartmentId;
        if (!supabase || !apartment_id) throw new Error('Select a society first.');

        const run = await fetchLastRollbackableRun(supabase, apartment_id);
        if (!run) {
            alert('No completed sync run to roll back. If you just installed rollback, run supabase_ledger_sync_journal.sql in Supabase first.');
            return;
        }

        const counts = await fetchSyncRunChangeSummary(supabase, run.id);
        const when = run.completed_at ? new Date(run.completed_at).toLocaleString('en-IN') : 'unknown time';
        const msg = `Roll back sync from ${when}?

This will reverse in the database:
• ${counts.insert} inserted → deleted
• ${counts.update} updated → restored to before
• ${counts.deleted} removed → re-inserted
• ${counts.push_mark} pushed → sync keys cleared

Rows you edited in the app after that sync will be skipped.
Excel is NOT changed — use OneDrive Version History if the sheet needs restoring.

Continue?`;
        if (!confirm(msg)) return;

        if (btn) setButtonBusy(btn, 'Rolling back…');
        const result = await rollbackSyncRun(supabase, run.id);
        await pullState();
        refreshFinancesView();
        onRefresh?.();

        let detail = `Rollback complete: ${result.reverted} change(s) reverted`;
        if (result.skipped) detail += `, ${result.skipped} skipped (edited since sync)`;
        if (result.errors.length) detail += `\n\n${result.errors.slice(0, 8).join('\n')}`;
        alert(detail);
    }).catch((err) => alert(err.message || String(err)));
}

function confirmResetSyncState(buttonId, onRefresh) {
    const msg = `Reset sync state for testing?

This clears for the current society:
• external_sync_key and sync_hash on all transactions
• Last sync time, status, and conflict state

Excel Sync ID / Sync Status cells are not cleared — empty those columns in the sheet too if you want a fully clean re-import.

Continue?`;
    if (!confirm(msg)) return Promise.resolve();
    const btn = buttonId ? document.getElementById(buttonId) : null;
    return withButtonBusy(btn, 'Resetting…', async () => {
        const { clearedKeys } = await resetSyncState();
        alert(`Sync state reset. Cleared linkage on ${clearedKeys} transaction(s). Run sync again when ready.`);
        onRefresh?.();
    }).catch((err) => alert(err.message || String(err)));
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

    q('reset-sync-state')?.addEventListener('click', () => {
        void confirmResetSyncState(q('reset-sync-state')?.id, onRefresh);
    });

    q('rollback-sync')?.addEventListener('click', () => {
        void confirmRollbackLastSync(q('rollback-sync')?.id, onRefresh);
    });

    q('run')?.addEventListener('click', async () => {
        const btn = q('run');
        if (!btn || isSyncing) return;

        await withButtonBusy(btn, 'Syncing…', async () => {
            isSyncing = true;
            try {
                if (activeProvider !== 'FILE') await ensureOAuthConnected(activeProvider);
                const { imported, skipped, updated, pushed, conflicts, boundsWarnings } = await runSync();
                let msg = `Sync complete: ${imported} pulled, ${updated} updated, ${skipped} skipped.`;
                if (pushed > 0) msg += ` ${pushed} pushed.`;
                if (conflicts?.length) msg += ` ${conflicts.length} conflict(s) — open panel to review.`;
                if (boundsWarnings?.length) msg += `\n\nSheet bounds:\n• ${boundsWarnings.join('\n• ')}`;
                alert(msg);
                onRefresh();
            } finally {
                isSyncing = false;
            }
        }).catch((err) => {
            isSyncing = false;
            syncLog('error', err.message);
            alert(`${err.message}\n\nUse Administration → Spreadsheet sync → Sync log for details.`);
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
                const { imported, skipped, updated, pushed, conflicts, boundsWarnings } = await runSync();
                let msg = `Sync complete: ${imported} pulled, ${updated} updated, ${skipped} skipped.`;
                if (pushed > 0) msg += ` ${pushed} pushed.`;
                if (conflicts?.length) msg += ` ${conflicts.length} conflict(s) — open panel to review.`;
                if (boundsWarnings?.length) msg += `\n\nSheet bounds:\n• ${boundsWarnings.join('\n• ')}`;
                alert(msg);
                renderLedgerSyncPanel();
            } finally {
                isSyncing = false;
            }
        }).catch((err) => {
            isSyncing = false;
            syncLog('error', err.message);
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
    ws.addRow(TEMPLATE_HEADERS);
    ws.addRow(['2026-06-01', 'DR', 1500, '', '', 'Maintenance', '', 'Lift AMC', 'BANK', 'Otis', 'INV-001', 'cheque', 'CHQ-123', '', '']);
    ws.addRow(['2026-06-02', 'CR', 25000, '', '', 'Maintenance Collection', '', 'Flat A-101 June', 'BANK', '', '', 'upi', 'UPI-99', '', '']);
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
    teardownSyncLogDrawer();
    document.getElementById('sync-log-root')?.remove();
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
