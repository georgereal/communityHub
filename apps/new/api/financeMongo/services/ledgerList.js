/**
 * Ledger list filters + pagination — shared by loadLedger / export / unmatched-bank.
 */
import { dayKey } from '../money.js';
import { computeLedgerRunningBalances } from './ledgerBalances.js';

function aptFilter(apartmentId) {
    return { apartment_id: apartmentId };
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function monthBounds(year, month) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 0 || m > 11) return null;
    const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const endDate = new Date(y, m + 1, 0);
    const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
    return { start, end };
}

/**
 * Build Mongo filter for paginated ledger list / export.
 * @param {string} apartmentId
 * @param {Record<string, unknown>} body
 */
export function buildLedgerListFilter(apartmentId, body = {}) {
    const filter = { ...aptFilter(apartmentId) };

    const includeExcluded = body.include_excluded === true
        || body.include_excluded === '1'
        || body.includeExcluded === true;
    if (!includeExcluded) {
        filter.excluded_from_ledger = { $ne: true };
    }

    const type = body.type || body.pivot_type;
    if (type === 'IN' || type === 'OUT') filter.type = type;

    const wallet = body.wallet || body.pivot_wallet;
    if (wallet === 'BANK' || wallet === 'CASH') {
        if (wallet === 'BANK') filter.wallet = 'BANK';
        else {
            filter.$and = filter.$and || [];
            filter.$and.push({
                $or: [
                    { wallet: 'CASH' },
                    { wallet: { $exists: false } },
                    { wallet: null },
                    { wallet: '' },
                ],
            });
        }
    }

    const cat = String(body.cat || '').trim();
    if (cat) filter.cat = cat;

    const txnId = body.transaction_id || body.transactionId;
    if (txnId) filter.id = String(txnId);
    const txnIds = body.transaction_ids;
    if (!txnId && txnIds) {
        const ids = String(txnIds).split(',').map((s) => s.trim()).filter(Boolean);
        if (ids.length) filter.id = { $in: ids };
    }

    let dateFrom = body.date_from || body.dateFrom || null;
    let dateTo = body.date_to || body.dateTo || null;

    if (body.pivot_year != null && body.pivot_month != null) {
        const bounds = monthBounds(body.pivot_year, body.pivot_month);
        if (bounds) {
            dateFrom = bounds.start;
            dateTo = bounds.end;
        }
    }

    // Exact calendar day (same-day reorder peers)
    const day = body.date || body.day;
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
        dateFrom = String(day).slice(0, 10);
        dateTo = dateFrom;
    }

    if (dateFrom || dateTo) {
        filter.date = {};
        if (dateFrom) filter.date.$gte = String(dateFrom).slice(0, 10);
        if (dateTo) filter.date.$lte = String(dateTo).slice(0, 10);
    }

    const pivotKey = body.pivot_key || body.key;
    const dimension = body.pivot_dimension || body.dimension || 'cat';
    if (pivotKey && pivotKey !== '__other__') {
        if (dimension === 'sub_category') {
            if (pivotKey === '(none)') {
                filter.$and = filter.$and || [];
                filter.$and.push({
                    $or: [
                        { sub_category: { $exists: false } },
                        { sub_category: null },
                        { sub_category: '' },
                    ],
                });
            } else {
                filter.sub_category = pivotKey;
            }
        } else if (dimension === 'vendor') {
            if (pivotKey === '(none)') {
                filter.$and = filter.$and || [];
                filter.$and.push({
                    $or: [
                        { vendor_name: { $exists: false } },
                        { vendor_name: null },
                        { vendor_name: '' },
                    ],
                });
            } else {
                filter.vendor_name = pivotKey;
            }
        } else if (dimension === 'wallet_cat') {
            if (String(pivotKey).includes('|')) {
                const [w, ...rest] = String(pivotKey).split('|');
                const catKey = rest.join('|');
                if (w === 'BANK') filter.wallet = 'BANK';
                else {
                    filter.$and = filter.$and || [];
                    filter.$and.push({
                        $or: [
                            { wallet: 'CASH' },
                            { wallet: { $exists: false } },
                            { wallet: null },
                            { wallet: '' },
                        ],
                    });
                }
                if (catKey) filter.cat = catKey;
            } else if (pivotKey === 'BANK' || pivotKey === 'CASH') {
                // group row — wallet only already handled above if pivot_wallet set
                if (pivotKey === 'BANK') filter.wallet = 'BANK';
            } else {
                filter.cat = pivotKey;
            }
        } else {
            filter.cat = pivotKey;
        }
    }

    const sourceScope = body.source_scope || body.sourceScope;
    if (sourceScope === 'sheet') {
        filter.$and = filter.$and || [];
        filter.$and.push({
            $or: [
                { external_sync_key: { $exists: true, $nin: [null, ''] } },
                { sync_hash: { $exists: true, $nin: [null, ''] } },
            ],
        });
        filter.exclude_from_reports = { $ne: true };
    } else if (sourceScope === 'excluded-reports') {
        filter.exclude_from_reports = true;
    } else if (sourceScope === 'manual') {
        filter.exclude_from_reports = { $ne: true };
        filter.$and = filter.$and || [];
        filter.$and.push({
            $and: [
                {
                    $or: [
                        { external_sync_key: { $exists: false } },
                        { external_sync_key: null },
                        { external_sync_key: '' },
                    ],
                },
                {
                    $or: [
                        { sync_hash: { $exists: false } },
                        { sync_hash: null },
                        { sync_hash: '' },
                    ],
                },
            ],
        });
        // "bank" scope needs matched statement ids — handled by caller when needed
    }

    const q = String(body.q || '').trim();
    if (q) {
        const re = { $regex: escapeRe(q), $options: 'i' };
        const textOr = [
            { description: re },
            { vendor_name: re },
            { vendor_invoice: re },
            { bank_reference: re },
            { sub_category: re },
            { cat: re },
            { wallet: re },
        ];
        // Numeric queries also match amount substring ("81" → 81500).
        const amtQ = q.replace(/[^\d.]/g, '');
        if (amtQ) {
            textOr.push({
                $expr: {
                    $regexMatch: {
                        input: { $toString: '$amount' },
                        regex: escapeRe(amtQ),
                    },
                },
            });
        }
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: textOr });
    }

    const noVouchers = body.no_vouchers === true
        || body.no_vouchers === '1'
        || body.no_vouchers === 'true'
        || body.noVouchers === true;
    if (noVouchers) {
        filter.$and = filter.$and || [];
        filter.$and.push({
            $or: [
                { voucherIds: { $exists: false } },
                { voucherIds: { $size: 0 } },
            ],
        });
    }

    // Excel-style column filters from the ledger UI (passbook/bills stay client-side).
    const and = () => { filter.$and = filter.$and || []; return filter.$and; };
    const pushOr = (ors) => { if (ors.length) and().push({ $or: ors }); };
    const textRe = (s) => ({ $regex: escapeRe(String(s).trim()), $options: 'i' });

    const colDate = String(body.col_date || '').trim();
    if (colDate) {
        // `date` is stored as ISO string/Date — normalize to string and substring-match.
        and().push({
            $expr: {
                $regexMatch: {
                    input: { $toString: '$date' },
                    regex: escapeRe(colDate),
                    options: 'i',
                },
            },
        });
    }

    const colDesc = String(body.col_description || '').trim();
    if (colDesc) {
        const re = textRe(colDesc);
        pushOr([{ description: re }, { bank_reference: re }, { vendor_invoice: re }]);
    }

    const colType = String(body.col_type || '').trim().toLowerCase();
    if (colType) {
        // Client joins tokens: 'income'|'expense' 'no reports' 'reconciled'.
        // 'reconciled' can't be evaluated server-side — skip it (client post-filter).
        const wantsIn = colType.includes('income');
        const wantsOut = colType.includes('expense');
        if (wantsIn && !wantsOut) filter.type = 'IN';
        else if (wantsOut && !wantsIn) filter.type = 'OUT';
        if (colType.includes('no report')) filter.exclude_from_reports = true;
    }

    const colCat = String(body.col_cat || '').trim();
    if (colCat) {
        const re = textRe(colCat);
        pushOr([{ cat: re }, { sub_category: re }, { vendor_name: re }]);
    }

    const colWallet = String(body.col_wallet || '').trim();
    if (colWallet) {
        const re = textRe(colWallet);
        pushOr([{ wallet: re }]);
    }

    let colAmount = null;
    if (body.col_amount) {
        try { colAmount = typeof body.col_amount === 'string' ? JSON.parse(body.col_amount) : body.col_amount; } catch { colAmount = null; }
    }
    if (colAmount && colAmount.kind === 'number') {
        const v = parseFloat(colAmount.value);
        const v2 = parseFloat(colAmount.value2);
        // Signed amount: IN → +amount, OUT → −amount.
        const signed = { $cond: [{ $eq: ['$type', 'IN'] }, '$amount', { $multiply: ['$amount', -1] }] };
        const op = colAmount.op;
        const exprs = [];
        // eq matches the displayed magnitude — "equals 1" should hit a −₹1 expense too.
        const absSigned = { $abs: signed };
        if (op === 'eq' && Number.isFinite(v)) exprs.push({ $gte: [absSigned, Math.abs(v) - 0.005] }, { $lte: [absSigned, Math.abs(v) + 0.005] });
        else if (op === 'gt' && Number.isFinite(v)) exprs.push({ $gt: [signed, v] });
        else if (op === 'gte' && Number.isFinite(v)) exprs.push({ $gte: [signed, v] });
        else if (op === 'lt' && Number.isFinite(v)) exprs.push({ $lt: [signed, v] });
        else if (op === 'lte' && Number.isFinite(v)) exprs.push({ $lte: [signed, v] });
        else if (op === 'between' && (Number.isFinite(v) || Number.isFinite(v2))) {
            const lo = Number.isFinite(v) && Number.isFinite(v2) ? Math.min(v, v2) : (Number.isFinite(v) ? v : -Infinity);
            const hi = Number.isFinite(v) && Number.isFinite(v2) ? Math.max(v, v2) : (Number.isFinite(v2) ? v2 : Infinity);
            exprs.push({ $gte: [signed, lo] }, { $lte: [signed, hi] });
        }
        exprs.forEach((e) => and().push({ $expr: e }));
    }

    return filter;
}

