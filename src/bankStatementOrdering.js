/** Passbook / bank statement line ordering helpers. */

export const ORDER_SOURCE = {
    AUTO: 'auto',
    BALANCE_INFERRED: 'balance_inferred',
    MANUAL: 'manual',
};

const DEFAULT_TOLERANCE = 0.01;

/** Sort key for grouping lines from the same import batch (file upload / passbook scan). */
export function importOrderKey(importRow) {
    if (!importRow) return '';
    if (importRow.created_at) return String(importRow.created_at);
    if (importRow.file_name) return String(importRow.file_name);
    return String(importRow.id || '');
}

function compareImportThenOcr(a, b, importById) {
    const impA = importById?.get?.(a?.import_id);
    const impB = importById?.get?.(b?.import_id);
    const byImport = importOrderKey(impA).localeCompare(importOrderKey(impB));
    if (byImport !== 0) return byImport;
    return (a?.source_row_index ?? 0) - (b?.source_row_index ?? 0);
}

export function linePriorBalance(line) {
    const balance = parseFloat(line?.balance);
    if (!Number.isFinite(balance)) return null;
    const credit = parseFloat(line?.credit || 0);
    const debit = parseFloat(line?.debit || 0);
    if (credit > 0.001) return balance - credit;
    if (debit > 0.001) return balance + debit;
    return null;
}

export function linePassbookBalance(line) {
    if (line?.balance == null || line.balance === '') return null;
    const value = parseFloat(line.balance);
    return Number.isFinite(value) ? value : null;
}

export function assignSourceOrder(lines = []) {
    return lines.map((line, index) => ({
        ...line,
        source_row_index: line.source_row_index ?? index,
        line_order: line.line_order ?? index,
        order_source: line.order_source || ORDER_SOURCE.AUTO,
    }));
}

function inferDayOrder(dayLines, priorClosingBalance, importById = null, tolerance = DEFAULT_TOLERANCE) {
    if (dayLines.length <= 1) {
        return { ordered: [...dayLines], uncertain: false, source: ORDER_SOURCE.AUTO };
    }

    const manual = dayLines.some((line) => line.order_source === ORDER_SOURCE.MANUAL);
    if (manual) {
        return {
            ordered: [...dayLines].sort((a, b) => (a.line_order ?? 0) - (b.line_order ?? 0)),
            uncertain: false,
            source: ORDER_SOURCE.MANUAL,
        };
    }

    // Same-day order: import batch (file / scan) then OCR row index within that batch
    const autoOrdered = importById
        ? [...dayLines].sort((a, b) => compareImportThenOcr(a, b, importById))
        : [...dayLines].sort((a, b) => (a.source_row_index ?? 0) - (b.source_row_index ?? 0));

    const withBalance = autoOrdered.filter((line) => linePriorBalance(line) != null && linePassbookBalance(line) != null);
    if (withBalance.length >= dayLines.length && priorClosingBalance != null) {
        let seekPrior = priorClosingBalance;
        let chainOk = true;
        for (const line of autoOrdered) {
            const prior = linePriorBalance(line);
            if (prior == null || Math.abs(prior - seekPrior) > tolerance) {
                chainOk = false;
                break;
            }
            seekPrior = linePassbookBalance(line);
        }
        if (chainOk) {
            return { ordered: autoOrdered, uncertain: false, source: ORDER_SOURCE.BALANCE_INFERRED };
        }
        return { ordered: autoOrdered, uncertain: true, source: ORDER_SOURCE.AUTO };
    }

    return { ordered: autoOrdered, uncertain: false, source: ORDER_SOURCE.AUTO };
}

