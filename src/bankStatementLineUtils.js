const normalizeDesc = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const formatBalanceKey = (line) => {
    if (line?.balance == null || line.balance === '') return '';
    const value = parseFloat(String(line.balance).replace(/[,₹\s]/g, ''));
    return Number.isFinite(value) ? value.toFixed(2) : '';
};

export const bankLineAmount = (line) => (
    parseFloat(line.credit || 0) > 0.001 ? parseFloat(line.credit) : parseFloat(line.debit || 0)
);

export const bankLineType = (line) => (parseFloat(line.credit || 0) > 0.001 ? 'IN' : 'OUT');

/** Uniqueness key for import dedupe — includes passbook balance when OCR captured it. */
export const bankLineFingerprint = (line) => {
    const amt = bankLineAmount(line);
    const base = `${line.line_date}|${normalizeDesc(line.description)}|${amt.toFixed(2)}`;
    const balanceKey = formatBalanceKey(line);
    return balanceKey ? `${base}|${balanceKey}` : base;
};

/** 1-based OCR row label from source_row_index (AI extract sequence). */
export function formatOcrRowDisplay(line) {
    const idx = line?.source_row_index;
    if (idx == null || idx === '' || Number.isNaN(Number(idx))) return null;
    return Number(idx) + 1;
}

export function extractOcrRowIndexFromTxn(txn, fallbackIndex = 0) {
    if (!txn || typeof txn !== 'object') return fallbackIndex;
    const raw = txn.source_row_index
        ?? txn.sourceRowIndex
        ?? txn.rowIndex
        ?? txn.row_index
        ?? txn.rowNumber
        ?? txn.row_number
        ?? txn.sequence
        ?? txn.lineNumber
        ?? txn.line_number;
    if (raw != null && raw !== '' && !Number.isNaN(parseInt(raw, 10))) {
        return parseInt(raw, 10);
    }
    return fallbackIndex;
}
