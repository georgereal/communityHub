/**
 * Bulk apply maintenance collections from bank or NoBroker statement exports.
 */
import ExcelJS from 'exceljs';
import { portalState, supabase, pullState } from './store.js';
import {
    getUnitByNumber,
    getOpenInvoicesForUnit,
    invoiceBalance,
    recordMaintenanceCollectionPayment,
} from './maintenanceBilling.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const parseDate = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
        const [a, b, c] = parts.map((x) => parseInt(x, 10));
        if (c > 1000) return `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
        if (a > 1000) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`;
    }
    return null;
};

const parseAmount = (val) => {
    if (val == null || val === '') return 0;
    const n = parseFloat(String(val).replace(/[,₹]/g, ''));
    return Number.isFinite(n) ? Math.abs(n) : 0;
};

const unitNumbersSorted = () =>
    portalState.units
        .filter((u) => u.is_community !== true)
        .map((u) => String(u.number || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

export const matchFlatFromText = (text) => {
    const hay = String(text || '').toUpperCase().replace(/\s+/g, ' ');
    if (!hay) return null;
    for (const num of unitNumbersSorted()) {
        const needle = num.toUpperCase();
        const re = new RegExp(`(?:^|[^A-Z0-9])${needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:[^A-Z0-9]|$)`);
        if (re.test(hay) || hay.includes(needle)) return num;
    }
    return null;
};

const existingBankReferences = () => {
    const refs = new Set();
    (portalState.finances.txns || []).forEach((t) => {
        const r = (t.bank_reference || '').trim().toLowerCase();
        if (r) refs.add(r);
    });
    return refs;
};

const readSheetHeaders = async (file) => {
    const wb = new ExcelJS.Workbook();
    const buf = await file.arrayBuffer();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('No worksheet found in file.');

    const headerRow = ws.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col] = String(cell.value || '').trim().toLowerCase();
    });

    const col = (names) => {
        const idx = headers.findIndex((h) => names.some((n) => h.includes(n)));
        return idx >= 0 ? idx + 1 : null;
    };

    return { ws, col };
};

export async function parseBankCollectionLines(file) {
    const { ws, col } = await readSheetHeaders(file);
    const dateCol = col(['date']);
    const descCol = col(['description', 'narration', 'particular', 'remark']);
    const creditCol = col(['credit', 'deposit']);
    const debitCol = col(['debit', 'withdraw']);
    const refCol = col(['reference', 'utr', 'ref', 'transaction']);

    if (!dateCol) throw new Error('Could not find Date column.');

    const lines = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const lineDate = parseDate(row.getCell(dateCol).value);
        if (!lineDate) return;
        const credit = creditCol ? parseAmount(row.getCell(creditCol).value) : 0;
        if (credit <= 0.001) return;
        const description = descCol ? String(row.getCell(descCol).value || '').trim() : '';
        const reference = refCol ? String(row.getCell(refCol).value || '').trim() : '';
        lines.push({ date: lineDate, amount: credit, description, reference, source: 'bank' });
    });

    if (!lines.length) throw new Error('No credit (deposit) rows found in the statement.');
    return lines;
}

export async function parseNoBrokerCollectionLines(file) {
    const { ws, col } = await readSheetHeaders(file);
    const dateCol = col(['date', 'payment', 'paid']);
    const amountCol = col(['amount', 'rent', 'received', 'credit']);
    const flatCol = col(['flat', 'unit', 'property', 'apartment', 'house']);
    const tenantCol = col(['tenant', 'name', 'resident']);
    const descCol = col(['description', 'narration', 'remark', 'note']);
    const refCol = col(['reference', 'utr', 'transaction', 'id']);

    if (!dateCol || !amountCol) {
        throw new Error('Could not find Date and Amount columns. Export from NoBroker with payment date and amount.');
    }

    const lines = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const lineDate = parseDate(row.getCell(dateCol).value);
        const amount = parseAmount(row.getCell(amountCol).value);
        if (!lineDate || amount <= 0.001) return;
        const flatHint = flatCol ? String(row.getCell(flatCol).value || '').trim() : '';
        const tenant = tenantCol ? String(row.getCell(tenantCol).value || '').trim() : '';
        const description = [
            flatHint,
            tenant,
            descCol ? String(row.getCell(descCol).value || '').trim() : '',
        ].filter(Boolean).join(' · ');
        const reference = refCol ? String(row.getCell(refCol).value || '').trim() : '';
        lines.push({ date: lineDate, amount, description, reference, flatHint, source: 'nobroker' });
    });

    if (!lines.length) throw new Error('No payment rows found in the file.');
    return lines;
};

