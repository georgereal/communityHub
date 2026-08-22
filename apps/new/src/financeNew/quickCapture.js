/**
 * Bills & receipts — mobile-first Quick Capture wizard (full-page steps).
 * Reuses saveFinanceDocument + R2 attachment upload; in-memory draft until Save.
 */
import { portalState } from '../store.js';
import { can } from '../capabilities.js';
import { withButtonBusy } from '../buttonBusy.js';
import { categoryDisplayLabel } from '../expenseCategories.js';
import { buildCategoryOptions, buildSubCategoryOptions } from '../classifyOptions.js';
import { fnFinances } from './classicState.js';
import { filesToBase64Payload, postFnMutation } from './mongoMutations.js';
import { bindFinanceNewWindow } from './windowBridge.js';
import { titleCaseVendor } from '../vendorFormat.js';
import { ensureVendorInDirectory, listDirectoryVendors } from './vendors.js';

const TOTAL_STEPS = 6;

/** Ignore the synthetic history.back() from closeQuickCapture. */
let ignoreNextPop = false;

const INCOME_EXTRA_BY_CAT = {
    Promotion: { vendorRequired: true, vendorLabel: 'Sponsor / vendor' },
    Marketing: { vendorRequired: false, vendorLabel: 'Event / vendor' },
    'Other Income': { vendorRequired: false, vendorLabel: 'Received from' },
};

/** @type {{
 *   step: number,
 *   kind: 'OUT'|'IN'|null,
 *   billFiles: File[],
 *   paymentFiles: File[],
 *   vendor: string,
 *   invoice: string,
 *   particulars: string,
 *   amount: string,
 *   date: string,
 *   cat: string,
 *   sub_category: string,
 *   notes: string,
 *   payMode: 'unpaid'|'cash'|'cheque'|'online',
 *   chequeNo: string,
 *   onlineRef: string,
 *   paidOn: string,
 *   historyPushed: boolean,
 * }} */
const draft = createEmptyDraft();

function createEmptyDraft() {
    return {
        step: 1,
        kind: null,
        billFiles: [],
        paymentFiles: [],
        vendor: '',
        invoice: '',
        particulars: '',
        amount: '',
        date: todayISO(),
        cat: '',
        sub_category: '',
        notes: '',
        payMode: 'unpaid',
        chequeNo: '',
        onlineRef: '',
        paidOn: '',
        historyPushed: false,
    };
}

function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

function resetDraft() {
    Object.assign(draft, createEmptyDraft());
}

function isIncome() {
    return draft.kind === 'IN';
}

function kindLabel() {
    return isIncome() ? 'Receipt' : 'Bill';
}

function canEnter() {
    return can('accounts.bills_enter');
}

function isDirty() {
    return !!(
        draft.kind
        || draft.billFiles.length
        || draft.paymentFiles.length
        || draft.vendor.trim()
        || draft.invoice.trim()
        || draft.particulars.trim()
        || draft.amount
        || draft.chequeNo.trim()
        || draft.onlineRef.trim()
        || draft.payMode !== 'unpaid'
    );
}

function shell() {
    return document.getElementById('fn-quick-capture');
}

function $(id) {
    return document.getElementById(id);
}

function setError(id, msg) {
    const el = $(id);
    if (!el) return;
    if (msg) {
        el.hidden = false;
        el.textContent = msg;
    } else {
        el.hidden = true;
        el.textContent = '';
    }
}

function billPaymentNotes(mode, chequeNo = '', onlineRef = '', paidOn = '') {
    let base = 'Payment: Unpaid';
    if (mode === 'cheque') base = `Cheque: ${chequeNo}`;
    else if (mode === 'online') base = onlineRef ? `Online: ${onlineRef}` : 'Payment: Online';
    else if (mode === 'cash') base = 'Payment: Cash';
    if (mode !== 'unpaid' && paidOn) return `${base}\nPaid on: ${String(paidOn).slice(0, 10)}`;
    return base;
}

function formatMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fileKey(file) {
    return `${file.name}::${file.size}::${file.lastModified}`;
}

function revokeThumbUrls(container) {
    if (!container) return;
    container.querySelectorAll('[data-object-url]').forEach((el) => {
        const url = el.getAttribute('data-object-url');
        if (url) URL.revokeObjectURL(url);
    });
}

