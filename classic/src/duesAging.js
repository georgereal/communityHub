/**
 * Dues aging report and payment reminders
 */
import ExcelJS from 'exceljs';
import { portalState, supabase } from './store.js';
import {
    clearResidentsCache,
    getBillToForInvoice,
    getResidents,
    loadResidents,
} from './residents.js';
import { invoiceMatchesBlock, getSelectedBlock } from './blockFilter.js';
import { logActivity } from './activityAudit.js';
import {
    downloadReminderPdf,
    emailReminderPdf,
    getInvoiceDisplayLabelForPdf,
} from './invoicePdf.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

export const invoiceBalance = (inv) =>
    Math.max(0, parseFloat(inv.amount || 0) - parseFloat(inv.amount_paid || 0));

const todayIso = () => new Date().toISOString().slice(0, 10);

export const daysOverdue = (inv, asOf = todayIso()) => {
    if (!inv.due_date) return 0;
    if (inv.due_date >= asOf) return 0;
    return Math.floor(
        (new Date(`${asOf}T12:00:00`) - new Date(`${inv.due_date}T12:00:00`)) / 86400000,
    );
};

export const getAgingBucket = (inv, asOf = todayIso()) => {
    if (invoiceBalance(inv) <= 0.001) return null;
    const days = daysOverdue(inv, asOf);
    if (days <= 0) return 'current';
    if (days <= 30) return '1-30';
    if (days <= 60) return '31-60';
    if (days <= 90) return '61-90';
    return '90+';
};

const BUCKET_LABELS = {
    current: 'Current',
    '1-30': '1–30 days',
    '31-60': '31–60 days',
    '61-90': '61–90 days',
    '90+': '90+ days',
};

export const getLastReminder = (invoiceId) => {
    const logs = (portalState.finances.maintenanceReminderLog || [])
        .filter((l) => l.invoice_id === invoiceId)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return logs[0] || null;
};

export const getAgingRows = (asOf = todayIso()) => {
    const residents = getResidents();
    return (portalState.finances.maintenanceInvoices || [])
        .filter((inv) => invoiceBalance(inv) > 0.001)
        .filter((inv) => invoiceMatchesBlock(inv))
        .map((inv) => {
            const bucket = getAgingBucket(inv, asOf);
            const billTo = getBillToForInvoice(inv, residents);
            const lastRem = getLastReminder(inv.id);
            return {
                inv,
                bucket,
                bucketLabel: BUCKET_LABELS[bucket] || bucket,
                balance: invoiceBalance(inv),
                daysOverdue: daysOverdue(inv, asOf),
                billTo,
                lastReminder: lastRem,
                displayLabel: getInvoiceDisplayLabelForPdf(inv),
            };
        })
        .filter((r) => r.bucket && r.bucket !== 'current')
        .sort((a, b) => b.daysOverdue - a.daysOverdue || a.displayLabel.localeCompare(b.displayLabel));
};

export const getAgingSummary = (asOf = todayIso()) => {
    const summary = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    (portalState.finances.maintenanceInvoices || [])
        .filter((inv) => invoiceBalance(inv) > 0.001)
        .filter((inv) => invoiceMatchesBlock(inv))
        .forEach((inv) => {
            const bucket = getAgingBucket(inv, asOf);
            if (bucket) summary[bucket] = (summary[bucket] || 0) + invoiceBalance(inv);
        });
    return summary;
};

export async function logReminderSend({
    invoiceId,
    channel,
    reminderType = 'OVERDUE',
    daysOverdue: daysOd,
    sentToEmail,
}) {
    if (!supabase) return;
    const apartment_id = portalState.access?.activeApartmentId;
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('maintenance_reminder_log').insert({
        id: crypto.randomUUID(),
        apartment_id,
        invoice_id: invoiceId,
        channel,
        reminder_type: reminderType,
        days_overdue: daysOd,
        sent_to_email: sentToEmail || null,
        sent_by: user?.id || null,
    });
}

const reminderSentToday = (invoiceId) => {
    const last = getLastReminder(invoiceId);
    if (!last?.created_at) return false;
    const d = new Date(last.created_at).toISOString().slice(0, 10);
    return d === todayIso();
};