export const buildAllocationPlan = (unitId, amount) => {
    const open = getOpenInvoicesForUnit(unitId);
    let remaining = amount;
    const rows = [];
    const labels = [];
    open.forEach((inv) => {
        if (remaining <= 0.001) return;
        const bal = invoiceBalance(inv);
        const apply = Math.min(remaining, bal);
        if (apply <= 0) return;
        rows.push({ invoice_id: inv.id, amount: apply });
        labels.push(`${inv.period_label} ${formatMoney(apply)}`);
        remaining -= apply;
    });
    return { rows, labels, unallocated: Math.max(0, remaining) };
};

export const enrichCollectionLines = (lines) => {
    const refs = existingBankReferences();
    return lines.map((line, index) => {
        const flat = line.flatHint || matchFlatFromText(line.description);
        const unit = flat ? getUnitByNumber(flat) : null;
        const dupRef = line.reference && refs.has(line.reference.toLowerCase());
        let status = 'ready';
        let statusNote = '';
        let plan = { rows: [], labels: [], unallocated: line.amount };

        if (dupRef) {
            status = 'duplicate';
            statusNote = 'Reference already recorded';
        } else if (!unit) {
            status = 'no_flat';
            statusNote = 'Could not match flat — pick manually';
        } else {
            plan = buildAllocationPlan(unit.id, line.amount);
            if (!plan.rows.length) {
                status = 'no_invoices';
                statusNote = 'No open invoices — will save as advance';
            } else if (plan.unallocated > 0.001) {
                statusNote = `${formatMoney(plan.unallocated)} unallocated`;
            }
        }

        return {
            ...line,
            id: `bulk-col-${index}`,
            flat: flat || '',
            unitId: unit?.id || null,
            status,
            statusNote,
            plan,
            include: status === 'ready' || status === 'no_invoices',
        };
    });
};

let previewRows = [];

const flatOptionsHtml = (selected) => {
    const opts = portalState.units
        .filter((u) => u.is_community !== true)
        .map((u) => `<option value="${u.number}"${u.number === selected ? ' selected' : ''}>${u.number}</option>`)
        .join('');
    return `<option value="">— Select flat —</option>${opts}`;
};

export const renderBulkCollectionPreview = () => {
    const el = document.getElementById('bulk-collection-preview');
    if (!el) return;

    if (!previewRows.length) {
        el.innerHTML = '<p class="maintenance-alloc-hint">Upload a bank or NoBroker statement to preview collections.</p>';
        return;
    }

    el.innerHTML = `
      <div class="bulk-collection-summary">
        <span><strong>${previewRows.filter((r) => r.include).length}</strong> selected</span>
        <span>${formatMoney(previewRows.filter((r) => r.include).reduce((s, r) => s + r.amount, 0))} total</span>
      </div>
      <div class="bulk-collection-table-wrap">
        <table class="bulk-collection-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="bulk-collection-select-all" checked /></th>
              <th>Date</th>
              <th>Amount</th>
              <th>Flat</th>
              <th>Apply to</th>
              <th>Reference</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${previewRows.map((row) => `
              <tr class="bulk-collection-row bulk-collection-row--${row.status}" data-id="${row.id}">
                <td><input type="checkbox" class="bulk-collection-include" data-id="${row.id}" ${row.include ? 'checked' : ''} ${row.status === 'duplicate' ? 'disabled' : ''} /></td>
                <td>${row.date}</td>
                <td>${formatMoney(row.amount)}</td>
                <td>
                  <select class="bulk-collection-flat expense-combobox" data-id="${row.id}">
                    ${flatOptionsHtml(row.flat)}
                  </select>
                </td>
                <td class="bulk-collection-apply">${row.plan.labels.length ? row.plan.labels.join('; ') : (row.statusNote || '—')}</td>
                <td>${row.reference || '—'}</td>
                <td><span class="bulk-collection-status bulk-collection-status--${row.status}">${row.statusNote || row.status}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    document.getElementById('bulk-collection-select-all')?.addEventListener('change', (e) => {
        const on = e.target.checked;
        previewRows.forEach((r) => {
            if (r.status !== 'duplicate') r.include = on;
        });
        el.querySelectorAll('.bulk-collection-include:not(:disabled)').forEach((cb) => { cb.checked = on; });
    });

    el.querySelectorAll('.bulk-collection-include').forEach((cb) => {
        cb.addEventListener('change', () => {
            const row = previewRows.find((r) => r.id === cb.dataset.id);
            if (row) row.include = cb.checked;
        });
    });

    el.querySelectorAll('.bulk-collection-flat').forEach((sel) => {
        sel.addEventListener('change', () => {
            const row = previewRows.find((r) => r.id === sel.dataset.id);
            if (!row) return;
            row.flat = sel.value;
            const unit = getUnitByNumber(sel.value);
            row.unitId = unit?.id || null;
            if (unit) {
                row.plan = buildAllocationPlan(unit.id, row.amount);
                row.status = row.plan.rows.length ? 'ready' : 'no_invoices';
                row.statusNote = row.plan.rows.length
                    ? (row.plan.unallocated > 0.001 ? `${formatMoney(row.plan.unallocated)} unallocated` : '')
                    : 'No open invoices — will save as advance';
                row.include = row.status !== 'duplicate';
            } else {
                row.status = 'no_flat';
                row.statusNote = 'Select a flat';
                row.plan = { rows: [], labels: [], unallocated: row.amount };
            }
            const tr = el.querySelector(`tr[data-id="${row.id}"]`);
            tr?.querySelector('.bulk-collection-apply')?.replaceChildren(
                document.createTextNode(row.plan.labels.length ? row.plan.labels.join('; ') : (row.statusNote || '—')),
            );
            const statusEl = tr?.querySelector('.bulk-collection-status');
            if (statusEl) {
                statusEl.textContent = row.statusNote || row.status;
                statusEl.className = `bulk-collection-status bulk-collection-status--${row.status}`;
            }
        });
    });
};

