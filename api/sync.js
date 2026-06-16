import { createClient } from '@supabase/supabase-js';

// Vercel Serverless Function for background ledger sync
export default async function handler(req, res) {
    // 1. Auth check (Cron secret or similar)
    const authHeader = req.headers.authorization;
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        return res.status(500).json({ error: 'Missing Supabase environment variables.' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    try {
        // 2. Find all societies that have auto-sync enabled
        const { data: settings, error: settingsError } = await supabase
            .from('ledger_sync_settings')
            .select('*, apartments(name)')
            .gt('sync_interval_minutes', 0);

        if (settingsError) throw settingsError;

        const results = [];

        for (const s of settings) {
            try {
                // Check if it's time to sync
                const lastSynced = s.last_synced_at ? new Date(s.last_synced_at) : new Date(0);
                const now = new Date();
                const diffMins = (now - lastSynced) / (1000 * 60);

                if (diffMins < s.sync_interval_minutes) {
                    results.push({ apartment: s.apartments?.name, status: 'SKIPPED', message: 'Too soon' });
                    continue;
                }

                // Perform sync for this society
                const result = await performSync(supabase, s);
                results.push({ apartment: s.apartments?.name, status: 'OK', result });
            } catch (err) {
                console.error(`Sync failed for ${s.apartments?.name}:`, err);
                results.push({ apartment: s.apartments?.name, status: 'ERROR', message: err.message });
                
                // Update status in DB
                await supabase.from('ledger_sync_settings').update({
                    last_sync_status: 'ERROR',
                    last_sync_message: `Background sync failed: ${err.message}`,
                    last_synced_at: new Date().toISOString()
                }).eq('apartment_id', s.apartment_id);
            }
        }

        return res.status(200).json({ results });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

async function performSync(supabase, settings) {
    const { apartment_id, provider, last_synced_by } = settings;
    if (!last_synced_by) throw new Error('No user associated with last sync.');

    // 1. Get OAuth App config
    const { data: app, error: appError } = await supabase
        .from('ledger_sync_oauth_apps')
        .select('*')
        .eq('apartment_id', apartment_id)
        .eq('provider', provider)
        .maybeSingle();

    if (appError || !app) throw new Error('OAuth app not configured for this society.');

    // 2. Get User Connection
    const { data: conn, error: connError } = await supabase
        .from('user_oauth_connections')
        .select('*')
        .eq('user_id', last_synced_by)
        .eq('apartment_id', apartment_id)
        .eq('provider', provider)
        .maybeSingle();

    if (connError || !conn) throw new Error('User connection not found.');

    // 3. Refresh Token if needed
    let accessToken = conn.access_token;
    const expired = conn.token_expires_at && new Date(conn.token_expires_at) <= new Date(Date.now() + 60000);
    
    if (expired) {
        accessToken = await refreshToken(supabase, conn, app);
    }

    // 4. Pull from Spreadsheet
    let rows = [];
    let etag = null;
    let driveId, itemId, shareId, useSharesApi;

    if (provider === 'GOOGLE') {
        const sheetId = parseGoogleSheetId(settings.spreadsheet_url);
        const range = encodeURIComponent(`${settings.sheet_name}!${settings.range_a1 || 'A:J'}`);
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || 'Google Sheets pull failed.');
        rows = parseLedgerRowsFromAoA(json.values || [], `google:${sheetId}`, settings.column_mapping);
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
        rows = parseLedgerRowsFromAoA(json.values || [], `microsoft:${shareIdEncoded.slice(0, 32)}`, settings.column_mapping);
        shareId = shareIdEncoded;
        useSharesApi = !settings.spreadsheet_url.includes('driveId=');
    }

    // 5. Push to Spreadsheet
    let pushed = 0;
    const localTxns = await getUnsyncedTransactions(supabase, apartment_id);
    
        if (localTxns.length > 0 && provider === 'MICROSOFT') {
            pushed = await pushMicrosoftRows({
                accessToken,
                driveId,
                itemId,
                shareId,
                useSharesApi,
                sheetName: settings.sheet_name,
                rowsToPush: localTxns,
                columnMapping: settings.column_mapping
            });

        // Mark as synced in DB
        for (const txn of localTxns) {
            const syncKey = `app:txn:${txn.id}`;
            const hashBase = `${txn.date}|${txn.type}|${txn.amount}|${txn.cat}|${txn.description || ''}`;
            const syncHash = Buffer.from(hashBase).toString('base64');
            await supabase.from('transactions').update({ 
                external_sync_key: syncKey,
                sync_hash: syncHash 
            }).eq('id', txn.id);
        }
    }

    // 6. Import to DB
    const { imported, updated } = await importToDatabase(supabase, apartment_id, rows, settings.last_synced_at);

    // 7. Update Settings
    await supabase.from('ledger_sync_settings').update({
        last_synced_at: new Date().toISOString(),
        last_sync_status: 'OK',
        last_sync_message: `Auto-sync: Pulled ${imported} new, ${updated} updated. Pushed ${pushed} new.`,
        last_sync_imported: imported,
        last_sync_pushed: pushed,
        last_sync_etag: etag
    }).eq('apartment_id', apartment_id);

    return { imported, updated, pushed };
}

async function refreshToken(supabase, conn, app) {
    let res, json;
    if (conn.provider === 'GOOGLE') {
        res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: app.client_id,
                refresh_token: conn.refresh_token,
                grant_type: 'refresh_token',
            }),
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

    await supabase.from('user_oauth_connections').update({
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

function parseLedgerRowsFromAoA(aoa, sourceKey, mapping) {
    if (!aoa?.length || !mapping) return [];
    const parsed = [];
    const dateCol = mapping.date;
    const typeCol = mapping.type;
    const amtCol = mapping.amount;
    const catCol = mapping.category;
    const descCol = mapping.description;
    const walletCol = mapping.wallet;
    const vendorCol = mapping.vendor;
    const refCol = mapping.reference;
    const syncIdCol = mapping.sync_id;

    for (let i = 1; i < aoa.length; i++) {
        const row = aoa[i] || [];
        const date = row[dateCol];
        if (!date) continue;
        
        const type = String(row[typeCol] || '').toUpperCase().includes('IN') ? 'IN' : 'OUT';
        const amount = parseFloat(String(row[amtCol] || '0').replace(/[,₹]/g, '')) || 0;
        if (amount <= 0) continue;

        const syncId = syncIdCol >= 0 ? String(row[syncIdCol] || '').trim() : null;
        const hashBase = `${date}|${type}|${amount}|${String(row[catCol] || '')}|${String(row[descCol] || '')}`;
        const syncHash = Buffer.from(hashBase).toString('base64');

        parsed.push({
            row_index: i + 1,
            external_sync_key: syncId || `${sourceKey}:row:${i + 1}`,
            sync_hash: syncHash,
            date, type, amount,
            cat: row[catCol] || 'Other',
            description: row[descCol] || '',
            wallet: row[walletCol] || 'CASH',
            vendor_name: row[vendorCol] || null,
            vendor_invoice: row[refCol] || null
        });
    }
    return parsed;
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

async function pushMicrosoftRows({ accessToken, driveId, itemId, shareId, useSharesApi, sheetName, rowsToPush, columnMapping = {} }) {
    const base = useSharesApi ? `/shares/${shareId}/driveItem` : `/drives/${driveId}/items/${itemId}`;
    const safeSheet = sheetName.replace(/'/g, "''");
    
    const urRes = await fetch(`https://graph.microsoft.com/v1.0${base}/workbook/worksheets('${safeSheet}')/usedRange`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const usedRange = await urRes.json();
    const lastRowMatch = (usedRange.address || '').match(/\d+$/);
    const nextRowIndex = lastRowMatch ? parseInt(lastRowMatch[0]) + 1 : 2;

    const mapping = columnMapping || {};
    const mappedIndices = Object.values(mapping).filter(v => v >= 0);
    const maxCol = mappedIndices.length > 0 ? Math.max(...mappedIndices) : 9;

    const values = rowsToPush.map(r => {
        const rowData = new Array(maxCol + 1).fill('');
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
        setVal('sync_id', `app:txn:${r.id}`);
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
    const res = await fetch(`https://graph.microsoft.com/v1.0${base}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values })
    });
    if (!res.ok) throw new Error('Push to Excel failed.');
    return values.length;
}

async function importToDatabase(supabase, apartment_id, rows, last_sync_at) {
    const { data: existingTxns } = await supabase
        .from('transactions')
        .select('*')
        .eq('apartment_id', apartment_id)
        .not('external_sync_key', 'is', null);

    const existingMap = new Map(existingTxns.map(t => [t.external_sync_key, t]));
    let imported = 0, updated = 0;

    for (const row of rows) {
        const existing = existingMap.get(row.external_sync_key);
        if (existing) {
            if (existing.sync_hash !== row.sync_hash) {
                const dbChangedLocally = last_sync_at && existing.updated_at && new Date(existing.updated_at) > new Date(last_sync_at);
                if (!dbChangedLocally) {
                    await supabase.from('transactions').update({
                        amount: row.amount, cat: row.cat, description: row.description,
                        wallet: row.wallet, type: row.type, date: row.date,
                        vendor_name: row.vendor_name, vendor_invoice: row.vendor_invoice,
                        sync_hash: row.sync_hash, updated_at: new Date().toISOString()
                    }).eq('id', existing.id);
                    updated++;
                }
            }
        } else {
            await supabase.from('transactions').insert({
                id: crypto.randomUUID(), apartment_id,
                amount: row.amount, cat: row.cat, description: row.description,
                wallet: row.wallet, type: row.type, date: row.date,
                vendor_name: row.vendor_name, vendor_invoice: row.vendor_invoice,
                external_sync_key: row.external_sync_key, sync_hash: row.sync_hash
            });
            imported++;
        }
    }
    return { imported, updated };
}
