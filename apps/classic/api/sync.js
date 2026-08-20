import { createServiceClient } from '../../../packages/server/serverSupabase.js';
import { requireApartmentPermission } from '../../../packages/server/serverAuth.js';
import {
    parseLedgerSheet,
    computeSyncHash,
    computeAnchorHash,
    normalizeMapping,
    colForField,
} from '../src/ledgerColumnMapping.js';
import { pushMicrosoftRows } from '../src/microsoftExcelPush.js';
import { importExcelRows } from '../src/ledgerSyncApply.js';
import { getLedgerSyncExportRows, resolveSyncColumnMapping } from '../src/ledgerDisplayRows.js';
import { setRunLogSink, syncLog, syncLogBounds } from '../src/ledgerSyncLog.js';
import {
    buildSyncFetchRange,
    parseRangeAddress,
    reconcileSheetBoundsForSync,
} from '../src/ledgerSheetRegion.js';
import {
    createSyncRunJournal,
    journalPushMark,
    snapshotTxn,
} from '../src/ledgerSyncJournal.js';

// Vercel Serverless Function for background ledger sync
export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers.authorization || '';
    const service = createServiceClient();

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

                    const result = await performSync(service, s, { source: 'cron' });
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
    const apartment_id = req.body?.apartment_id;
    if (!apartment_id) {
        return res.status(400).json({ error: 'apartment_id is required.' });
    }

    try {
        await requireApartmentPermission(req, apartment_id, 'accounts.edit');
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
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

        const result = await performSync(service, settings, { source: 'manual_api' });
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

async function performSync(supabase, settings, { source = 'cron' } = {}) {
    const { apartment_id, provider } = settings;
    let columnMapping = normalizeMapping(settings.column_mapping);
    if (colForField(columnMapping, 'date') < 0) {
        columnMapping = resolveSyncColumnMapping(settings, []);
    }
    if (colForField(columnMapping, 'date') < 0) {
        throw new Error('Column mapping is incomplete — map Date to an Excel column in Admin → Spreadsheet sync (step 3), then save.');
    }

    const journal = await createSyncRunJournal(supabase, apartment_id, {
        source,
        created_by: settings.last_synced_by || null,
    });
    setRunLogSink((level, message, detail) => journal.log(level, message, detail));
    syncLog('info', `Sync started (${source})`, { apartment_id, provider, runId: journal.runId });

    try {
    const { conn, app, connTable } = await resolveSyncCredentials(supabase, settings);
    // Refresh token if needed
    let accessToken = conn.access_token;
    const expired = conn.token_expires_at && new Date(conn.token_expires_at) <= new Date(Date.now() + 60000);

    if (expired) {
        accessToken = await refreshToken(supabase, conn, app, connTable);
    }

    // Pull from spreadsheet
    let rows = [];
    let pullStats = { excelDataRows: 0, parsed: 0, skipped: 0, unparseableNonEmpty: 0 };
    let etag = null;
    let driveId, itemId, shareId, useSharesApi;

    let sheetBounds = null;
    let boundsWarnings = [];
    let boundsPatch = {};

    if (provider === 'GOOGLE') {
        const sheetId = parseGoogleSheetId(settings.spreadsheet_url);
        const rangeA1 = settings.range_a1 || 'A:J';
        const fetchRange = buildSyncFetchRange(rangeA1);
        const range = encodeURIComponent(`${settings.sheet_name}!${fetchRange}`);
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || 'Google Sheets pull failed.');
        const rangeMeta = parseRangeAddress(fetchRange);
        const reconciled = reconcileSheetBoundsForSync(json.values || [], settings, rangeMeta);
        sheetBounds = reconciled.bounds;
        boundsWarnings = reconciled.warnings;
        boundsPatch = reconciled.settingsPatch;
        columnMapping = resolveSyncColumnMapping(
            { ...settings, column_mapping: columnMapping },
            sheetBounds?.headersRaw || [],
        );
        const sheet = parseLedgerSheet(json.values || [], `google:${sheetId}`, columnMapping, sheetBounds);
        rows = sheet.parsed;
        pullStats = {
            excelDataRows: sheet.excelDataRows,
            parsed: sheet.parsed.length,
            skipped: sheet.skipped,
            unparseableNonEmpty: sheet.unparseableNonEmpty ?? 0,
        };
        syncLogBounds(sheetBounds, boundsWarnings);
        syncLog('info', `Parsed ${rows.length} row(s) from Google Sheets`);
    } else if (provider === 'MICROSOFT') {
        const shareIdEncoded = encodeMicrosoftShareId(settings.spreadsheet_url);
        const item = await resolveMicrosoftDriveItem(settings.spreadsheet_url, accessToken);
        driveId = item.parentReference?.driveId;
        itemId = item.id;
        etag = item.eTag;

        const safeSheet = settings.sheet_name.replace(/'/g, "''");
        const fetchUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/worksheets('${safeSheet}')/usedRange(valuesOnly=true)`;
        const res = await fetch(fetchUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || 'Excel pull failed.');
        const rangeMeta = json.address ? parseRangeAddress(json.address) : { startRow: 1, endRow: null, startCol: 'A', endCol: 'J' };
        const reconciled = reconcileSheetBoundsForSync(json.values || [], settings, rangeMeta);
        sheetBounds = reconciled.bounds;
        boundsWarnings = reconciled.warnings;
        boundsPatch = reconciled.settingsPatch;
        columnMapping = resolveSyncColumnMapping(
            { ...settings, column_mapping: columnMapping },
            sheetBounds?.headersRaw || [],
        );
        const sheet = parseLedgerSheet(json.values || [], `microsoft:${shareIdEncoded.slice(0, 32)}`, columnMapping, sheetBounds);
        rows = sheet.parsed;
        pullStats = {
            excelDataRows: sheet.excelDataRows,
            parsed: sheet.parsed.length,
            skipped: sheet.skipped,
            unparseableNonEmpty: sheet.unparseableNonEmpty ?? 0,
        };
        syncLogBounds(sheetBounds, boundsWarnings);
        syncLog('info', `Parsed ${rows.length} row(s) from Excel`, { address: rangeMeta });
        shareId = shareIdEncoded;
        useSharesApi = false;
    } else {
        throw new Error(`Unsupported sync provider: ${provider || '(none)'}.`);
    }

    if (pullStats.unparseableNonEmpty > 0) {
        throw new Error(
            `Pulled ${pullStats.excelDataRows} Excel row(s) but ${pullStats.unparseableNonEmpty} had data that could not be imported. `
            + 'Check Date, Type, and Amount (or Dr/Cr) on each row match your column mapping.',
        );
    }

    // Push to spreadsheet
    let pushed = 0;
    const reconciledIds = await loadReconciledTxnIds(supabase, apartment_id);
    const unsynced = await getUnsyncedTransactions(supabase, apartment_id);
    const rowsToPush = getLedgerSyncExportRows(unsynced, { reconciledIds });
    
    if (rowsToPush.length > 0 && provider === 'MICROSOFT') {
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
                rowsToPush,
                columnMapping,
                rangeA1: settings.range_a1 || 'A:M',
                headerRow: sheetBounds?.headerRow ?? settings.header_row ?? null,
                footerRow: sheetBounds?.footerRow ?? settings.footer_row ?? null,
                onRowPushed: async (txn, excelRowIndex) => {
                    const before = snapshotTxn(txn);
                    const syncKey = `app:txn:${txn.id}`;
                    const withKey = { ...txn, external_sync_key: syncKey };
                    const syncHash = computeSyncHash(withKey, columnMapping);
                    const syncAnchorHash = computeAnchorHash(withKey, columnMapping);
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
    }

    // 6. Import to DB
    const { data: allTxns } = await supabase.from('transactions').select('*').eq('apartment_id', apartment_id);
    const { imported, updated, skipped, deleted } = await importExcelRows(
        supabase, apartment_id, rows, allTxns || [], columnMapping, { journal },
    );

    // 7. Update Settings
    const pullMsg = pullStats.skipped > 0
        ? ` (${pullStats.skipped} Excel row(s) skipped — missing date/type/amount)`
        : '';
    const reconcileMsg = skipped > 0 ? ` ${skipped} unchanged.` : '';
    const deletedMsg = deleted > 0 ? ` ${deleted} removed.` : '';
    const boundsMsg = boundsWarnings.length ? ` Bounds: ${boundsWarnings.join('; ')}.` : '';
    const syncStatus = boundsWarnings.length ? 'WARN' : 'OK';
    const statusMessage = `Auto-sync: Pulled ${imported} new, ${updated} updated, ${deleted} removed. Pushed ${pushed} new.${pullMsg}${reconcileMsg}${deletedMsg}${boundsMsg}`;

    await journal.complete({
        imported,
        updated,
        deleted,
        skipped,
        pushed,
        status: syncStatus,
        message: statusMessage,
        bounds: sheetBounds,
    });

    await supabase.from('ledger_sync_settings').update({
        ...boundsPatch,
        ...(columnMapping?.ledgerUiFormat && !settings.column_mapping?.ledgerUiFormat
            ? { column_mapping: columnMapping }
            : {}),
        last_synced_at: new Date().toISOString(),
        last_sync_status: syncStatus,
        last_sync_message: statusMessage,
        last_sync_imported: imported,
        last_sync_pushed: pushed,
        last_sync_etag: etag,
    }).eq('apartment_id', apartment_id);

    return { imported, updated, pushed, skipped, deleted, syncRunId: journal.runId, ...pullStats };
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
        .is('external_sync_key', null)
        .or('excluded_from_ledger.is.null,excluded_from_ledger.eq.false');
    if (error) throw error;
    return data || [];
}

async function loadReconciledTxnIds(supabase, apartment_id) {
    const { data, error } = await supabase
        .from('bank_statement_lines')
        .select('transaction_id')
        .eq('apartment_id', apartment_id)
        .eq('match_status', 'MATCHED');
    if (error) return new Set();
    return new Set((data || []).map((row) => row.transaction_id).filter(Boolean));
}
