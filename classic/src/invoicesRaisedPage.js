/**
 * Accounts subview: NoBroker invoices raised — dump browser + upload.
 * Core columns always on; extra charge / meta columns optional via toggles.
 */
import {
    parseNoBrokerInvoicesRaisedFile,
    applyNoBrokerInvoicesRaisedImport,
    getNoBrokerInvoicesRaised,
} from './nobrokerInvoicesRaised.js';
import { withButtonBusy } from './buttonBusy.js';

const STORAGE_KEY = 'fa-raised-optional-cols';

const CORE_COLS = [
    { key: 'billing_month', label: 'Month' },
    { key: 'unit_number', label: 'Unit' },
    { key: 'invoice_number', label: 'Invoice #' },
    { key: 'total_raised', label: 'Total raised', numeric: true },
];

const OPTIONAL_META = [
    { key: 'resident_name', label: 'Resident' },
    { key: 'occupancy_status', label: 'Occupancy' },
    { key: 'start_period_date', label: 'Start period' },
    { key: 'end_period_date', label: 'End period' },
    { key: 'invoice_date', label: 'Invoice date' },
    { key: 'due_date', label: 'Due date' },
    { key: 'source_file', label: 'Source file' },
];

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const monthLabel = (iso) => {
    if (!iso) return '—';
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 7);
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
};

const loadOptionalKeys = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return new Set([
                'charge:Maintenance charges',
                'charge:Common water consumption charges',
                'charge:Water Meter Rent',
                'charge:Car Parking',
                'charge:Home water consumption charges',
            ]);
        }
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set(['Maintenance charges']);
    }
};

const saveOptionalKeys = (set) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch { /* ignore */ }
};

let optionalKeys = loadOptionalKeys();
/** @type {Record<string, string>} per-column filter expressions */
let columnFilters = {};
let wired = false;

const ACCOUNT_NAME_KEYS = [
    'Account Name', 'Owner Name', 'Tenant Name', 'Resident Name',
    'User Full Name', 'Primary Owner', 'Member Name',
];

const accountNameOf = (row) => {
    if (row.resident_name) return String(row.resident_name);
    const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
    for (const k of ACCOUNT_NAME_KEYS) {
        if (raw[k] != null && String(raw[k]).trim()) return String(raw[k]).trim();
    }
    for (const [k, v] of Object.entries(raw)) {
        if (/account name|owner name|tenant name|resident/i.test(k) && v != null && String(v).trim()) {
            return String(v).trim();
        }
    }
    return '';
};

const chargeAmount = (row, head) => {
    const charges = row.charges && typeof row.charges === 'object' ? row.charges : {};
    return parseFloat(charges[head]) || 0;
};

/** Raw comparable value for a column (number or string). */
const columnRawValue = (row, col) => {
    const key = col.key;
    if (key === 'billing_month') return monthLabel(row.billing_month);
    if (key === 'unit_number') return row.unit_number || '';
    if (key === 'invoice_number') return row.invoice_number || '';
    if (key === 'total_raised') return parseFloat(row.total_raised) || 0;
    if (key === 'resident_name') return accountNameOf(row);
    if (key === 'occupancy_status') return row.occupancy_status || '';
    if (key === 'start_period_date' || key === 'end_period_date' || key === 'invoice_date' || key === 'due_date') {
        return row[key] || '';
    }
    if (key === 'source_file') return row.source_file || '';
    if (key.startsWith('charge:')) return chargeAmount(row, key.slice('charge:'.length));
    if (key.startsWith('raw:')) {
        const field = key.slice('raw:'.length);
        const v = row.raw?.[field];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (v == null || v === '') return col.numeric ? 0 : '';
        const asNum = parseFloat(String(v).replace(/[,₹\s]/g, ''));
        if (col.numeric && Number.isFinite(asNum)) return asNum;
        return String(v);
    }
    return row[key] ?? '';
};

/**
 * Match typed filter against a cell.
 * Numbers: `0`, `=0`, `>1000`, `>=500`, `<100`, `<=50`, `!=0`, `100-500`
 * Text: case-insensitive contains (use `=` for exact).
 */
