/**
 * Finance-New read API — remodeled Mongo collections (communityHub).
 * POST { action, apartment_id, ... }
 */
import { requireAnyApartmentPermission } from './serverAuth.js';
import { readJsonBody } from './vercelRequest.js';
import { getMongoDb } from './mongoClient.js';
import { logMongoApi } from './mongoLog.js';

const VIEW_PERMS = ['accounts.view', 'accounts.edit', 'accounts.bills_entry'];

function aptFilter(apartmentId) {
    return { apartment_id: apartmentId };
}

async function boot(db, apartmentId) {
    const config = await db.collection('finance_config').findOne(aptFilter(apartmentId));
    const [
        ledgerCount,
        voucherCount,
        bankImportCount,
        duesCount,
        nobrokerCount,
    ] = await Promise.all([
        db.collection('ledger_entries').countDocuments(aptFilter(apartmentId)),
        db.collection('vouchers').countDocuments(aptFilter(apartmentId)),
        db.collection('bank_imports').countDocuments(aptFilter(apartmentId)),
        db.collection('dues_invoices').countDocuments(aptFilter(apartmentId)),
        db.collection('nobroker_invoices').countDocuments(aptFilter(apartmentId)),
    ]);

    return {
        config: config || {
            apartment_id: apartmentId,
            bankAccount: null,
            vendors: [],
            subCategories: [],
            chargeHeads: [],
            penaltyRules: [],
            classificationRules: [],
            chartOfAccounts: [],
            expensePlanItems: [],
            expensePlanRecurring: [],
        },
        counts: {
            ledgerEntries: ledgerCount,
            vouchers: voucherCount,
            bankImports: bankImportCount,
            duesInvoices: duesCount,
            nobrokerInvoices: nobrokerCount,
        },
    };
}

async function loadLedger(db, apartmentId, body = {}) {
    const limit = Math.min(Math.max(Number(body.limit) || 5000, 1), 10000);
    const entries = await db.collection('ledger_entries')
        .find(aptFilter(apartmentId))
        .sort({ date: -1, created_at: -1 })
        .limit(limit)
        .toArray();
    return { entries, total: entries.length };
}

