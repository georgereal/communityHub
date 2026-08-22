/**
 * Directional sync transforms — formulas live in column_mapping, not hardcoded sync logic.
 *
 * Import (Excel → DB):  importExpr on each mapped field
 * Export (DB → Excel):  exportExpr on each mapped field
 *
 * References:
 *   {value}        — raw cell (import) or DB field value (export)
 *   {field:type}   — another field on the row / transaction
 *   {col:3}        — Excel column index on this row (import only)
 *
 * Functions:
 *   NORM_TYPE, TO_DR_CR, PARSE_AMOUNT, NORM_WALLET, FORMAT_DATE, UPPER, LOWER, TRIM,
 *   IF(cond, then, else), COALESCE(a,b), CONCAT(a,b,...), ROUND(x),
 *   DR_COLUMN(x), CR_COLUMN(x)  — import: set type+amount from Dr/Cr cell
 */

export const DEFAULT_IMPORT_EXPR = {
    date: 'FORMAT_DATE({value})',
    type: 'NORM_TYPE({value})',
    amount: 'PARSE_AMOUNT({value})',
    debit_dr: 'DR_COLUMN({value})',
    credit_cr: 'CR_COLUMN({value})',
    wallet: 'NORM_WALLET({value})',
    excel_sync_status: '',
};

export const DEFAULT_EXPORT_EXPR = {
    date: 'FORMAT_DATE({value})',
    type: '{value}',
    amount: '{value}',
    debit_dr: 'IF({field:type}="OUT",{field:amount},"")',
    credit_cr: 'IF({field:type}="IN",{field:amount},"")',
    wallet: '{value}',
    excel_sync_status: '"SYNCED"',
};

export const FORMULA_PRESETS = [
    { id: 'default', label: 'Default for field', importExpr: null, exportExpr: null },
    { id: 'as_is', label: 'As-is', importExpr: '{value}', exportExpr: '{value}' },
    { id: 'norm_type', label: 'Normalize → IN/OUT', importExpr: 'NORM_TYPE({value})', exportExpr: '{value}' },
    { id: 'to_dr_cr', label: 'IN/OUT → DR/CR (export)', importExpr: 'NORM_TYPE({value})', exportExpr: 'TO_DR_CR({value})' },
    { id: 'parse_amount', label: 'Parse number', importExpr: 'PARSE_AMOUNT({value})', exportExpr: '{value}' },
    { id: 'format_date', label: 'Date YYYY-MM-DD', importExpr: 'FORMAT_DATE({value})', exportExpr: 'FORMAT_DATE({value})' },
    { id: 'norm_wallet', label: 'CASH / BANK', importExpr: 'NORM_WALLET({value})', exportExpr: '{value}' },
    { id: 'dr_column', label: 'Dr → OUT + amount', importExpr: 'DR_COLUMN({value})', exportExpr: 'IF({field:type}="OUT",{field:amount},"")' },
    { id: 'cr_column', label: 'Cr → IN + amount', importExpr: 'CR_COLUMN({value})', exportExpr: 'IF({field:type}="IN",{field:amount},"")' },
    {
        id: 'bank_concat',
        label: 'Bank type + reference',
        importExpr: '{value}',
        exportExpr: 'CONCAT({field:bank_payment_type}," ",{field:bank_reference})',
    },
];

export function getDefaultImportExpr(fieldKey) {
    return DEFAULT_IMPORT_EXPR[fieldKey] ?? '{value}';
}

export function getDefaultExportExpr(fieldKey) {
    return DEFAULT_EXPORT_EXPR[fieldKey] ?? '{value}';
}

