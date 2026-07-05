/** Society expense categories for bank recon, ledger, and admin. */

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
    'Water tank cleaning',
    'JMC (ABC Share)',
    'Other',
];

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
