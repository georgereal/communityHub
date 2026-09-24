/**
 * Finance-New reports — Mongo aggregations only (no full client pivots / Postgres).
 */
import { requireAnyApartmentPermission } from '../../../packages/server/serverAuth.js';
import { readJsonBody } from '../../../packages/server/vercelRequest.js';
import { getMongoDb } from '../../../packages/server/mongoClient.js';
import { logMongoApi } from '../../../packages/server/mongoLog.js';

const VIEW_PERMS = ['accounts.view', 'accounts.edit', 'accounts.bills_entry'];

function aptMatch(apartmentId) {
    return { apartment_id: apartmentId };
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

function monthLabel(y, m) {
    return new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

function buildMonthRange(count, endDate = new Date()) {
    const months = [];
    const n = Math.min(Math.max(Number(count) || 6, 1), 24);
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(endDate.getFullYear(), endDate.getMonth() - i, 1);
        months.push({
            y: d.getFullYear(),
            m: d.getMonth(),
            label: monthLabel(d.getFullYear(), d.getMonth()),
            key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        });
    }
    return months;
}

/** Stable YYYY-MM from date strings / Date — avoid server TZ shifting months. */
function txnMonthKey(dateVal) {
    if (dateVal == null || dateVal === '') return null;
    if (dateVal instanceof Date && !Number.isNaN(dateVal.getTime())) {
        const y = dateVal.getUTCFullYear();
        const m = dateVal.getUTCMonth() + 1;
        return `${y}-${String(m).padStart(2, '0')}`;
    }
    const s = String(dateVal).trim();
    const m = s.match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function entryId(t) {
    if (!t) return '';
    return String(t.id || t._id || '');
}

/** Mirror src/expenseCategories.js normalizeCategoryKey (canonical keys for pivots). */
const CATEGORY_LABELS = {
    Security: 'Security / Guards',
    Maintenance: 'General Maintenance',
    Plumbing: 'Plumbing / Water',
    Electrical: 'Electrical / Diesel',
    Stationery: 'Office / Stationery',
    'Maintenance Collection': 'Maintenance Collection',
    Marketing: 'Marketing / Events',
    Promotion: 'Promotion / Sponsorship',
    Interest: 'Bank Interest',
    'Petty Inflow': 'Petty Cash Top-up',
    'Petty Cash': 'Petty Cash',
    'Bank Reject': 'Bank Reject',
    Reconcile: 'Bank Reconciliation',
    'Other Income': 'Other Income',
    Other: 'Miscellaneous',
};
const CATEGORY_ALIASES = { 'Petty Cash Top-up': 'Petty Inflow' };
const LABEL_TO_KEY = Object.fromEntries(
    Object.entries(CATEGORY_LABELS).map(([key, label]) => [label.toLowerCase(), key]),
);

function normalizeCat(cat) {
    const t = String(cat ?? '').trim();
    if (!t) return 'Other';
    if (CATEGORY_ALIASES[t]) return CATEGORY_ALIASES[t];
    if (LABEL_TO_KEY[t.toLowerCase()]) return LABEL_TO_KEY[t.toLowerCase()];
    return t;
}

function categoryLabel(cat) {
    const key = normalizeCat(cat);
    return CATEGORY_LABELS[key] || key;
}

function reportWallet(txn) {
    return String(txn?.wallet || '').toUpperCase() === 'BANK' ? 'BANK' : 'CASH';
}

function isReportable(txn) {
    return !txn?.exclude_from_reports;
}

function isBankPettyFunding(t) {
    return t?.type === 'OUT'
        && reportWallet(t) === 'BANK'
        && normalizeCat(t.cat).toLowerCase() === 'petty cash'
        && !t.exclude_from_cash_float;
}

function isCashDeskSpend(t) {
    return t?.type === 'OUT'
        && reportWallet(t) === 'CASH'
        && normalizeCat(t.cat).toLowerCase() !== 'petty cash';
}

function isExpenseFromSheet(txn) {
    return txn?.type === 'OUT' && Boolean(txn.external_sync_key || txn.sync_hash);
}

function isLedgerChequePayment(t) {
    if (!t || t.type !== 'OUT' || reportWallet(t) !== 'BANK') return false;
    if (t.excluded_from_ledger) return false;
    const typ = String(t.bank_payment_type || '').toUpperCase();
    if (typ === 'CHEQUE') return true;
    if (typ === 'UPI' || typ === 'NEFT' || typ === 'IMPS' || typ === 'RTGS') return false;
    const hay = `${t.description || ''} ${t.bank_reference || ''} ${t.vendor_name || ''}`.toUpperCase();
    return /\bCHQ\b|CHEQUE/.test(hay);
}

function isCashNotes(notes) {
    const n = String(notes || '');
    return /Payment:\s*Cash/i.test(n) || n.trim().toLowerCase() === 'cash';
}

/** Match classic isChequeFinanceDocument — notes start with `Cheque: …`. */
function isChequeDoc(notes) {
    return /^Cheque:\s*.+/i.test(String(notes || '').trim());
}

/** Match classic bookStatus(). */
function bookStatus(doc) {
    const raw = String(doc?.status || '').toLowerCase();
    if (raw === 'void') return 'void';
    if (raw === 'linked' || doc?.transaction_id) return 'linked';
    if (raw === 'unpaid' || raw === 'paid') return raw;
    const notes = String(doc?.notes || '').trim();
    if (/^Cheque:\s*.+/i.test(notes)) return 'paid';
    if (/Payment:\s*Cash/i.test(notes) || notes.toLowerCase() === 'cash') return 'paid';
    if (/^Online:\s*.+/i.test(notes) || /Payment:\s*Online/i.test(notes)) return 'paid';
    if (/Payment:\s*Unpaid/i.test(notes) || !notes) return 'unpaid';
    return 'unpaid';
}

/** Unpaid OR cheque-ready (not linked) — classic getOpenChequeExpenseDocuments. */
function isPendingCommitmentDoc(d) {
    if (!d || d.kind !== 'OUT') return false;
    const st = bookStatus(d);
    if (st === 'linked' || st === 'void') return false;
    return isChequeDoc(d.notes) || st === 'unpaid';
}

function importOrderKey(imp) {
    if (!imp) return '';
    if (imp.created_at) return String(imp.created_at);
    if (imp.file_name) return String(imp.file_name);
    return String(imp.id || '');
}

function compareBankLines(a, b, importById) {
    const dateCmp = String(a.line_date || '').localeCompare(String(b.line_date || ''));
    if (dateCmp !== 0) return dateCmp;
    const ao = a.line_order;
    const bo = b.line_order;
    if (ao != null && bo != null && Number(ao) !== Number(bo)) return Number(ao) - Number(bo);
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    const impA = importById.get(String(a.import_id));
    const impB = importById.get(String(b.import_id));
    const byImport = importOrderKey(impA).localeCompare(importOrderKey(impB));
    if (byImport !== 0) return byImport;
    return (a.source_row_index ?? 0) - (b.source_row_index ?? 0);
}

function passbookRowBalance(line, importById) {
    const PASSBOOK_PREFIX = 'evolyx-passbook:';
    const imp = importById.get(String(line?.import_id));
    const fileName = String(imp?.file_name || '');
    if (!fileName.startsWith(PASSBOOK_PREFIX)) return null;
    if (line?.balance == null || line.balance === '') return null;
    const value = parseFloat(line.balance);
    return Number.isFinite(value) ? value : null;
}

function computeLedgerBankSnapshot(entries, bankAccount) {
    const openingAmt = bankAccount?.opening_balance != null && bankAccount.opening_balance !== ''
        && !Number.isNaN(parseFloat(bankAccount.opening_balance))
        ? parseFloat(bankAccount.opening_balance)
        : null;
    const openingDate = bankAccount?.opening_balance_date
        ? String(bankAccount.opening_balance_date).slice(0, 10)
        : null;
    const bankTxns = (entries || [])
        .filter((t) => !t?.excluded_from_ledger && reportWallet(t) === 'BANK')
        .filter((t) => {
            const day = String(t.date || '').slice(0, 10);
            return !openingDate || day >= openingDate;
        })
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const net = bankTxns.reduce((s, t) => {
        const amt = Math.abs(Number(t.amount) || 0);
        return s + (t.type === 'IN' ? amt : -amt);
    }, 0);
    const last = bankTxns[bankTxns.length - 1];
    const asOf = last ? String(last.date || '').slice(0, 10) : openingDate;
    if (openingAmt == null) {
        return { bankBalance: null, asOf, txnCount: bankTxns.length, hasBank: false };
    }
    return {
        bankBalance: round2(openingAmt + net),
        asOf,
        txnCount: bankTxns.length,
        hasBank: true,
    };
}

/**
 * Classic: prefer last chronological passbook balance on/after opening;
 * else opening + credits − debits (calculated from MATCHED lines only).
 *
 * Passbook balance: sourced from the bank-uploaded statement balance column —
 * uses all lines because it reflects what the bank actually shows.
 *
 * Calculated balance: only MATCHED+POSTED lines are counted because unmatched
 * lines have not been posted to the ledger yet and should not affect the
 * reported financial position.
 */
function computeBankBalanceSnapshot(bankLines, imports, bankAccount) {
    const importById = new Map((imports || []).map((i) => [String(i.id), i]));
    const openingAmt = bankAccount?.opening_balance != null && bankAccount.opening_balance !== ''
        && !Number.isNaN(parseFloat(bankAccount.opening_balance))
        ? parseFloat(bankAccount.opening_balance)
        : null;
    const openingDate = bankAccount?.opening_balance_date
        ? String(bankAccount.opening_balance_date).slice(0, 10)
        : null;

    const allChronological = [...(bankLines || [])]
        .sort((a, b) => compareBankLines(a, b, importById))
        .filter((l) => !openingDate || String(l.line_date || '') >= openingDate);

    // Passbook balance: from bank-uploaded file balance column — all lines (reflects actual bank).
    let passbook = null;
    for (let i = allChronological.length - 1; i >= 0; i -= 1) {
        const bal = passbookRowBalance(allChronological[i], importById);
        if (bal != null) {
            passbook = { balance: round2(bal), asOf: allChronological[i].line_date };
            break;
        }
    }

    // Calculated balance: only MATCHED lines (posted to ledger) — unmatched lines
    // are not yet in the ledger so must not affect the financial position shown in reports.
    const matchedChronological = allChronological.filter(
        (l) => l.match_status === 'MATCHED',
    );

    let calculated = null;
    if (openingAmt != null) {
        // computed_balance on the last matched line is the most accurate when available.
        const lastMatched = matchedChronological[matchedChronological.length - 1];
        if (lastMatched?.computed_balance != null && lastMatched.computed_balance !== '') {
            calculated = {
                balance: round2(parseFloat(lastMatched.computed_balance)),
                asOf: lastMatched.line_date,
            };
        } else {
            let balance = openingAmt;
            let asOf = openingDate;
            for (const line of matchedChronological) {
                balance += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
                asOf = line.line_date;
            }
            calculated = { balance: round2(balance), asOf: asOf || openingDate };
        }
    }

    const bankBalance = passbook?.balance ?? calculated?.balance ?? null;
    const asOf = passbook?.asOf || calculated?.asOf || openingDate;
    return { bankBalance, asOf, passbook, calculated, hasBank: bankBalance != null };
}

/**
 * Classic Wallet Left (getCashWalletLeft / computeBillsCashFloatSummary.unused).
 * Petty Cash bank funding − linked cash bills (+ opening carry) + cash receipts on hand.
 */
export function computeWalletLeft(entries, vouchers, bankAccount) {
    const funding = (entries || []).filter((t) => {
        if (t.type !== 'OUT' || t.exclude_from_cash_float) return false;
        if (t.is_cash_float) return true;
        return reportWallet(t) === 'BANK' && normalizeCat(t.cat).toLowerCase() === 'petty cash';
    }).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const cashOut = (vouchers || []).filter((d) => d.kind === 'OUT' && isCashNotes(d.notes) && bookStatus(d) !== 'void');

    const linkedByTxn = new Map();
    for (const d of cashOut) {
        if (bookStatus(d) !== 'linked' || !d.transaction_id) continue;
        const key = String(d.transaction_id);
        linkedByTxn.set(key, round2((linkedByTxn.get(key) || 0) + Math.abs(Number(d.amount) || 0)));
    }

    const linkedFor = (t) => {
        for (const k of [t.id, t._id].filter((v) => v != null && v !== '')) {
            const hit = linkedByTxn.get(String(k));
            if (hit) return hit;
        }
        return 0;
    };

    const openingRaw = bankAccount?.cash_float_opening_balance ?? bankAccount?.cash_float_opening;
    const openingAmt = openingRaw != null && openingRaw !== '' && !Number.isNaN(parseFloat(openingRaw))
        ? round2(parseFloat(openingRaw))
        : null;

    let carry = openingAmt != null ? openingAmt : 0;
    for (const t of funding) {
        const amt = Math.abs(Number(t.amount) || 0);
        const linked = linkedFor(t);
        carry = round2(carry + amt - linked);
    }

    // Same as ledger KPI / getCashWalletLeft: leftover float only (not receipts on hand).
    const finalCarry = funding.length ? carry : (openingAmt != null ? openingAmt : 0);
    return round2(finalCarry);
}

function pivotKey(txn, dimension) {
    if (dimension === 'sub_category') return txn.sub_category?.trim() || '(none)';
    if (dimension === 'vendor') return txn.vendor_name?.trim() || '(none)';
    if (dimension === 'wallet_cat') {
        return `${reportWallet(txn)}|${normalizeCat(txn.cat)}`;
    }
    return normalizeCat(txn.cat);
}

function pivotLabel(key, dimension) {
    if (dimension === 'wallet_cat' && key.includes('|')) {
        const [wallet, cat] = key.split('|');
        return `${wallet === 'BANK' ? 'Bank' : 'Cash'} · ${categoryLabel(cat)}`;
    }
    if (dimension === 'cat' || !dimension) return categoryLabel(key);
    return key;
}

function buildPivot(txns, months, dimension) {
    const monthKeys = months.map((mo) => mo.key);
    const rowMap = new Map();
    for (const t of txns) {
        const mk = txnMonthKey(t.date);
        if (!mk || !monthKeys.includes(mk)) continue;
        const key = pivotKey(t, dimension);
        if (!rowMap.has(key)) {
            rowMap.set(key, {
                key,
                label: pivotLabel(key, dimension),
                cells: months.map(() => 0),
                total: 0,
            });
        }
        const row = rowMap.get(key);
        const idx = monthKeys.indexOf(mk);
        const amt = Math.abs(Number(t.amount) || 0);
        row.cells[idx] = round2(row.cells[idx] + amt);
        row.total = round2(row.total + amt);
    }
    const rows = [...rowMap.values()]
        .filter((r) => r.total > 0.001)
        .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    return { rows, entryCount: txns.length };
}

function monthlyTotals(txns, months) {
    const monthKeys = months.map((mo) => mo.key);
    return months.map((_, i) => {
        const key = monthKeys[i];
        return round2(txns
            .filter((t) => txnMonthKey(t.date) === key)
            .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0));
    });
}

function normalizeCollectionGapOpening(raw) {
    if (!raw || typeof raw !== 'object') {
        return { amount: 0, asOfMonth: null };
    }
    const asOfMonth = raw.asOfMonth || raw.as_of_month || null;
    const month = asOfMonth && /^\d{4}-\d{2}$/.test(String(asOfMonth).slice(0, 7))
        ? String(asOfMonth).slice(0, 7)
        : null;
    const amount = raw.amount == null || raw.amount === ''
        ? 0
        : round2(raw.amount);
    return { amount: Number.isFinite(amount) ? amount : 0, asOfMonth: month };
}

/**
 * Running raised − Maintenance Collection gap.
 * opening.amount = known gap through end of asOfMonth; only later months accumulate.
 * When asOfMonth is null, accumulate from earliest data (opening amount still applied).
 */
function buildCollectionGapSeries({
    months,
    raisedByMonth,
    maintCollectedByMonth,
    opening,
}) {
    const open = normalizeCollectionGapOpening(opening);
    const asOf = open.asOfMonth;
    const allKeys = new Set([
        ...Object.keys(raisedByMonth || {}),
        ...Object.keys(maintCollectedByMonth || {}),
        ...months.map((m) => m.key),
    ]);
    if (asOf) allKeys.add(asOf);
    const sortedKeys = [...allKeys].filter(Boolean).sort();

    const cumAfterAsOf = new Map();
    let running = 0;
    for (const key of sortedKeys) {
        if (asOf && key <= asOf) {
            cumAfterAsOf.set(key, 0);
            continue;
        }
        running = round2(
            running
            + (Number(raisedByMonth[key]) || 0)
            - (Number(maintCollectedByMonth[key]) || 0),
        );
        cumAfterAsOf.set(key, running);
    }

    const collectionGap = months.map((mo) => {
        if (asOf && mo.key < asOf) return null;
        if (asOf && mo.key === asOf) return open.amount;
        const after = cumAfterAsOf.get(mo.key);
        if (after == null) return open.amount;
        return round2(open.amount + after);
    });

    const maintCollected = months.map((mo) => round2(maintCollectedByMonth[mo.key] || 0));

    return {
        collectionGapOpening: open,
        maintCollected,
        collectionGap,
    };
}

async function summary(db, apartmentId) {
    const [ledger, vouchers] = await Promise.all([
        db.collection('ledger_entries').aggregate([
            { $match: { ...aptMatch(apartmentId), excluded_from_ledger: { $ne: true } } },
            {
                $facet: {
                    byTypeWallet: [
                        {
                            $group: {
                                _id: { type: '$type', wallet: { $ifNull: ['$wallet', 'CASH'] } },
                                amount: { $sum: '$amount' },
                                count: { $sum: 1 },
                            },
                        },
                    ],
                    byMonth: [
                        {
                            $group: {
                                _id: { month: { $substr: [{ $ifNull: ['$date', ''] }, 0, 7] }, type: '$type' },
                                amount: { $sum: '$amount' },
                                count: { $sum: 1 },
                            },
                        },
                        { $sort: { '_id.month': 1 } },
                    ],
                },
            },
        ]).toArray(),
        db.collection('vouchers').aggregate([
            { $match: { ...aptMatch(apartmentId), status: { $ne: 'void' } } },
            {
                $group: {
                    _id: { kind: '$kind', status: '$status' },
                    amount: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
        ]).toArray(),
    ]);

    const facet = ledger[0] || { byTypeWallet: [], byMonth: [] };
    return {
        byTypeWallet: (facet.byTypeWallet || []).map((r) => ({
            type: r._id?.type,
            wallet: r._id?.wallet,
            amount: r.amount,
            count: r.count,
        })),
        byMonth: (facet.byMonth || []).map((r) => ({
            month: r._id?.month,
            type: r._id?.type,
            amount: r.amount,
            count: r.count,
        })),
        vouchers: vouchers.map((r) => ({
            kind: r._id?.kind,
            status: r._id?.status,
            amount: r.amount,
            count: r.count,
        })),
    };
}

async function byCategory(db, apartmentId, body = {}) {
    const type = body.type === 'IN' || body.type === 'OUT' ? body.type : null;
    const match = { ...aptMatch(apartmentId), excluded_from_ledger: { $ne: true }, exclude_from_reports: { $ne: true } };
    if (type) match.type = type;
    const rows = await db.collection('ledger_entries').aggregate([
        { $match: match },
        {
            $group: {
                _id: { cat: { $ifNull: ['$cat', 'Other'] }, type: '$type' },
                amount: { $sum: '$amount' },
                count: { $sum: 1 },
            },
        },
        { $sort: { amount: -1 } },
    ]).toArray();
    return {
        rows: rows.map((r) => ({
            cat: r._id?.cat,
            type: r._id?.type,
            amount: r.amount,
            count: r.count,
        })),
    };
}

async function aging(db, apartmentId) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.collection('dues_invoices').aggregate([
        {
            $match: {
                ...aptMatch(apartmentId),
                $expr: { $gt: [{ $subtract: ['$amount', { $ifNull: ['$amount_paid', 0] }] }, 0.009] },
            },
        },
        {
            $project: {
                unit_id: 1,
                due_date: 1,
                period_label: 1,
                outstanding: { $subtract: ['$amount', { $ifNull: ['$amount_paid', 0] }] },
                daysPast: {
                    $dateDiff: {
                        startDate: { $toDate: '$due_date' },
                        endDate: { $toDate: today },
                        unit: 'day',
                    },
                },
            },
        },
        {
            $bucket: {
                groupBy: '$daysPast',
                boundaries: [-99999, 1, 31, 61, 91, 99999],
                default: 'unknown',
                output: {
                    count: { $sum: 1 },
                    amount: { $sum: '$outstanding' },
                },
            },
        },
    ]).toArray();
    return { buckets: rows };
}

function parseSheetOnly(body) {
    if (body.sheetOnly == null && body.sheet_only == null) return true;
    const v = body.sheetOnly ?? body.sheet_only;
    return v === true || v === '1' || v === 'true';
}

const REPORT_LEDGER_PROJECTION = {
    id: 1,
    type: 1,
    date: 1,
    amount: 1,
    cat: 1,
    sub_category: 1,
    vendor_name: 1,
    wallet: 1,
    description: 1,
    bank_reference: 1,
    bank_payment_type: 1,
    bankLineRefs: 1,
    external_sync_key: 1,
    sync_hash: 1,
    excluded_from_ledger: 1,
    exclude_from_reports: 1,
    exclude_from_cash_float: 1,
    is_cash_float: 1,
};

const REPORT_IMPORT_PROJECTION = {
    id: 1,
    created_at: 1,
    file_name: 1,
    'lines.line_date': 1,
    'lines.line_order': 1,
    'lines.source_row_index': 1,
    'lines.balance': 1,
    'lines.credit': 1,
    'lines.debit': 1,
    'lines.match_status': 1,
    'lines.transaction_id': 1,
    'lines.computed_balance': 1,
};

const REPORT_VOUCHER_PROJECTION = {
    id: 1,
    kind: 1,
    status: 1,
    notes: 1,
    transaction_id: 1,
    doc_date: 1,
    date: 1,
    amount: 1,
    cat: 1,
    sub_category: 1,
    vendor_name: 1,
    exclude_from_reports: 1,
};

const REPORT_NOBROKER_PROJECTION = {
    billing_month: 1,
    charges: 1,
    total_raised: 1,
};

/**
 * Full Financial Reports pack — pivots, raised stack, book-balance snapshot.
 * Computed server-side from Mongo; client renders only.
 * Projections omit raw blobs (spreadsheet snapshots, OCR text) so the read
 * stays inside the 10s function cap.
 */
async function analytics(db, apartmentId, body = {}) {
    const months = buildMonthRange(body.months || body.monthCount || 6);
    const sheetOnly = parseSheetOnly(body);
    let cashMode = body.cashExpenseReporting || body.cash_mode || 'petty_bank';
    if (cashMode !== 'cash_detail') cashMode = 'petty_bank';
    let pivotDimension = body.pivotDimension || body.dimension || 'cat';
    if (!['cat', 'sub_category', 'vendor', 'wallet_cat'].includes(pivotDimension)) {
        pivotDimension = 'cat';
    }
    if (pivotDimension === 'wallet_cat') cashMode = 'cash_detail';

    const monthStart = `${months[0].y}-${String(months[0].m + 1).padStart(2, '0')}-01`;
    const last = months[months.length - 1];
    const monthEndDate = new Date(last.y, last.m + 1, 0);
    const monthEnd = monthEndDate.toISOString().slice(0, 10);

    const [entriesRaw, imports, vouchers, nobroker, config] = await Promise.all([
        // Reports include excluded_from_ledger rows (classic does too) — only omit voided via exclude_from_reports.
        db.collection('ledger_entries').find(aptMatch(apartmentId)).project(REPORT_LEDGER_PROJECTION).toArray(),
        db.collection('bank_imports').find(aptMatch(apartmentId)).project(REPORT_IMPORT_PROJECTION).toArray(),
        db.collection('vouchers').find({
            ...aptMatch(apartmentId),
            status: { $ne: 'void' },
            kind: 'OUT',
        }).project(REPORT_VOUCHER_PROJECTION).toArray(),
        db.collection('nobroker_invoices').find(aptMatch(apartmentId)).project(REPORT_NOBROKER_PROJECTION).toArray(),
        db.collection('finance_config').findOne(aptMatch(apartmentId)),
    ]);

    const entries = (entriesRaw || []).map((e) => ({
        ...e,
        id: e.id || e._id,
    }));

    const matchedTxnIds = new Set();
    const bankLines = [];
    for (const imp of imports || []) {
        for (const line of imp.lines || []) {
            bankLines.push({ ...line, import_id: imp.id || imp._id });
            if (line.match_status === 'MATCHED' && line.transaction_id) {
                matchedTxnIds.add(String(line.transaction_id));
            }
        }
    }

    const isExpenseFromBankRecon = (txn) => {
        if (txn?.type !== 'OUT') return false;
        const id = entryId(txn);
        if (id && matchedTxnIds.has(id)) return true;
        // Remodeled ledger may carry bank refs even if line match_status lagged.
        if (Array.isArray(txn.bankLineRefs) && txn.bankLineRefs.length) return true;
        return false;
    };
    const isStructured = (txn) => isExpenseFromSheet(txn) || isExpenseFromBankRecon(txn);

    const cashBillExpenses = (vouchers || [])
        .filter((d) => isCashNotes(d.notes) && isReportable(d))
        .map((d) => ({
            id: `voucher:${d.id || d._id}`,
            type: 'OUT',
            date: d.doc_date || d.date,
            amount: d.amount,
            cat: d.cat || 'Other',
            sub_category: d.sub_category,
            vendor_name: d.vendor_name,
            wallet: 'CASH',
            exclude_from_reports: d.exclude_from_reports,
            _fromCashBill: true,
        }));

    const filterExpenses = () => {
        if (cashMode === 'cash_detail') {
            const ledger = entries.filter((t) => {
                if (t.type !== 'OUT' || !isReportable(t)) return false;
                if (isBankPettyFunding(t)) return false;
                if (isCashDeskSpend(t)) return false;
                if (sheetOnly && !isStructured(t)) return false;
                return true;
            });
            return [...ledger, ...cashBillExpenses];
        }
        return entries.filter((t) => {
            if (t.type !== 'OUT' || !isReportable(t)) return false;
            if (sheetOnly && !isStructured(t)) return false;
            return true;
        });
    };

    const incomeTxns = entries.filter((t) => t.type === 'IN' && isReportable(t));
    const expenseTxns = filterExpenses();

    const inRange = (txns) => txns.filter((t) => {
        const mk = txnMonthKey(t.date);
        return mk && months.some((mo) => mo.key === mk);
    });

    const incomeInRange = inRange(incomeTxns);
    const expenseInRange = inRange(expenseTxns);
    const incomePivot = buildPivot(incomeInRange, months, 'cat');
    const expensePivot = buildPivot(expenseInRange, months, pivotDimension);

    // Raised invoices stack by charge head
    const raisedHeads = new Map();
    for (const inv of nobroker || []) {
        const bm = String(inv.billing_month || '').slice(0, 7);
        if (!months.some((mo) => mo.key === bm)) continue;
        const charges = inv.charges && typeof inv.charges === 'object' ? inv.charges : {};
        for (const [head, raw] of Object.entries(charges)) {
            const amt = Math.abs(Number(raw) || 0);
            if (amt < 0.001) continue;
            if (!raisedHeads.has(head)) {
                raisedHeads.set(head, {
                    key: head,
                    label: head,
                    cells: months.map(() => 0),
                    total: 0,
                });
            }
            const row = raisedHeads.get(head);
            const idx = months.findIndex((mo) => mo.key === bm);
            if (idx >= 0) {
                row.cells[idx] = round2(row.cells[idx] + amt);
                row.total = round2(row.total + amt);
            }
        }
    }
    const raisedRows = [...raisedHeads.values()]
        .filter((r) => r.total > 0.001)
        .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

    const incomeMonth = monthlyTotals(incomeInRange, months);
    const expenseMonth = monthlyTotals(expenseInRange, months);
    const raisedMonth = months.map((mo) => round2(
        raisedRows.reduce((s, r) => s + (r.cells[months.indexOf(mo)] || 0), 0),
    ));

    // Full-history raised + Maintenance Collection buckets for running collection gap.
    const raisedByMonth = {};
    for (const inv of nobroker || []) {
        const bm = String(inv.billing_month || '').slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(bm)) continue;
        const charges = inv.charges && typeof inv.charges === 'object' ? inv.charges : {};
        let rowTotal = 0;
        for (const raw of Object.values(charges)) {
            rowTotal += Math.abs(Number(raw) || 0);
        }
        if (rowTotal < 0.001 && inv.total_raised != null) {
            rowTotal = Math.abs(Number(inv.total_raised) || 0);
        }
        if (rowTotal < 0.001) continue;
        raisedByMonth[bm] = round2((raisedByMonth[bm] || 0) + rowTotal);
    }
    const maintCollectedByMonth = {};
    for (const t of incomeTxns) {
        const cat = String(t.cat || '');
        if (cat !== 'Maintenance Collection') continue;
        const mk = txnMonthKey(t.date);
        if (!mk) continue;
        maintCollectedByMonth[mk] = round2(
            (maintCollectedByMonth[mk] || 0) + Math.abs(Number(t.amount) || 0),
        );
    }
    const gapPack = buildCollectionGapSeries({
        months,
        raisedByMonth,
        maintCollectedByMonth,
        opening: config?.collectionGapOpening,
    });

    // Book balance / recon snapshot — match classic getBankBalanceReconciliation + Wallet Left + pending.
    const unmatchedLines = bankLines.filter((l) => l.match_status === 'UNMATCHED');
    const unmatchedTxns = entries.filter((t) => {
        if (t.excluded_from_ledger) return false;
        if (reportWallet(t) !== 'BANK') return false;
        const id = entryId(t);
        return id && !matchedTxnIds.has(id);
    });

    const bankAccount = config?.bankAccount || null;
    const bankSnap = computeBankBalanceSnapshot(bankLines, imports, bankAccount);
    const ledgerBank = computeLedgerBankSnapshot(entries, bankAccount);
    const bankBalance = ledgerBank.bankBalance ?? bankSnap.bankBalance;
    const bankAsOf = ledgerBank.asOf || bankSnap.asOf;
    const hasBank = bankBalance != null;

    const cashWallet = computeWalletLeft(entries, vouchers, bankAccount);

    // Classic getPendingChequesSummary: open commitments (unpaid + cheque-ready) + uncleared ledger cheques.
    const openCommitmentBills = (vouchers || []).filter(isPendingCommitmentDoc);
    const openCommitmentAmt = round2(openCommitmentBills.reduce((s, d) => s + Math.abs(Number(d.amount) || 0), 0));

    const unclearedCheques = unmatchedTxns.filter(isLedgerChequePayment);
    const unclearedAmt = round2(unclearedCheques.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0));
    const pendingTotal = round2(openCommitmentAmt + unclearedAmt);

    const book = hasBank ? round2(bankBalance + cashWallet - pendingTotal) : cashWallet;

    let unmatchedNet = 0;
    for (const line of unmatchedLines) {
        unmatchedNet += (Number(line.credit) || 0) - (Number(line.debit) || 0);
    }
    let unreconciledNet = 0;
    for (const t of unmatchedTxns) {
        const amt = Math.abs(Number(t.amount) || 0);
        unreconciledNet += t.type === 'IN' ? amt : -amt;
    }

    const inRangeOut = entries.filter((t) => t.type === 'OUT' && inRange([t]).length);
    const sourceCounts = {
        sheet: inRangeOut.filter((t) => isExpenseFromSheet(t) && isReportable(t)).length,
        bank: inRangeOut.filter((t) => isExpenseFromBankRecon(t) && !isExpenseFromSheet(t) && isReportable(t)).length,
        excluded: inRangeOut.filter((t) => t.exclude_from_reports).length,
        manual: inRangeOut.filter((t) => isReportable(t) && !isStructured(t)).length,
    };

    // Per-month expense totals for diagnosing classic vs Mongo chart drift.
    const expenseByMonth = Object.fromEntries(
        months.map((mo) => [mo.key, round2(
            expenseInRange
                .filter((t) => txnMonthKey(t.date) === mo.key)
                .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0),
        )]),
    );

    return {
        months: months.map((m) => ({ y: m.y, m: m.m, label: m.label, key: m.key })),
        settings: {
            monthCount: months.length,
            sheetOnly,
            cashExpenseReporting: cashMode,
            pivotDimension,
            monthStart,
            monthEnd,
        },
        income: incomePivot,
        expense: { ...expensePivot, sourceCounts },
        raised: {
            rows: raisedRows,
            invoiceCount: (nobroker || []).length,
        },
        monthly: {
            raised: raisedMonth,
            income: incomeMonth,
            expense: expenseMonth,
            net: incomeMonth.map((v, i) => round2(v - expenseMonth[i])),
            maintCollected: gapPack.maintCollected,
            collectionGap: gapPack.collectionGap,
            expenseByMonth,
        },
        collectionGapOpening: gapPack.collectionGapOpening,
        bookBalance: {
            cash: cashWallet,
            bankBalance,
            hasBank,
            asOf: bankAsOf,
            pending: {
                openAmt: openCommitmentAmt,
                openCount: openCommitmentBills.length,
                unpaidAmt: openCommitmentAmt,
                unpaidCount: openCommitmentBills.length,
                unclearedAmt,
                unclearedCount: unclearedCheques.length,
                total: pendingTotal,
                count: openCommitmentBills.length + unclearedCheques.length,
            },
            book,
        },
        recon: {
            unmatchedLines: unmatchedLines.length,
            unmatchedNet: round2(unmatchedNet),
            unreconciledTxns: unmatchedTxns.length,
            unreconciledNet: round2(unreconciledNet),
            matchedCount: matchedTxnIds.size,
            passbook: bankSnap.passbook,
            calculated: bankSnap.calculated,
        },
    };
}

