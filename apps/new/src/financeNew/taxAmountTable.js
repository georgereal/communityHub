/**
 * Taxable / tax% / tax₹ / total mini-table used by expense & bill forms.
 * User can fill any consistent pair — the rest auto-computes:
 *   base + pct   → tax = base·pct/100, total = base + tax
 *   total + pct  → base = total/(1+pct/100), tax = total − base
 *   base + tax   → total = base + tax, pct = tax/base·100
 *   total + tax  → base = total − tax, pct derived
 * `total` keeps the legacy element id (e.g. cash-amt) — the value that is saved.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (el) => {
    const v = parseFloat(el?.value);
    return Number.isFinite(v) ? v : null;
};
const setNum = (el, v) => {
    if (!el) return;
    el.value = v == null || !Number.isFinite(v) ? '' : String(r2(v));
};

export function wireTaxAmountTable({ base, pct, tax, total }) {
    const els = { base, pct, tax, total };
    const onBaseOrPct = () => {
        const b = num(base);
        const p = num(pct) ?? 0;
        if (b == null) return;
        const t = r2(b * p / 100);
        setNum(tax, t);
        setNum(total, b + t);
    };
    const onTax = () => {
        const t = num(tax);
        if (t == null) return;
        const b = num(base);
        if (b != null) {
            setNum(total, b + t);
            setNum(pct, b ? t / b * 100 : 0);
        } else {
            const tot = num(total);
            if (tot == null) return;
            const nb = r2(tot - t);
            setNum(base, nb);
            setNum(pct, nb ? t / nb * 100 : 0);
        }
    };
    const onTotal = () => {
        const tot = num(total);
        if (tot == null) return;
        const b = num(base);
        if (b != null) {
            const t = r2(tot - b);
            setNum(tax, t);
            setNum(pct, b ? t / b * 100 : 0);
        } else {
            const p = num(pct);
            const t = num(tax);
            if (p != null) {
                const nb = r2(tot / (1 + p / 100));
                setNum(base, nb);
                setNum(tax, tot - nb);
            } else if (t != null) {
                const nb = r2(tot - t);
                setNum(base, nb);
                setNum(pct, nb ? t / nb * 100 : 0);
            }
        }
    };
    base?.addEventListener('input', onBaseOrPct);
    pct?.addEventListener('input', onBaseOrPct);
    tax?.addEventListener('input', onTax);
    total?.addEventListener('input', onTotal);
    return els;
}

/** @returns {{ taxable_amount: number|null, tax_percent: number|null, tax_amount: number|null, amount: number|null }} */
export function readTaxAmountTable({ base, pct, tax, total }) {
    const amount = num(total);
    const tax_percent = num(pct);
    const taxable_amount = num(base);
    const tax_amount = num(tax);
    return {
        taxable_amount: taxable_amount != null ? r2(taxable_amount) : null,
        tax_percent: tax_percent != null ? r2(tax_percent) : null,
        tax_amount: tax_amount != null ? r2(tax_amount) : null,
        amount: amount != null ? r2(amount) : null,
    };
}

/** Restore fields from a saved record; defaults tax% to 0. */
export function fillTaxAmountTable({ base, pct, tax, total }, rec = {}) {
    setNum(total, rec.amount ?? null);
    const p = rec.tax_percent != null ? Number(rec.tax_percent) : 0;
    setNum(pct, p);
    if (rec.taxable_amount != null) {
        setNum(base, rec.taxable_amount);
        setNum(tax, rec.tax_amount ?? (r2(Number(rec.taxable_amount) * p / 100)));
    } else {
        setNum(base, null);
        setNum(tax, null);
    }
}

/** Clear all cells; tax% back to 0. */
export function resetTaxAmountTable({ base, pct, tax, total }) {
    [base, tax, total].forEach((el) => { if (el) el.value = ''; });
    if (pct) pct.value = '0';
}
