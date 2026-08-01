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

/** Remember a custom category so dropdowns refresh before/without a round-trip. */
export const registerCustomCategory = (cat, isIncome = false) => {
    const name = String(cat || '').trim();
    if (!name) return name;
    if (!portalState.finances.extraCategories) portalState.finances.extraCategories = [];
    const type = isIncome ? 'IN' : 'OUT';
    const exists = portalState.finances.extraCategories.some(
        (c) => c.type === type && String(c.name).toLowerCase() === name.toLowerCase(),
    );
    if (!exists) portalState.finances.extraCategories.push({ name, type });
    return name;
};

/** Remember a custom sub-category under a category. */
export const registerCustomSubCategory = (catKey, name) => {
    const category = normalizeCategoryKey(catKey) || String(catKey || '').trim();
    const sub = String(name || '').trim();
    if (!category || !sub) return sub;
    if (!portalState.finances.subCategories) portalState.finances.subCategories = [];
    const exists = portalState.finances.subCategories.some(
        (r) => (r.category === category || r.category === catKey)
            && String(r.name).toLowerCase() === sub.toLowerCase(),
    );
    if (!exists) portalState.finances.subCategories.push({ category, name: sub });
    return sub;
};

export const buildCategoryOptions = (isIncome) => {
    const base = isIncome ? INCOME_CATS : EXPENSE_CATS;
    const fromDocs = (portalState.finances.financeDocuments || [])
        .filter((d) => (isIncome ? d.kind === 'IN' : d.kind === 'OUT') && d.cat)
        .map((d) => normalizeCategoryKey(d.cat) || d.cat);
    const fromTxns = (portalState.finances.txns || [])
        .filter((t) => (isIncome ? t.type === 'IN' : t.type === 'OUT') && t.cat)
        .map((t) => normalizeCategoryKey(t.cat) || t.cat);
    const fromExtra = (portalState.finances.extraCategories || [])
        .filter((c) => (isIncome ? c.type === 'IN' : c.type === 'OUT') && c.name)
        .map((c) => c.name);
    return [...new Set([...base, ...fromDocs, ...fromTxns, ...fromExtra].filter(Boolean))]
        .sort((a, b) => categoryDisplayLabel(a).localeCompare(categoryDisplayLabel(b)));
};

export const buildSubCategoryOptions = (catKey) => {
    if (!catKey) return [];
    const key = normalizeCategoryKey(catKey) || catKey;
    const defaults = SUB_CAT_SUGGESTIONS[key] || SUB_CAT_SUGGESTIONS.Other || [];
    const saved = (portalState.finances.subCategories || [])
        .filter((row) => row.category === key || row.category === catKey)
        .map((row) => row.name);
    const fromDocs = (portalState.finances.financeDocuments || [])
        .filter((d) => d.kind === 'OUT' && d.sub_category
            && (normalizeCategoryKey(d.cat) || d.cat) === key)
        .map((d) => d.sub_category);
    const fromTxns = (portalState.finances.txns || [])
        .filter((t) => t.type === 'OUT' && t.sub_category
            && (normalizeCategoryKey(t.cat) || t.cat) === key)
        .map((t) => t.sub_category);
    return [...new Set([...defaults, ...saved, ...fromDocs, ...fromTxns].filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
};