export const sendReminderForInvoice = async (invoiceId, { force = false } = {}) => {
    if (!force && reminderSentToday(invoiceId)) {
        if (!confirm('A reminder was already sent today for this invoice. Send again?')) {
            return { skipped: true };
        }
    }
    await loadResidents(true);
    const result = await emailReminderPdf(invoiceId);
    if (result.method === 'cancelled') return { cancelled: true };

    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === invoiceId);
    const billTo = getBillToForInvoice(inv, getResidents());
    const channel = result.method === 'share' ? 'EMAIL' : (result.method === 'mailto' ? 'EMAIL' : 'PDF');
    await logReminderSend({
        invoiceId,
        channel,
        daysOverdue: daysOverdue(inv),
        sentToEmail: billTo.email,
    });
    await logActivity({
        entityType: 'REMINDER',
        entityId: invoiceId,
        action: channel === 'PDF' ? 'SEND_PDF' : 'SEND_EMAIL',
        summary: `Reminder sent for invoice ${inv?.period_label || invoiceId}`,
        newData: { sent_to: billTo.email, channel },
    });
    const { pullState } = await import('./store.js');
    await pullState();
    return result;
};

export const renderAgingPage = async () => {
    await loadResidents(true);

    const summary = getAgingSummary();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('aging-sum-current', formatMoney(summary.current));
    set('aging-sum-30', formatMoney(summary['1-30']));
    set('aging-sum-60', formatMoney(summary['31-60']));
    set('aging-sum-90', formatMoney(summary['61-90']));
    set('aging-sum-90plus', formatMoney(summary['90+']));

    const blockNote = document.getElementById('aging-block-note');
    if (blockNote) {
        const b = getSelectedBlock();
        blockNote.textContent = b ? `Filtered to block ${b}` : '';
        blockNote.hidden = !b;
    }

    const list = document.getElementById('aging-reminder-list');
    if (!list) return;

    const rows = getAgingRows();
    if (!rows.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No overdue invoices in the selected aging buckets.</p>';
        return;
    }

    list.innerHTML = rows.map((r) => {
        const last = r.lastReminder
            ? new Date(r.lastReminder.created_at).toLocaleDateString('en-GB')
            : 'Never';
        const email = r.billTo.email
            || '<span style="color:var(--danger);">No email</span>';
        return `<label class="bulk-head-check aging-reminder-row">
          <input type="checkbox" class="aging-reminder-checkbox" value="${r.inv.id}" />
          <span class="bulk-head-check__body">
            <strong>${r.displayLabel} · ${r.inv.period_label}</strong>
            <span>${r.bucketLabel} · ${formatMoney(r.balance)} due · ${email} · Last reminder: ${last}</span>
          </span>
          <span class="aging-row-actions">
            <button type="button" class="btn btn-outline btn--small aging-pdf-btn" data-id="${r.inv.id}">PDF</button>
            <button type="button" class="btn btn-outline btn--small aging-send-btn" data-id="${r.inv.id}">Send</button>
          </span>
        </label>`;
    }).join('');

    list.querySelectorAll('.aging-pdf-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await downloadReminderPdf(btn.dataset.id);
            } catch (err) {
                alert(err?.message || 'Could not generate PDF.');
            }
        });
    });
    list.querySelectorAll('.aging-send-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await sendReminderForInvoice(btn.dataset.id);
                renderAgingPage();
            } catch (err) {
                alert(err?.message || 'Could not send reminder.');
            }
        });
    });
};

export const exportAgingExcel = async () => {
    const rows = getAgingRows();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Aging');
    ws.addRow(['Flat / group', 'Period', 'Due date', 'Balance', 'Bucket', 'Days overdue', 'Email', 'Last reminder']);
    rows.forEach((r) => {
        ws.addRow([
            r.displayLabel,
            r.inv.period_label,
            r.inv.due_date || '',
            r.balance,
            r.bucketLabel,
            r.daysOverdue,
            r.billTo.email || '',
            r.lastReminder?.created_at || '',
        ]);
    });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Dues_Aging_${todayIso()}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
};

export const initDuesAgingUi = () => {
    document.getElementById('aging-export-btn')?.addEventListener('click', () => {
        exportAgingExcel().catch((err) => alert(err?.message || 'Export failed.'));
    });
    document.getElementById('aging-bulk-send-btn')?.addEventListener('click', async () => {
        const ids = [...document.querySelectorAll('.aging-reminder-checkbox:checked')].map((el) => el.value);
        if (!ids.length) return alert('Select at least one invoice.');
        if (!confirm(`Send ${ids.length} reminder(s)?`)) return;
        for (const id of ids) {
            try {
                await sendReminderForInvoice(id);
            } catch (err) {
                alert(err?.message || `Failed for invoice ${id}`);
            }
        }
        renderAgingPage();
    });
    document.getElementById('aging-select-all')?.addEventListener('click', () => {
        document.querySelectorAll('.aging-reminder-checkbox').forEach((el) => { el.checked = true; });
    });
};
