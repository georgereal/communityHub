import { createClient } from '@supabase/supabase-js';
import {
    parseLedgerSheet,
    computeSyncHash,
    computeAnchorHash,
    normalizeMapping,
    colForField,
} from '../src/ledgerColumnMapping.js';
import { pushMicrosoftRows } from '../src/microsoftExcelPush.js';
import { importExcelRows } from '../src/ledgerSyncApply.js';

// Vercel Serverless Function for background ledger sync
export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers.authorization || '';
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
        return res.status(500).json({ error: 'Missing Supabase environment variables.' });
    }

    const service = createClient(supabaseUrl, supabaseServiceKey);

    // Mode A: Cron secret — sync all due societies.
    const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
    if (isCron) {
        try {
            const { data: settings, error: settingsError } = await service
                .from('ledger_sync_settings')
                .select('*, apartments(name)')
                .gt('sync_interval_minutes', 0);

            if (settingsError) throw settingsError;

            const results = [];
            for (const s of settings) {
                try {
                    const lastSynced = s.last_synced_at ? new Date(s.last_synced_at) : new Date(0);
                    const now = new Date();
                    const diffMins = (now - lastSynced) / (1000 * 60);

                    if (diffMins < s.sync_interval_minutes) {
                        results.push({ apartment: s.apartments?.name, status: 'SKIPPED', message: 'Too soon' });
                        continue;
                    }

                    const result = await performSync(service, s);
                    results.push({ apartment: s.apartments?.name, status: 'OK', result });
                } catch (err) {
                    console.error(`Sync failed for ${s.apartments?.name}:`, err);
                    results.push({ apartment: s.apartments?.name, status: 'ERROR', message: err.message });

                    await service.from('ledger_sync_settings').update({
                        last_sync_status: 'ERROR',
                        last_sync_message: `Background sync failed: ${err.message}`,
                        last_synced_at: new Date().toISOString(),
                    }).eq('apartment_id', s.apartment_id);
                }
            }

            return res.status(200).json({ results });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // Mode B: Admin test button — uses Supabase session JWT.
    if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length);
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
        return res.status(401).json({ error: 'Invalid session.' });
    }

    const apartment_id = req.body?.apartment_id;
    if (!apartment_id) {
        return res.status(400).json({ error: 'apartment_id is required.' });
    }

    const allowed = await userCanAccountsEdit(service, user.id, apartment_id);
    if (!allowed) {
        return res.status(403).json({ error: 'Not permitted.' });
    }

    try {
        const { data: settings, error: settingsError } = await service
            .from('ledger_sync_settings')
            .select('*')
            .eq('apartment_id', apartment_id)
            .maybeSingle();
        if (settingsError) throw settingsError;
        if (!settings) {
            return res.status(400).json({ error: 'Spreadsheet sync is not configured for this society yet.' });
        }

        const result = await performSync(service, settings);
        return res.status(200).json({ ok: true, result });
    } catch (err) {
        await service.from('ledger_sync_settings').update({
            last_sync_status: 'ERROR',
            last_sync_message: `Manual server sync failed: ${err.message}`,
            last_synced_at: new Date().toISOString(),
        }).eq('apartment_id', apartment_id);
        return res.status(500).json({ error: err.message });
    }
}

async function userCanAccountsEdit(supabase, userId, apartmentId) {
    // v2 RBAC first
    try {
        const { data: roles } = await supabase
            .from('user_role_assignments')
            .select('role_key, scope, apartment_id')
            .eq('user_id', userId);

        const aptRoleKeys = (roles || [])
            .filter((r) => r.scope === 'apartment' && String(r.apartment_id) === String(apartmentId))
            .map((r) => r.role_key);

        if (aptRoleKeys.length) {
            const { data: rp } = await supabase
                .from('role_permissions')
                .select('permission_key')
                .in('role_key', aptRoleKeys);
            const perms = new Set((rp || []).map((x) => x.permission_key));
            if (perms.has('accounts.edit')) return true;
        }
    } catch {
        // ignore, fall back to v1
    }

    // v1 fallback
    const { data: prof } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();
    return ['admin', 'accounts_manager'].includes(prof?.role);
}