function roundMoney(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function isCashNotes(notes) {
    const n = String(notes || '');
    return /Payment:\s*Cash/i.test(n) || n.trim().toLowerCase() === 'cash';
}

async function listVouchers(db, apartmentId, body = {}) {
    const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
    const offset = Math.max(Number(body.offset) || 0, 0);
    const filter = { ...aptFilter(apartmentId) };
    if (body.kind === 'IN' || body.kind === 'OUT') filter.kind = body.kind;
    if (body.status && body.status !== 'all') {
        if (Array.isArray(body.status)) filter.status = { $in: body.status };
        else filter.status = body.status;
    }
    if (body.pay === 'cash') {
        filter.$or = [
            { notes: { $regex: 'Payment:\\s*Cash', $options: 'i' } },
            { notes: { $in: ['cash', 'Cash'] } },
        ];
    } else if (body.pay === 'cheque') {
        filter.notes = { $regex: 'Payment:\\s*Cheque|CHQ|CHEQUE', $options: 'i' };
    }
    if (body.q) {
        const q = String(body.q).trim();
        if (q) {
            const textOr = [
                { vendor_name: { $regex: q, $options: 'i' } },
                { description: { $regex: q, $options: 'i' } },
                { cat: { $regex: q, $options: 'i' } },
            ];
            if (filter.$or) filter.$and = [{ $or: filter.$or }, { $or: textOr }];
            else filter.$or = textOr;
        }
    }
    const ids = body.ids || body.document_ids;
    if (Array.isArray(ids) && ids.length) {
        filter.id = { $in: ids.map(String) };
    }
    const txnIds = body.transaction_ids || body.transactionIds;
    if (Array.isArray(txnIds) && txnIds.length) {
        filter.transaction_id = { $in: txnIds.map(String) };
    }

    const col = db.collection('vouchers');
    const [total, rows] = await Promise.all([
        col.countDocuments(filter),
        col.find(filter).sort({ doc_date: -1, created_at: -1 }).skip(offset).limit(limit).toArray(),
    ]);
    return {
        rows,
        documents: rows,
        total,
        offset,
        limit,
        hasMore: offset + rows.length < total,
    };
}

/**
 * Bills page KPIs + cash-float / commitments working set (Mongo vouchers + funding ledger ids).
 * Shape matches classic financeDocumentsAggregates — no client paging fallback required.
 */
async function voucherAggregates(db, apartmentId) {
    const vouchers = db.collection('vouchers');
    const match = { apartment_id: apartmentId, status: { $ne: 'void' } };

    const [facetRows, fundingTxns] = await Promise.all([
        vouchers.aggregate([
            { $match: match },
            {
                $facet: {
                    byKindStatus: [
                        {
                            $group: {
                                _id: { kind: '$kind', status: '$status' },
                                count: { $sum: 1 },
                                amount: { $sum: '$amount' },
                            },
                        },
                    ],
                    totals: [
                        { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
                    ],
                    slim: [
                        { $project: { amount: 1, status: 1, kind: 1 } },
                    ],
                    cashDocs: [
                        {
                            $match: {
                                $or: [
                                    { notes: { $regex: 'Payment:\\s*Cash', $options: 'i' } },
                                    { notes: { $in: ['cash', 'Cash'] } },
                                ],
                            },
                        },
                    ],
                    openDocs: [
                        { $match: { status: { $in: ['unpaid', 'paid', 'open'] } } },
                    ],
                },
            },
        ]).toArray(),
        db.collection('ledger_entries').find({
            apartment_id: apartmentId,
            type: 'OUT',
            excluded_from_ledger: { $ne: true },
        }, {
            projection: {
                id: 1,
                cat: 1,
                wallet: 1,
                type: 1,
                is_cash_float: 1,
                exclude_from_cash_float: 1,
            },
        }).toArray(),
    ]);

    const facet = facetRows[0] || {
        byKindStatus: [],
        totals: [],
        slim: [],
        cashDocs: [],
        openDocs: [],
    };

    const fundingIds = [...new Set(
        (fundingTxns || [])
            .filter((t) => {
                if (t.exclude_from_cash_float) return false;
                if (t.is_cash_float) return true;
                return String(t.wallet || '').toUpperCase() === 'BANK'
                    && String(t.cat || '').trim().toLowerCase() === 'petty cash';
            })
            .map((r) => r.id)
            .filter(Boolean)
            .map(String),
    )];

    let fundingLinked = [];
    if (fundingIds.length) {
        fundingLinked = await vouchers.find({
            ...match,
            transaction_id: { $in: fundingIds },
        }).toArray();
    }

    let unpaidOutAmt = 0;
    let paidOutAmt = 0;
    let linkedOutAmt = 0;
    let unpaidOutCount = 0;
    let paidOutCount = 0;
    let linkedOutCount = 0;
    for (const row of facet.slim || []) {
        if (row.kind !== 'OUT') continue;
        const amt = roundMoney(row.amount);
        const st = String(row.status || '').toLowerCase();
        if (st === 'unpaid' || st === 'open') {
            unpaidOutAmt += amt;
            unpaidOutCount += 1;
        } else if (st === 'paid') {
            paidOutAmt += amt;
            paidOutCount += 1;
        } else if (st === 'linked') {
            linkedOutAmt += amt;
            linkedOutCount += 1;
        }
    }

    const byId = new Map();
    for (const doc of [...(facet.cashDocs || []), ...(facet.openDocs || []), ...fundingLinked]) {
        if (doc?.id) byId.set(String(doc.id), doc);
    }

    const fundingBillTotals = {};
    let linkedCashAmt = 0;
    let linkedCashCount = 0;
    let openCashAmt = 0;
    let openCashCount = 0;
    for (const doc of byId.values()) {
        if (doc.kind !== 'OUT' || !isCashNotes(doc.notes)) continue;
        const amt = roundMoney(doc.amount);
        const st = String(doc.status || '').toLowerCase();
        const linked = st === 'linked' || !!doc.transaction_id;
        if (linked && doc.transaction_id) {
            linkedCashAmt += amt;
            linkedCashCount += 1;
            const key = String(doc.transaction_id);
            fundingBillTotals[key] = roundMoney((fundingBillTotals[key] || 0) + amt);
        } else if (st === 'paid' || st === 'open') {
            openCashAmt += amt;
            openCashCount += 1;
        }
    }

    const cashDocumentIds = (facet.cashDocs || []).map((d) => d.id).filter(Boolean);
    const openDocumentIds = (facet.openDocs || []).map((d) => d.id).filter(Boolean);

    return {
        byKindStatus: (facet.byKindStatus || []).map((r) => ({
            kind: r._id?.kind,
            status: r._id?.status,
            count: r.count,
            amount: r.amount,
        })),
        totals: facet.totals?.[0] || { count: 0, amount: 0 },
        summary: {
            total: (facet.slim || []).length,
            unpaidOutAmt: roundMoney(unpaidOutAmt),
            paidOutAmt: roundMoney(paidOutAmt),
            linkedOutAmt: roundMoney(linkedOutAmt),
            unpaidOutCount,
            paidOutCount,
            linkedOutCount,
            linkedCashAmt: roundMoney(linkedCashAmt),
            linkedCashCount,
            openCashAmt: roundMoney(openCashAmt),
            openCashCount,
        },
        documents: [...byId.values()],
        cashDocumentIds,
        openDocumentIds,
        fundingTransactionIds: fundingIds,
        fundingBillTotals,
    };
}

async function loadBankImports(db, apartmentId) {
    const imports = await db.collection('bank_imports')
        .find(aptFilter(apartmentId))
        .sort({ created_at: -1 })
        .toArray();
    return { imports };
}

async function loadBilling(db, apartmentId) {
    const [duesInvoices, billingGroups, billingBatches] = await Promise.all([
        db.collection('dues_invoices').find(aptFilter(apartmentId)).sort({ due_date: 1 }).toArray(),
        db.collection('billing_groups').find(aptFilter(apartmentId)).sort({ sort_order: 1 }).toArray(),
        db.collection('billing_batches').find(aptFilter(apartmentId)).sort({ created_at: -1 }).toArray(),
    ]);
    return { duesInvoices, billingGroups, billingBatches };
}

async function listNobroker(db, apartmentId, body = {}) {
    const unitNumber = String(body.unit_number || '').trim().toUpperCase();
    const filter = aptFilter(apartmentId);
    if (unitNumber) {
        const escaped = unitNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.unit_number = { $regex: `^${escaped}$`, $options: 'i' };
    }
    const max = unitNumber ? 5000 : 500;
    const limit = Math.min(Math.max(Number(body.limit) || (unitNumber ? 2000 : 100), 1), max);
    const offset = Math.max(Number(body.offset) || 0, 0);
    const col = db.collection('nobroker_invoices');
    const [total, rows] = await Promise.all([
        col.countDocuments(filter),
        col.find(filter).sort({ billing_month: -1 }).skip(offset).limit(limit).toArray(),
    ]);
    return { rows, total, offset, limit };
}

export async function runFinanceMongoRead(action, { db, apartmentId, body = {} }) {
    switch (action) {
        case 'boot':
            return boot(db, apartmentId);
        case 'loadLedger':
            return loadLedger(db, apartmentId, body);
        case 'listVouchers':
            return listVouchers(db, apartmentId, body);
        case 'voucherAggregates':
            return voucherAggregates(db, apartmentId);
        case 'loadBankImports':
            return loadBankImports(db, apartmentId);
        case 'loadBilling':
            return loadBilling(db, apartmentId);
        case 'listNobroker':
            return listNobroker(db, apartmentId, body);
        default:
            throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const started = Date.now();
    let apartmentId = null;
    let userId = null;
    let action = null;
    try {
        const body = await readJsonBody(req);
        action = body.action;
        const auth = await requireAnyApartmentPermission(req, body.apartment_id, VIEW_PERMS);
        apartmentId = auth.apartmentId;
        userId = auth.user?.id || null;
        const db = await getMongoDb();
        const result = await runFinanceMongoRead(action, { db, apartmentId, body });
        logMongoApi({
            method: 'POST',
            path: '/api/finance-mongo',
            op: action,
            userId,
            apartmentId,
            ms: Date.now() - started,
        });
        return res.status(200).json({ ok: true, ...result });
    } catch (err) {
        logMongoApi({
            method: 'POST',
            path: '/api/finance-mongo',
            op: action,
            userId,
            apartmentId,
            ms: Date.now() - started,
            error: err.message || 'Finance Mongo request failed.',
        });
        const status = err.status || 500;
        return res.status(status).json({ error: err.message || 'Finance Mongo request failed.' });
    }
}