export const openBulkCollectionModal = () => {
    previewRows = [];
    const formatEl = document.getElementById('bulk-collection-format');
    const fileEl = document.getElementById('bulk-collection-file');
    if (formatEl) formatEl.value = 'bank';
    if (fileEl) fileEl.value = '';
    renderBulkCollectionPreview();
    document.getElementById('bulk-collection-modal')?.classList.add('active');
};

export const closeBulkCollectionModal = () => {
    document.getElementById('bulk-collection-modal')?.classList.remove('active');
};

export async function applyBulkCollections() {
    const selected = previewRows.filter((r) => r.include && r.unitId && r.status !== 'duplicate');
    if (!selected.length) throw new Error('Select at least one row with a matched flat.');

    let applied = 0;
    let skipped = 0;
    const errors = [];

    for (const row of selected) {
        try {
            await recordMaintenanceCollectionPayment({
                unitNumber: row.flat,
                amount: row.amount,
                date: row.date,
                description: row.description || `Statement import — ${row.flat}`,
                wallet: 'BANK',
                bankReference: row.reference || null,
                bankPaymentType: row.source === 'nobroker' ? 'UPI' : 'NEFT',
                allocations: row.plan.rows,
            });
            applied += 1;
        } catch (err) {
            skipped += 1;
            errors.push(`${row.flat || row.date}: ${err?.message || 'Failed'}`);
        }
    }

    await pullState();
    closeBulkCollectionModal();
    if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();

    const msg = [`Applied ${applied} collection(s).`];
    if (skipped) msg.push(`${skipped} failed.`);
    if (errors.length) msg.push(errors.slice(0, 5).join('\n'));
    alert(msg.join('\n'));
}

export const initBulkCollectionImport = () => {
    document.getElementById('bulk-collection-open-btn')?.addEventListener('click', openBulkCollectionModal);
    document.querySelectorAll('#bulk-collection-close-btn, #bulk-collection-close-btn-footer').forEach((btn) => {
        btn.addEventListener('click', closeBulkCollectionModal);
    });
    document.getElementById('bulk-collection-apply-btn')?.addEventListener('click', () => {
        applyBulkCollections().catch((err) => alert(err?.message || 'Bulk apply failed.'));
    });
    document.getElementById('bulk-collection-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const format = document.getElementById('bulk-collection-format')?.value || 'bank';
        try {
            const lines = format === 'nobroker'
                ? await parseNoBrokerCollectionLines(file)
                : await parseBankCollectionLines(file);
            previewRows = enrichCollectionLines(lines);
            renderBulkCollectionPreview();
        } catch (err) {
            alert(err?.message || 'Could not parse file.');
            previewRows = [];
            renderBulkCollectionPreview();
        }
    });
    document.getElementById('bulk-collection-format')?.addEventListener('change', () => {
        previewRows = [];
        const fileEl = document.getElementById('bulk-collection-file');
        if (fileEl) fileEl.value = '';
        renderBulkCollectionPreview();
    });
};

window.openBulkCollectionModal = openBulkCollectionModal;
