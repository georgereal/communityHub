/** Finance-New clone (billingBatches.js) */
import { fnFinances, fnLedger, ensureFnClassicShape } from './classicState.js';
import { bindFinanceNewWindow } from './windowBridge.js';
/**
 * Billing batch history — list runs and detail modal
 */
import { portalState } from '../store.js';
import { downloadInvoicePdfsZip } from '../invoicePdf.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const getUnitLabel = (unitId) =>
    portalState.units.find((u) => u.id === unitId)?.number || '—';

const getInvoiceDisplayLabel = (inv) => {
    if (inv.billing_group_id) {
        const group = fnFinances().maintenanceBillingGroups?.find((g) => g.id === inv.billing_group_id);
        const memberIds = (fnFinances().maintenanceBillingGroupUnits || [])
            .filter((m) => m.group_id === inv.billing_group_id)
            .map((m) => m.unit_id);
        const flats = portalState.units
            .filter((u) => memberIds.includes(u.id))
            .map((u) => u.number)
            .join(', ');
        return group ? `${group.name}${flats ? ` (${flats})` : ''}` : flats || 'Combined';
    }
    return getUnitLabel(inv.unit_id);
};

const invoiceBalance = (inv) =>
    Math.max(0, parseFloat(inv.amount || 0) - parseFloat(inv.amount_paid || 0));

const statusBadge = (inv) => {
    const bal = invoiceBalance(inv);
    const paid = parseFloat(inv.amount_paid || 0);
    let status = 'OPEN';
    if (bal <= 0.001) status = 'PAID';
    else if (paid > 0.001) status = 'PARTIAL';
    const cls = { OPEN: 'dues-open', PARTIAL: 'dues-partial', PAID: 'dues-paid' }[status];
    return `<span class="maintenance-dues-badge ${cls}">${status}</span>`;
};

export const getBatches = () =>
    [...(fnFinances().maintenanceBillingBatches || [])]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

export const getBatchInvoices = (batchId) =>
    (fnFinances().maintenanceInvoices || []).filter((inv) => inv.batch_id === batchId);

export const getBatchSkips = (batchId) =>
    (fnFinances().maintenanceBillingBatchSkips || []).filter((s) => s.batch_id === batchId);

export const batchTotalAmount = (batchId) => {
    const batch = getBatches().find((b) => b.id === batchId);
    if (batch?.total_amount != null) return parseFloat(batch.total_amount);
    return getBatchInvoices(batchId).reduce((s, inv) => s + parseFloat(inv.amount || 0), 0);
};

export const renderBillingRunsList = () => {
    const list = document.getElementById('fn-billing-runs-list');
    if (!list) return;

    const batches = getBatches();
    list.innerHTML = '';

    if (!batches.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No billing runs yet. Raise invoices to create a batch.</p>';
        return;
    }

    batches.forEach((batch) => {
        const invoices = getBatchInvoices(batch.id);
        const total = batch.total_amount != null
            ? parseFloat(batch.total_amount)
            : invoices.reduce((s, inv) => s + parseFloat(inv.amount || 0), 0);
        const created = batch.created_at
            ? new Date(batch.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '—';
        const row = document.createElement('div');
        row.className = 'apt-row maintenance-dues-row billing-run-row';
        row.innerHTML = `
          <div><strong>${batch.period_label}</strong></div>
          <div>${batch.due_date ? new Date(`${batch.due_date}T12:00:00`).toLocaleDateString('en-GB') : '—'}</div>
          <div style="font-size:0.78rem; color:var(--text-dim);">${created}</div>
          <div style="text-align:right;">${invoices.length}</div>
          <div style="text-align:right;">${formatMoney(total)}</div>
          <div style="text-align:center;">${batch.skipped_count || 0}</div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline btn--small" data-batch-id="${batch.id}">View</button>
          </div>`;
        row.querySelector('button')?.addEventListener('click', () => openBatchDetailModal(batch.id));
        list.appendChild(row);
    });
};

export const openBatchDetailModal = (batchId) => {
    const batch = getBatches().find((b) => b.id === batchId);
    if (!batch) return;

    const invoices = getBatchInvoices(batchId);
    const skips = getBatchSkips(batchId);
    const total = batchTotalAmount(batchId);

    document.getElementById('batch-detail-title').textContent = `Billing run — ${batch.period_label}`;
    document.getElementById('batch-detail-subtitle').textContent =
        `${invoices.length} invoice(s) · ${formatMoney(total)} · ${skips.length} skipped`;

    const invTable = document.getElementById('batch-detail-invoices');
    if (invTable) {
        invTable.innerHTML = invoices.length
            ? `<table class="invoice-lines-table">
              <thead><tr><th>Flat / group</th><th>Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>${invoices.map((inv) => `<tr>
                <td>${getInvoiceDisplayLabel(inv)}</td>
                <td>${formatMoney(inv.amount)}</td>
                <td>${statusBadge(inv)}</td>
                <td><button type="button" class="btn btn-outline btn--small" data-inv="${inv.id}">View</button></td>
              </tr>`).join('')}</tbody>
            </table>`
            : '<p class="maintenance-alloc-hint">No invoices linked to this batch.</p>';

        invTable.querySelectorAll('[data-inv]').forEach((btn) => {
            btn.addEventListener('click', () => {
                window.viewInvoiceDetail?.(btn.dataset.inv);
            });
        });
    }

    const skipList = document.getElementById('batch-detail-skips');
    if (skipList) {
        skipList.innerHTML = skips.length
            ? `<ul class="batch-skip-list">${skips.map((s) =>
                `<li><strong>${getUnitLabel(s.unit_id)}</strong> — ${s.reason}</li>`,
            ).join('')}</ul>`
            : '<p class="maintenance-alloc-hint">No flats were skipped in this run.</p>';
    }

    const zipBtn = document.getElementById('batch-detail-download-zip');
    if (zipBtn) {
        zipBtn.onclick = async () => {
            const ids = invoices.map((i) => i.id);
            if (!ids.length) return alert('No invoices in this batch.');
            try {
                await downloadInvoicePdfsZip(ids);
            } catch (err) {
                alert(err?.message || 'Download failed.');
            }
        };
    }

    const sendBtn = document.getElementById('batch-detail-send');
    if (sendBtn) {
        sendBtn.onclick = () => {
            window.closeBatchDetailModal?.();
            window.openSendInvoicesModal?.();
        };
    }

    document.getElementById('batch-detail-modal')?.classList.add('active');
    document.getElementById('batch-detail-modal').dataset.batchId = batchId;
};

export const closeBatchDetailModal = () => {
    document.getElementById('batch-detail-modal')?.classList.remove('active');
};

bindFinanceNewWindow('closeBatchDetailModal', closeBatchDetailModal);

export const initBillingBatchesUi = () => {
    document.getElementById('batch-detail-close')?.addEventListener('click', closeBatchDetailModal);
    document.getElementById('batch-detail-cancel')?.addEventListener('click', closeBatchDetailModal);
    document.getElementById('batch-detail-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'batch-detail-modal') closeBatchDetailModal();
    });
};
