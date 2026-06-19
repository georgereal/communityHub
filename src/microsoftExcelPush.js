import { transactionToExcelRow, maxMappedColumn, colForField, normalizeMapping } from './ledgerColumnMapping.js';

function colLetter(n) {
    let letter = '';
    let i = n;
    while (i >= 0) {
        letter = String.fromCharCode((i % 26) + 65) + letter;
        i = Math.floor(i / 26) - 1;
    }
    return letter;
}

async function graphJson(path, accessToken, init = {}) {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...init.headers,
        },
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
}

async function resolveWorkbookBase({ accessToken, driveId, itemId, shareId, useSharesApi, safeSheet }) {
    const sharesBase = useSharesApi && shareId ? `/shares/${shareId}/driveItem` : null;
    const driveBase = `/drives/${driveId}/items/${itemId}`;
    let base = driveId && itemId ? driveBase : (sharesBase || driveBase);

    let used = await graphJson(
        `${base}/workbook/worksheets('${safeSheet}')/usedRange`,
        accessToken,
    );
    if (!used.res.ok && sharesBase) {
        base = driveBase;
        used = await graphJson(
            `${base}/workbook/worksheets('${safeSheet}')/usedRange`,
            accessToken,
        );
    }
    if (!used.res.ok) {
        const msg = used.json?.error?.message || 'Could not read Excel workbook used range.';
        throw new Error(msg);
    }

    const address = used.json.address || '';
    const lastRowMatch = address.match(/\d+$/);
    const nextRowIndex = lastRowMatch ? parseInt(lastRowMatch[0], 10) + 1 : 2;

    return { base, sharesBase, driveBase, nextRowIndex };
}

async function patchExcelRow({
    base,
    sharesBase,
    driveBase,
    accessToken,
    safeSheet,
    rangeAddress,
    values,
}) {
    const patchRange = async (apiBase) => graphJson(
        `${apiBase}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')`,
        accessToken,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [values] }),
        },
    );

    let patch = await patchRange(base);

    if (!patch.res.ok && sharesBase && base === sharesBase) {
        const msg = String(patch.json?.error?.message || '');
        if (msg.includes('not supported for MSA') || msg.includes('Sharing') || patch.res.status === 400) {
            patch = await patchRange(driveBase);
        }
    }

    if (!patch.res.ok) {
        const code = patch.json?.error?.code ? ` [${patch.json.error.code}]` : '';
        const msg = patch.json?.error?.message || `HTTP ${patch.res.status}`;
        throw new Error(`Push to Excel failed: ${msg}${code} (range ${rangeAddress}, sheet "${safeSheet}")`);
    }
}

function excelRowValues(txn, columnMapping) {
    const { rowData, maxCol } = transactionToExcelRow(txn, columnMapping);
    const width = Math.max(maxCol, maxMappedColumn(columnMapping)) + 1;
    const row = rowData.slice(0, width);
    while (row.length < width) row.push('');
    return { row, maxCol: width - 1 };
}

/**
 * Append transaction rows to Excel one at a time via Microsoft Graph.
 * Calls onRowPushed(txn, excelRowIndex) after each successful row (optional).
 */
export async function pushMicrosoftRows({
    accessToken,
    driveId,
    itemId,
    shareId,
    useSharesApi,
    sheetName,
    rowsToPush,
    columnMapping = {},
    onRowPushed,
}) {
    if (!rowsToPush?.length) return 0;
    if (!driveId || !itemId) {
        throw new Error('Excel workbook drive/item id missing — re-save the spreadsheet URL.');
    }

    const safeSheet = String(sheetName || 'Transactions').replace(/'/g, "''");
    const { base, sharesBase, driveBase, nextRowIndex: startRow } = await resolveWorkbookBase({
        accessToken,
        driveId,
        itemId,
        shareId,
        useSharesApi,
        safeSheet,
    });

    let nextRowIndex = startRow;
    let pushed = 0;
    const total = rowsToPush.length;

    for (const txn of rowsToPush) {
        const { row, maxCol } = excelRowValues(txn, columnMapping);
        const rangeAddress = `A${nextRowIndex}:${colLetter(maxCol)}${nextRowIndex}`;

        await patchExcelRow({
            base,
            sharesBase,
            driveBase,
            accessToken,
            safeSheet,
            rangeAddress,
            values: row,
        });

        pushed += 1;
        if (onRowPushed) {
            await onRowPushed(txn, nextRowIndex);
        }

        console.log(`Excel push: row ${pushed}/${total} → ${rangeAddress}`);
        nextRowIndex += 1;
    }

    return pushed;
}

/** Write Sync ID values back to the mapped Excel column (one cell per row). */
export async function writeExcelSyncIds({
    accessToken,
    driveId,
    itemId,
    shareId,
    useSharesApi,
    sheetName,
    columnMapping,
    assignments = [],
}) {
    if (!assignments.length || !driveId || !itemId) return 0;

    const syncCol = colForField(normalizeMapping(columnMapping), 'external_sync_key');
    if (syncCol < 0) return 0;

    const safeSheet = String(sheetName || 'Transactions').replace(/'/g, "''");
    const { base, sharesBase, driveBase } = await resolveWorkbookBase({
        accessToken,
        driveId,
        itemId,
        shareId,
        useSharesApi,
        safeSheet,
    });

    const col = colLetter(syncCol);
    let written = 0;
    for (const { rowIndex, syncKey } of assignments) {
        if (!rowIndex || !syncKey) continue;
        const rangeAddress = `${col}${rowIndex}:${col}${rowIndex}`;
        await patchExcelRow({
            base,
            sharesBase,
            driveBase,
            accessToken,
            safeSheet,
            rangeAddress,
            values: [syncKey],
        });
        written += 1;
    }
    return written;
}