const matchesColumnFilter = (expr, value, { numeric } = {}) => {
    const raw = String(expr ?? '').trim();
    if (!raw) return true;

    const asNumber = (v) => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        const n = parseFloat(String(v ?? '').replace(/[,₹\s]/g, ''));
        return Number.isFinite(n) ? n : null;
    };

    const range = raw.match(/^(-?\d+(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:\.\d+)?)$/);
    if (range) {
        const lo = parseFloat(range[1]);
        const hi = parseFloat(range[2]);
        const n = asNumber(value);
        if (n == null) return false;
        return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
    }

    const cmp = raw.match(/^(>=|<=|!=|<>|>|<|=)\s*(-?\d+(?:\.\d+)?)$/);
    if (cmp) {
        const op = cmp[1] === '<>' ? '!=' : cmp[1];
        const target = parseFloat(cmp[2]);
        const n = asNumber(value);
        if (n == null) return false;
        if (op === '>=') return n >= target;
        if (op === '<=') return n <= target;
        if (op === '>') return n > target;
        if (op === '<') return n < target;
        if (op === '!=') return n !== target;
        return n === target;
    }

    // Bare number → equals (so "0" finds zeros)
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
        const target = parseFloat(raw);
        const n = asNumber(value);
        if (n == null) return false;
        return Math.abs(n - target) < 0.0005;
    }

    const text = String(value ?? '').toLowerCase();
    const q = raw.toLowerCase();
    if (q.startsWith('=')) return text === q.slice(1).trim();
    if (numeric && asNumber(value) == null && text === '—') {
        // empty amount cells shown as — treat as 0 for text? skip
    }
    return text.includes(q);
};

const filtersActive = () => Object.values(columnFilters).some((v) => String(v || '').trim());

const clearFilters = () => {
    columnFilters = {};
    renderInvoicesRaisedPage();
};

const PREFERRED_HEADS = [
    'Maintenance charges',
    'Common water consumption charges',
    'Water Meter Rent',
    'Car Parking',
    'Home water consumption charges',
    'Non Occupancy Charges',
];

/** Excel headers stored in raw that aren't already shown as mapped/charge cols. */
const allRawFieldKeys = (rows) => {
    const skipNorm = new Set([
        ...CORE_COLS.map((c) => c.label.toLowerCase()),
        'month', 'unit', 'invoice #', 'total raised',
        'bill number', 'invoice no', 'invoice number',
        'start period date', 'end period date', 'bill date', 'invoice date',
        'due date', 'actual due date', 'display due date',
        'resident name', 'occupancy status',
    ]);
    const set = new Set();
    rows.forEach((r) => {
        const raw = r.raw && typeof r.raw === 'object' ? r.raw : {};
        Object.keys(raw).forEach((k) => {
            const n = k.toLowerCase().replace(/[\s_]+/g, ' ').trim();
            if (skipNorm.has(n)) return;
            const charges = r.charges && typeof r.charges === 'object' ? r.charges : {};
            if (Object.prototype.hasOwnProperty.call(charges, k)) return;
            set.add(k);
        });
    });
    return [...set].sort((a, b) => a.localeCompare(b));
};

const allChargeHeads = (rows) => {
    const set = new Set();
    rows.forEach((r) => {
        const charges = r.charges && typeof r.charges === 'object' ? r.charges : {};
        Object.keys(charges).forEach((k) => set.add(k));
    });
    return [
        ...PREFERRED_HEADS.filter((h) => set.has(h)),
        ...[...set].filter((h) => !PREFERRED_HEADS.includes(h)).sort(),
    ];
};

const formatCell = (v) => {
    if (v == null || v === '') return '—';
    if (typeof v === 'number' && Number.isFinite(v)) {
        return Math.abs(v) >= 1 ? formatMoney(v) : String(v);
    }
    return String(v);
};

const cellValue = (row, key) => {
    if (key === 'billing_month') return monthLabel(row.billing_month);
    if (key === 'total_raised') return formatMoney(row.total_raised);
    if (key.startsWith('charge:')) {
        const head = key.slice('charge:'.length);
        const charges = row.charges && typeof row.charges === 'object' ? row.charges : {};
        const amt = parseFloat(charges[head]) || 0;
        return formatMoney(amt);
    }
    if (key.startsWith('raw:')) {
        const field = key.slice('raw:'.length);
        const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
        return formatCell(raw[field]);
    }
    if (key === 'resident_name') {
        return accountNameOf(row) || '—';
    }
    return row[key] || '—';
};

const visibleColumns = (chargeHeads, rawKeys) => {
    const cols = [...CORE_COLS];
    OPTIONAL_META.forEach((c) => {
        if (optionalKeys.has(c.key)) cols.push(c);
    });
    chargeHeads.forEach((head) => {
        if (optionalKeys.has(`charge:${head}`)) {
            cols.push({ key: `charge:${head}`, label: head, numeric: true });
        }
    });
    rawKeys.forEach((field) => {
        const key = `raw:${field}`;
        if (optionalKeys.has(key)) {
            cols.push({ key, label: field });
        }
    });
    return cols;
};

