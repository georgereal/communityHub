/**
 * Ledger reads — entries list + summary pack (server-owned KPIs).
 */
import { runFinanceMongoRead } from '../../finance-mongo.js';
import { computeWalletLeft } from '../../finance-mongo-reports.js';
import { dayKey, roundMoney, todayKey } from '../money.js';

function aptFilter(apartmentId) {
    return { apartment_id: apartmentId };
}

function isActive(entry) {
    return !entry?.excluded_from_ledger;
}

function txnMovement(t) {
    const amt = Math.abs(Number(t.amount) || 0);
    return t.type === 'IN' ? amt : -amt;
}

function isBankWallet(t) {
    return String(t.wallet || 'CASH').toUpperCase() === 'BANK';
}

/**
 * Same rules as client getLedgerBankBalance / dashboard-summary:
 * opening + BANK movements on/after opening date; prefer config.ledgerBalance.closing when clean.
 * Petty cash KPI = Wallet Left (Bills & receipts float), not CASH-wallet ledger sum.
 */
export async function buildLedgerSummary(db, apartmentId) {
    const config = await db.collection('finance_config').findOne(aptFilter(apartmentId)) || {};
    const [entries, vouchers] = await Promise.all([
        db.collection('ledger_entries')
            .find(aptFilter(apartmentId))
            .project({
                type: 1,
                wallet: 1,
                amount: 1,
                date: 1,
                cat: 1,
                excluded_from_ledger: 1,
                running_balance_after: 1,
                is_cash_float: 1,
                exclude_from_cash_float: 1,
                cash_desk_deposit: 1,
            })
            .toArray(),
        db.collection('vouchers')
            .find({
                ...aptFilter(apartmentId),
                status: { $ne: 'void' },
            })
            .project({
                kind: 1,
                status: 1,
                amount: 1,
                notes: 1,
                transaction_id: 1,
            })
            .toArray(),
    ]);

    const active = entries.filter(isActive).map((t) => ({
        ...t,
        id: t.id || t._id,
    }));
    const voucherRows = (vouchers || []).map((d) => ({
        ...d,
        id: d.id || d._id,
        transaction_id: d.transaction_id || d.ledgerEntryId || null,
    }));
    const excludedCount = entries.length - active.length;
    const today = todayKey();

    let todayOut = 0;
    for (const t of active) {
        const amt = Math.abs(Number(t.amount) || 0);
        if (t.type === 'OUT' && dayKey(t.date) === today) {
            todayOut += amt;
        }
    }
    todayOut = roundMoney(todayOut);

    const bankAccount = config.bankAccount || null;
    const cash = roundMoney(computeWalletLeft(active, voucherRows, bankAccount));

    const openingRaw = bankAccount?.opening_balance;
    const openingAmount = openingRaw == null || openingRaw === ''
        ? null
        : parseFloat(openingRaw);
    const openingDate = dayKey(bankAccount?.opening_balance_date);
    const lb = config.ledgerBalance || {};
    const needsRecalc = lb.needsRecalc === true;
    const ledgerBalance = {
        needsRecalc,
        dirtyFromDate: lb.dirtyFromDate || null,
        lastRecalcAt: lb.lastRecalcAt || null,
        closing: lb.closing != null && !Number.isNaN(parseFloat(lb.closing))
            ? roundMoney(lb.closing)
            : null,
    };

    let bank = null;
    let asOf = openingDate || null;
    let needsOpening = false;
    let bankTxnCount = 0;

    if (openingAmount == null || Number.isNaN(openingAmount)) {
        needsOpening = true;
        const bankRows = active.filter(isBankWallet);
        bankTxnCount = bankRows.length;
        if (bankRows.length) {
            asOf = dayKey(bankRows.map((t) => t.date).sort().at(-1)) || asOf;
        }
    } else {
        const bankRows = active
            .filter(isBankWallet)
            .filter((t) => {
                const day = dayKey(t.date);
                if (openingDate && day && day < openingDate) return false;
                return true;
            })
            .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
        bankTxnCount = bankRows.length;
        asOf = bankRows.length
            ? dayKey(bankRows[bankRows.length - 1].date) || openingDate
            : openingDate;

        if (!needsRecalc && ledgerBalance.closing != null) {
            bank = ledgerBalance.closing;
        } else {
            const lastWithBalance = [...bankRows].reverse()
                .find((t) => t.running_balance_after != null && t.running_balance_after !== '');
            if (lastWithBalance) {
                bank = roundMoney(lastWithBalance.running_balance_after);
            } else {
                let running = openingAmount;
                for (const t of bankRows) running += txnMovement(t);
                bank = roundMoney(running);
            }
        }
    }

    const totals = {
        cash,
        bank,
        combined: bank != null ? roundMoney(cash + bank) : cash,
    };

    return {
        totals,
        todayOut,
        ledgerBalance,
        counts: {
            total: entries.length,
            active: active.length,
            excluded: excludedCount,
            bankTxns: bankTxnCount,
        },
        asOf,
        needsOpening,
        bankAccount: bankAccount
            ? {
                opening_balance: bankAccount.opening_balance ?? null,
                opening_balance_date: dayKey(bankAccount.opening_balance_date),
            }
            : null,
    };
}

export async function executeLedgerRead(action, ctx) {
    if (action === 'ledgerSummary') {
        const summary = await buildLedgerSummary(ctx.db, ctx.apartmentId);
        return { summary };
    }
    return runFinanceMongoRead(action, ctx);
}
