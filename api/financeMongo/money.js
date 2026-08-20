/** Shared money / day helpers for finance Mongo domain. */

export function roundMoney(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

export function dayKey(value) {
    if (value == null || value === '') return null;
    const s = String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function todayKey() {
    return new Date().toISOString().slice(0, 10);
}
