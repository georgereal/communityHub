/**
 * Maintenance invoice PDF generation + email helpers
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import JSZip from 'jszip';
import { portalState, supabase } from './store.js';
import { calcTypeLabel, getInvoiceLines } from './billingHeads.js';
import { ruleTypeLabel } from './penaltyRules.js';
import { getGroupById, getInvoiceGroupLabel, getUnitIdsForGroup } from './billingGroups.js';
import {
    clearResidentsCache,
    fetchResidentsForApartment,
    getBillToForInvoice,
    loadResidents,
} from './residents.js';

const getUnitLabel = (unitId) =>
    portalState.units.find((u) => u.id === unitId)?.number || '—';

export const getInvoiceDisplayLabelForPdf = (inv) => {
    if (inv?.billing_group_id) {
        return getInvoiceGroupLabel(inv, getUnitLabel) || 'Combined invoice';
    }
    return getUnitLabel(inv?.unit_id);
};

const invoiceBalance = (inv) =>
    Math.max(0, parseFloat(inv.amount || 0) - parseFloat(inv.amount_paid || 0));

const invoiceStatus = (inv) => {
    const bal = invoiceBalance(inv);
    const paid = parseFloat(inv.amount_paid || 0);
    if (bal <= 0.001) return 'PAID';
    if (paid > 0.001) return 'PARTIAL';
    return 'OPEN';
};

const formatInr = (n) => `Rs. ${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
    });
};

const sanitizeFilename = (s) => String(s || 'invoice').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_');

export { clearResidentsCache };

export async function fetchResidentsForBilling() {
    return loadResidents(true);
}

const lineDescription = (line) => {
    if (line.penalty_rule_id || String(line.calc_type || '').startsWith('PENALTY_')) {
        const t = line.calc_type?.replace('PENALTY_', '') || '';
        return `${line.head_name} (Penalty · ${ruleTypeLabel(t)})`;
    }
    return line.head_name;
};

const lineTypeLabel = (line) => {
    if (String(line.calc_type || '').startsWith('PENALTY_')) {
        return `Penalty · ${ruleTypeLabel(line.calc_type.replace('PENALTY_', ''))}`;
    }
    return calcTypeLabel(line.calc_type);
};

export const buildInvoicePdfData = async (invoiceId) => {
    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error('Invoice not found.');

    const residents = await fetchResidentsForBilling();
    const billTo = getBillToForInvoice(inv, residents);
    const lines = getInvoiceLines(invoiceId);
    const isCombined = !!inv.billing_group_id;
    const societyName = portalState.community?.name || 'CommunityHub';
    const bank = portalState.admin?.bankAccount;
    const bal = invoiceBalance(inv);
    const status = invoiceStatus(inv);

    return {
        inv,
        billTo,
        lines,
        isCombined,
        societyName,
        bank,
        balance: bal,
        status,
        displayLabel: getInvoiceDisplayLabelForPdf(inv),
        invoiceNo: `${inv.period_label || 'Invoice'} · ${getInvoiceDisplayLabelForPdf(inv)}`,
    };
};

export const invoicePdfFilename = (inv) => {
    const label = sanitizeFilename(getInvoiceDisplayLabelForPdf(inv));
    const period = sanitizeFilename(inv.period_label || 'invoice');
    return `Invoice_${period}_${label}.pdf`;
};

export async function generateInvoicePdfBlob(invoiceId) {
    const data = await buildInvoicePdfData(invoiceId);
    const { inv, billTo, lines, isCombined, societyName, bank, balance, status } = data;

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 14;
    let y = margin;

    // Header band
    doc.setFillColor(30, 41, 59);
    doc.rect(0, 0, pageW, 32, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text(societyName, margin, 14);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('MAINTENANCE INVOICE', margin, 22);
    doc.setFontSize(9);
    doc.text(`Generated ${formatDate(new Date().toISOString().slice(0, 10))}`, pageW - margin, 14, { align: 'right' });
    doc.text(`Status: ${status}`, pageW - margin, 22, { align: 'right' });

    y = 40;
    doc.setTextColor(30, 41, 59);

    // Meta row
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Invoice for', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.text(data.displayLabel, margin + 28, y);
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.text('Period', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.text(inv.period_label || '—', margin + 28, y);
    doc.setFont('helvetica', 'bold');
    doc.text('Due date', pageW / 2, y);
    doc.setFont('helvetica', 'normal');
    doc.text(formatDate(inv.due_date), pageW / 2 + 22, y);
    y += 10;

    // Bill to box
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(margin, y, pageW - margin * 2, 28, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('BILL TO', margin + 4, y + 6);
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(11);
    doc.text(billTo.name, margin + 4, y + 13);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Flat(s): ${billTo.flats || data.displayLabel}`, margin + 4, y + 19);
    const contactLine = [billTo.phone, billTo.email].filter(Boolean).join(' · ');
    if (contactLine) doc.text(contactLine, margin + 4, y + 24);
    y += 34;

    // Line items
    const head = isCombined
        ? ['Flat', 'Description', 'Type', 'Qty', 'Amount (Rs.)']
        : ['Description', 'Type', 'Qty', 'Amount (Rs.)'];

    const body = lines.map((l) => {
        const qty = l.quantity != null ? String(l.quantity) : '—';
        const amt = formatInr(l.amount).replace('Rs. ', '');
        const flat = l.unit_id ? getUnitLabel(l.unit_id) : '—';
        const desc = lineDescription(l);
        const type = lineTypeLabel(l);
        return isCombined ? [flat, desc, type, qty, amt] : [desc, type, qty, amt];
    });

    autoTable(doc, {
        startY: y,
        head: [head],
        body,
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 2.5, textColor: [30, 41, 59] },
        headStyles: {
            fillColor: [79, 70, 229],
            textColor: 255,
            fontStyle: 'bold',
            fontSize: 8,
        },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: isCombined
            ? { 0: { cellWidth: 18 }, 4: { halign: 'right' } }
            : { 3: { halign: 'right' } },
    });

    y = doc.lastAutoTable.finalY + 8;

    // Totals
    const totalsX = pageW - margin - 55;
    doc.setFontSize(9);
    const addTotalRow = (label, value, bold = false) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.text(label, totalsX, y);
        doc.text(formatInr(value), pageW - margin, y, { align: 'right' });
        y += 6;
    };
    addTotalRow('Invoice total', inv.amount);
    addTotalRow('Amount paid', inv.amount_paid);
    doc.setTextColor(185, 28, 28);
    addTotalRow('Balance due', balance, true);
    doc.setTextColor(30, 41, 59);
    y += 4;

    // Payment instructions
    if (bank?.bank_name) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text('Payment instructions', margin, y);
        y += 5;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        const payLines = [
            bank.bank_name,
            bank.branch ? `Branch: ${bank.branch}` : null,
            bank.account_holder ? `Account: ${bank.account_holder}` : null,
            bank.account_number ? `A/c No: ${bank.account_number}` : null,
            bank.ifsc ? `IFSC: ${bank.ifsc}` : null,
            bank.upi_id ? `UPI: ${bank.upi_id}` : null,
        ].filter(Boolean);
        payLines.forEach((line) => {
            doc.text(line, margin, y);
            y += 4;
        });
        y += 4;
    }

    if (inv.notes?.trim()) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text('Notes', margin, y);
        y += 4;
        doc.setFont('helvetica', 'normal');
        const noteLines = doc.splitTextToSize(inv.notes.trim(), pageW - margin * 2);
        doc.text(noteLines, margin, y);
        y += noteLines.length * 4 + 2;
    }

    // Footer
    const footerY = doc.internal.pageSize.getHeight() - 10;
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text(
        `This is a computer-generated invoice from ${societyName}. Please quote flat number and period when paying.`,
        pageW / 2,
        footerY,
        { align: 'center' },
    );

    return doc.output('blob');
}

export async function downloadInvoicePdf(invoiceId) {
    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error('Invoice not found.');
    const blob = await generateInvoicePdfBlob(invoiceId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = invoicePdfFilename(inv);
    a.click();
    URL.revokeObjectURL(url);
}

const buildEmailBody = (data) => {
    const { inv, billTo, balance, societyName } = data;
    return [
        `Dear ${billTo.name},`,
        '',
        `Please find attached the maintenance invoice for ${billTo.flats || data.displayLabel}.`,
        '',
        `Period: ${inv.period_label}`,
        `Due date: ${formatDate(inv.due_date)}`,
        `Amount due: ${formatInr(balance)}`,
        '',
        'The PDF invoice has been downloaded to your device — please attach it to this email before sending.',
        '',
        'Thank you,',
        societyName,
    ].join('\n');
};

export async function emailInvoicePdf(invoiceId) {
    const data = await buildInvoicePdfData(invoiceId);
    const { inv, billTo } = data;
    const blob = await generateInvoicePdfBlob(invoiceId);
    const filename = invoicePdfFilename(inv);
    const file = new File([blob], filename, { type: 'application/pdf' });
    const subject = encodeURIComponent(`Maintenance Invoice — ${inv.period_label} — ${data.displayLabel}`);
    const body = encodeURIComponent(buildEmailBody(data));

    if (navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({
                title: `Invoice ${inv.period_label}`,
                text: `Maintenance invoice for ${data.displayLabel}`,
                files: [file],
            });
            return { method: 'share' };
        } catch (err) {
            if (err?.name === 'AbortError') return { method: 'cancelled' };
        }
    }

    await downloadInvoicePdf(invoiceId);

    const to = billTo.allEmails.length ? billTo.allEmails.join(',') : '';
    const mailto = `mailto:${to}?subject=${subject}&body=${body}`;
    window.location.href = mailto;
    return { method: 'mailto', email: to };
}

export async function generateReminderPdfBlob(invoiceId) {
    const data = await buildInvoicePdfData(invoiceId);
    const { inv, billTo, societyName, bank, balance } = data;
    const daysOd = Math.max(0, Math.floor(
        (new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00`)
            - new Date(`${inv.due_date || new Date().toISOString().slice(0, 10)}T12:00:00`)) / 86400000,
    ));

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 14;
    let y = margin;

    doc.setFillColor(185, 28, 28);
    doc.rect(0, 0, pageW, 28, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('PAYMENT REMINDER', margin, 14);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(societyName, margin, 22);

    y = 36;
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(11);
    doc.text(`Dear ${billTo.name},`, margin, y);
    y += 8;
    doc.setFontSize(9);
    const lines = [
        `This is a friendly reminder that maintenance dues for ${billTo.flats || data.displayLabel} remain outstanding.`,
        '',
        `Period: ${inv.period_label}`,
        `Due date: ${formatDate(inv.due_date)}`,
        daysOd > 0 ? `Days overdue: ${daysOd}` : 'Status: Due soon',
        `Amount billed: ${formatInr(inv.amount)}`,
        `Amount paid: ${formatInr(inv.amount_paid)}`,
        `Balance due: ${formatInr(balance)}`,
    ];
    lines.forEach((line) => {
        if (line === '') { y += 3; return; }
        doc.text(line, margin, y);
        y += 5;
    });

    y += 4;
    if (bank?.bank_name) {
        doc.setFont('helvetica', 'bold');
        doc.text('Please pay to:', margin, y);
        y += 5;
        doc.setFont('helvetica', 'normal');
        [bank.bank_name, bank.account_number ? `A/c: ${bank.account_number}` : null, bank.ifsc ? `IFSC: ${bank.ifsc}` : null, bank.upi_id ? `UPI: ${bank.upi_id}` : null]
            .filter(Boolean)
            .forEach((line) => { doc.text(line, margin, y); y += 4; });
    }

    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('Thank you for your prompt attention.', margin, y + 6);

    return doc.output('blob');
}

export async function downloadReminderPdf(invoiceId) {
    const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error('Invoice not found.');
    const blob = await generateReminderPdfBlob(invoiceId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Reminder_${sanitizeFilename(inv.period_label)}_${sanitizeFilename(getInvoiceDisplayLabelForPdf(inv))}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
}

export async function emailReminderPdf(invoiceId) {
    const data = await buildInvoicePdfData(invoiceId);
    const { inv, billTo, balance, societyName } = data;
    const blob = await generateReminderPdfBlob(invoiceId);
    const filename = `Reminder_${sanitizeFilename(inv.period_label)}.pdf`;
    const file = new File([blob], filename, { type: 'application/pdf' });
    const subject = encodeURIComponent(`Payment Reminder — ${inv.period_label} — ${data.displayLabel}`);
    const body = encodeURIComponent([
        `Dear ${billTo.name},`,
        '',
        `Please find attached a payment reminder for ${billTo.flats || data.displayLabel}.`,
        `Balance due: ${formatInr(balance)}`,
        '',
        'Thank you,',
        societyName,
    ].join('\n'));

    if (navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ title: 'Payment reminder', files: [file] });
            return { method: 'share' };
        } catch (err) {
            if (err?.name === 'AbortError') return { method: 'cancelled' };
        }
    }

    await downloadReminderPdf(invoiceId);
    const to = billTo.allEmails.length ? billTo.allEmails.join(',') : '';
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
    return { method: 'mailto', email: to };
}

export async function downloadInvoicePdfsZip(invoiceIds) {
    if (!invoiceIds?.length) throw new Error('Select at least one invoice.');
    const zip = new JSZip();
    const folder = zip.folder('invoices');

    for (const id of invoiceIds) {
        const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === id);
        if (!inv) continue;
        const blob = await generateInvoicePdfBlob(id);
        folder.file(invoicePdfFilename(inv), blob);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Maintenance_Invoices_${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);
}

export const openSendInvoicesModal = async () => {
    await fetchResidentsForBilling();
    const modal = document.getElementById('send-invoices-modal');
    if (!modal) return;

    const onlyOpen = document.getElementById('send-invoices-open-only');
    if (onlyOpen) onlyOpen.checked = true;

    await renderSendInvoicesList();
    modal.classList.add('active');
};

export const closeSendInvoicesModal = () => {
    document.getElementById('send-invoices-modal')?.classList.remove('active');
};

const sendableInvoices = () => {
    const onlyOpen = document.getElementById('send-invoices-open-only')?.checked !== false;
    let invoices = [...(portalState.finances.maintenanceInvoices || [])];
    if (onlyOpen) {
        invoices = invoices.filter((inv) => invoiceStatus(inv) !== 'PAID');
    }
    invoices.sort((a, b) => {
        const fa = getInvoiceDisplayLabel(a);
        const fb = getInvoiceDisplayLabel(b);
        if (fa !== fb) return fa.localeCompare(fb, undefined, { numeric: true });
        return (b.due_date || '').localeCompare(a.due_date || '');
    });
    return invoices;
};

export const renderSendInvoicesList = async () => {
    const container = document.getElementById('send-invoices-list');
    if (!container) return;

    const invoices = sendableInvoices();
    if (!invoices.length) {
        container.innerHTML = '<p class="maintenance-alloc-hint">No invoices to send.</p>';
        return;
    }

    const residents = await loadResidents();
    container.innerHTML = invoices.map((inv) => {
        const billTo = getBillToForInvoice(inv, residents);
        const emailHint = billTo.email
            ? billTo.email
            : '<span style="color:var(--danger);">No email on file</span>';
        return `<label class="bulk-head-check send-invoice-row">
          <input type="checkbox" class="send-invoice-checkbox" value="${inv.id}" checked />
          <span class="bulk-head-check__body">
            <strong>${getInvoiceDisplayLabel(inv)} · ${inv.period_label}</strong>
            <span>${formatInr(invoiceBalance(inv))} due · ${billTo.name} · ${emailHint}</span>
          </span>
        </label>`;
    }).join('');
};

const getSelectedSendInvoiceIds = () =>
    [...document.querySelectorAll('.send-invoice-checkbox:checked')].map((el) => el.value);

export const initInvoicePdfUi = () => {
    document.getElementById('send-invoices-open-only')?.addEventListener('change', () => void renderSendInvoicesList());
    document.getElementById('send-invoices-select-all')?.addEventListener('click', () => {
        document.querySelectorAll('.send-invoice-checkbox').forEach((el) => { el.checked = true; });
    });
    document.getElementById('send-invoices-select-none')?.addEventListener('click', () => {
        document.querySelectorAll('.send-invoice-checkbox').forEach((el) => { el.checked = false; });
    });
    document.getElementById('send-invoices-download-zip')?.addEventListener('click', async () => {
        const btn = document.getElementById('send-invoices-download-zip');
        const ids = getSelectedSendInvoiceIds();
        if (!ids.length) return alert('Select at least one invoice.');
        if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
        try {
            await downloadInvoicePdfsZip(ids);
        } catch (err) {
            alert(err?.message || 'Could not generate ZIP.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Download PDFs (ZIP)'; }
        }
    });
    document.getElementById('send-invoices-email-btn')?.addEventListener('click', async () => {
        const ids = getSelectedSendInvoiceIds();
        if (!ids.length) return alert('Select at least one invoice.');
        if (!confirm(`Prepare ${ids.length} invoice email(s)? Each will download a PDF and open your email client (attach the PDF before sending).`)) return;

        for (let i = 0; i < ids.length; i += 1) {
            const id = ids[i];
            const inv = portalState.finances.maintenanceInvoices.find((x) => x.id === id);
            const label = inv ? getInvoiceDisplayLabel(inv) : id;
            if (i > 0 && !confirm(`Continue to email ${i + 1} of ${ids.length}: ${label}?`)) break;
            try {
                const result = await emailInvoicePdf(id);
                if (result.method === 'cancelled') break;
            } catch (err) {
                alert(err?.message || `Could not prepare email for ${label}.`);
            }
        }
    });
    document.getElementById('send-invoices-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'send-invoices-modal') closeSendInvoicesModal();
    });
};

window.openSendInvoicesModal = openSendInvoicesModal;
window.closeSendInvoicesModal = closeSendInvoicesModal;
window.downloadInvoicePdf = downloadInvoicePdf;
window.emailInvoicePdf = emailInvoicePdf;
