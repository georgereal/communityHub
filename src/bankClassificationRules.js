/**
 * Bank statement line classification rules — pattern → category/vendor.
 */
import { bankLineType } from './bankStatementLineUtils.js';

export function sortClassificationRules(rules = []) {
    return [...rules].sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const lenA = String(a.description_match || '').length;
        const lenB = String(b.description_match || '').length;
        if (lenB !== lenA) return lenB - lenA;
        return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
}

export function normalizeRuleText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ');
}

export function descriptionMatchesRule(description, matchText) {
    const raw = String(matchText || '').trim();
    if (!raw) return false;

    // Optional regex: /pattern/ or /pattern/i — otherwise case-insensitive "contains"
    const regexWrapped = raw.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexWrapped) {
        try {
            return new RegExp(regexWrapped[1], regexWrapped[2]).test(String(description || ''));
        } catch {
            return false;
        }
    }

    const hay = normalizeRuleText(description);
    const needle = normalizeRuleText(raw);
    if (hay.includes(needle)) return true;
    const compactHay = hay.replace(/[^a-z0-9]/g, '');
    const compactNeedle = needle.replace(/[^a-z0-9]/g, '');
    return compactNeedle.length > 0 && compactHay.includes(compactNeedle);
}

/** Match against stored line record; DOM textarea is fallback for unsaved edits only. */
export function lineTextForRuleMatch(line, row = null) {
    const fromRecord = line?.description;
    if (fromRecord != null && String(fromRecord).trim() !== '') return fromRecord;
    const fromDom = row?.querySelector?.('[data-field="description"]')?.value;
    return fromDom != null ? fromDom : '';
}

/** @returns {object|null} first matching enabled rule for this line */
export function findMatchingRule(line, rules = [], row = null) {
    if (!line) return null;
    const type = bankLineType(line);
    const desc = lineTextForRuleMatch(line, row);
    const active = (rules || []).filter((r) => r.enabled !== false);
    const sorted = sortClassificationRules(active);

    for (const rule of sorted) {
        const ruleType = String(rule.line_type || '').toUpperCase().trim();
        if (ruleType !== type) continue;
        if (descriptionMatchesRule(desc, rule.description_match)) return rule;
    }
    // Fallback: description matched but rule type was wrong in the rule editor
    for (const rule of sorted) {
        if (descriptionMatchesRule(desc, rule.description_match)) return rule;
    }
    return null;
}

/** Suggest a shorter match phrase from a full description (for "save as rule"). */
export function suggestRuleMatchText(description) {
    const raw = String(description || '').trim();
    if (!raw) return '';
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length <= 6) return raw;
    return parts.slice(0, 6).join(' ');
}
