import { prepareImportedStatementLines } from '../../../classic/src/bankStatementOrdering.js';
import { extractOcrRowIndexFromTxn } from '../../../classic/src/bankStatementLineUtils.js';

const MONTHS_SHORT = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDate(val) {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const monthMatch = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3})[-/\s](\d{2}|\d{4})$/);
    if (monthMatch) {
        const [, day, mon, year] = monthMatch;
        const monthIndex = MONTHS_SHORT[mon.toLowerCase()];
        if (monthIndex == null) return null;
        const fullYear = year.length === 2 ? `20${year}` : year;
        const dt = new Date(Date.UTC(parseInt(fullYear, 10), monthIndex, parseInt(day, 10)));
        if (Number.isNaN(dt.getTime())) return null;
        return dt.toISOString().slice(0, 10);
    }
    const parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map((x) => parseInt(x, 10));
        if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
        if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
    return null;
}

function parseAmount(val) {
    if (val == null || val === '') return 0;
    const n = parseFloat(String(val).replace(/[,₹\s]/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : 0;
}

function collectRawTransactions(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.account_statement?.transactions)) return data.account_statement.transactions;
    if (Array.isArray(data.transactions) && data.transactions.length) return data.transactions;
    const out = [];
    if (Array.isArray(data.accounts)) {
        for (const acct of data.accounts) {
            if (Array.isArray(acct?.transactions)) out.push(...acct.transactions);
        }
    }
    return out;
}

export function mapEvolyxTransactionsToStatementLines(data, openingConfig = {}) {
    const raw = collectRawTransactions(data);
    const lines = [];

    for (let sourceIndex = 0; sourceIndex < raw.length; sourceIndex += 1) {
        const txn = raw[sourceIndex];
        if (!txn || typeof txn !== 'object') continue;
        const lineDate = parseDate(
            txn.line_date
            || txn.date
            || txn.transactionDate
            || txn.transaction_date
            || txn.txnDate
            || txn.txn_date
            || txn.valueDate
            || txn.value_date
            || txn.postingDate,
        );
        if (!lineDate) continue;

        const description = String(
            txn.description
            || txn.narration
            || txn.particulars
            || txn.remarks
            || txn.details
            || txn.reference
            || '',
        ).trim();

        let debit = parseAmount(txn.debit ?? txn.withdrawal ?? txn.withdraw ?? txn.dr);
        let credit = parseAmount(txn.credit ?? txn.deposit ?? txn.cr);
        if (debit <= 0.001 && credit <= 0.001 && txn.amount != null) {
            const amt = parseAmount(txn.amount);
            const drCr = String(
                txn.type
                || txn.transaction_type
                || txn.drCr
                || txn.dr_cr
                || txn.debitCredit
                || txn.transactionType
                || '',
            ).toUpperCase();
            if (drCr.includes('CR') || drCr.includes('CREDIT') || drCr === 'C' || drCr === 'DEPOSIT') credit = amt;
            else debit = amt;
        }
        if (debit <= 0.001 && credit <= 0.001) continue;

        lines.push({
            line_date: lineDate,
            description: description || null,
            debit,
            credit,
            balance: txn.balance != null ? parseAmount(txn.balance) : null,
            source_row_index: extractOcrRowIndexFromTxn(txn, sourceIndex),
        });
    }

    return prepareImportedStatementLines(lines, openingConfig);
}
