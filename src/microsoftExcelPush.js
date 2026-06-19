import { rowsToExcelValues } from './ledgerColumnMapping.js';

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

/**
 * Append transaction rows to an Excel Online worksheet via Microsoft Graph.
 * Tries shares API first when configured; falls back to drive endpoints (required for MSA).
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
}) {
    if (!rowsToPush?.length) return 0;
    if (!driveId || !itemId) {
        throw new Error('Excel workbook drive/item id missing — re-save the spreadsheet URL.');
    }

    const sharesBase = useSharesApi && shareId ? `/shares/${shareId}/driveItem` : null;
    const driveBase = `/drives/${driveId}/items/${itemId}`;
    // After resolving the workbook item, drive endpoints are more reliable (especially MSA / personal accounts).
    let base = driveId && itemId ? driveBase : (sharesBase || driveBase);
    const safeSheet = String(sheetName || 'Transactions').replace(/'/g, "''");

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

    const { values, maxCol } = rowsToExcelValues(rowsToPush, columnMapping);
    if (!values.length) return 0;

    const width = maxCol + 1;
    const padded = values.map((row) => {
        const out = row.slice(0, width);
        while (out.length < width) out.push('');
        return out;
    });

    const endRow = nextRowIndex + padded.length - 1;
    const rangeAddress = `A${nextRowIndex}:${colLetter(maxCol)}${endRow}`;

    const patchRange = async (apiBase) => graphJson(
        `${apiBase}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')`,
        accessToken,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: padded }),
        },
    );

    let patch = await patchRange(base);

    if (!patch.res.ok && sharesBase) {
        const msg = String(patch.json?.error?.message || '');
        if (msg.includes('not supported for MSA') || msg.includes('Sharing') || patch.res.status === 400) {
            patch = await patchRange(driveBase);
            base = driveBase;
        }
    }

    if (!patch.res.ok) {
        const code = patch.json?.error?.code ? ` [${patch.json.error.code}]` : '';
        const msg = patch.json?.error?.message || `HTTP ${patch.res.status}`;
        throw new Error(`Push to Excel failed: ${msg}${code} (range ${rangeAddress}, sheet "${sheetName}")`);
    }

    return padded.length;
}