export function ledgerListPaging(body = {}, { defaultLimit = 50, maxLimit = 200 } = {}) {
    const limit = Math.min(Math.max(Number(body.limit) || defaultLimit, 1), maxLimit);
    const offset = Math.max(Number(body.offset) || 0, 0);
    return { limit, offset };
}

/**
 * Paginated ledger list.
 */
export async function loadLedgerPage(db, apartmentId, body = {}) {
    const filter = buildLedgerListFilter(apartmentId, body);
    const { limit, offset } = ledgerListPaging(body);

    // source_scope=bank: rows matched on statement — need matched ids from imports
    if ((body.source_scope || body.sourceScope) === 'bank') {
        const matchedIds = await collectMatchedTxnIds(db, apartmentId);
        filter.id = { $in: matchedIds.length ? matchedIds : ['__none__'] };
        filter.exclude_from_reports = { $ne: true };
        // exclude sheet-synced
        filter.$and = filter.$and || [];
        filter.$and.push({
            $and: [
                {
                    $or: [
                        { external_sync_key: { $exists: false } },
                        { external_sync_key: null },
                        { external_sync_key: '' },
                    ],
                },
                {
                    $or: [
                        { sync_hash: { $exists: false } },
                        { sync_hash: null },
                        { sync_hash: '' },
                    ],
                },
            ],
        });
    } else if ((body.source_scope || body.sourceScope) === 'omitted') {
        // excluded OR unstructured manual — approximate as exclude_from_reports OR (no sheet keys)
        // Keep simple: exclude_from_reports OR no sync keys (manual-ish)
        delete filter.exclude_from_reports;
        filter.$or = [
            { exclude_from_reports: true },
            {
                $and: [
                    {
                        $or: [
                            { external_sync_key: { $exists: false } },
                            { external_sync_key: null },
                            { external_sync_key: '' },
                        ],
                    },
                    {
                        $or: [
                            { sync_hash: { $exists: false } },
                            { sync_hash: null },
                            { sync_hash: '' },
                        ],
                    },
                ],
            },
        ];
    }

    const col = db.collection('ledger_entries');
    const [total, entries] = await Promise.all([
        col.countDocuments(filter),
        col.find(filter).sort({ date: -1, created_at: -1 }).skip(offset).limit(limit).toArray(),
    ]);

    const config = await db.collection('finance_config').findOne(aptFilter(apartmentId)) || {};
    const lb = config.ledgerBalance || {};

    // Paginated rows rely on stored running_balance_after for the calculated
    // column — recompute live when it is stale or was never recalculated.
    const bankRowsMissingBalance = entries.some((t) =>
        String(t.wallet || '').toUpperCase() === 'BANK'
        && !t.excluded_from_ledger
        && (t.running_balance_after == null || t.running_balance_after === ''));
    if ((lb.needsRecalc === true || bankRowsMissingBalance)
        && config.bankAccount?.opening_balance != null) {
        try {
            const { byId } = await computeLedgerRunningBalances(db, apartmentId, config);
            for (const t of entries) {
                const id = String(t._id || t.id);
                if (byId.has(id)) t.running_balance_after = byId.get(id);
            }
        } catch (err) {
            console.warn('[finance/ledger] live balance overlay failed:', err?.message || err);
        }
    }

    return {
        entries,
        total,
        offset,
        limit,
        hasMore: offset + entries.length < total,
        ledgerBalance: {
            needsRecalc: lb.needsRecalc === true,
            dirtyFromDate: lb.dirtyFromDate || null,
            lastRecalcAt: lb.lastRecalcAt || null,
            closing: lb.closing != null && !Number.isNaN(parseFloat(lb.closing))
                ? parseFloat(lb.closing)
                : null,
        },
    };
}

