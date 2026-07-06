/** Society expense categories for bank recon, ledger, and admin. */

export const BANK_REJECT_CAT = 'Bank Reject';

/** Display labels for canonical category keys (income + expense). */
export const CATEGORY_LABELS = {
    Security: 'Security / Guards',
    Maintenance: 'General Maintenance',
    Plumbing: 'Plumbing / Water',
    Electrical: 'Electrical / Diesel',
    Stationery: 'Office / Stationery',
    'Maintenance Collection': 'Maintenance Collection',
    Marketing: 'Marketing / Events',
    Promotion: 'Promotion / Sponsorship',
    Interest: 'Bank Interest',
    'Petty Inflow': 'Petty Cash Top-up',
    'Bank Reject': 'Bank Reject',
    Reconcile: 'Bank Reconciliation',
    'Other Income': 'Other Income',
    Other: 'Miscellaneous',
};

/** Legacy / alternate stored values → canonical key. */
const CATEGORY_ALIASES = {
    'Petty Cash': 'Petty Inflow',
    'Petty Cash Top-up': 'Petty Inflow',
};

const LABEL_TO_KEY = Object.fromEntries(
    Object.entries(CATEGORY_LABELS).map(([key, label]) => [label.toLowerCase(), key]),
);

export const INCOME_CATS = [
    'Maintenance Collection',
    'Marketing',
    'Promotion',
    'Interest',
    'Petty Inflow',
    'Reconcile',
    BANK_REJECT_CAT,
    'Other Income',
];

export const EXPENSE_CATS = [
    'Security',
    'Housekeeping',
    'Water Tankers',
    'Audit',
    'Housekeeping material',
    'Gardener Salary',
    'Electrician Salary',
    'Electrical work',
    'Plumbing Work',
    'Water Meter',
    'Bescom',
    'Lift',
    'Lift AMC',
    'Generator AMC',
    'Diesel',
    'Water softener Salt',
    'Water Softener Expenses',
    'Bank Charges',
    BANK_REJECT_CAT,
    'Water tank cleaning',
    'JMC (ABC Share)',
    'Other',
];

export const categoryOptionsForType = (type) => (type === 'IN' ? INCOME_CATS : EXPENSE_CATS);

/** Map stored cat (key, label, or alias) to the canonical key used in lists & pivots. */
export const normalizeCategoryKey = (cat) => {
    const t = String(cat ?? '').trim();
    if (!t) return t;
    if (CATEGORY_ALIASES[t]) return CATEGORY_ALIASES[t];
    const allKeys = [...INCOME_CATS, ...EXPENSE_CATS];
    if (allKeys.includes(t)) return t;
    const byLabel = LABEL_TO_KEY[t.toLowerCase()];
    if (byLabel) return byLabel;
    return t;
};

export const categoryDisplayLabel = (cat) => {
    const key = normalizeCategoryKey(cat);
    return CATEGORY_LABELS[key] || key || 'Uncategorised';
};

export const isBankRejectCategory = (cat) => cat === BANK_REJECT_CAT;

/** Bank rejects are non-P&L by default. */
export const defaultExcludeFromReports = (cat) => isBankRejectCategory(cat);

export const SUB_CAT_SUGGESTIONS = {
    'Bank Charges': [
        'NEFT charges',
        'RTGS charges',
        'Cheque book charges',
        'Annual account charges',
        'SMS / alert charges',
        'GST on bank charges',
        'Other',
    ],
    Other: ['Miscellaneous'],
};

export function inferExpenseCategory(desc) {
    const u = String(desc || '').toUpperCase();
    if (/REJECT|RETURNED|BOUNCE|DISHONOU?R|CHQ\s*RET|CHEQUE\s*RET|INWARD\s*RET/.test(u)) return BANK_REJECT_CAT;
    if (/LIFT\s*AMC|LIFT\s*MAINT/.test(u)) return 'Lift AMC';
    if (/\bLIFT\b|ELEVATOR/.test(u)) return 'Lift';
    if (/GENERATOR\s*AMC|\bDG\s*AMC|GEN\s*AMC/.test(u)) return 'Generator AMC';
    if (/\bDIESEL\b|\bDG\b/.test(u)) return 'Diesel';
    if (/BANK\s*CHARG|IMPS\s*CHG|NEFT\s*CHG|RTGS\s*CHG|CHQ\s*CHG/.test(u)) return 'Bank Charges';
    if (/JMC|ABC\s*SHARE/.test(u)) return 'JMC (ABC Share)';
    if (/WATER\s*TANK\s*CLEAN|TANK\s*CLEAN/.test(u)) return 'Water tank cleaning';
    if (/SOFTENER.*SALT/.test(u)) return 'Water softener Salt';
    if (/SOFTENER/.test(u)) return 'Water Softener Expenses';
    if (/BESCOM|\bEB\b|ELECTRICITY\s*BILL/.test(u)) return 'Bescom';
    if (/WATER\s*METER/.test(u)) return 'Water Meter';
    if (/WATER\s*TANKER|TANKER/.test(u)) return 'Water Tankers';
    if (/HOUSEKEEP.*MATERIAL|HK\s*MAT/.test(u)) return 'Housekeeping material';
    if (/GARDEN/.test(u)) return 'Gardener Salary';
    if (/ELECTRICIAN/.test(u)) return 'Electrician Salary';
    if (/ELECTRIC|ELECTRICAL/.test(u)) return 'Electrical work';
    if (/PLUMB/.test(u)) return 'Plumbing Work';
    if (/HOUSEKEEP|\bHK\b/.test(u)) return 'Housekeeping';
    if (/SECURITY|GUARD/.test(u)) return 'Security';
    if (/\bAUDIT\b/.test(u)) return 'Audit';
    return 'Other';
}