const filteredRows = (rows, cols) => {
    let list = [...rows];
    const active = cols.filter((c) => String(columnFilters[c.key] || '').trim());
    if (active.length) {
        list = list.filter((row) =>
            active.every((c) =>
                matchesColumnFilter(columnFilters[c.key], columnRawValue(row, c), { numeric: Boolean(c.numeric) }),
            ),
        );
    }
    list.sort((a, b) =>
        String(b.billing_month || '').localeCompare(String(a.billing_month || ''))
        || String(a.unit_number || '').localeCompare(String(b.unit_number || ''), undefined, { numeric: true })
        || String(a.invoice_number || '').localeCompare(String(b.invoice_number || '')),
    );
    return list;
};

const renderColumnPicker = (chargeHeads, rawKeys) => {
    const el = document.getElementById('raised-col-picker');
    if (!el) return;

    const metaBits = OPTIONAL_META.map((c) => `
      <label class="raised-col-picker__opt">
        <input type="checkbox" data-raised-col="${esc(c.key)}" ${optionalKeys.has(c.key) ? 'checked' : ''} />
        ${esc(c.label)}
      </label>`).join('');

    const chargeBits = chargeHeads.map((head) => {
        const key = `charge:${head}`;
        return `
      <label class="raised-col-picker__opt">
        <input type="checkbox" data-raised-col="${esc(key)}" ${optionalKeys.has(key) ? 'checked' : ''} />
        ${esc(head)}
      </label>`;
    }).join('');

    const rawBits = rawKeys.map((field) => {
        const key = `raw:${field}`;
        return `
      <label class="raised-col-picker__opt">
        <input type="checkbox" data-raised-col="${esc(key)}" ${optionalKeys.has(key) ? 'checked' : ''} />
        ${esc(field)}
      </label>`;
    }).join('');

    el.innerHTML = `
      <details class="raised-col-picker">
        <summary class="btn btn-outline btn--small">Columns</summary>
        <div class="raised-col-picker__menu">
          <div class="raised-col-picker__group">
            <span class="raised-col-picker__label">Always shown</span>
            <span class="raised-col-picker__hint">Month · Unit · Invoice # · Total raised</span>
          </div>
          <div class="raised-col-picker__group">
            <span class="raised-col-picker__label">Optional details</span>
            ${metaBits}
          </div>
          <div class="raised-col-picker__group">
            <span class="raised-col-picker__label">Charge heads</span>
            ${chargeBits || '<span class="raised-col-picker__hint">No charge columns yet</span>'}
          </div>
          <div class="raised-col-picker__group">
            <span class="raised-col-picker__label">All Excel columns</span>
            ${rawBits || '<span class="raised-col-picker__hint">Re-upload after adding the raw column to see every field</span>'}
          </div>
        </div>
      </details>`;
};

const syncClearFiltersBtn = () => {
    const btn = document.getElementById('raised-clear-filters');
    if (btn) btn.hidden = !filtersActive();
};

const filterPlaceholder = (col) => (col.numeric ? '>1000 / 0' : 'Filter…');

