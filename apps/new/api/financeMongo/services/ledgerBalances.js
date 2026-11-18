/**
 * Shared BANK-ledger chronological walk — used by recalculateLedgerBalances
 * (mutations) and by the ledger list read to overlay live running balances.
 */
import { dayKey } from '../money.js';

const apt = (apartmentId) => ({ apartment_id: apartmentId });
const txnMovement = (t) => {
    const amt = parseFloat(t.amount) || 0;
    return t.type === 'IN' ? amt : -amt;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * All active BANK ledger entries in running-balance order:
 * statement line_date (when matched) then statement line order within a day.
 */
export async function loadBankLedgerChronological(db, apartmentId) {
    const [entries, imports] = await Promise.all([
        db.collection('ledger_entries').find({
            ...apt(apartmentId),
            wallet: 'BANK',
            excluded_from_ledger: { $ne: true },
        }).toArray(),
        db.collection('bank_imports').find(apt(apartmentId)).toArray(),
    ]);
    const lineByTxn = new Map();
    for (const imp of imports) {
        for (const line of imp.lines || []) {
            if (line.transaction_id) lineByTxn.set(String(line.transaction_id), line);
        }
    }
    const sortDay = (t) => {
        const line = lineByTxn.get(String(t._id || t.id));
        return dayKey(line?.line_date || t.date) || '';
    };
    entries.sort((a, b) => {
        const dayCmp = sortDay(a).localeCompare(sortDay(b));
        if (dayCmp) return dayCmp;
        const lineA = lineByTxn.get(String(a._id || a.id));
        const lineB = lineByTxn.get(String(b._id || b.id));
        if (lineA && lineB) {
            const orderCmp = (lineA.line_order || 0) - (lineB.line_order || 0);
            if (orderCmp) return orderCmp;
            const ocrCmp = (lineA.source_row_index || 0) - (lineB.source_row_index || 0);
            if (ocrCmp) return ocrCmp;
        } else if (lineA && !lineB) return -1;
        else if (!lineA && lineB) return 1;
        return String(a._id || a.id).localeCompare(String(b._id || b.id));
    });
    return { entries, lineByTxn, sortDay };
}

/**
 * Live running bank balance after each active BANK row (same walk as
 * recalculateLedgerBalances). Returns empty byId when opening is unset.
 *
 * @returns {{ byId: Map<string, number>, closing: number|null, needsOpening: boolean }}
 */
export async function computeLedgerRunningBalances(db, apartmentId, config = null) {
    const cfg = config || await db.collection('finance_config').findOne(apt(apartmentId)) || {};
    const openingAmt = cfg.bankAccount?.opening_balance;
    const openingDate = dayKey(cfg.bankAccount?.opening_balance_date);
    const { entries, sortDay } = await loadBankLedgerChronological(db, apartmentId);

    if (openingAmt == null || Number.isNaN(parseFloat(openingAmt))) {
        return { byId: new Map(), closing: null, needsOpening: true };
    }

    let running = parseFloat(openingAmt);
    const byId = new Map();
    for (const t of entries) {
        const day = sortDay(t);
        if (openingDate && day && day < openingDate) continue;
        running += txnMovement(t);
        byId.set(String(t._id || t.id), round2(running));
    }
    return { byId, closing: round2(running), needsOpening: false };
}