export function inferLineOrderByBalance(lines = [], { openingAmount = null, openingDate = null, tolerance = DEFAULT_TOLERANCE, importById = null } = {}) {
    const withSource = assignSourceOrder(lines);
    const byDate = new Map();
    for (const line of withSource) {
        const key = line.line_date || '';
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(line);
    }

    const dates = [...byDate.keys()].sort();
    let priorClosing = openingAmount != null && !Number.isNaN(parseFloat(openingAmount))
        ? parseFloat(openingAmount)
        : null;
    const dayMeta = new Map();
    const ordered = [];

    for (const date of dates) {
        const dayLines = byDate.get(date) || [];
        const onOrAfterOpening = !openingDate || date >= openingDate;
        const { ordered: dayOrdered, uncertain, source } = onOrAfterOpening
            ? inferDayOrder(dayLines, priorClosing, importById, tolerance)
            : {
                ordered: importById
                    ? [...dayLines].sort((a, b) => compareImportThenOcr(a, b, importById))
                    : [...dayLines].sort((a, b) => (a.source_row_index ?? 0) - (b.source_row_index ?? 0)),
                uncertain: false,
                source: ORDER_SOURCE.AUTO,
            };

        dayOrdered.forEach((line, index) => {
            ordered.push({
                ...line,
                line_order: index,
                order_source: line.order_source === ORDER_SOURCE.MANUAL ? ORDER_SOURCE.MANUAL : source,
            });
        });
        dayMeta.set(date, { uncertain, source });

        const lastWithBalance = [...dayOrdered].reverse().find((line) => linePassbookBalance(line) != null);
        if (lastWithBalance) priorClosing = linePassbookBalance(lastWithBalance);
    }

    return { lines: ordered, dayMeta };
}

export function sortStatementLinesChronologically(lines = [], importById = null) {
    return [...lines].sort((a, b) => compareLineOrder(a, b, importById));
}

export function prepareImportedStatementLines(lines = [], openingConfig = {}, importById = null) {
    const { lines: ordered } = inferLineOrderByBalance(lines, {
        openingAmount: openingConfig.amount,
        openingDate: openingConfig.date,
        importById,
    });
    return ordered;
}

export function compareLineOrder(a, b, importById = null) {
    const byDate = String(a?.line_date || '').localeCompare(String(b?.line_date || ''));
    if (byDate !== 0) return byDate;

    const aManual = a?.order_source === ORDER_SOURCE.MANUAL;
    const bManual = b?.order_source === ORDER_SOURCE.MANUAL;
    if (aManual || bManual) {
        return (a?.line_order ?? 0) - (b?.line_order ?? 0);
    }

    if (importById) {
        const byImportOcr = compareImportThenOcr(a, b, importById);
        if (byImportOcr !== 0) return byImportOcr;
    } else {
        const byOcr = (a?.source_row_index ?? 0) - (b?.source_row_index ?? 0);
        if (byOcr !== 0) return byOcr;
    }

    return (a?.line_order ?? 0) - (b?.line_order ?? 0);
}

/** Compute running balance per line id in chronological order. */
export function computeRunningBalances(lines = [], openingConfig = {}, importById = null) {
    const amount = openingConfig.amount;
    const date = openingConfig.date;
    const hasOpening = amount != null && !Number.isNaN(parseFloat(amount));
    const balances = new Map();

    if (!hasOpening) return balances;

    let running = parseFloat(amount);
    for (const line of sortStatementLinesChronologically(lines, importById)) {
        if (date && line.line_date < date) continue;
        running += parseFloat(line.credit || 0) - parseFloat(line.debit || 0);
        if (line.id) balances.set(line.id, running);
    }

    return balances;
}

export function applyRunningBalances(lines = [], openingConfig = {}) {
    const balances = computeRunningBalances(lines, openingConfig);
    return lines.map((line) => ({
        ...line,
        computed_balance: line.id && balances.has(line.id) ? balances.get(line.id) : null,
    }));
}

export function dayOrderHint(dayLines = []) {
    if (dayLines.length <= 1) return '';
    if (dayLines.some((line) => line.order_source === ORDER_SOURCE.MANUAL)) {
        return 'Manual order';
    }
    if (dayLines.some((line) => line.order_source === ORDER_SOURCE.BALANCE_INFERRED)) {
        return 'Order matches passbook balance chain (import + OCR sequence)';
    }
    if (dayLines.some((line) => line.order_source === ORDER_SOURCE.AUTO && line.source_row_index != null)) {
        return 'Order by import file, then OCR row #';
    }
    return 'Use ↑ ↓ to fix order';
}

export function buildDayOrderHints(lines = []) {
    const byDate = new Map();
    for (const line of lines) {
        const key = line.line_date || '';
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(line);
    }
    const hints = new Map();
    for (const [date, dayLines] of byDate) {
        const hint = dayOrderHint(dayLines);
        if (hint) hints.set(date, hint);
    }
    return hints;
}
