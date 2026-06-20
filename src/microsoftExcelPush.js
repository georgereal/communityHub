import {
    transactionToExcelRow,
    maxMappedColumn,
    colForField,
    normalizeMapping,
} from './ledgerColumnMapping.js';
import { colIndexToLetters, parseColumnRange } from './ledgerSheetRegion.js';

function colLetter(n) {
    return colIndexToLetters(n);
}

async function graphRequest(path, accessToken, init = {}) {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...init.headers,
        },
    });
    const text = await res.text();
    let json = {};
    if (text) {
        try { json = JSON.parse(text); } catch { json = {}; }
    }
    return { res, json };
}

function sessionHeaders(sessionId, extra = {}) {
    return sessionId ? { 'workbook-session-id': sessionId, ...extra } : extra;
}

async function createWorkbookSession(accessToken, base, sharesBase, driveBase) {
    const tryCreate = async (apiBase) => {
        const { res, json } = await graphRequest(
            `${apiBase}/workbook/createSession`,
            accessToken,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ persistChanges: true }),
            },
        );
        return { res, json, apiBase };
    };

    let attempt = await tryCreate(base);
    if (!attempt.res.ok && sharesBase && base === sharesBase) {
        attempt = await tryCreate(driveBase);
    }
    if (!attempt.res.ok) return null;
    return { sessionId: attempt.json.id, base: attempt.apiBase };
}

async function closeWorkbookSession(accessToken, base, sessionId) {
    if (!sessionId) return;
    const { res, json } = await graphRequest(
        `${base}/workbook/closeSession`,
        accessToken,
        {
            method: 'POST',
            headers: sessionHeaders(sessionId, { 'Content-Type': 'application/json' }),
            body: '{}',
        },
    );
    if (!res.ok && res.status !== 204) {
        const msg = json?.error?.message || `HTTP ${res.status}`;
        throw new Error(`Could not close Excel workbook session: ${msg}`);
    }
}

async function resolveWorkbookBase({ accessToken, driveId, itemId, shareId, useSharesApi, safeSheet }) {
    const sharesBase = useSharesApi && shareId ? `/shares/${shareId}/driveItem` : null;
    const driveBase = `/drives/${driveId}/items/${itemId}`;
    let base = driveId && itemId ? driveBase : (sharesBase || driveBase);

    let used = await graphRequest(
        `${base}/workbook/worksheets('${safeSheet}')/usedRange`,
        accessToken,
    );
    if (!used.res.ok && sharesBase) {
        base = driveBase;
        used = await graphRequest(
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
    sessionId = null,
}) {
    const patchRange = async (apiBase) => graphRequest(
        `${apiBase}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')`,
        accessToken,
        {
            method: 'PATCH',
            headers: sessionHeaders(sessionId, { 'Content-Type': 'application/json' }),
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

async function insertExcelRow({
    base,
    sharesBase,
    driveBase,
    accessToken,
    safeSheet,
    rangeAddress,
    sessionId = null,
}) {
    const insertAt = async (apiBase) => graphRequest(
        `${apiBase}/workbook/worksheets('${safeSheet}')/range(address='${rangeAddress}')/insert`,
        accessToken,
        {
            method: 'POST',
            headers: sessionHeaders(sessionId, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ shift: 'Down' }),
        },
    );

    let ins = await insertAt(base);
    if (!ins.res.ok && sharesBase && base === sharesBase) {
        const msg = String(ins.json?.error?.message || '');
        if (msg.includes('not supported for MSA') || msg.includes('Sharing') || ins.res.status === 400) {
            ins = await insertAt(driveBase);
        }
    }
    if (!ins.res.ok) {
        const msg = ins.json?.error?.message || `HTTP ${ins.res.status}`;
        throw new Error(`Insert row in Excel failed: ${msg} (range ${rangeAddress})`);
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
 * Push transaction rows to Excel inside a workbook session (one persist on closeSession).
 * When footerRow is set, inserts each row before the totals row (shifts totals down).
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
    rangeA1 = 'A:J',
    footerRow = null,
    onRowPushed,
}) {
    if (!rowsToPush?.length) return 0;
    if (!driveId || !itemId) {
        throw new Error('Excel workbook drive/item id missing — re-save the spreadsheet URL.');
    }

    const safeSheet = String(sheetName || 'Transactions').replace(/'/g, "''");
    let { base, sharesBase, driveBase, nextRowIndex } = await resolveWorkbookBase({
        accessToken,
        driveId,
        itemId,
        shareId,
        useSharesApi,
        safeSheet,
    });

    const session = await createWorkbookSession(accessToken, base, sharesBase, driveBase);
    let sessionId = session?.sessionId ?? null;
    if (session?.base) base = session.base;

    if (sessionId) {
        console.log('Excel push: using workbook session (single persist on close)');
    } else {
        console.warn('Excel push: workbook session unavailable — falling back to per-row persist');
    }

    const { startCol } = parseColumnRange(rangeA1 || 'A:J');
    const insertBeforeFooter = footerRow != null && footerRow > 0;
    let targetRow = insertBeforeFooter ? footerRow : nextRowIndex;

    const pendingCallbacks = [];
    let pushed = 0;
    const total = rowsToPush.length;

    try {
        for (const txn of rowsToPush) {
            const { row, maxCol } = excelRowValues(txn, columnMapping);
            const writeRange = `${startCol}${targetRow}:${colLetter(maxCol)}${targetRow}`;

            if (insertBeforeFooter) {
                await insertExcelRow({
                    base,
                    sharesBase,
                    driveBase,
                    accessToken,
                    safeSheet,
                    rangeAddress: writeRange,
                    sessionId,
                });
            }

            await patchExcelRow({
                base,
                sharesBase,
                driveBase,
                accessToken,
                safeSheet,
                rangeAddress: writeRange,
                values: row.slice(0, maxCol + 1),
                sessionId,
            });

            pushed += 1;
            pendingCallbacks.push({ txn, excelRowIndex: targetRow });
            console.log(`Excel push: row ${pushed}/${total} → ${writeRange}${insertBeforeFooter ? ' (before totals)' : ''}`);
            targetRow += 1;
        }

        if (sessionId) {
            await closeWorkbookSession(accessToken, base, sessionId);
            sessionId = null;
        }

        for (const { txn, excelRowIndex } of pendingCallbacks) {
            if (onRowPushed) await onRowPushed(txn, excelRowIndex);
        }
    } catch (err) {
        if (sessionId) {
            try {
                await closeWorkbookSession(accessToken, base, sessionId);
            } catch (closeErr) {
                console.warn('Excel push: closeSession after error failed:', closeErr.message);
            }
        }
        throw err;
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
    let { base, sharesBase, driveBase } = await resolveWorkbookBase({
        accessToken,
        driveId,
        itemId,
        shareId,
        useSharesApi,
        safeSheet,
    });

    const session = await createWorkbookSession(accessToken, base, sharesBase, driveBase);
    const sessionId = session?.sessionId ?? null;
    if (session?.base) base = session.base;

    try {
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
                sessionId,
            });
            written += 1;
        }
        if (sessionId) await closeWorkbookSession(accessToken, base, sessionId);
        return written;
    } catch (err) {
        if (sessionId) {
            try { await closeWorkbookSession(accessToken, base, sessionId); } catch { /* ignore */ }
        }
        throw err;
    }
}