async function collectMatchedTxnIds(db, apartmentId) {
    const imports = await db.collection('bank_imports')
        .find(aptFilter(apartmentId))
        .project({ 'lines.match_status': 1, 'lines.transaction_id': 1 })
        .toArray();
    const ids = new Set();
    for (const imp of imports || []) {
        for (const line of imp.lines || []) {
            if (line.match_status === 'MATCHED' && line.transaction_id) {
                ids.add(String(line.transaction_id));
            }
        }
    }
    return [...ids];
}

/**
 * BANK ledger rows not matched on any statement line — for bank recon UI.
 */
export async function loadUnmatchedBankLedger(db, apartmentId, body = {}) {
    const matchedIds = await collectMatchedTxnIds(db, apartmentId);
    const filter = {
        ...aptFilter(apartmentId),
        wallet: 'BANK',
        excluded_from_ledger: { $ne: true },
    };
    if (matchedIds.length) {
        filter.id = { $nin: matchedIds };
    }
    const type = body.type;
    if (type === 'IN' || type === 'OUT') filter.type = type;

    const limit = Math.min(Math.max(Number(body.limit) || 500, 1), 2000);
    const entries = await db.collection('ledger_entries')
        .find(filter)
        .project({
            id: 1,
            date: 1,
            amount: 1,
            type: 1,
            cat: 1,
            description: 1,
            vendor_name: 1,
            wallet: 1,
            bank_reference: 1,
            bank_payment_type: 1,
            excluded_from_ledger: 1,
        })
        .sort({ date: -1, created_at: -1 })
        .limit(limit)
        .toArray();

    return {
        entries,
        total: entries.length,
        matchedCount: matchedIds.length,
    };
}

/**
 * Export filtered ledger (higher cap). Same filters as list.
 */
export async function exportLedgerPage(db, apartmentId, body = {}) {
    return loadLedgerPage(db, apartmentId, {
        ...body,
        limit: Math.min(Math.max(Number(body.limit) || 5000, 1), 10000),
        offset: Math.max(Number(body.offset) || 0, 0),
    });
}

export { dayKey, collectMatchedTxnIds };