export function renderInvoicesRaisedPage() {
    const rows = getNoBrokerInvoicesRaised();
    const chargeHeads = allChargeHeads(rows);
    const rawKeys = allRawFieldKeys(rows);
    const cols = visibleColumns(chargeHeads, rawKeys);
    const list = filteredRows(rows, cols);

    renderColumnPicker(chargeHeads, rawKeys);
    syncClearFiltersBtn();

    const meta = document.getElementById('raised-page-meta');
    if (meta) {
        const total = list.reduce((s, r) => s + (parseFloat(r.total_raised) || 0), 0);
        if (!rows.length) {
            meta.textContent = 'No data yet — upload a NoBroker invoice export.';
        } else if (filtersActive()) {
            meta.textContent = `Showing ${list.length} of ${rows.length} row(s) · ${formatMoney(total)}`;
        } else {
            meta.textContent = `${list.length} row(s) · ${formatMoney(total)}`;
        }
    }

    const tbody = document.getElementById('raised-table-body');
    const thead = document.getElementById('raised-table-head');
    if (thead) {
        const headerRow = `<tr>${cols.map((c) =>
            `<th class="${c.numeric ? 'fa-num' : ''}">${esc(c.label)}</th>`).join('')}</tr>`;
        const filterRow = `<tr class="raised-filter-row">${cols.map((c) => {
            const active = String(columnFilters[c.key] || '').trim();
            return `<th class="${c.numeric ? 'fa-num' : ''}">
          <input type="search" class="raised-col-filter${active ? ' raised-col-filter--active' : ''}"
            data-raised-col-filter="${esc(c.key)}"
            value="${esc(columnFilters[c.key] || '')}"
            placeholder="${esc(filterPlaceholder(c))}"
            aria-label="Filter ${esc(c.label)}" />
        </th>`;
        }).join('')}</tr>`;
        thead.innerHTML = headerRow + filterRow;
    }
    if (tbody) {
        if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="${Math.max(cols.length, 1)}" class="maintenance-dues-empty">${
                rows.length ? 'No rows match the column filters.' : 'No invoice rows to show.'
            }</td></tr>`;
        } else {
            tbody.innerHTML = list.map((row) => `
        <tr>
          ${cols.map((c) =>
                `<td class="${c.numeric ? 'fa-num' : ''}">${esc(cellValue(row, c.key))}</td>`).join('')}
        </tr>`).join('');
        }
    }
}

async function handleUpload(file) {
    if (!file) return;
    const btn = document.getElementById('raised-page-upload-btn');
    try {
        await withButtonBusy(btn, 'Importing…', async () => {
            const parsed = await parseNoBrokerInvoicesRaisedFile(file);
            const result = await applyNoBrokerInvoicesRaisedImport(parsed);
            (result.chargeHeads || []).forEach((h) => optionalKeys.add(`charge:${h}`));
            optionalKeys.add('resident_name');
            const sampleRaw = getNoBrokerInvoicesRaised()[0]?.raw || {};
            ['Owner Name', 'Tenant Name', 'Unit Number', 'Unit Name', 'Bill Area', 'bill_id', 'Account Name']
                .forEach((k) => {
                    if (sampleRaw[k] != null) optionalKeys.add(`raw:${k}`);
                });
            if (sampleRaw['Account Name'] != null) optionalKeys.add('resident_name');
            saveOptionalKeys(optionalKeys);
            renderInvoicesRaisedPage();
            try {
                const { renderFinanceAnalytics } = await import('./financeAnalytics.js');
                renderFinanceAnalytics();
            } catch { /* reports not mounted */ }
            alert(
                `Imported ${result.importedCount} invoice(s) for ${result.billingMonths.join(', ')}.\n` +
                `Total raised: ${formatMoney(result.totalRaised)}.`,
            );
        });
    } catch (err) {
        alert(err?.message || 'Import failed.');
    }
}

export function initInvoicesRaisedPage() {
    if (wired) {
        renderInvoicesRaisedPage();
        return;
    }
    wired = true;

    document.getElementById('raised-page-upload-btn')?.addEventListener('click', () => {
        document.getElementById('raised-page-file')?.click();
    });
    document.getElementById('raised-page-file')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) void handleUpload(file);
        e.target.value = '';
    });
    document.getElementById('raised-clear-filters')?.addEventListener('click', () => {
        clearFilters();
    });
    document.getElementById('raised-col-picker')?.addEventListener('change', (e) => {
        const input = e.target.closest('[data-raised-col]');
        if (!input) return;
        const key = input.dataset.raisedCol;
        if (input.checked) optionalKeys.add(key);
        else optionalKeys.delete(key);
        saveOptionalKeys(optionalKeys);
        renderInvoicesRaisedPage();
    });

    // Column filter row — preserve focus while typing
    const tableWrap = document.querySelector('#subview-invoices-raised .raised-table-wrap');
    tableWrap?.addEventListener('input', (e) => {
        const input = e.target.closest('[data-raised-col-filter]');
        if (!input) return;
        const key = input.dataset.raisedColFilter;
        columnFilters[key] = input.value;
        const activeEl = document.activeElement;
        const activeKey = activeEl?.dataset?.raisedColFilter;
        const selStart = activeEl?.selectionStart;
        const selEnd = activeEl?.selectionEnd;
        renderInvoicesRaisedPage();
        if (activeKey) {
            const again = document.querySelector(`[data-raised-col-filter="${CSS.escape(activeKey)}"]`);
            if (again) {
                again.focus();
                if (typeof selStart === 'number') {
                    try { again.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
                }
            }
        }
    });

    renderInvoicesRaisedPage();
}