async function resolveSyncCredentials(supabase, settings) {
    const { apartment_id, provider, last_synced_by } = settings;

    const { data: app, error: appError } = await supabase
        .from('ledger_sync_oauth_apps')
        .select('*')
        .eq('apartment_id', apartment_id)
        .eq('provider', provider)
        .maybeSingle();

    if (appError || !app) throw new Error('OAuth app not configured for this society.');
    if (provider === 'MICROSOFT' && !app.client_secret) {
        throw new Error('Microsoft client secret is not configured.');
    }

    const { data: serviceConn } = await supabase
        .from('ledger_sync_service_accounts')
        .select('*')
        .eq('apartment_id', apartment_id)
        .eq('provider', provider)
        .maybeSingle();

    if (serviceConn?.refresh_token) {
        return { conn: serviceConn, app, connTable: 'ledger_sync_service_accounts' };
    }

    if (!last_synced_by) {
        throw new Error('Connect Microsoft under Admin → Spreadsheet Sync (with client secret saved), then try again.');
    }

    const { data: conn, error: connError } = await supabase
        .from('user_oauth_connections')
        .select('*')
        .eq('user_id', last_synced_by)
        .eq('apartment_id', apartment_id)
        .eq('provider', provider)
        .maybeSingle();

    if (connError || !conn) {
        throw new Error('Microsoft connection not found. Use Connect for background sync in Admin first.');
    }

    if (!conn.refresh_token) {
        throw new Error('Microsoft connection has no refresh token. Re-connect via Admin → Connect for background sync.');
    }

    return { conn, app, connTable: 'user_oauth_connections' };
}

