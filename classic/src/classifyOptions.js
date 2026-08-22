/**
 * Shared category / sub-category option lists for ledger, bank recon, and bills.
 * Merges static catalogs with values already used in the apartment (+ session adds).
 */
import { portalState } from './store.js';
import {
    INCOME_CATS,
    EXPENSE_CATS,
    SUB_CAT_SUGGESTIONS,
    normalizeCategoryKey,
    categoryDisplayLabel,
} from './expenseCategories.js';

/** Finance-New keeps Mongo data on portalState.financeNew, not portalState.finances. */
function financesForClassify() {
    const fn = portalState.financeNew;
    if (fn?.booted && fn.finances) return fn.finances;
    return portalState.finances || {};
}

function extraCategoryBucket() {
    const f = financesForClassify();
    if (!f.extraCategories) f.extraCategories = [];
    if (portalState.finances && portalState.finances !== f) {
        if (!portalState.finances.extraCategories) portalState.finances.extraCategories = [];
    }
    return f;
}

function txnMatchesKind(row, isIncome) {
    const type = String(row?.type || '').toUpperCase();
    const kind = String(row?.kind || '').toUpperCase();
    if (isIncome) return type === 'IN' || kind === 'IN';
    return type === 'OUT' || kind === 'OUT';
}

/** Collect cats for income vs expense. Wallet (CASH/BANK) is ignored — one list for both. */
function catsFromRows(rows, isIncome) {
    return (rows || [])
        .filter((row) => txnMatchesKind(row, isIncome) && row.cat)
        .map((row) => normalizeCategoryKey(row.cat) || row.cat);
}

function catsFromChart(isIncome) {
    const accounts = portalState.financeNew?.ledger?.accounts
        || portalState.ledger?.accounts
        || [];
    const want = isIncome ? 'IN' : 'OUT';
    return accounts
        .filter((a) => {
            const t = String(a.type || a.kind || a.side || '').toUpperCase();
            if (!t) return !isIncome;
            return t === want || t === (isIncome ? 'INCOME' : 'EXPENSE');
        })
        .map((a) => a.name || a.cat || a.label)
        .filter(Boolean);
}

/** Remember a custom category so dropdowns refresh before/without a round-trip. */
export const registerCustomCategory = (cat, isIncome = false) => {
    const name = String(cat || '').trim();
    if (!name) return name;
    const f = extraCategoryBucket();
    const type = isIncome ? 'IN' : 'OUT';
    const exists = f.extraCategories.some(
        (c) => c.type === type && String(c.name).toLowerCase() === name.toLowerCase(),
    );
    if (!exists) f.extraCategories.push({ name, type });
    if (portalState.finances && portalState.finances !== f) {
        const existsClassic = portalState.finances.extraCategories.some(
            (c) => c.type === type && String(c.name).toLowerCase() === name.toLowerCase(),
        );
        if (!existsClassic) portalState.finances.extraCategories.push({ name, type });
    }
    return name;
};

/** Remember a custom sub-category under a category. */
export const registerCustomSubCategory = (catKey, name) => {
    const category = normalizeCategoryKey(catKey) || String(catKey || '').trim();
    const sub = String(name || '').trim();
    if (!category || !sub) return sub;
    const f = financesForClassify();
    if (!f.subCategories) f.subCategories = [];
    const exists = f.subCategories.some(
        (r) => (r.category === category || r.category === catKey)
            && String(r.name).toLowerCase() === sub.toLowerCase(),
    );
    if (!exists) f.subCategories.push({ category, name: sub });
    return sub;
};

function catsFromSubCategoryParents(isIncome) {
    if (isIncome) return [];
    const f = financesForClassify();
    return (f.subCategories || []).map((row) => row.category).filter(Boolean);
}

function catsFromExpensePlan() {
    const f = financesForClassify();
    return [
        ...(f.expensePlanItems || []).map((i) => i.cat),
        ...(f.expensePlanRecurring || []).map((i) => i.cat),
    ].filter(Boolean);
}

export const defaultExpenseCategory = () => EXPENSE_CATS[0];
export const defaultIncomeCategory = () => INCOME_CATS[0];

/**
 * Uber category list for Finance-New / Admin-New.
 * Split only by income vs expense — never by Cash vs Bank.
 */
export const buildCategoryOptions = (isIncome) => {
    const f = financesForClassify();
    const base = isIncome ? INCOME_CATS : EXPENSE_CATS;
    const fromDocs = catsFromRows(f.financeDocuments, isIncome);
    const fromTxns = catsFromRows(f.txns, isIncome);
    const fromLedgerPack = catsFromRows(portalState.financeNew?.ledgerEntries, isIncome);
    const fromExtra = (f.extraCategories || [])
        .filter((c) => (isIncome ? c.type === 'IN' : c.type === 'OUT') && c.name)
        .map((c) => c.name);
    const fromChart = catsFromChart(isIncome);
    const fromSubs = catsFromSubCategoryParents(isIncome);
    const fromPlan = isIncome ? [] : catsFromExpensePlan();
    return [...new Set([
        ...base,
        ...fromDocs,
        ...fromTxns,
        ...fromLedgerPack,
        ...fromExtra,
        ...fromChart,
        ...fromSubs,
        ...fromPlan,
    ].filter(Boolean))]
        .sort((a, b) => categoryDisplayLabel(a).localeCompare(categoryDisplayLabel(b)));
};

export const buildCategoryOptionGroups = () => ({
    income: buildCategoryOptions(true),
    expense: buildCategoryOptions(false),
});

export const buildSubCategoryOptions = (catKey) => {
    if (!catKey) return [];
    const f = financesForClassify();
    const key = normalizeCategoryKey(catKey) || catKey;
    const defaults = SUB_CAT_SUGGESTIONS[key] || SUB_CAT_SUGGESTIONS.Other || [];
    const saved = (f.subCategories || [])
        .filter((row) => row.category === key || row.category === catKey)
        .map((row) => row.name);
    const fromDocs = (f.financeDocuments || [])
        .filter((d) => d.kind === 'OUT' && d.sub_category
            && (normalizeCategoryKey(d.cat) || d.cat) === key)
        .map((d) => d.sub_category);
    const fromTxns = (f.txns || [])
        .filter((t) => t.type === 'OUT' && t.sub_category
            && (normalizeCategoryKey(t.cat) || t.cat) === key)
        .map((t) => t.sub_category);
    const fromLedgerPack = (portalState.financeNew?.ledgerEntries || [])
        .filter((t) => t.type === 'OUT' && t.sub_category
            && (normalizeCategoryKey(t.cat) || t.cat) === key)
        .map((t) => t.sub_category);
    return [...new Set([...defaults, ...saved, ...fromDocs, ...fromTxns, ...fromLedgerPack].filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
};