function renderThumbs(containerId, files, { purpose, removable = true } = {}) {
    const el = $(containerId);
    if (!el) return;
    revokeThumbUrls(el);
    if (!files.length) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = files.map((file, i) => {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        const url = isPdf ? '' : URL.createObjectURL(file);
        const thumb = isPdf
            ? `<span class="qc-thumb__pdf"><i class="fa-solid fa-file-pdf" aria-hidden="true"></i></span>`
            : `<img class="qc-thumb__img" src="${url}" alt="" data-object-url="${url}" />`;
        const remove = removable
            ? `<button type="button" class="qc-thumb__remove" data-qc-remove="${purpose}" data-qc-index="${i}" aria-label="Remove ${file.name}">&times;</button>`
            : '';
        return `<div class="qc-thumb" title="${escapeAttr(file.name)}">${thumb}${remove}</div>`;
    }).join('');
}

function escapeAttr(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function addFiles(list, purpose) {
    const incoming = Array.from(list || []).filter(Boolean);
    if (!incoming.length) return;
    const target = purpose === 'payment' ? draft.paymentFiles : draft.billFiles;
    const seen = new Set(target.map(fileKey));
    for (const f of incoming) {
        const k = fileKey(f);
        if (seen.has(k)) continue;
        seen.add(k);
        target.push(f);
    }
    refreshFileThumbs();
}

function removeFile(purpose, index) {
    const target = purpose === 'payment' ? draft.paymentFiles : draft.billFiles;
    if (index < 0 || index >= target.length) return;
    target.splice(index, 1);
    refreshFileThumbs();
}

function refreshFileThumbs() {
    renderThumbs('qc-bill-thumbs', draft.billFiles, { purpose: 'bill' });
    renderThumbs('qc-pay-thumbs', draft.paymentFiles, { purpose: 'payment' });
    if (draft.step === 6) {
        renderThumbs('qc-review-thumbs', [...draft.billFiles, ...draft.paymentFiles], {
            purpose: 'bill',
            removable: false,
        });
    }
}

function recentVendors() {
    return listDirectoryVendors().slice(0, 24);
}

function populateVendorUi() {
    const vendors = recentVendors();
    const list = $('qc-vendor-datalist');
    if (list) {
        list.innerHTML = vendors.map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
    }
    const chips = $('qc-vendor-chips');
    if (chips) {
        const top = vendors.slice(0, 8);
        chips.innerHTML = top.length
            ? top.map((v) =>
                `<button type="button" class="qc-chip" data-qc-vendor="${escapeAttr(v)}">${escapeHtml(v)}</button>`,
            ).join('')
            : '';
    }
}

function populateCategories() {
    const sel = $('qc-category');
    if (!sel) return;
    const keys = buildCategoryOptions(isIncome());
    const current = draft.cat || keys[0] || '';
    draft.cat = current;
    sel.innerHTML = keys.map((key) => {
        const label = categoryDisplayLabel(key);
        const selected = key === current ? ' selected' : '';
        return `<option value="${escapeAttr(key)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');
    populateSubcats();
}

function populateSubcats() {
    const list = $('qc-subcat-datalist');
    if (!list) return;
    const suggestions = buildSubCategoryOptions(draft.cat);
    list.innerHTML = suggestions.map((s) => `<option value="${escapeAttr(s)}"></option>`).join('');
}

function syncVendorStepCopy() {
    const heading = $('qc-vendor-heading');
    const hint = $('qc-vendor-hint');
    const label = $('qc-vendor-label');
    const invLabel = $('qc-invoice-label');
    const partLabel = $('qc-particulars-label');
    if (isIncome()) {
        if (heading) heading.textContent = 'From & particulars';
        if (hint) hint.textContent = 'Pick a vendor from the list or type a new one (saved to Vendors). Particulars are required.';
        if (label) label.innerHTML = 'Received from <span class="qc-optional">(optional — type or pick)</span>';
        if (partLabel) partLabel.innerHTML = 'Particulars <abbr title="required">*</abbr>';
        if (invLabel) invLabel.innerHTML = 'Receipt / invoice # <span class="qc-optional">(optional)</span>';
    } else {
        if (heading) heading.textContent = 'Vendor & particulars';
        if (hint) hint.textContent = 'Pick a vendor from the list or type a new one (saved to Vendors). Particulars are required.';
        if (label) label.innerHTML = 'Vendor <span class="qc-optional">(optional — type or pick)</span>';
        if (partLabel) partLabel.innerHTML = 'Particulars <abbr title="required">*</abbr>';
        if (invLabel) invLabel.innerHTML = 'Invoice # <span class="qc-optional">(optional)</span>';
    }
}

function syncPhotoStepCopy() {
    const heading = $('qc-photo-heading');
    if (heading) {
        heading.textContent = isIncome()
            ? 'Add receipt photo or PDF'
            : 'Add bill photo or PDF';
    }
}

function syncPayStepCopy() {
    const heading = $('qc-pay-heading');
    const hint = $('qc-pay-hint');
    if (isIncome()) {
        if (heading) heading.textContent = 'Money received?';
        if (hint) hint.textContent = 'Mark how funds arrived, or leave unpaid for now.';
    } else {
        if (heading) heading.textContent = 'How was this paid?';
        if (hint) hint.textContent = 'Mark payment status, or leave unpaid for now.';
    }
    syncPayModeUi();
}

function syncPayModeUi() {
    const mode = draft.payMode;
    document.querySelectorAll('#qc-pay-pills [data-qc-pay]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.qcPay === mode);
    });
    const chequeWrap = $('qc-cheque-wrap');
    const onlineWrap = $('qc-online-wrap');
    const paidWrap = $('qc-paid-date-wrap');
    if (chequeWrap) chequeWrap.hidden = mode !== 'cheque';
    if (onlineWrap) onlineWrap.hidden = mode !== 'online';
    if (paidWrap) paidWrap.hidden = mode === 'unpaid';
    if (mode !== 'unpaid' && !draft.paidOn) {
        draft.paidOn = todayISO();
        const paidEl = $('qc-paid-date');
        if (paidEl) paidEl.value = draft.paidOn;
    }
}

function syncAmountStepCopy() {
    const dateLabel = $('qc-date-label');
    const catLabel = $('qc-cat-label');
    const subWrap = $('qc-subcat-wrap');
    if (dateLabel) {
        dateLabel.innerHTML = isIncome()
            ? 'Receipt date <abbr title="required">*</abbr>'
            : 'Bill date <abbr title="required">*</abbr>';
    }
    if (catLabel) {
        catLabel.innerHTML = isIncome()
            ? 'Income type <abbr title="required">*</abbr>'
            : 'Category <abbr title="required">*</abbr>';
    }
    if (subWrap) subWrap.hidden = isIncome();
}

function readStepFields(step) {
    if (step === 3) {
        draft.vendor = $('qc-vendor')?.value?.trim() || '';
        draft.invoice = $('qc-invoice')?.value?.trim() || '';
        draft.particulars = $('qc-particulars')?.value?.trim() || '';
    } else if (step === 4) {
        draft.amount = $('qc-amount')?.value?.trim() || '';
        draft.date = $('qc-date')?.value || todayISO();
        draft.cat = $('qc-category')?.value || draft.cat;
        draft.sub_category = $('qc-subcat')?.value?.trim() || '';
    } else if (step === 5) {
        draft.chequeNo = $('qc-cheque')?.value?.trim() || '';
        draft.onlineRef = $('qc-online-ref')?.value?.trim() || '';
        draft.paidOn = $('qc-paid-date')?.value || '';
    }
}

function writeStepFields(step) {
    if (step === 3) {
        const v = $('qc-vendor');
        const inv = $('qc-invoice');
        const part = $('qc-particulars');
        if (v) v.value = draft.vendor;
        if (inv) inv.value = draft.invoice;
        if (part) part.value = draft.particulars;
        populateVendorUi();
        syncVendorStepCopy();
    } else if (step === 4) {
        const amt = $('qc-amount');
        const date = $('qc-date');
        const sub = $('qc-subcat');
        if (amt) amt.value = draft.amount;
        if (date) date.value = draft.date || todayISO();
        if (sub) sub.value = draft.sub_category;
        populateCategories();
        syncAmountStepCopy();
    } else if (step === 5) {
        const cheque = $('qc-cheque');
        const online = $('qc-online-ref');
        const paid = $('qc-paid-date');
        if (cheque) cheque.value = draft.chequeNo;
        if (online) online.value = draft.onlineRef;
        if (paid) paid.value = draft.paidOn || todayISO();
        syncPayStepCopy();
        refreshFileThumbs();
    } else if (step === 2) {
        syncPhotoStepCopy();
        refreshFileThumbs();
    } else if (step === 6) {
        renderReview();
    }
}

function validateStep(step) {
    setError('qc-photo-error', '');
    setError('qc-vendor-error', '');
    setError('qc-amount-error', '');
    setError('qc-pay-error', '');
    setError('qc-review-error', '');

    if (step === 1) {
        if (!draft.kind) return 'Choose bill or receipt.';
        return null;
    }
    if (step === 3) {
        readStepFields(3);
        if (!draft.particulars) return 'Enter the particulars.';
        return null;
    }
    if (step === 4) {
        readStepFields(4);
        const amt = parseFloat(draft.amount);
        if (!Number.isFinite(amt) || amt <= 0) return 'Enter a valid amount.';
        if (!draft.date) return 'Enter the date.';
        if (!draft.cat) return 'Choose a category.';
        if (isIncome()) {
            const extra = INCOME_EXTRA_BY_CAT[draft.cat];
            if (extra?.vendorRequired && !draft.vendor) {
                return `Enter ${extra.vendorLabel.toLowerCase()} on the previous step.`;
            }
        }
        return null;
    }
    if (step === 5) {
        readStepFields(5);
        if (draft.payMode === 'cheque' && !draft.chequeNo) {
            return 'Enter the cheque number, or choose another payment mode.';
        }
        if (draft.payMode !== 'unpaid' && !draft.paidOn) {
            return 'Enter the payment date.';
        }
        return null;
    }
    return null;
}

function paymentSummary() {
    const mode = draft.payMode;
    if (mode === 'unpaid') return 'Unpaid';
    if (mode === 'cash') return `Cash · ${draft.paidOn || '—'}`;
    if (mode === 'cheque') return `Cheque · ${draft.chequeNo || '—'} · ${draft.paidOn || '—'}`;
    if (mode === 'online') {
        const ref = draft.onlineRef ? ` · ${draft.onlineRef}` : '';
        return `Online${ref} · ${draft.paidOn || '—'}`;
    }
    return mode;
}

function renderReview() {
    const list = $('qc-review-list');
    if (!list) return;
    const amt = parseFloat(draft.amount);
    const rows = [
        { step: 1, label: 'Type', value: kindLabel() },
        { step: 3, label: isIncome() ? 'From' : 'Vendor', value: draft.vendor || '—' },
        { step: 3, label: 'Particulars', value: draft.particulars || '—' },
        { step: 3, label: 'Invoice #', value: draft.invoice || '—' },
        { step: 4, label: 'Amount', value: formatMoney(amt) },
        { step: 4, label: 'Date', value: draft.date || '—' },
        { step: 4, label: 'Category', value: categoryDisplayLabel(draft.cat) || draft.cat || '—' },
    ];
    if (!isIncome() && draft.sub_category) {
        rows.push({ step: 4, label: 'Sub-category', value: draft.sub_category });
    }
    rows.push(
        { step: 5, label: 'Payment', value: paymentSummary() },
    );
    list.innerHTML = rows.map((r) => `
      <button type="button" class="qc-review__row" data-qc-goto="${r.step}">
        <span class="qc-review__label">${escapeHtml(r.label)}</span>
        <span class="qc-review__value">${escapeHtml(r.value)}</span>
        <span class="qc-review__edit" aria-hidden="true"><i class="fa-solid fa-pen"></i></span>
      </button>
    `).join('');

    const titleAmt = $('qc-title');
    if (titleAmt) titleAmt.textContent = `${kindLabel()} · ${formatMoney(amt)}`;
    refreshFileThumbs();
}

function updateChrome() {
    const step = draft.step;
    const meta = $('qc-step-meta');
    const title = $('qc-title');
    const bar = $('qc-progress-bar');
    const footer = $('qc-footer');
    const skip = $('qc-skip');
    const cont = $('qc-continue');
    const back = $('qc-back');

    if (meta) {
        const suffix = draft.kind ? ` · ${kindLabel()}` : '';
        meta.textContent = `Step ${step} of ${TOTAL_STEPS}${suffix}`;
    }
    if (title && step !== 6) {
        const titles = {
            1: 'Quick capture',
            2: 'Add photo',
            3: 'Vendor',
            4: 'Amount',
            5: 'Payment',
            6: 'Review',
        };
        title.textContent = titles[step] || 'Quick capture';
    }
    if (bar) bar.style.width = `${(step / TOTAL_STEPS) * 100}%`;

    document.querySelectorAll('.qc-step').forEach((sec) => {
        const n = Number(sec.dataset.qcStep);
        sec.hidden = n !== step;
    });

    if (footer) footer.hidden = step === 1;
    if (skip) skip.hidden = step !== 2;
    if (cont) {
        cont.textContent = step === 6
            ? (isIncome() ? 'Save receipt' : 'Save bill')
            : 'Continue';
        cont.hidden = step === 1;
    }
    if (back) {
        back.title = step === 1 ? 'Close' : 'Back';
        back.setAttribute('aria-label', step === 1 ? 'Close' : 'Back');
    }
}

function goStep(step) {
    const next = Math.max(1, Math.min(TOTAL_STEPS, step));
    if (draft.step !== next && draft.step >= 3 && draft.step <= 5) {
        readStepFields(draft.step);
    }
    draft.step = next;
    writeStepFields(next);
    updateChrome();
    shell()?.querySelector('.qc-body')?.scrollTo?.(0, 0);
}

function openQuickCapture() {
    if (!canEnter()) {
        alert('You do not have permission to enter bills or receipts.');
        return;
    }
    const root = shell();
    if (!root) {
        alert('Quick capture is not available on this page.');
        return;
    }
    resetDraft();
    draft.date = todayISO();
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('qc-open');
    goStep(1);
    if (!draft.historyPushed) {
        try {
            history.pushState({ fnQuickCapture: true }, '');
            draft.historyPushed = true;
        } catch {
            /* ignore */
        }
    }
}

function closeQuickCapture({ force = false } = {}) {
    if (!force && isDirty() && !confirm('Discard this capture?')) return false;
    const root = shell();
    if (root) {
        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');
    }
    document.documentElement.classList.remove('qc-open');
    revokeThumbUrls($('qc-bill-thumbs'));
    revokeThumbUrls($('qc-pay-thumbs'));
    revokeThumbUrls($('qc-review-thumbs'));
    const wasPushed = draft.historyPushed;
    resetDraft();
    if (wasPushed && history.state?.fnQuickCapture) {
        ignoreNextPop = true;
        try {
            history.back();
        } catch {
            ignoreNextPop = false;
        }
    }
    return true;
}

function onBack() {
    if (draft.step <= 1) {
        closeQuickCapture();
        return;
    }
    goStep(draft.step - 1);
}

function onContinue() {
    if (draft.step === 6) {
        void withButtonBusy($('qc-continue'), 'Saving…', saveDraft);
        return;
    }
    const err = validateStep(draft.step);
    if (err) {
        const map = {
            2: 'qc-photo-error',
            3: 'qc-vendor-error',
            4: 'qc-amount-error',
            5: 'qc-pay-error',
        };
        setError(map[draft.step] || 'qc-review-error', err);
        return;
    }
    goStep(draft.step + 1);
}

async function saveDraft() {
    setError('qc-review-error', '');
    const err4 = validateStep(4);
    const err5 = validateStep(5);
    const err3 = validateStep(3);
    if (err3 || err4 || err5) {
        setError('qc-review-error', err3 || err4 || err5);
        return;
    }

    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) {
        setError('qc-review-error', 'No active apartment selected.');
        return;
    }

    const amt = parseFloat(draft.amount);
    const payMode = draft.payMode;
    const notes = billPaymentNotes(payMode, draft.chequeNo, draft.onlineRef, draft.paidOn);
    const vendor_name = draft.vendor
        ? await ensureVendorInDirectory(apartment_id, draft.vendor)
        : null;
    const description = [draft.particulars || null, draft.invoice ? `Inv ${draft.invoice}` : null]
        .filter(Boolean)
        .join(' · ') || null;

    try {
        const billPayload = await filesToBase64Payload(draft.billFiles, { purpose: 'bill' });
        const payPayload = await filesToBase64Payload(draft.paymentFiles, { purpose: 'payment' });
        const result = await postFnMutation('saveFinanceDocument', {
            apartment_id,
            document: {
                kind: isIncome() ? 'IN' : 'OUT',
                doc_date: draft.date || todayISO(),
                amount: amt,
                cat: draft.cat,
                vendor_name,
                description,
                sub_category: isIncome() ? null : (draft.sub_category || null),
                notes,
                source: 'manual',
                status: payMode === 'unpaid' ? 'unpaid' : 'paid',
            },
            keepAttachments: [],
            removeAttachments: [],
            newAttachmentFiles: [...billPayload, ...payPayload],
        });

        if (result.document) {
            if (!fnFinances().financeDocuments) fnFinances().financeDocuments = [];
            const list = fnFinances().financeDocuments;
            const idx = list.findIndex((d) => d.id === result.document.id);
            if (idx >= 0) list[idx] = result.document;
            else list.unshift(result.document);
        }

        const { refreshFinanceDocumentsAfterSave } = await import('./financeDocuments.js');
        refreshFinanceDocumentsAfterSave(result.document);

        const savedLabel = isIncome() ? 'Receipt saved.' : 'Bill saved.';
        closeQuickCapture({ force: true });
        alert(savedLabel);
    } catch (err) {
        setError('qc-review-error', err?.message || 'Could not save.');
    }
}

function onPopState() {
    if (ignoreNextPop) {
        ignoreNextPop = false;
        return;
    }
    const root = shell();
    if (!root || root.hidden) return;
    draft.historyPushed = false;
    if (draft.step > 1) {
        goStep(draft.step - 1);
        try {
            history.pushState({ fnQuickCapture: true }, '');
            draft.historyPushed = true;
        } catch {
            /* ignore */
        }
    } else {
        closeQuickCapture({ force: true });
    }
}

function wireOnce() {
    const root = shell();
    if (!root || root.dataset.wired === '1') return;
    root.dataset.wired = '1';

    $('qc-back')?.addEventListener('click', () => onBack());
    $('qc-close')?.addEventListener('click', () => closeQuickCapture());
    $('qc-skip')?.addEventListener('click', () => goStep(3));
    $('qc-continue')?.addEventListener('click', () => onContinue());

    root.querySelectorAll('[data-qc-kind]').forEach((btn) => {
        btn.addEventListener('click', () => {
            draft.kind = btn.dataset.qcKind === 'IN' ? 'IN' : 'OUT';
            draft.cat = buildCategoryOptions(isIncome())[0] || '';
            goStep(2);
        });
    });

    const wireFileInput = (id, purpose) => {
        $(id)?.addEventListener('change', (e) => {
            addFiles(e.target.files, purpose);
            e.target.value = '';
        });
    };
    wireFileInput('qc-camera', 'bill');
    wireFileInput('qc-files', 'bill');
    wireFileInput('qc-pay-camera', 'payment');
    wireFileInput('qc-pay-files', 'payment');
    wireFileInput('qc-review-files', 'bill');

    root.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-qc-remove]');
        if (removeBtn) {
            removeFile(removeBtn.dataset.qcRemove, Number(removeBtn.dataset.qcIndex));
            return;
        }
        const chip = e.target.closest('[data-qc-vendor]');
        if (chip) {
            draft.vendor = chip.dataset.qcVendor || '';
            const input = $('qc-vendor');
            if (input) input.value = draft.vendor;
            return;
        }
        const goto = e.target.closest('[data-qc-goto]');
        if (goto) {
            goStep(Number(goto.dataset.qcGoto));
            return;
        }
        const pay = e.target.closest('[data-qc-pay]');
        if (pay) {
            draft.payMode = pay.dataset.qcPay || 'unpaid';
            syncPayModeUi();
        }
    });

    $('qc-category')?.addEventListener('change', () => {
        draft.cat = $('qc-category')?.value || draft.cat;
        populateSubcats();
    });

    $('qc-vendor')?.addEventListener('blur', () => {
        const el = $('qc-vendor');
        if (!el) return;
        const next = titleCaseVendor(el.value);
        if (next && next !== el.value) el.value = next;
        draft.vendor = next;
    });

    window.addEventListener('popstate', onPopState);
}

export function initQuickCapture() {
    wireOnce();
    const btn = document.getElementById('fn-btn-quick-capture');
    if (btn) {
        btn.hidden = !canEnter();
        if (!btn.dataset.wired) {
            btn.dataset.wired = '1';
            btn.addEventListener('click', () => openQuickCapture());
        }
    }
}

export { openQuickCapture, closeQuickCapture };

bindFinanceNewWindow('openQuickCapture', openQuickCapture);
bindFinanceNewWindow('closeQuickCapture', () => closeQuickCapture());