export async function runFinanceMongoReport(report, { db, apartmentId, body = {} }) {
    switch (report) {
        case 'summary':
            return summary(db, apartmentId);
        case 'byCategory':
            return byCategory(db, apartmentId, body);
        case 'aging':
            return aging(db, apartmentId);
        case 'analytics':
            return analytics(db, apartmentId, body);
        default:
            throw Object.assign(new Error(`Unknown report: ${report}`), { status: 400 });
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const started = Date.now();
    let apartmentId = null;
    let userId = null;
    let report = null;
    try {
        const body = await readJsonBody(req);
        const auth = await requireAnyApartmentPermission(req, body.apartment_id, VIEW_PERMS);
        apartmentId = auth.apartmentId;
        userId = auth.user?.id || null;
        const db = await getMongoDb();
        report = body.report || body.action || 'summary';
        const result = await runFinanceMongoReport(report, { db, apartmentId, body });
        logMongoApi({
            method: 'POST',
            path: '/api/finance-mongo-reports',
            op: report,
            collection: 'reports',
            userId,
            apartmentId,
            ms: Date.now() - started,
        });
        return res.status(200).json({ ok: true, report, ...result });
    } catch (err) {
        logMongoApi({
            method: 'POST',
            path: '/api/finance-mongo-reports',
            op: report,
            collection: 'reports',
            userId,
            apartmentId,
            ms: Date.now() - started,
            error: err.message || 'Report failed.',
        });
        return res.status(err.status || 500).json({ error: err.message || 'Report failed.' });
    }
}