function parseAmount(val) {
    const n = parseFloat(String(val ?? '').replace(/[,₹\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

function normType(val) {
    const s = String(val ?? '').toUpperCase();
    if (!s) return null;
    if (s.includes('IN') || s.includes('CR') || s.includes('CREDIT') || s.includes('INCOME')) return 'IN';
    if (s.includes('OUT') || s.includes('DR') || s.includes('DEBIT') || s.includes('EXPENSE')) return 'OUT';
    return null;
}

function normLedgerType(val) {
    return normType(val);
}

function ledgerTypeLabel(val) {
    if (val === 'IN') return 'Income';
    if (val === 'OUT') return 'Expense';
    return val ?? '';
}

function yesNoBool(val) {
    const s = String(val ?? '').trim().toLowerCase();
    if (!s) return false;
    return s === 'yes' || s === 'y' || s === 'true' || s === '1';
}

function yesNoLabel(val) {
    return val ? 'Yes' : 'No';
}

function ledgerCatLabel(val) {
    return val ?? '';
}

function formatLedgerDate(val) {
    if (val == null || val === '') return '';
    const iso = formatDate(val);
    if (!iso) return String(val ?? '');
    const [, year, month, day] = iso.match(/^(\d{4})-(\d{2})-(\d{2})/) || [];
    if (!year) return iso;
    return `${day}-${month}-${year.slice(-2)}`;
}

function parseLedgerDisplayDate(val) {
    const s = String(val ?? '').trim();
    const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (m) {
        const day = m[1].padStart(2, '0');
        const month = m[2].padStart(2, '0');
        let year = m[3];
        if (year.length === 2) year = `20${year}`;
        return `${year}-${month}-${day}`;
    }
    return formatDate(val);
}

function toDrCr(val) {
    if (val === 'OUT') return 'DR';
    if (val === 'IN') return 'CR';
    return val ?? '';
}

function normWallet(val) {
    const s = String(val ?? '').toUpperCase();
    if (!s) return null;
    return s.includes('BANK') ? 'BANK' : 'CASH';
}

function excelSerialToIso(serial) {
    const n = typeof serial === 'number' ? serial : parseFloat(String(serial));
    if (!Number.isFinite(n) || n < 1) return null;
    // Excel 1900 date system → Unix epoch (25569 = days from 1899-12-30 to 1970-01-01)
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function formatDate(val) {
    if (val == null || val === '') return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    if (typeof val === 'number') {
        const fromSerial = excelSerialToIso(val);
        if (fromSerial) return fromSerial;
    }
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    if (/^\d+(\.\d+)?$/.test(s)) {
        const fromSerial = excelSerialToIso(parseFloat(s));
        if (fromSerial) return fromSerial;
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const NON_DATE_LABEL_RE = /\b(grand\s*)?total(s)?\b|\bsub\s*total\b|\bsum(mary)?\b|^total$/i;

/** True when a parsed import date is safe to insert into timestamptz columns. */
export function isImportableDate(val) {
    if (val == null || val === '') return false;
    if (typeof val === 'number') return excelSerialToIso(val) != null;
    const s = String(val).trim();
    if (!s || NON_DATE_LABEL_RE.test(s)) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10))) {
        const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
        return !Number.isNaN(d.getTime());
    }
    if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToIso(parseFloat(s)) != null;
    const d = new Date(s);
    return !Number.isNaN(d.getTime());
}

function cellStr(val) {
    if (val == null) return '';
    return String(val).trim();
}

function resolveFieldRef(name, ctx, direction) {
    if (direction === 'import') {
        if (ctx.record && name in ctx.record) return ctx.record[name];
        const defKey = Object.entries({
            type: 'type', amount: 'amount', cat: 'cat', wallet: 'wallet',
            description: 'description', vendor_name: 'vendor_name',
            bank_payment_type: 'bank_payment_type', bank_reference: 'bank_reference',
            sub_category: 'sub_category', vendor_invoice: 'vendor_invoice',
            date: 'date', external_sync_key: 'external_sync_key',
        }).find(([, col]) => col === name)?.[0];
        if (defKey && ctx.record?.[name] !== undefined) return ctx.record[name];
        return ctx.record?.[name];
    }
    return ctx.txn?.[name];
}

function resolveRef(token, ctx, direction) {
    if (token === 'value') return ctx.value;
    if (token.startsWith('field:')) {
        return resolveFieldRef(token.slice(6), ctx, direction);
    }
    if (token.startsWith('col:') && direction === 'import') {
        const n = parseInt(token.slice(4), 10);
        return ctx.row?.[n];
    }
    return undefined;
}

function tokenize(expr) {
    const tokens = [];
    let i = 0;
    const s = String(expr || '').trim();
    while (i < s.length) {
        if (/\s/.test(s[i])) { i += 1; continue; }
        if (s[i] === '"' || s[i] === "'") {
            const q = s[i];
            let j = i + 1;
            let inner = '';
            while (j < s.length && s[j] !== q) {
                inner += s[j];
                j += 1;
            }
            tokens.push({ type: 'string', value: inner });
            i = j + 1;
            continue;
        }
        if ('(),'.includes(s[i])) {
            tokens.push({ type: s[i] });
            i += 1;
            continue;
        }
        if ('+-*/'.includes(s[i])) {
            tokens.push({ type: 'op', value: s[i] });
            i += 1;
            continue;
        }
        if (s[i] === '{') {
            let j = i + 1;
            let inner = '';
            while (j < s.length && s[j] !== '}') { inner += s[j]; j += 1; }
            tokens.push({ type: 'ref', value: inner });
            i = j + 1;
            continue;
        }
        if (/[=<>!]/.test(s[i])) {
            let op = s[i];
            if (s[i + 1] === '=') op += '=';
            tokens.push({ type: 'cmp', value: op });
            i += op.length;
            continue;
        }
        let j = i;
        while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j += 1;
        if (j > i) {
            const word = s.slice(i, j);
            if (/^\d+(\.\d+)?$/.test(word)) tokens.push({ type: 'number', value: parseFloat(word) });
            else tokens.push({ type: 'ident', value: word });
            i = j;
            continue;
        }
        i += 1;
    }
    return tokens;
}

function evaluateTokens(tokens, ctx, direction) {
    let pos = 0;

    function peek() { return tokens[pos]; }
    function consume(type, value) {
        const t = tokens[pos];
        if (!t || (type && t.type !== type) || (value !== undefined && t.value !== value)) {
            throw new Error(`Formula syntax error near token ${pos}`);
        }
        pos += 1;
        return t;
    }

    function parsePrimary() {
        const t = peek();
        if (!t) return '';
        if (t.type === 'string') { consume('string'); return t.value; }
        if (t.type === 'number') { consume('number'); return t.value; }
        if (t.type === 'ref') {
            consume('ref');
            return resolveRef(t.value, ctx, direction);
        }
        if (t.type === 'ident') {
            const name = t.value;
            consume('ident');
            if (peek()?.type === '(') {
                consume('(');
                const args = [];
                if (peek()?.type !== ')') {
                    args.push(parseCompare());
                    while (peek()?.type === ',') {
                        consume(',');
                        args.push(parseCompare());
                    }
                }
                consume(')');
                return callFn(name, args, ctx, direction);
            }
            return name;
        }
        if (t.type === '(') {
            consume('(');
            const v = parseCompare();
            consume(')');
            return v;
        }
        return '';
    }

    function parseMul() {
        let left = parsePrimary();
        while (peek()?.type === 'op' && '*/'.includes(peek().value)) {
            const op = consume('op').value;
            const right = parsePrimary();
            const a = parseAmount(left);
            const b = parseAmount(right);
            left = op === '*' ? a * b : b === 0 ? 0 : a / b;
        }
        return left;
    }

    function parseAdd() {
        let left = parseMul();
        while (peek()?.type === 'op' && '+-'.includes(peek().value)) {
            const op = consume('op').value;
            const right = parseMul();
            const a = typeof left === 'number' ? left : parseAmount(left);
            const b = typeof right === 'number' ? right : parseAmount(right);
            left = op === '+' ? a + b : a - b;
        }
        return left;
    }

    function parseCompare() {
        let left = parseAdd();
        const t = peek();
        if (t?.type === 'cmp') {
            const op = consume('cmp').value;
            const right = parseAdd();
            const l = String(left ?? '');
            const r = String(right ?? '');
            if (op === '=' || op === '==') return l === r;
            if (op === '!=' || op === '<>') return l !== r;
        }
        return left;
    }

    const result = parseCompare();
    return result;
}

function callFn(name, args, ctx, direction) {
    const U = name.toUpperCase();
    if (U === 'IF') {
        return args[0] ? args[1] : (args[2] ?? '');
    }
    if (U === 'COALESCE') {
        for (const a of args) {
            if (a !== null && a !== undefined && a !== '') return a;
        }
        return '';
    }
    if (U === 'CONCAT') return args.map((a) => cellStr(a)).filter(Boolean).join('').trim()
        || args.map((a) => cellStr(a)).join(' ').trim();
    if (U === 'UPPER') return String(args[0] ?? '').toUpperCase();
    if (U === 'LOWER') return String(args[0] ?? '').toLowerCase();
    if (U === 'TRIM') return cellStr(args[0]);
    if (U === 'ROUND') return Math.round(parseAmount(args[0]));
    if (U === 'NORM_TYPE') return normType(args[0]);
    if (U === 'TO_DR_CR') return toDrCr(args[0]);
    if (U === 'PARSE_AMOUNT') return parseAmount(args[0]);
    if (U === 'NORM_WALLET') return normWallet(args[0]);
    if (U === 'FORMAT_DATE') return formatDate(args[0]);
    if (U === 'FORMAT_LEDGER_DATE') {
        return direction === 'export'
            ? formatLedgerDate(args[0])
            : (parseLedgerDisplayDate(args[0]) || formatDate(args[0]));
    }
    if (U === 'NORM_LEDGER_TYPE') return normLedgerType(args[0]);
    if (U === 'LEDGER_TYPE_LABEL') return ledgerTypeLabel(args[0]);
    if (U === 'YES_NO_BOOL') return yesNoBool(args[0]);
    if (U === 'YES_NO_LABEL') return yesNoLabel(args[0]);
    if (U === 'LEDGER_CAT_LABEL') return ledgerCatLabel(args[0]);
    if (U === 'FN' && args.length >= 1) {
        const name = String(args[0] ?? '').replace(/^@/, '');
        const body = ctx.mapping?.formulaSnippets?.[name];
        if (body) return evaluate(body, ctx, direction).value;
    }
    if (U === 'DR_COLUMN' && direction === 'import') {
        const n = parseAmount(args[0]);
        if (n > 0 && !ctx.record?.type) {
            return { __patch: { type: 'OUT', amount: n }, __value: undefined };
        }
        return { __value: undefined };
    }
    if (U === 'CR_COLUMN' && direction === 'import') {
        const n = parseAmount(args[0]);
        if (n > 0 && !ctx.record?.type) {
            return { __patch: { type: 'IN', amount: n }, __value: undefined };
        }
        return { __value: undefined };
    }
    return args[0] ?? '';
}

function evaluate(expr, ctx, direction) {
    if (!expr || !String(expr).trim()) return { value: undefined };
    const snippets = ctx.mapping?.formulaSnippets || {};
    const expanded = expandSnippetRefs(expr, snippets);
    const tokens = tokenize(expanded);
    const raw = evaluateTokens(tokens, ctx, direction);
    if (raw && typeof raw === 'object' && ('__patch' in raw || '__value' in raw)) {
        return { value: raw.__value, patch: raw.__patch };
    }
    return { value: raw === '' ? undefined : raw };
}

/** @returns {{ value?: any, patch?: Record<string, any> }} */
export function runImportTransform(expr, ctx) {
    return evaluate(expr, ctx, 'import');
}

/** @returns {any} */
export function runExportTransform(expr, ctx) {
    const { value } = evaluate(expr, ctx, 'export');
    if (value === null || value === undefined) return '';
    return value;
}

export function expandSnippetRefs(expr, snippets = {}) {
    if (!expr || !snippets || typeof snippets !== 'object') return expr;
    return String(expr).replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
        if (Object.prototype.hasOwnProperty.call(snippets, name) && snippets[name]) {
            return `(${snippets[name]})`;
        }
        return match;
    });
}

export const BUILTIN_FUNCTIONS = [
    { name: '{value}', desc: 'This field — Excel cell on import, DB column on export' },
    { name: '{field:amount}', desc: 'Another field on the same row (import) or transaction (export)' },
    { name: '{col:3}', desc: 'Raw Excel column index (0-based), import only' },
    { name: '@snippet_name', desc: 'Expand a custom function from the library above' },
    { name: 'NORM_TYPE(x)', desc: 'DR/CR/IN/OUT → IN or OUT' },
    { name: 'TO_DR_CR(x)', desc: 'IN/OUT → CR or DR' },
    { name: 'PARSE_AMOUNT(x)', desc: 'Number from text' },
    { name: 'NORM_WALLET(x)', desc: '→ CASH or BANK' },
    { name: 'FORMAT_DATE(x)', desc: '→ YYYY-MM-DD' },
    { name: 'IF(a,b,c)', desc: 'Conditional' },
    { name: 'CONCAT(a,b,…)', desc: 'Join values' },
    { name: 'DR_COLUMN(x)', desc: 'Import: Dr cell → OUT + amount' },
    { name: 'CR_COLUMN(x)', desc: 'Import: Cr cell → IN + amount' },
];

export function presetById(id) {
    return FORMULA_PRESETS.find((p) => p.id === id) || null;
}

export function detectPreset(expr, direction, fieldKey = '') {
    if (!expr) return 'default';
    const key = direction === 'import' ? 'importExpr' : 'exportExpr';
    const def = fieldKey
        ? (direction === 'import' ? getDefaultImportExpr(fieldKey) : getDefaultExportExpr(fieldKey))
        : '';
    if (def && expr === def) return 'default';
    const hit = FORMULA_PRESETS.find((p) => p.id !== 'default' && p[key] === expr);
    return hit?.id || 'custom';
}