async function performSync(supabase, settings) {
    const { apartment_id, provider } = settings;
    const mapping = normalizeMapping(settings.column_mapping);
    if (colForField(mapping, 'date') < 0) {
        throw new Error('Column mapping is incomplete — map Date to an Excel column in Admin → Spreadsheet sync (step 3), then save.');
    }

    const { conn, app, connTable } = await resolveSyncCredentials(supabase, settings);
    // Refresh token if needed
    let accessToken = conn.access_token;
    const expired = conn.token_expires_at && new Date(conn.token_expires_at) <= new Date(Date.now() + 60000);

    if (expired) {
        accessToken = await refreshToken(supabase, conn, app, connTable);
    }

    // Pull from spreadsheet
    let rows = [];
    let pullStats = { excelDataRows: 0, parsed: 0, skipped: 0 };
    let etag = null;
    let driveId, itemId, shareId, useSharesApi;

    if (provider === 'GOOGLE') {
        const sheetId = parseGoogleSheetId(settings.spreadsheet_url);
        const range = encodeURIComponent(`${settings.sheet_name}!${settings.range_a1 || 'A:J'}`);
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || 'Google Sheets pull failed.');
        const sheet = parseLedgerSheet(json.values || [], `google:${sheetId}`, settings.column_mapping);
        rows = sheet.parsed;
        pullStats = { excelDataRows: sheet.excelDataRows, parsed: sheet.parsed.length, skipped: sheet.skipped };
    } else if (provider === 'MICROSOFT') {
        const shareIdEncoded = encodeMicrosoftShareId(settings.spreadsheet_url);
        const item = await resolveMicrosoftDriveItem(settings.spreadsheet_url, accessToken);
        driveId = item.parentReference?.driveId;
        itemId = item.id;
        etag = item.eTag;
        
        const safeSheet = settings.sheet_name.replace(/'/g, "''");
        const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/worksheets('${safeSheet}')/usedRange(valuesOnly=true)`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || 'Excel pull failed.');
        const sheet = parseLedgerSheet(json.values || [], `microsoft:${shareIdEncoded.slice(0, 32)}`, settings.column_mapping);
        rows = sheet.parsed;
        pullStats = { excelDataRows: sheet.excelDataRows, parsed: sheet.parsed.length, skipped: sheet.skipped };
        shareId = shareIdEncoded;
        useSharesApi = false;
    } else {
        throw new Error(`Unsupported sync provider: ${provider || '(none)'}.`);
    }

    if (pullStats.excelDataRows > 0 && pullStats.parsed === 0) {
        throw new Error(
            `Pulled ${pullStats.excelDataRows} Excel row(s) but none could be imported. `
            + 'Check Date, Type, and Amount (or Dr/Cr) on each row match your column mapping.',
        );
    }

    // 5. Push to Spreadsheet
    let pushed = 0;
    const localTxns = await getUnsyncedTransactions(supabase, apartment_id);
    
    if (localTxns.length > 0 && provider === 'MICROSOFT') {
        if (!driveId || !itemId) {
            throw new Error('Could not resolve Excel workbook for push. Re-save the spreadsheet URL.');
        }
        pushed = await pushMicrosoftRows({
                accessToken,
                driveId,
                itemId,
                shareId,
                useSharesApi,
                sheetName: settings.sheet_name,
                rowsToPush: localTxns,
                columnMapping: settings.column_mapping,
                onRowPushed: async (txn, excelRowIndex) => {
                    const syncKey = `app:txn:${txn.id}`;
                    const withKey = { ...txn, external_sync_key: syncKey };
                    const syncHash = computeSyncHash(withKey, settings.column_mapping);
                    const syncAnchorHash = computeAnchorHash(withKey, settings.column_mapping);
                    const { error } = await supabase.from('transactions').update({
                        external_sync_key: syncKey,
                        sync_hash: syncHash,
                        sync_anchor_hash: syncAnchorHash,
                        excel_row_index: excelRowIndex,
                    }).eq('id', txn.id);
                    if (error) throw new Error(error.message);
                },
            });
    }

    // 6. Import to DB
    const { data: allTxns } = await supabase.from('transactions').select('*').eq('apartment_id', apartment_id);
    const { imported, updated, skipped, deleted } = await importExcelRows(
        supabase, apartment_id, rows, allTxns || [], settings.column_mapping,
    );

    // 7. Update Settings
    const pullMsg = pullStats.skipped > 0
        ? ` (${pullStats.skipped} Excel row(s) skipped — missing date/type/amount)`
        : '';
    const reconcileMsg = skipped > 0 ? ` ${skipped} unchanged.` : '';
    const deletedMsg = deleted > 0 ? ` ${deleted} removed.` : '';
    await supabase.from('ledger_sync_settings').update({
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'OK',
        last_sync_message: `Auto-sync: Pulled ${imported} new, ${updated} updated, ${deleted} removed. Pushed ${pushed} new.${pullMsg}${reconcileMsg}${deletedMsg}`,
        last_sync_imported: imported,
        last_sync_pushed: pushed,
        last_sync_etag: etag
    }).eq('apartment_id', apartment_id);

    return { imported, updated, pushed, skipped, deleted, ...pullStats };
}

async function refreshToken(supabase, conn, app, connTable = 'user_oauth_connections') {
    let res, json;
    if (conn.provider === 'GOOGLE') {
        const params = {
            client_id: app.client_id,
            refresh_token: conn.refresh_token,
            grant_type: 'refresh_token',
        };
        if (app.client_secret) params.client_secret = app.client_secret;
        res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        });
    } else {
        if (!app.client_secret) throw new Error('Microsoft background sync requires a Client Secret.');
        res = await fetch(`https://login.microsoftonline.com/${app.tenant_id || 'common'}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: app.client_id,
                client_secret: app.client_secret,
                refresh_token: conn.refresh_token,
                grant_type: 'refresh_token',
                scope: 'Files.ReadWrite User.Read offline_access'
            }),
        });
    }

    json = await res.json();
    if (!res.ok) throw new Error(json.error_description || 'Token refresh failed.');

    const expiresAt = json.expires_in
        ? new Date(Date.now() + json.expires_in * 1000).toISOString()
        : null;

    await supabase.from(connTable).update({
        access_token: json.access_token,
        refresh_token: json.refresh_token || conn.refresh_token,
        token_expires_at: expiresAt,
        updated_at: new Date().toISOString()
    }).eq('id', conn.id);

    return json.access_token;
}

// Helper functions (simplified versions of frontend logic)
function parseGoogleSheetId(url) {
    const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return m?.[1] || null;
}

function encodeMicrosoftShareId(url) {
    const b64 = Buffer.from(url).toString('base64');
    return `u!${b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

async function resolveMicrosoftDriveItem(spreadsheetUrl, token) {
    try {
        const url = new URL(spreadsheetUrl);
        const driveId = url.searchParams.get('driveId');
        const docId = url.searchParams.get('docId');
        if (driveId && docId) {
            const itemId = docId.includes('!') ? docId.split('!')[1] : docId;
            const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (res.ok) return await res.json();
        }
    } catch {}
    const shareId = encodeMicrosoftShareId(spreadsheetUrl);
    const res = await fetch(`https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem`, {
        headers: { Authorization: `Bearer ${token}`, Prefer: 'redeemSharingLink' }
    });
    if (!res.ok) throw new Error('Could not resolve Microsoft drive item.');
    return await res.json();
}

async function getUnsyncedTransactions(supabase, apartment_id) {
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('apartment_id', apartment_id)
        .is('external_sync_key', null);
    if (error) throw error;
    return data || [];
}
