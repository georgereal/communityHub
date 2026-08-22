/**
 * Sentry Finance Engine (Audit Relational)
 */
import { portalState, persist, supabase, pullState } from './store.js';
import { renderEditableLedgerRows, initLedgerBulkBar, renderExcludedLedgerSection, setLedgerViewRefresh } from './ledgerTable.js';
import { renderFinanceAnalytics } from './financeAnalytics.js';
import { renderLedgerPivotBanner, sortLedgerTxns, sortLedgerTxnsChronological, toggleLedgerSort, updateLedgerSortIndicators, applyLedgerTableFilters, setLedgerCategoryFilter } from './ledgerFilter.js';
import {
    collectAllocationDraft,
    formatAllocationSummary,
    syncMaintenanceIncomeSection,
    validateMaintenanceAllocations,
} from './maintenanceBilling.js';
import { ACCOUNTS_SUBVIEW_ROUTES, applyNavPermissions, getFinanceAccountsPages } from './navigation.js';
import { hasClientPermission, isApartmentAdminUser } from './rbac.js';
import { filesToBase64Payload, postFinanceMutation } from './financeApi.js';
import { initLedgerExport } from './ledgerExport.js';
import { getLedgerBankBalance, annotateLedgerRunningBalancesInOrder, getActiveLedgerTxns } from './ledgerBalance.js';
import { applySavedTransactionLocally, removeTransactionLocally } from './ledgerTxnLocal.js';
import {
    getPassbookClosingBalance,
    getBankOpeningConfig,
    recalculateBankStatementBalances,
    saveBankOpeningBalance,
} from './bankReconciliation.js';
import { withButtonBusy } from './buttonBusy.js';
import { ACCOUNTS_PAGE_HELP, applyFinancePageHeader, wireFinancePageHelp } from './financePageHelp.js';
import { canCrud } from './rbacMatrix.js';
import { EXPENSE_CATS, SUB_CAT_SUGGESTIONS, INCOME_CATS, BANK_REJECT_CAT, defaultExcludeFromReports, CATEGORY_LABELS, categoryDisplayLabel } from './expenseCategories.js';

const CAT_LABELS = CATEGORY_LABELS;

const INCOME_EXTRA_BY_CAT = {
    Promotion: {
        hint: 'Who sponsored or paid for this promotion?',
        vendor: {
            label: 'Sponsor / vendor',
            placeholder: 'e.g. ABC Builders, Local supermarket',
            required: true,
        },
        reference: {
            label: 'Contract / reference',
            placeholder: 'e.g. Banner agreement #12',
        },
    },
    Marketing: {
        hint: 'Which event or vendor is this income linked to?',
        vendor: {
            label: 'Event / vendor',
            placeholder: 'e.g. Diwali carnival, Food festival vendor',
        },
        reference: {
            label: 'Event reference',
            placeholder: 'e.g. Stall #4, 15 Jun event',
        },
    },
    'Other Income': {
        hint: 'Optional — who paid or what is this income for?',
        vendor: {
            label: 'Received from',
            placeholder: 'e.g. Tenant deposit, Ad hoc refund',
        },
    },
    Interest: {
        hint: 'Optional — note the bank account or statement period.',
        reference: {
            label: 'Period / account',
            placeholder: 'e.g. Q1 2026 savings account',
        },
    },
};

const RECEIPT_BUCKET = 'transaction-receipts';

const getLabel = (cat) => categoryDisplayLabel(cat);

const todayISO = () => new Date().toISOString().slice(0, 10);

const labelForCat = (cat) => categoryDisplayLabel(cat);

export const getReceiptPaths = (txn) => {
    if (!txn) return [];
    if (Array.isArray(txn.receipt_urls) && txn.receipt_urls.length) {
        return txn.receipt_urls.filter(Boolean);
    }
    if (txn.receipt_url) return [txn.receipt_url];
    return [];
};

export const getBankProofPaths = (txn) => {
    if (!txn) return [];
    if (Array.isArray(txn.bank_proof_urls) && txn.bank_proof_urls.length) {
        return txn.bank_proof_urls.filter(Boolean);
    }
    return [];
};

export const getAllAttachmentPaths = (txn) => [...getReceiptPaths(txn), ...getBankProofPaths(txn)];

const BANK_REF_META = {
    CHEQUE: { label: 'Cheque number', placeholder: 'e.g. 004521' },
    UPI: { label: 'UPI / transaction ID', placeholder: 'e.g. 123456789012' },
    NEFT: { label: 'NEFT / IMPS / RTGS reference', placeholder: 'e.g. NEFT/HDFC/4821' },
};

const receiptFileName = (path) => {
    const base = String(path || '').split('/').pop() || 'Receipt';
    return base.replace(/^\d+-/, '');
};

const isPdfPath = (path) => /\.pdf$/i.test(path || '');

const isPdfFile = (file) =>
    file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name || '');

const resolveCategory = (raw, allowedKeys) => {
    const t = String(raw ?? '').trim();
    if (!t) return allowedKeys[0];
    if (allowedKeys.includes(t)) return t;
    const byLabel = Object.entries(CAT_LABELS).find(
        ([key, label]) => allowedKeys.includes(key) && label.toLowerCase() === t.toLowerCase(),
    );
    if (byLabel) return byLabel[0];
    const partial = allowedKeys.find((key) =>
        key.toLowerCase().includes(t.toLowerCase()) ||
        (CAT_LABELS[key] || '').toLowerCase().includes(t.toLowerCase()),
    );
    return partial || allowedKeys[0];
};

const populateCategoryDatalists = () => {
    const expenseList = document.getElementById('expense-cat-datalist');
    const incomeList = document.getElementById('income-cat-datalist');
    if (expenseList) {
        expenseList.innerHTML = EXPENSE_CATS.map((key) =>
            `<option value="${labelForCat(key)}"></option>`,
        ).join('');
    }
    if (incomeList) {
        incomeList.innerHTML = INCOME_CATS.map((key) =>
            `<option value="${labelForCat(key)}"></option>`,
        ).join('');
    }
};

const populateSubCatDatalist = (catKey) => {
    const list = document.getElementById('expense-subcat-datalist');
    if (!list) return;
    const defaults = SUB_CAT_SUGGESTIONS[catKey] || SUB_CAT_SUGGESTIONS.Other;
    const saved = (portalState.finances.subCategories || [])
        .filter((row) => row.category === catKey)
        .map((row) => row.name);
    const suggestions = [...new Set([...defaults, ...saved])].sort((a, b) => a.localeCompare(b));
    list.innerHTML = suggestions.map((s) => `<option value="${s}"></option>`).join('');
};

const populateVendorDatalist = () => {
    const list = document.getElementById('expense-vendor-datalist');
    if (!list) return;
    let vendors = (portalState.finances.vendors || []).map((row) => row.name).filter(Boolean);
    if (!vendors.length) {
        vendors = [...new Set(
            portalState.finances.txns
                .filter((t) => t.vendor_name)
                .map((t) => t.vendor_name.trim()),
        )];
    }
    vendors = [...new Set(vendors)].sort((a, b) => a.localeCompare(b));
    list.innerHTML = vendors.map((v) => `<option value="${v}"></option>`).join('');

    const incomeList = document.getElementById('income-vendor-datalist');
    if (incomeList) incomeList.innerHTML = list.innerHTML;
};

export const syncIncomeExtraSection = (catKey, txn = null) => {
    const section = document.getElementById('income-extra-section');
    if (!section) return;

    const config = INCOME_EXTRA_BY_CAT[catKey];
    const vendorWrap = document.getElementById('income-extra-vendor-wrap');
    const refWrap = document.getElementById('income-extra-ref-wrap');
    const vendorInput = document.getElementById('income-vendor-input');
    const refInput = document.getElementById('income-reference-input');
    const hintEl = document.getElementById('income-extra-hint');
    const prevCat = section.dataset.incomeExtraCat;

    if (!config) {
        section.hidden = true;
        if (vendorWrap) vendorWrap.hidden = true;
        if (refWrap) refWrap.hidden = true;
        if (vendorInput) vendorInput.value = '';
        if (refInput) refInput.value = '';
        section.dataset.incomeExtraCat = catKey;
        return;
    }

    if (!txn && prevCat && prevCat !== catKey) {
        if (vendorInput) vendorInput.value = '';
        if (refInput) refInput.value = '';
    }

    section.hidden = false;
    section.dataset.incomeExtraCat = catKey;
    if (hintEl) hintEl.textContent = config.hint || '';

    if (config.vendor && vendorWrap && vendorInput) {
        vendorWrap.hidden = false;
        const vendorLabel = document.getElementById('income-vendor-label');
        if (vendorLabel) {
            vendorLabel.innerHTML = `${config.vendor.label}${config.vendor.required ? '' : ' <span class="expense-optional">(optional)</span>'}`;
        }
        vendorInput.placeholder = config.vendor.placeholder || '';
        vendorInput.required = !!config.vendor.required;
        if (txn) vendorInput.value = txn.vendor_name || '';
    } else if (vendorWrap) {
        vendorWrap.hidden = true;
        if (vendorInput) {
            vendorInput.value = '';
            vendorInput.required = false;
        }
    }

    if (config.reference && refWrap && refInput) {
        refWrap.hidden = false;
        const refLabel = document.getElementById('income-reference-label');
        if (refLabel) {
            refLabel.innerHTML = `${config.reference.label} <span class="expense-optional">(optional)</span>`;
        }
        refInput.placeholder = config.reference.placeholder || '';
        if (txn) refInput.value = txn.vendor_invoice || '';
    } else if (refWrap) {
        refWrap.hidden = true;
        if (refInput) refInput.value = '';
    }

    populateVendorDatalist();
};

export const refreshExpenseReferences = async () => {
    if (!supabase) return;
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return;
    const [v, s] = await Promise.all([
        supabase.from('expense_vendors').select('*').eq('apartment_id', apartment_id).order('last_used_at', { ascending: false }),
        supabase.from('expense_sub_categories').select('*').eq('apartment_id', apartment_id).order('last_used_at', { ascending: false }),
    ]);
    if (!v.error) portalState.finances.vendors = v.data || [];
    if (!s.error) portalState.finances.subCategories = s.data || [];
    populateVendorDatalist();
    const cat = resolveCategory(document.getElementById('expense-cat-input')?.value, EXPENSE_CATS);
    populateSubCatDatalist(cat);
};

const findVendorRow = (name) => {
    const needle = String(name || '').trim().toLowerCase();
    return (portalState.finances.vendors || []).find((row) => row.name?.trim().toLowerCase() === needle);
};

const findSubCategoryRow = (category, name) => {
    const needle = String(name || '').trim().toLowerCase();
    return (portalState.finances.subCategories || []).find(
        (row) => row.category === category && row.name?.trim().toLowerCase() === needle,
    );
};

async function rememberVendor(apartment_id, name) {
    if (!supabase || !name) return;
    const normalized = name.trim();
    const existing = findVendorRow(normalized);
    const payload = {
        id: existing?.id || crypto.randomUUID(),
        apartment_id,
        name: normalized,
        use_count: (existing?.use_count || 0) + 1,
        last_used_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('expense_vendors').upsert(payload, { onConflict: 'apartment_id,name' });
    if (error) console.warn('Could not cache vendor:', error.message);
}

async function rememberSubCategory(apartment_id, category, name) {
    if (!supabase || !name) return;
    const normalized = name.trim();
    const existing = findSubCategoryRow(category, normalized);
    const payload = {
        id: existing?.id || crypto.randomUUID(),
        apartment_id,
        category,
        name: normalized,
        use_count: (existing?.use_count || 0) + 1,
        last_used_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('expense_sub_categories').upsert(payload, { onConflict: 'apartment_id,category,name' });
    if (error) console.warn('Could not cache sub-category:', error.message);
}

const formatTxnDetail = (t) => {
    const chunks = [];
    if (t.vendor_name) chunks.push(`<span style="font-weight:800;">${t.vendor_name}</span>`);
    if (t.vendor_invoice) chunks.push(`<span style="color:var(--text-dim); font-weight:600;">Inv ${t.vendor_invoice}</span>`);
    if (t.wallet === 'BANK' && t.bank_reference) {
        const tag = { CHEQUE: 'Chq', UPI: 'UPI', NEFT: 'NEFT' }[t.bank_payment_type] || 'Bank';
        chunks.push(`<span style="color:var(--text-dim); font-weight:600;">${tag} ${t.bank_reference}</span>`);
    }
    if (t.description) chunks.push(t.description);
    if (t.sub_category) chunks.push(`<span style="color:var(--text-dim); font-weight:600;">${t.sub_category}</span>`);
    if (t.cat === 'Maintenance Collection') {
        const allocSummary = formatAllocationSummary(t.id);
        if (allocSummary) chunks.push(`<span style="color:var(--accent); font-weight:700;">${allocSummary}</span>`);
    }
    return chunks.join('<span style="color:#cbd5e1;"> · </span>') || '—';
};

/** Plain-text variant for tables that must not render HTML markup. */
export const formatTxnDetailPlain = (t) => {
    const parts = [];
    if (t.vendor_name) parts.push(t.vendor_name);
    if (t.vendor_invoice) parts.push(`Inv ${t.vendor_invoice}`);
    if (t.wallet === 'BANK' && t.bank_reference) {
        const tag = { CHEQUE: 'Chq', UPI: 'UPI', NEFT: 'NEFT' }[t.bank_payment_type] || 'Bank';
        parts.push(`${tag} ${t.bank_reference}`);
    }
    if (t.description) parts.push(t.description);
    if (t.sub_category) parts.push(t.sub_category);
    if (t.cat === 'Maintenance Collection') {
        const allocSummary = formatAllocationSummary(t.id);
        if (allocSummary) parts.push(allocSummary);
    }
    return parts.join(' · ') || '—';
};

const syncBankTypePills = (type = 'CHEQUE') => {
    document.querySelectorAll('#expense-bank-type-pills .expense-bank-pill, #income-bank-type-pills .expense-bank-pill').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.bankType === type);
    });
};

const getBankFormIds = () => {
    const isIncome = portalState.cashModalMode === 'income';
    return {
        sectionId: isIncome ? 'income-bank-section' : 'expense-bank-section',
        pillsId: isIncome ? 'income-bank-type-pills' : 'expense-bank-type-pills',
        refLabelId: isIncome ? 'income-bank-ref-label' : 'expense-bank-ref-label',
        refId: isIncome ? 'income-bank-ref' : 'expense-bank-ref',
        proofListId: isIncome ? 'cash-income-bank-proof-list' : 'cash-bank-proof-list',
        proofInputId: isIncome ? 'cash-income-bank-proof' : 'cash-bank-proof',
        walletPillsId: isIncome ? 'income-wallet-pills' : 'expense-wallet-pills',
    };
};

const getActiveBankType = () => {
    const { pillsId } = getBankFormIds();
    return document.querySelector(`#${pillsId} .expense-bank-pill.active`)?.dataset.bankType || 'CHEQUE';
};

const updateBankRefLabel = () => {
    const { refLabelId, refId } = getBankFormIds();
    const meta = BANK_REF_META[getActiveBankType()] || BANK_REF_META.CHEQUE;
    const label = document.getElementById(refLabelId);
    const input = document.getElementById(refId);
    if (label) label.textContent = meta.label;
    if (input) input.placeholder = meta.placeholder;
};

const syncBankWalletUI = () => {
    const { sectionId, walletPillsId } = getBankFormIds();
    const wallet = getActiveWallet(walletPillsId);
    const bankSection = document.getElementById(sectionId);
    if (bankSection) bankSection.hidden = wallet !== 'BANK';
    if (wallet === 'BANK') updateBankRefLabel();
};

const syncExpenseWalletUI = () => syncBankWalletUI();

const syncWalletPills = (containerId, wallet) => {
    document.querySelectorAll(`#${containerId} .expense-wallet-pill, #${containerId} .ledger-line-wallet__btn`).forEach((btn) => {
        const on = btn.dataset.wallet === wallet;
        btn.classList.toggle('active', on);
        const radio = btn.querySelector('input[type="radio"]');
        if (radio) radio.checked = on;
    });
};

const getActiveWallet = (containerId) => {
    const checked = document.querySelector(`#${containerId} input[type="radio"]:checked`);
    if (checked?.value) return checked.value;
    return document.querySelector(`#${containerId} .expense-wallet-pill.active, #${containerId} .ledger-line-wallet__btn.active`)?.dataset.wallet || 'CASH';
};

const resetReceiptUI = (existingPaths = []) => {
    const paths = Array.isArray(existingPaths)
        ? existingPaths.filter(Boolean)
        : (existingPaths ? [existingPaths] : []);
    portalState.pendingReceiptPaths = [...paths];
    portalState.pendingReceiptFiles = [];
    portalState.originalReceiptPaths = [...paths];
    renderReceiptUI();
};

const revokeReceiptPreviewUrls = () => {
    (portalState.receiptPreviewObjectUrls || []).forEach((url) => {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    });
    portalState.receiptPreviewObjectUrls = [];
};

const receiptPreviewHost = () => document.getElementById('cash-receipt-preview');

const isAttachmentPdf = (label = '', key = '') =>
    /\.pdf$/i.test(String(label)) || /\.pdf$/i.test(String(key));

let receiptPreviewRenderGen = 0;

const resolveAttachmentThumbSource = (item) => {
    if (item.billAtt) return billAttachmentKey(item.billAtt) || item.billAtt;
    if (item.path) return item.path;
    return null;
};

/** Load real image previews for already-uploaded (R2/storage) attachments. */
const hydrateSavedAttachmentThumbs = async (preview, items, gen) => {
    if (!preview || !items?.length) return;
    const jobs = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.saved && item.kind === 'image');
    await Promise.all(jobs.map(async ({ item, index }) => {
        if (gen !== receiptPreviewRenderGen) return;
        const source = resolveAttachmentThumbSource(item);
        if (!source) return;
        const card = preview.children[index];
        const thumbEl = card?.querySelector?.('.expense-attach-card__thumb');
        if (!thumbEl || thumbEl.querySelector('img.expense-attach-card__img')) return;
        thumbEl.classList.add('expense-attach-card__thumb--loading');
        try {
            const url = await resolveReceiptUrl(source);
            if (gen !== receiptPreviewRenderGen || !url) return;
            const img = document.createElement('img');
            img.className = 'expense-attach-card__img';
            img.alt = '';
            img.loading = 'lazy';
            img.src = url;
            img.onerror = () => {
                thumbEl.classList.remove('expense-attach-card__thumb--loading');
            };
            img.onload = () => {
                thumbEl.classList.remove('expense-attach-card__thumb--loading');
                const icon = thumbEl.querySelector('.expense-attach-card__icon');
                if (icon) icon.remove();
            };
            // Insert behind any "New" badge
            const badge = thumbEl.querySelector('.expense-attach-card__new');
            if (badge) thumbEl.insertBefore(img, badge);
            else thumbEl.prepend(img);
        } catch {
            thumbEl.classList.remove('expense-attach-card__thumb--loading');
        }
    }));
};

const renderReceiptUI = () => {
    const isBill = portalState.cashSaveTarget === 'bill';
    // Ledger lines no longer host direct receipt uploads — bills & receipts hold attachments.
    if (!isBill) {
        revokeReceiptPreviewUrls();
        return;
    }

    const preview = receiptPreviewHost();
    const list = document.getElementById('cash-receipt-list');

    revokeReceiptPreviewUrls();
    const gen = ++receiptPreviewRenderGen;

    const keptBill = portalState.billKeepAttachments || [];
    const pending = portalState.pendingReceiptFiles || [];
    const items = [
        ...keptBill.map((att, i) => {
            const label = billAttachmentLabel(att, i);
            const key = billAttachmentKey(att);
            return {
                key: `bill-${i}-${key}`,
                label,
                kind: isAttachmentPdf(label, key) ? 'pdf' : 'image',
                saved: true,
                billAtt: att,
                billKey: key,
            };
        }),
        ...pending.map((file, i) => ({
            key: `new-${i}-${file.name}-${file.size}`,
            label: file.name,
            kind: isPdfFile(file) ? 'pdf' : 'image',
            saved: false,
            file,
        })),
    ];

    if (!items.length) {
        if (preview) {
            preview.hidden = true;
            preview.innerHTML = '';
        }
        if (list) {
            list.hidden = true;
            list.innerHTML = '';
        }
        return;
    }

    if (list) {
        list.hidden = true;
        list.innerHTML = '';
    }
    if (!preview) return;

    preview.hidden = false;
    preview.innerHTML = items.map((item) => {
        let thumb = '';
        if (!item.saved && item.file && item.kind === 'image') {
            const url = URL.createObjectURL(item.file);
            portalState.receiptPreviewObjectUrls = [...(portalState.receiptPreviewObjectUrls || []), url];
            thumb = `<img class="expense-attach-card__img" src="${url}" alt="" />`;
        } else {
            const icon = item.kind === 'pdf' ? 'fa-file-pdf' : 'fa-file-image';
            thumb = `<span class="expense-attach-card__icon expense-attach-card__icon--${item.kind}"><i class="fa-solid ${icon}"></i></span>`;
        }

        let viewAttr = '';
        let removeAttr = '';
        if (item.billKey) {
            viewAttr = `data-view-bill-key="${encodeURIComponent(item.billKey)}"`;
            removeAttr = `data-remove-bill-key="${encodeURIComponent(item.billKey)}"`;
        } else {
            viewAttr = `data-view-file="${encodeURIComponent(item.label)}::${item.file?.size || 0}"`;
            removeAttr = `data-remove-file="${encodeURIComponent(item.label)}::${item.file?.size || 0}"`;
        }

        const badge = item.saved ? '' : '<span class="expense-attach-card__new">New</span>';
        const loadingClass = item.saved && item.kind === 'image' ? ' expense-attach-card__thumb--loading' : '';
        return `<article class="expense-attach-card" ${viewAttr} title="${item.label.replace(/"/g, '&quot;')}">
          <div class="expense-attach-card__thumb${loadingClass}">${thumb}${badge}</div>
          <div class="expense-attach-card__meta">
            <span class="expense-attach-card__name">${item.label}</span>
            <button type="button" class="expense-attach-card__remove" ${removeAttr} aria-label="Remove ${item.label}">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </article>`;
    }).join('');

    preview.querySelectorAll('[data-view-bill-key]').forEach((el) => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-remove-bill-key], [data-remove-file]')) return;
            void viewBillAttachment(
                decodeURIComponent(el.dataset.viewBillKey),
                portalState.billKeepAttachments || [],
            );
        });
    });
    preview.querySelectorAll('[data-view-file]').forEach((el) => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-remove-bill-key], [data-remove-file]')) return;
            const token = decodeURIComponent(el.dataset.viewFile);
            const [name, sizeStr] = token.split('::');
            const size = parseInt(sizeStr, 10);
            const file = (portalState.pendingReceiptFiles || []).find((f) => f.name === name && f.size === size);
            if (file) {
                const gallery = [
                    ...(portalState.billKeepAttachments || []),
                    ...(portalState.pendingReceiptFiles || []),
                ];
                const start = gallery.findIndex((g) => g === file || (g instanceof File && g.name === file.name && g.size === file.size));
                void window.viewAttachmentGallery?.(gallery, start >= 0 ? start : 0);
            }
        });
    });
    preview.querySelectorAll('[data-remove-bill-key]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = decodeURIComponent(btn.dataset.removeBillKey);
            portalState.billKeepAttachments = (portalState.billKeepAttachments || []).filter(
                (a) => billAttachmentKey(a) !== key,
            );
            renderReceiptUI();
        });
    });
    preview.querySelectorAll('[data-remove-file]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const token = decodeURIComponent(btn.dataset.removeFile);
            const [name, sizeStr] = token.split('::');
            const size = parseInt(sizeStr, 10);
            portalState.pendingReceiptFiles = (portalState.pendingReceiptFiles || []).filter(
                (f) => !(f.name === name && f.size === size),
            );
            renderReceiptUI();
        });
    });

    void hydrateSavedAttachmentThumbs(preview, items, gen);
};

const viewBillAttachment = async (key, allEntries = null) => {
    const entries = Array.isArray(allEntries) && allEntries.length
        ? allEntries
        : (portalState.billKeepAttachments?.length ? portalState.billKeepAttachments : (key ? [key] : []));
    if (!entries.length) return;
    const idx = key
        ? Math.max(0, entries.findIndex((a) => billAttachmentKey(a) === key || a === key))
        : 0;
    await window.viewAttachmentGallery?.(entries, idx >= 0 ? idx : 0);
};

const resetBankProofUI = (existingPaths = []) => {
    const paths = Array.isArray(existingPaths) ? existingPaths.filter(Boolean) : [];
    portalState.pendingBankProofPaths = [...paths];
    portalState.pendingBankProofFiles = [];
    portalState.originalBankProofPaths = [...paths];
    renderBankProofUI();
};

const renderBankProofUI = () => {
    const { proofListId } = getBankFormIds();
    const list = document.getElementById(proofListId);
    if (!list) return;

    const kept = portalState.pendingBankProofPaths || [];
    const pending = portalState.pendingBankProofFiles || [];
    const items = [
        ...kept.map((path) => ({
            label: receiptFileName(path),
            kind: isPdfPath(path) ? 'pdf' : 'image',
            saved: true,
            path,
        })),
        ...pending.map((file) => ({
            label: file.name,
            kind: isPdfFile(file) ? 'pdf' : 'image',
            saved: false,
            file,
        })),
    ];

    if (!items.length) {
        list.hidden = true;
        list.innerHTML = '';
        return;
    }

    list.hidden = false;
    list.innerHTML = items.map((item) => {
        const icon = item.kind === 'pdf' ? 'fa-file-pdf' : 'fa-file-image';
        const viewBtn = item.saved
            ? `<button type="button" class="expense-link-btn" data-view-bank-path="${encodeURIComponent(item.path)}">view</button>`
            : `<button type="button" class="expense-link-btn" data-view-bank-file="${encodeURIComponent(item.label)}::${item.file?.size || 0}">view</button>`;
        const removeAttr = item.saved
            ? `data-remove-bank-saved="${encodeURIComponent(item.path)}"`
            : `data-remove-bank-file="${encodeURIComponent(item.label)}::${item.file?.size || 0}"`;
        return `<li class="expense-receipt-item">
          <span class="expense-receipt-item__name"><i class="fa-solid ${icon}"></i> ${item.label}</span>
          <span class="expense-receipt-item__actions">${viewBtn}<button type="button" class="expense-link-btn" ${removeAttr}>remove</button></span>
        </li>`;
    }).join('');

    list.querySelectorAll('[data-view-bank-path]').forEach((btn) => {
        btn.addEventListener('click', () => window.viewReceipt(decodeURIComponent(btn.dataset.viewBankPath)));
    });
    list.querySelectorAll('[data-view-bank-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const token = decodeURIComponent(btn.dataset.viewBankFile);
            const [name, sizeStr] = token.split('::');
            const size = parseInt(sizeStr, 10);
            const file = (portalState.pendingBankProofFiles || []).find((f) => f.name === name && f.size === size);
            if (file) window.previewReceiptFile(file);
        });
    });
    list.querySelectorAll('[data-remove-bank-saved]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const path = decodeURIComponent(btn.dataset.removeBankSaved);
            portalState.pendingBankProofPaths = (portalState.pendingBankProofPaths || []).filter((p) => p !== path);
            renderBankProofUI();
        });
    });
    list.querySelectorAll('[data-remove-bank-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const token = decodeURIComponent(btn.dataset.removeBankFile);
            const [name, sizeStr] = token.split('::');
            const size = parseInt(sizeStr, 10);
            portalState.pendingBankProofFiles = (portalState.pendingBankProofFiles || []).filter(
                (f) => !(f.name === name && f.size === size),
            );
            renderBankProofUI();
        });
    });
};

export const initExpenseModal = () => {
    populateCategoryDatalists();
    populateVendorDatalist();
    const wirePillGroup = (container, afterSelect) => {
        if (!container || container.dataset.wired) return;
        container.dataset.wired = '1';
        const selectWallet = (pill) => {
            const wallet = pill.dataset.wallet;
            container.querySelectorAll('.expense-wallet-pill').forEach((b) => {
                const on = b.dataset.wallet === wallet;
                b.classList.toggle('active', on);
                const radio = b.querySelector('input[type="radio"]');
                if (radio) radio.checked = on;
            });
            afterSelect?.();
        };
        container.addEventListener('click', (e) => {
            const pill = e.target.closest('.expense-wallet-pill');
            if (!pill || !container.contains(pill)) return;
            selectWallet(pill);
        });
        container.addEventListener('change', (e) => {
            if (e.target.type !== 'radio') return;
            const pill = e.target.closest('.expense-wallet-pill');
            if (pill) selectWallet(pill);
        });
    };
    wirePillGroup(document.getElementById('expense-wallet-pills'), syncBankWalletUI);
    wirePillGroup(document.getElementById('income-wallet-pills'), syncBankWalletUI);

    const billPayPills = document.getElementById('bill-payment-pills');
    if (billPayPills && !billPayPills.dataset.wired) {
        billPayPills.dataset.wired = '1';
        billPayPills.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-bill-pay]');
            if (!btn || !billPayPills.contains(btn)) return;
            if (portalState.billModalReadOnly) return;
            syncBillPaymentUI(btn.dataset.billPay, {
                chequeNo: document.getElementById('bill-cheque-no')?.value || '',
                onlineRef: document.getElementById('bill-online-ref')?.value || '',
                paidOn: document.getElementById('bill-paid-date')?.value || '',
            });
            if (btn.dataset.billPay === 'cheque') {
                setTimeout(() => document.getElementById('bill-cheque-no')?.focus(), 30);
            } else if (btn.dataset.billPay === 'online') {
                setTimeout(() => document.getElementById('bill-online-ref')?.focus(), 30);
            } else if (btn.dataset.billPay === 'cash') {
                setTimeout(() => document.getElementById('bill-paid-date')?.focus(), 30);
            }
        });
    }

    const unlockBtn = document.getElementById('cash-modal-unlock-btn');
    if (unlockBtn && !unlockBtn.dataset.wired) {
        unlockBtn.dataset.wired = '1';
        unlockBtn.addEventListener('click', () => {
            const doc = portalState.editingFinanceDocId
                ? (portalState.finances.financeDocuments || []).find((d) => d.id === portalState.editingFinanceDocId)
                : null;
            if (doc) window.openFinanceDocumentEdit(doc, { readOnly: false });
            else setBillModalReadOnly(false);
        });
    }

    const wireBankTypePills = (container) => {
        if (!container || container.dataset.wired) return;
        container.dataset.wired = '1';
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.expense-bank-pill');
            if (!btn || !container.contains(btn)) return;
            container.querySelectorAll('.expense-bank-pill').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            updateBankRefLabel();
        });
    };
    wireBankTypePills(document.getElementById('expense-bank-type-pills'));
    wireBankTypePills(document.getElementById('income-bank-type-pills'));

    const catInput = document.getElementById('expense-cat-input');
    if (catInput && !catInput.dataset.wired) {
        catInput.dataset.wired = '1';
        catInput.addEventListener('change', () => {
            const cat = resolveCategory(catInput.value, EXPENSE_CATS);
            populateSubCatDatalist(cat);
        });
    }

    const incomeCatInput = document.getElementById('income-cat-input');
    if (incomeCatInput && !incomeCatInput.dataset.wired) {
        incomeCatInput.dataset.wired = '1';
        const syncIncomeSections = () => {
            const cat = resolveCategory(incomeCatInput.value, INCOME_CATS);
            syncMaintenanceIncomeSection(cat, portalState.editingTxnId);
            syncIncomeExtraSection(cat);
        };
        incomeCatInput.addEventListener('change', syncIncomeSections);
        incomeCatInput.addEventListener('input', syncIncomeSections);
    }

    const wireReceiptFileInput = (inputId) => {
        const input = document.getElementById(inputId);
        if (!input || input.dataset.wired) return;
        input.dataset.wired = '1';
        input.addEventListener('change', () => {
            const picked = Array.from(input.files || []);
            if (picked.length) {
                portalState.pendingReceiptFiles = [...(portalState.pendingReceiptFiles || []), ...picked];
                renderReceiptUI();
            }
            input.value = '';
        });
    };
    wireReceiptFileInput('cash-bill');
    wireReceiptFileInput('cash-bill-camera');

    const wireBankProofInput = (inputId) => {
        const input = document.getElementById(inputId);
        if (!input || input.dataset.wired) return;
        input.dataset.wired = '1';
        input.addEventListener('change', () => {
            const picked = Array.from(input.files || []);
            if (picked.length) {
                portalState.pendingBankProofFiles = [...(portalState.pendingBankProofFiles || []), ...picked];
                renderBankProofUI();
            }
            input.value = '';
        });
    };
    wireBankProofInput('cash-bank-proof');
    wireBankProofInput('cash-income-bank-proof');

    if (!initExpenseModal._escWired) {
        initExpenseModal._escWired = true;
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            // Receipt viewer handles its own Escape
            if (document.getElementById('receipt-modal')?.classList.contains('active')) return;
            // Open combobox menus handle Escape first via stopPropagation when focused
            const cash = document.getElementById('cash-modal');
            if (cash?.classList.contains('active')) {
                e.preventDefault();
                cash.classList.remove('active');
                return;
            }
            const ledgerLine = document.getElementById('ledger-line-modal');
            if (ledgerLine?.classList.contains('active')) {
                e.preventDefault();
                ledgerLine.classList.remove('active');
            }
        });
    }
};

export const processFinances = () => {
    let cash = 0;
    let outToday = 0;
    const now = new Date();
    portalState.finances.txns.forEach((t) => {
        const amt = parseFloat(t.amount);
        const d = new Date(t.date);
        const wallet = t.wallet || 'CASH';
        if (t.type === 'IN') {
            if (wallet === 'CASH') cash += amt;
        } else {
            if (wallet === 'CASH') cash -= amt;
            if (d.toDateString() === now.toDateString()) outToday += amt;
        }
    });

    const ledgerBank = getLedgerBankBalance();
    const bankBalance = ledgerBank.balance;
    const passbook = getPassbookClosingBalance();
    const passbookGap = bankBalance != null && passbook?.balance != null
        ? bankBalance - passbook.balance
        : null;

    const fmt = (n) => `₹ ${Number(n).toLocaleString('en-IN')}`;
    const k = (id) => document.getElementById(id);
    if (k('cash-balance')) {
        k('cash-balance').textContent = fmt(cash);
        const bankEl = k('bank-balance');
        if (bankEl) {
            bankEl.textContent = bankBalance != null ? fmt(bankBalance) : '—';
            if (ledgerBank.needsOpening) {
                bankEl.title = 'Set opening balance via the Opening control in the ledger toolbar';
            } else if (passbookGap != null && Math.abs(passbookGap) >= 1) {
                bankEl.title = `Ledger calculated ${fmt(bankBalance)} vs passbook ${fmt(passbook.balance)} (${fmt(passbookGap)} gap)`;
            } else {
                bankEl.title = `Opening + ${ledgerBank.txnCount} bank ledger entries`;
            }
        }
        const hintEl = k('ledger-bank-hint');
        if (hintEl) {
            if (ledgerBank.needsOpening) {
                hintEl.hidden = false;
                hintEl.innerHTML = '<button type="button" class="ledger-kpi__hint-btn" id="ledger-bank-hint-open">Set opening balance</button>';
            } else if (passbook?.balance != null && passbookGap != null && Math.abs(passbookGap) >= 1) {
                hintEl.hidden = false;
                hintEl.textContent = `Passbook shows ${fmt(passbook.balance)} — gap of ${fmt(passbookGap)} (missing ledger entries or opening date mismatch).`;
            } else {
                hintEl.hidden = true;
                hintEl.textContent = '';
            }
        }
        k('total-wealth').textContent = bankBalance != null ? fmt(cash + bankBalance) : fmt(cash);
        k('cash-today-out').textContent = fmt(outToday);
        if (k('cash-txn-count')) {
            const n = portalState.finances.txns.length;
            k('cash-txn-count').textContent = n ? `${n} entries` : '';
        }
    }
    syncLedgerOpeningFields();
};

export const renderCashLedger = () => {
    window.renderCashLedger = renderCashLedger;
    setLedgerViewRefresh(renderCashLedger);
    const list = document.getElementById('cash-ledger-items');
    if (!list) return;

    renderLedgerPivotBanner();
    const active = getActiveLedgerTxns([...portalState.finances.txns]);
    const filtered = applyLedgerTableFilters(active);
    const sorted = sortLedgerTxns(filtered);
    // Running Calculated always walks oldest→newest, even when the table shows newest-first.
    const running = annotateLedgerRunningBalancesInOrder(sortLedgerTxnsChronological(filtered));
    const enrichedSorted = sorted.map((t) => ({
        ...t,
        _ledgerComputedBalance: running.byId.get(t.id) ?? null,
    }));
    updateLedgerSortIndicators();

    const total = getActiveLedgerTxns().length;
    const showing = enrichedSorted.length;
    const cashBillCount = enrichedSorted.filter((t) => t._fromFinanceDocument).length;
    const bankCount = showing - cashBillCount;

    const countEl = document.getElementById('cash-txn-count');
    if (countEl) {
        if (cashBillCount > 0) {
            countEl.textContent = `${bankCount} bank · ${cashBillCount} cash bill${cashBillCount === 1 ? '' : 's'}`;
        } else if (showing === total) {
            countEl.textContent = total ? `${total} entries` : '';
        } else {
            countEl.textContent = `${showing} of ${total}`;
        }
    }

    renderEditableLedgerRows(enrichedSorted, { formatTxnDetail, getAllAttachmentPaths });
    renderExcludedLedgerSection({ formatTxnDetailPlain });
    updateLedgerSortIndicators();
    syncLedgerOpeningFields();
};

async function uploadReceiptFile(apartmentId, txnId, file, index, subfolder = '') {
    const stem = (file.name.replace(/\.[^.]+$/, '') || 'file')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 48);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const base = subfolder
        ? `${apartmentId}/${txnId}/${subfolder}/${index}-${stem}.${ext}`
        : `${apartmentId}/${txnId}/${index}-${stem}.${ext}`;
    const { error } = await supabase.storage.from(RECEIPT_BUCKET).upload(base, file, {
        upsert: true,
        contentType: file.type || (ext === 'pdf' ? 'application/pdf' : undefined),
    });
    if (error) throw error;
    return base;
}

async function uploadReceiptFiles(apartmentId, txnId, files, startIndex = 0, subfolder = '') {
    const paths = [];
    for (let i = 0; i < files.length; i++) {
        paths.push(await uploadReceiptFile(apartmentId, txnId, files[i], startIndex + i + 1, subfolder));
    }
    return paths;
}

async function deleteReceiptPaths(paths) {
    if (!paths?.length || !supabase) return;
    await supabase.storage.from(RECEIPT_BUCKET).remove(paths);
}

async function resolveReceiptUrl(pathOrUrl) {
    if (!pathOrUrl) return null;
    if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('blob:')) return pathOrUrl;

    const storagePath = String(pathOrUrl).replace(/^r2:/, '');

    // Bills / finance docs (and newer uploads) use private R2 via /api/storage.
    try {
        const res = await fetch('/api/storage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ action: 'createSignedUrl', path: storagePath, expiresIn: 300 }),
        });
        if (res.ok) {
            const json = await res.json().catch(() => ({}));
            const url = json.signedUrl || json.url;
            if (url) return url;
        }
    } catch {
        /* fall through to Supabase storage */
    }

    if (!supabase) return null;
    const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(storagePath, 3600);
    if (error) throw error;
    return data.signedUrl;
}

/** Normalize attachment entries (string path, {key, originalName}, File) for the viewer. */
export const normalizeAttachmentEntries = (entries = []) =>
    (Array.isArray(entries) ? entries : [])
        .map((entry, i) => {
            if (!entry) return null;
            if (entry instanceof File) {
                return {
                    source: entry,
                    label: entry.name || `File ${i + 1}`,
                    isPdf: isPdfFile(entry),
                };
            }
            if (typeof entry === 'object' && entry.key) {
                const key = String(entry.key).replace(/^r2:/, '');
                const label = entry.originalName || receiptFileName(key) || `File ${i + 1}`;
                return { source: key, label, isPdf: isPdfPath(label) || isPdfPath(key) };
            }
            if (typeof entry === 'string') {
                const key = entry.replace(/^r2:/, '');
                return { source: key, label: receiptFileName(key) || `File ${i + 1}`, isPdf: isPdfPath(key) };
            }
            return null;
        })
        .filter(Boolean);

const friendlyAttachmentLabel = (item, index, total) => {
    const raw = String(item?.label || '').trim() || `File ${index + 1}`;
    // Hide opaque storage UUIDs in the UI when possible
    const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{18,}(\.[a-z0-9]+)?$/i.test(raw);
    if (looksUuid) {
        const ext = (raw.split('.').pop() || '').toLowerCase();
        return total > 1 ? `File ${index + 1}${ext ? `.${ext}` : ''}` : (ext ? `Attachment.${ext}` : 'Attachment');
    }
    return raw.length > 42 ? `${raw.slice(0, 38)}…` : raw;
};

/** Open the shared receipt viewer for one or more attachments (R2 or storage paths, or Files). */
window.viewAttachmentGallery = async (entries, startIndex = 0) => {
    const items = normalizeAttachmentEntries(entries);
    if (!items.length) {
        alert('No attachments to preview.');
        return;
    }
    cleanupReceiptViewer();
    const idx = Math.max(0, Math.min(parseInt(startIndex, 10) || 0, items.length - 1));
    receiptViewerState = {
        items,
        index: idx,
        objectUrls: [],
        zoom: 1,
        currentUrl: null,
        currentName: '',
        isPdf: false,
    };
    try {
        await showReceiptAtIndex(idx);
        document.getElementById('receipt-modal')?.classList.add('active');
    } catch (err) {
        alert(err?.message || 'Could not load attachment preview.');
    }
};

let receiptViewerState = {
    items: [],
    index: 0,
    objectUrls: [],
    zoom: 1,
    currentUrl: null,
    currentName: '',
    isPdf: false,
};

const cleanupReceiptViewer = () => {
    receiptViewerState.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    receiptViewerState.objectUrls = [];
    receiptViewerState.currentUrl = null;
    const img = document.getElementById('receipt-img');
    const pdf = document.getElementById('receipt-pdf');
    if (img) {
        img.removeAttribute('src');
        img.style.transform = '';
    }
    if (pdf) pdf.removeAttribute('src');
};

const applyReceiptZoom = (nextZoom) => {
    const zoom = Math.max(0.5, Math.min(4, Math.round(nextZoom * 100) / 100));
    receiptViewerState.zoom = zoom;
    const img = document.getElementById('receipt-img');
    const label = document.getElementById('receipt-zoom-label');
    const resetBtn = document.getElementById('receipt-zoom-reset');
    const pct = `${Math.round(zoom * 100)}%`;
    if (img && !img.hidden) img.style.transform = `scale(${zoom})`;
    if (label) label.textContent = pct;
    if (resetBtn) resetBtn.textContent = pct;
    const zoomOut = document.getElementById('receipt-zoom-out');
    const zoomIn = document.getElementById('receipt-zoom-in');
    if (zoomOut) zoomOut.disabled = zoom <= 0.5;
    if (zoomIn) zoomIn.disabled = zoom >= 4;
};

const renderReceiptFileList = (items, activeIdx) => {
    const list = document.getElementById('receipt-file-list');
    if (!list) return;
    if (items.length <= 1) {
        list.hidden = true;
        list.innerHTML = '';
        return;
    }
    list.hidden = false;
    list.innerHTML = `
      <p class="receipt-viewer__files-title">${items.length} files</p>
      <div class="receipt-viewer__files-list">
        ${items.map((item, i) => {
            const label = friendlyAttachmentLabel(item, i, items.length);
            const icon = item.isPdf ? 'fa-file-pdf' : 'fa-file-image';
            return `<button type="button" class="receipt-viewer__file${i === activeIdx ? ' is-active' : ''}" data-receipt-tab="${i}" title="${escHtml(item.label || label)}">
              <i class="fa-solid ${icon}" aria-hidden="true"></i>
              <span class="receipt-viewer__file-label">${escHtml(label)}</span>
              <span class="receipt-viewer__file-idx">${i + 1}</span>
            </button>`;
        }).join('')}
      </div>`;
    list.querySelectorAll('[data-receipt-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            cleanupReceiptViewer();
            showReceiptAtIndex(parseInt(btn.dataset.receiptTab, 10));
        });
    });
};

const escHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const showReceiptAtIndex = async (index) => {
    const items = receiptViewerState.items || [];
    // Legacy callers may still set `.paths`
    if (!items.length && Array.isArray(receiptViewerState.paths)) {
        receiptViewerState.items = normalizeAttachmentEntries(receiptViewerState.paths);
    }
    const list = receiptViewerState.items || [];
    if (!list.length) return;

    const idx = Math.max(0, Math.min(index, list.length - 1));
    receiptViewerState.index = idx;
    receiptViewerState.zoom = 1;

    const item = list[idx];
    const img = document.getElementById('receipt-img');
    const pdf = document.getElementById('receipt-pdf');
    const empty = document.getElementById('receipt-viewer-empty');
    const caption = document.getElementById('receipt-viewer-caption');
    const openTab = document.getElementById('receipt-open-tab');
    const prevBtn = document.getElementById('receipt-prev-btn');
    const nextBtn = document.getElementById('receipt-next-btn');
    const zoomOut = document.getElementById('receipt-zoom-out');
    const zoomIn = document.getElementById('receipt-zoom-in');
    const zoomReset = document.getElementById('receipt-zoom-reset');

    let url;
    if (item.source instanceof File) {
        url = URL.createObjectURL(item.source);
        receiptViewerState.objectUrls.push(url);
    } else {
        url = await resolveReceiptUrl(item.source);
    }

    const displayName = friendlyAttachmentLabel(item, idx, list.length);
    const fullName = item.label || displayName;
    receiptViewerState.currentUrl = url || null;
    receiptViewerState.currentName = fullName;
    receiptViewerState.isPdf = !!item.isPdf;

    if (caption) {
        caption.textContent = list.length > 1
            ? `${displayName} · ${idx + 1} of ${list.length}`
            : displayName;
    }

    renderReceiptFileList(list, idx);

    if (prevBtn) {
        prevBtn.hidden = list.length <= 1;
        prevBtn.disabled = idx <= 0;
    }
    if (nextBtn) {
        nextBtn.hidden = list.length <= 1;
        nextBtn.disabled = idx >= list.length - 1;
    }

    if (item.isPdf) {
        if (img) {
            img.hidden = true;
            img.removeAttribute('src');
            img.style.transform = '';
        }
        const zoomWrap = document.getElementById('receipt-zoom-wrap');
        if (zoomWrap) zoomWrap.hidden = true;
        if (empty) empty.hidden = true;
        if (pdf) {
            pdf.hidden = false;
            pdf.src = url;
        }
        if (zoomOut) zoomOut.disabled = true;
        if (zoomIn) zoomIn.disabled = true;
        if (zoomReset) zoomReset.disabled = true;
    } else {
        if (pdf) {
            pdf.hidden = true;
            pdf.removeAttribute('src');
        }
        const zoomWrap = document.getElementById('receipt-zoom-wrap');
        if (zoomWrap) zoomWrap.hidden = false;
        if (empty) empty.hidden = !!url;
        if (img) {
            img.hidden = !url;
            if (url) img.src = url;
            img.style.transform = 'scale(1)';
        }
        if (zoomOut) zoomOut.disabled = false;
        if (zoomIn) zoomIn.disabled = false;
        if (zoomReset) zoomReset.disabled = false;
        applyReceiptZoom(1);
    }

    if (openTab) {
        if (url) {
            openTab.href = url;
            openTab.hidden = false;
        } else {
            openTab.hidden = true;
        }
    }
};

const downloadCurrentReceipt = async () => {
    const url = receiptViewerState.currentUrl;
    const name = receiptViewerState.currentName || 'attachment';
    if (!url) return;
    try {
        const res = await fetch(url);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = name.includes('.') ? name : `${name}${receiptViewerState.isPdf ? '.pdf' : '.jpg'}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
    } catch {
        // Fallback: open in new tab if download fetch is blocked
        window.open(url, '_blank', 'noopener');
    }
};

const wireReceiptViewerControls = () => {
    const modal = document.getElementById('receipt-modal');
    if (!modal || modal.dataset.viewerWired === '1') return;
    modal.dataset.viewerWired = '1';

    document.getElementById('receipt-zoom-in')?.addEventListener('click', () => {
        if (receiptViewerState.isPdf) return;
        applyReceiptZoom(receiptViewerState.zoom + 0.25);
    });
    document.getElementById('receipt-zoom-out')?.addEventListener('click', () => {
        if (receiptViewerState.isPdf) return;
        applyReceiptZoom(receiptViewerState.zoom - 0.25);
    });
    document.getElementById('receipt-zoom-reset')?.addEventListener('click', () => {
        if (receiptViewerState.isPdf) return;
        applyReceiptZoom(1);
    });
    document.getElementById('receipt-download-btn')?.addEventListener('click', () => {
        void downloadCurrentReceipt();
    });
    document.getElementById('receipt-prev-btn')?.addEventListener('click', () => {
        if (receiptViewerState.index <= 0) return;
        cleanupReceiptViewer();
        void showReceiptAtIndex(receiptViewerState.index - 1);
    });
    document.getElementById('receipt-next-btn')?.addEventListener('click', () => {
        const max = (receiptViewerState.items || []).length - 1;
        if (receiptViewerState.index >= max) return;
        cleanupReceiptViewer();
        void showReceiptAtIndex(receiptViewerState.index + 1);
    });

    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('receipt-modal')?.classList.contains('active')) return;
        if (e.key === 'Escape') {
            window.closeReceiptViewer();
            return;
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            document.getElementById('receipt-prev-btn')?.click();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            document.getElementById('receipt-next-btn')?.click();
        } else if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            document.getElementById('receipt-zoom-in')?.click();
        } else if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            document.getElementById('receipt-zoom-out')?.click();
        }
    });

    // Scroll-wheel zoom when over the image stage
    document.getElementById('receipt-viewer-body')?.addEventListener('wheel', (e) => {
        if (receiptViewerState.isPdf) return;
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        applyReceiptZoom(receiptViewerState.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
};

wireReceiptViewerControls();

// Re-wire if HTML was mounted after module init (view HTML shells).
document.addEventListener('DOMContentLoaded', () => wireReceiptViewerControls());
if (document.readyState !== 'loading') wireReceiptViewerControls();

export const saveCashData = async () => {
    const isIncome = portalState.cashModalMode === 'income';
    const saveTarget = portalState.cashSaveTarget === 'bill' ? 'bill' : 'ledger';

    const amtEl = document.getElementById(isIncome ? 'income-amt' : 'cash-amt');
    const descEl = document.getElementById(isIncome ? 'income-desc' : 'cash-desc');
    const dateEl = document.getElementById(isIncome ? 'income-date' : 'cash-date');
    const walletContainer = isIncome ? 'income-wallet-pills' : 'expense-wallet-pills';
    const catInput = document.getElementById(isIncome ? 'income-cat-input' : 'expense-cat-input');
    const subCatEl = document.getElementById('expense-subcat-input');
    const vendorEl = document.getElementById('expense-vendor-input');
    const invoiceEl = document.getElementById('expense-invoice-input');
    const bankRefEl = document.getElementById(isIncome ? 'income-bank-ref' : 'expense-bank-ref');

    const amt = parseFloat(amtEl?.value);
    let desc = descEl?.value?.trim() || null;
    const cat = resolveCategory(catInput?.value, isIncome ? INCOME_CATS : EXPENSE_CATS);
    if (isIncome && cat === 'Maintenance Collection' && saveTarget === 'ledger') {
        const unitNumber = document.getElementById('maintenance-unit-input')?.value?.trim();
        if (unitNumber && !String(desc || '').toUpperCase().includes(unitNumber.toUpperCase())) {
            desc = desc ? `${desc} · Flat ${unitNumber}` : `Maintenance collection — ${unitNumber}`;
        }
    }

    const wallet = getActiveWallet(walletContainer);
    const sub_category = !isIncome ? (subCatEl?.value?.trim() || null) : null;
    const bank_payment_type = wallet === 'BANK' ? getActiveBankType() : null;
    const bank_reference = wallet === 'BANK' ? (bankRefEl?.value?.trim() || null) : null;

    let vendor_name = null;
    let vendor_invoice = null;
    if (!isIncome) {
        vendor_name = vendorEl?.value?.trim() || null;
        vendor_invoice = readBillInvoiceNumber() || invoiceEl?.value?.trim() || null;
    } else if (saveTarget === 'bill') {
        vendor_invoice = readBillInvoiceNumber();
        vendor_name = document.getElementById('income-vendor-input')?.value?.trim() || null;
    } else {
        const extra = INCOME_EXTRA_BY_CAT[cat];
        if (extra?.vendor) {
            vendor_name = document.getElementById('income-vendor-input')?.value?.trim() || null;
        }
        if (extra?.reference) {
            vendor_invoice = document.getElementById('income-reference-input')?.value?.trim() || null;
        }
    }

    if (isNaN(amt) || amt <= 0) return alert('Enter a valid amount.');
    if (!isIncome && !vendor_name) return alert('Enter the vendor name.');
    if (isIncome) {
        const extra = INCOME_EXTRA_BY_CAT[cat];
        if (extra?.vendor?.required && !vendor_name) {
            return alert(`Enter ${extra.vendor.label.toLowerCase()}.`);
        }
    }

    if (saveTarget === 'bill') {
        const apartment_id = portalState.access?.activeApartmentId;
        if (!apartment_id) return alert('No active apartment selected.');
        const dateStr = dateEl?.value || todayISO();
        const payMode = getBillPaymentMode();
        const chequeNo = document.getElementById('bill-cheque-no')?.value?.trim() || '';
        if (payMode === 'cheque' && !chequeNo) {
            return alert('Enter the cheque number, or choose Unpaid / Paid · Cash / Paid · Online.');
        }
        const onlineRef = document.getElementById('bill-online-ref')?.value?.trim() || '';
        const paidOn = document.getElementById('bill-paid-date')?.value?.trim() || '';
        if (payMode !== 'unpaid' && !paidOn) {
            return alert('Enter the payment date.');
        }
        const notes = billPaymentNotes(payMode, chequeNo, onlineRef, paidOn);

        const existing = portalState.editingFinanceDocId
            ? (portalState.finances.financeDocuments || []).find((d) => d.id === portalState.editingFinanceDocId)
            : null;
        const linkTxnId = portalState.linkBillToTxnId || existing?.transaction_id || null;
        const keepAttachments = Array.isArray(portalState.billKeepAttachments)
            ? [...portalState.billKeepAttachments]
            : [];
        const original = Array.isArray(existing?.attachment_urls) ? existing.attachment_urls : [];
        const keepKeys = new Set(keepAttachments.map((a) => (a && typeof a === 'object' ? a.key : String(a || ''))).filter(Boolean));
        const removeAttachments = original.filter((a) => {
            const key = a && typeof a === 'object' ? a.key : String(a || '');
            return key && !keepKeys.has(key);
        });

        try {
            const result = await postFinanceMutation('saveFinanceDocument', {
                apartment_id,
                document: {
                    id: portalState.editingFinanceDocId || undefined,
                    kind: isIncome ? 'IN' : 'OUT',
                    doc_date: dateStr,
                    amount: amt,
                    cat,
                    vendor_name: vendor_name || (isIncome ? 'Receipt' : null),
                    description: [desc, vendor_invoice ? `Inv ${vendor_invoice}` : null].filter(Boolean).join(' · ') || null,
                    sub_category,
                    notes,
                    transaction_id: linkTxnId,
                    source: existing?.source || 'manual',
                    status: linkTxnId
                        ? 'linked'
                        : (payMode === 'unpaid' ? 'unpaid' : 'paid'),
                },
                keepAttachments,
                removeAttachments,
                newAttachmentFiles: await filesToBase64Payload(portalState.pendingReceiptFiles || []),
            });
            if (result.document) {
                if (!portalState.finances.financeDocuments) portalState.finances.financeDocuments = [];
                const list = portalState.finances.financeDocuments;
                const idx = list.findIndex((d) => d.id === result.document.id);
                if (idx >= 0) list[idx] = result.document;
                else list.unshift(result.document);
            }
            const linkedFromLedger = !!portalState.linkBillToTxnId;
            portalState.pendingReceiptFiles = [];
            portalState.pendingReceiptPaths = [];
            portalState.billKeepAttachments = [];
            portalState.editingFinanceDocId = null;
            portalState.linkBillToTxnId = null;
            document.getElementById('cash-modal').classList.remove('active');
            portalState.cashSaveTarget = 'ledger';
            if (linkedFromLedger) {
                if (typeof window.renderCashLedger === 'function') window.renderCashLedger();
                const { renderFinanceDocumentsPage } = await import('./financeDocuments.js');
                renderFinanceDocumentsPage();
            } else if (typeof window.switchView === 'function') {
                window.switchView('finance-docs');
            } else {
                const { renderFinanceDocumentsPage } = await import('./financeDocuments.js');
                renderFinanceDocumentsPage();
            }
        } catch (err) {
            alert(err?.message || 'Could not save bill / receipt.');
        }
        return;
    }

    const allocCheck = validateMaintenanceAllocations(amt, cat);
    if (allocCheck !== true) return alert(allocCheck);
    if (wallet === 'BANK') {
        const hasProof = (portalState.pendingBankProofPaths || []).length > 0
            || (portalState.pendingBankProofFiles || []).length > 0;
        if (!bank_reference && !hasProof) {
            return alert('Enter a cheque / UPI / NEFT reference, or upload bank proof.');
        }
    }

    const type = isIncome ? 'IN' : 'OUT';
    const dateStr = dateEl?.value || todayISO();
    const date = new Date(`${dateStr}T12:00:00`).toISOString();

    document.getElementById('cash-cat-select').value = cat;
    document.getElementById('cash-wallet-select').value = wallet;

    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return alert('No active apartment selected.');

    const txnId = portalState.editingTxnId || crypto.randomUUID();
    const receipt_urls = [...(portalState.pendingReceiptPaths || [])];
    const bank_proof_urls = wallet === 'BANK' ? [...(portalState.pendingBankProofPaths || [])] : [];
    const removedPaths = (portalState.originalReceiptPaths || []).filter((p) => !receipt_urls.includes(p));
    const removedBankPaths = wallet === 'BANK'
        ? (portalState.originalBankProofPaths || []).filter((p) => !bank_proof_urls.includes(p))
        : (portalState.originalBankProofPaths || []);

    const excludeFromReports = cat === BANK_REJECT_CAT
        || (isApartmentAdminUser() && document.getElementById('txn-exclude-reports')?.checked === true);

    try {
        const payload = {
            id: txnId,
            apartment_id,
            amount: amt,
            cat,
            sub_category,
            vendor_name,
            vendor_invoice,
            bank_payment_type,
            bank_reference,
            bank_proof_urls: wallet === 'BANK' ? bank_proof_urls : [],
            description: desc,
            wallet,
            type,
            date,
            exclude_from_reports: excludeFromReports,
        };
        const allocations = isIncome && cat === 'Maintenance Collection'
            ? collectAllocationDraft().rows
            : [];
        const result = await postFinanceMutation('saveTransaction', {
            apartment_id,
            transaction: payload,
            allocations,
            keepReceiptPaths: receipt_urls,
            keepBankProofPaths: bank_proof_urls,
            removeReceiptPaths: removedPaths,
            removeBankProofPaths: removedBankPaths,
            // Direct ledger receipt uploads removed — attachments live on linked bills/receipts.
            newReceiptFiles: [],
            newBankProofFiles: wallet === 'BANK' ? await filesToBase64Payload(portalState.pendingBankProofFiles || []) : [],
        });

        if (isIncome && cat === 'Maintenance Collection') {
            document.dispatchEvent(new CustomEvent('maintenance-payment-saved', {
                detail: { unitNumber: document.getElementById('maintenance-unit-input')?.value?.trim() || '' },
            }));
        }

        if (result.transaction) {
            applySavedTransactionLocally(result.transaction, { allocations });
        }

        populateVendorDatalist();
        populateSubCatDatalist(cat);
        processFinances();
        renderCashLedger();
        if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();
        if (document.getElementById('subview-reports')?.style.display !== 'none') {
            renderFinanceAnalytics();
        }
        portalState.editingTxnId = null;
        portalState.pendingReceiptPaths = [];
        portalState.pendingReceiptFiles = [];
        portalState.originalReceiptPaths = [];
        portalState.pendingBankProofPaths = [];
        portalState.pendingBankProofFiles = [];
        portalState.originalBankProofPaths = [];
        document.getElementById('cash-modal').classList.remove('active');
    } catch (err) {
        alert(err?.message || 'Could not upload receipts. Check that supabase_transactions_extras.sql has been run.');
    }
};
window.saveCashData = saveCashData;

window.previewReceiptFile = async (file) => {
    if (!file) return;
    await window.viewAttachmentGallery([file], 0);
};

window.viewReceipt = async (pathOrUrl, index = 0) => {
    if (!pathOrUrl) return;
    await window.viewAttachmentGallery([pathOrUrl], index);
};

window.viewReceipts = async (txnId, index = 0) => {
    const t = portalState.finances.txns.find((x) => x.id == txnId);
    const paths = getAllAttachmentPaths(t);
    if (!paths.length) return alert('No attachments for this expense.');
    await window.viewAttachmentGallery(paths, index);
};

window.closeReceiptViewer = () => {
    cleanupReceiptViewer();
    document.getElementById('receipt-modal')?.classList.remove('active');
};

document.getElementById('receipt-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'receipt-modal') window.closeReceiptViewer();
});

const openExpenseFormDefaults = (wallet = 'CASH') => {
    document.getElementById('cash-amt').value = '';
    document.getElementById('cash-desc').value = '';
    document.getElementById('expense-vendor-input').value = '';
    document.getElementById('expense-invoice-input').value = '';
    const billInv = document.getElementById('bill-invoice-input');
    if (billInv) billInv.value = '';
    document.getElementById('cash-date').value = todayISO();
    document.getElementById('expense-cat-input').value = labelForCat('Maintenance');
    document.getElementById('expense-subcat-input').value = '';
    populateSubCatDatalist('Maintenance');
    populateVendorDatalist();
    syncWalletPills('expense-wallet-pills', wallet);
    syncBankTypePills('CHEQUE');
    document.getElementById('expense-bank-ref').value = '';
    resetBankProofUI([]);
    syncExpenseWalletUI();
    document.getElementById('cash-cat-select').value = 'Maintenance';
    document.getElementById('cash-wallet-select').value = wallet;
    resetReceiptUI([]);
    const excludeEl = document.getElementById('txn-exclude-reports');
    if (excludeEl) excludeEl.checked = false;
};

const openIncomeFormDefaults = (wallet = 'CASH', catKey = 'Maintenance Collection') => {
    document.getElementById('income-amt').value = '';
    document.getElementById('income-desc').value = '';
    document.getElementById('income-date').value = todayISO();
    document.getElementById('income-cat-input').value = labelForCat(catKey);
    document.getElementById('maintenance-unit-input').value = '';
    document.getElementById('income-vendor-input').value = '';
    document.getElementById('income-reference-input').value = '';
    const billInv = document.getElementById('bill-invoice-input');
    if (billInv) billInv.value = '';
    const incomeBillInv = document.getElementById('income-bill-invoice-input');
    if (incomeBillInv) incomeBillInv.value = '';
    syncWalletPills('income-wallet-pills', wallet);
    syncBankTypePills('CHEQUE');
    document.getElementById('income-bank-ref').value = '';
    resetBankProofUI([]);
    syncBankWalletUI();
    document.getElementById('cash-cat-select').value = catKey;
    document.getElementById('cash-wallet-select').value = wallet;
    resetReceiptUI([]);
    syncMaintenanceIncomeSection(catKey);
    syncIncomeExtraSection(catKey);
    const excludeEl = document.getElementById('txn-exclude-reports');
    if (excludeEl) excludeEl.checked = false;
};

const getBillPaymentMode = () => {
    const active = document.querySelector('#bill-payment-pills .expense-wallet-pill.active')?.dataset?.billPay;
    if (active === 'cheque' || active === 'cash' || active === 'online' || active === 'unpaid') return active;
    return 'unpaid';
};

const syncBillPaymentUI = (mode = 'unpaid', opts = {}) => {
    const options = typeof opts === 'string' ? { chequeNo: opts } : (opts || {});
    const chequeNo = options.chequeNo || '';
    const onlineRef = options.onlineRef || '';
    const paidOn = options.paidOn || '';
    const pills = document.getElementById('bill-payment-pills');
    const chequeWrap = document.getElementById('bill-cheque-wrap');
    const chequeInput = document.getElementById('bill-cheque-no');
    const onlineWrap = document.getElementById('bill-online-wrap');
    const onlineInput = document.getElementById('bill-online-ref');
    const dateWrap = document.getElementById('bill-paid-date-wrap');
    const dateInput = document.getElementById('bill-paid-date');
    const pay = ['cheque', 'cash', 'online', 'unpaid'].includes(mode) ? mode : 'unpaid';
    const isPaid = pay === 'cheque' || pay === 'cash' || pay === 'online';
    pills?.querySelectorAll('[data-bill-pay]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.billPay === pay);
    });
    if (chequeWrap) chequeWrap.hidden = pay !== 'cheque';
    if (chequeInput) chequeInput.value = pay === 'cheque' ? chequeNo : '';
    if (onlineWrap) onlineWrap.hidden = pay !== 'online';
    if (onlineInput) onlineInput.value = pay === 'online' ? onlineRef : '';
    if (dateWrap) dateWrap.hidden = !isPaid;
    if (dateInput) {
        if (isPaid) {
            dateInput.value = paidOn || dateInput.value || todayISO();
        } else {
            dateInput.value = '';
        }
    }
};

const billPaymentNotes = (mode, chequeNo = '', onlineRef = '', paidOn = '') => {
    let base = 'Payment: Unpaid';
    if (mode === 'cheque') base = `Cheque: ${chequeNo}`;
    else if (mode === 'online') base = onlineRef ? `Online: ${onlineRef}` : 'Payment: Online';
    else if (mode === 'cash') base = 'Payment: Cash';
    if (mode !== 'unpaid' && paidOn) return `${base}\nPaid on: ${String(paidOn).slice(0, 10)}`;
    return base;
};

const parseBillPaymentFromNotes = (notes = '') => {
    const text = String(notes || '');
    const paidOnMatch = text.match(/Paid on:\s*(\d{4}-\d{2}-\d{2})/i);
    const paidOn = paidOnMatch ? paidOnMatch[1] : '';
    const chequeMatch = text.match(/^Cheque:\s*(.+)$/im);
    if (chequeMatch) {
        return { mode: 'cheque', chequeNo: chequeMatch[1].trim().split('\n')[0].trim(), onlineRef: '', paidOn };
    }
    const onlineMatch = text.match(/^Online:\s*(.+)$/im);
    if (onlineMatch) {
        return { mode: 'online', chequeNo: '', onlineRef: onlineMatch[1].trim().split('\n')[0].trim(), paidOn };
    }
    if (/Payment:\s*Online/i.test(text)) return { mode: 'online', chequeNo: '', onlineRef: '', paidOn };
    if (/Payment:\s*Cash/i.test(text)) return { mode: 'cash', chequeNo: '', onlineRef: '', paidOn };
    if (/Payment:\s*Unpaid/i.test(text)) return { mode: 'unpaid', chequeNo: '', onlineRef: '', paidOn: '' };
    if (!text.trim()) return { mode: 'unpaid', chequeNo: '', onlineRef: '', paidOn: '' };
    return { mode: 'unpaid', chequeNo: '', onlineRef: '', paidOn: '' };
};

const billAttachmentKey = (entry) => {
    if (!entry) return '';
    if (typeof entry === 'object' && entry.key) return String(entry.key);
    if (typeof entry === 'string') return entry.replace(/^r2:/, '');
    return '';
};

const billAttachmentLabel = (entry, i = 0) => {
    if (entry && typeof entry === 'object') {
        return entry.originalName || String(entry.key || '').split('/').pop() || `file-${i + 1}`;
    }
    return String(entry || '').split('/').pop() || `file-${i + 1}`;
};

const resetBillAttachmentUI = (attachments = []) => {
    portalState.billKeepAttachments = Array.isArray(attachments) ? [...attachments] : [];
    portalState.pendingReceiptFiles = [];
    portalState.pendingReceiptPaths = [];
    portalState.originalReceiptPaths = [];
    renderReceiptUI();
};

const applyCashModalChrome = ({ isIncome, isBill }) => {
    const modal = document.getElementById('cash-modal');
    const walletSection = document.querySelector('#expense-form-view .expense-form__section--wallet');
    const bankSection = document.getElementById('expense-bank-section');
    const incomeWallet = document.querySelector('#income-form-view .expense-form__section--wallet');
    const incomeBank = document.getElementById('income-bank-section');
    const excludeWrap = document.querySelector('.expense-form__exclude-reports');
    const receiptHint = document.getElementById('cash-receipt-hint');
    const billPay = document.getElementById('bill-payment-section');
    const billDocs = document.getElementById('bill-documents-section');
    const expenseInvoiceWrap = document.getElementById('expense-invoice-wrap');
    const billInvoiceWrap = document.getElementById('bill-invoice-wrap');
    const incomeBillInvoiceWrap = document.getElementById('income-bill-invoice-wrap');
    const billInvoiceLabel = document.getElementById('bill-invoice-label');
    const payTitle = document.getElementById('bill-payment-title');
    const payDesc = document.getElementById('bill-payment-desc');
    const docsTitle = billDocs?.querySelector('.bill-docs__title');
    const docsDesc = billDocs?.querySelector('.bill-docs__desc');

    modal?.classList.toggle('cash-modal--bill', !!isBill);
    modal?.classList.toggle('cash-modal--ledger', !isBill);

    if (billDocs) billDocs.hidden = !isBill;
    if (walletSection) walletSection.hidden = !!isBill;
    if (bankSection && isBill) bankSection.hidden = true;
    if (incomeWallet) incomeWallet.hidden = !!isBill;
    if (incomeBank && isBill) incomeBank.hidden = true;
    if (excludeWrap) {
        excludeWrap.hidden = !!isBill || !isApartmentAdminUser();
        if (isBill) excludeWrap.style.display = 'none';
        else excludeWrap.style.removeProperty('display');
    }
    if (expenseInvoiceWrap) expenseInvoiceWrap.hidden = !!isBill;
    if (billInvoiceWrap) billInvoiceWrap.hidden = !(isBill && !isIncome);
    if (incomeBillInvoiceWrap) incomeBillInvoiceWrap.hidden = !(isBill && isIncome);

    document.querySelectorAll('.bill-details-step').forEach((el) => {
        el.hidden = !isBill;
    });

    if (billPay) {
        billPay.hidden = !isBill;
        billPay.style.display = isBill ? 'block' : 'none';
    }

    if (isBill && docsTitle && docsDesc) {
        if (isIncome) {
            docsTitle.textContent = 'Attachments';
            docsDesc.textContent = 'Receipt, payment proof, or other files — photos or PDFs, multiple allowed.';
        } else {
            docsTitle.textContent = 'Attachments';
            docsDesc.textContent = 'Invoice, payment proof, cheque photo, or transfer screenshot — photos or PDFs, multiple allowed.';
        }
    }

    if (payTitle && payDesc) {
        if (isIncome) {
            payTitle.textContent = 'Money received?';
            payDesc.textContent = 'Mark how funds arrived, or leave unpaid if this is only an acknowledgement for now.';
            const unpaidBtn = billPay?.querySelector('[data-bill-pay="unpaid"]');
            const cashBtn = billPay?.querySelector('[data-bill-pay="cash"]');
            const chequeBtn = billPay?.querySelector('[data-bill-pay="cheque"]');
            const onlineBtn = billPay?.querySelector('[data-bill-pay="online"]');
            if (unpaidBtn) unpaidBtn.innerHTML = '<i class="fa-solid fa-clock"></i> Not yet';
            if (cashBtn) cashBtn.innerHTML = '<i class="fa-solid fa-money-bill-wave"></i> Cash in';
            if (chequeBtn) chequeBtn.innerHTML = '<i class="fa-solid fa-money-check"></i> Cheque in';
            if (onlineBtn) onlineBtn.innerHTML = '<i class="fa-solid fa-mobile-screen"></i> Online in';
        } else {
            payTitle.textContent = 'Payment status';
            payDesc.textContent = 'Already paid, or leave unpaid until cash / bank is linked later?';
            const unpaidBtn = billPay?.querySelector('[data-bill-pay="unpaid"]');
            const cashBtn = billPay?.querySelector('[data-bill-pay="cash"]');
            const chequeBtn = billPay?.querySelector('[data-bill-pay="cheque"]');
            const onlineBtn = billPay?.querySelector('[data-bill-pay="online"]');
            if (unpaidBtn) unpaidBtn.innerHTML = '<i class="fa-solid fa-clock"></i> Unpaid';
            if (cashBtn) cashBtn.innerHTML = '<i class="fa-solid fa-money-bill-wave"></i> Paid · Cash';
            if (chequeBtn) chequeBtn.innerHTML = '<i class="fa-solid fa-money-check"></i> Paid · Cheque';
            if (onlineBtn) onlineBtn.innerHTML = '<i class="fa-solid fa-mobile-screen"></i> Paid · Online';
        }
    }

    if (billInvoiceLabel) {
        billInvoiceLabel.innerHTML = 'Invoice # <span class="expense-optional">(optional)</span>';
    }
    if (receiptHint) {
        receiptHint.textContent = 'Images or PDFs · invoice and payment proof';
    }

    if (!isBill) {
        if (!isIncome) syncExpenseWalletUI();
        else syncBankWalletUI();
    }
};

const readBillInvoiceNumber = () => {
    if (portalState.cashSaveTarget === 'bill') {
        if (portalState.cashModalMode === 'income') {
            return document.getElementById('income-bill-invoice-input')?.value?.trim()
                || document.getElementById('bill-invoice-input')?.value?.trim()
                || null;
        }
        return document.getElementById('bill-invoice-input')?.value?.trim() || null;
    }
    return document.getElementById('expense-invoice-input')?.value?.trim() || null;
};

const parseInvoiceFromDescription = (description = '') => {
    const match = String(description || '').match(/\bInv\s+([^·]+)/i);
    return match ? match[1].trim() : '';
};

const stripInvoiceFromDescription = (description = '') => {
    return String(description || '')
        .replace(/\s*·\s*Inv\s+[^·]+/gi, '')
        .replace(/^Inv\s+[^·]+(?:\s*·\s*)?/i, '')
        .trim();
};

window.openExpense = (wallet = 'CASH', { asBill = true } = {}) => {
    const modal = document.getElementById('cash-modal');
    if (!modal) return;
    portalState.editingTxnId = null;
    portalState.editingFinanceDocId = null;
    portalState.linkBillToTxnId = null;
    portalState.cashModalMode = 'expense';
    portalState.cashSaveTarget = asBill ? 'bill' : 'ledger';

    document.getElementById('expense-form-view').style.display = 'grid';
    document.getElementById('income-form-view').style.display = 'none';
    if (asBill) {
        document.getElementById('cash-modal-title').textContent = 'Add bill';
        document.getElementById('cash-modal-desc').textContent = 'Fill details from the invoice, mark paid or unpaid, and attach invoice or payment proof.';
        document.getElementById('save-cash-btn').textContent = 'Save bill';
        syncBillPaymentUI('unpaid');
        resetBillAttachmentUI([]);
    } else {
        document.getElementById('cash-modal-title').textContent = 'Add Expense';
        document.getElementById('cash-modal-desc').textContent = 'Record money spent from petty cash or the bank account.';
        document.getElementById('save-cash-btn').textContent = 'Save Expense';
    }

    openExpenseFormDefaults(wallet);
    if (asBill) resetBillAttachmentUI([]);
    applyCashModalChrome({ isIncome: false, isBill: asBill });
    setBillModalReadOnly(false);
    modal.classList.add('active');
    setTimeout(() => {
        if (asBill) document.getElementById('cash-amt')?.focus();
        else document.getElementById('cash-amt')?.focus();
    }, 50);
};

window.openIncome = (wallet = 'CASH', { asBill = true } = {}) => {
    const modal = document.getElementById('cash-modal');
    if (!modal) return;
    portalState.editingTxnId = null;
    portalState.editingFinanceDocId = null;
    portalState.linkBillToTxnId = null;
    portalState.cashModalMode = 'income';
    portalState.cashSaveTarget = asBill ? 'bill' : 'ledger';

    document.getElementById('expense-form-view').style.display = 'none';
    document.getElementById('income-form-view').style.display = 'grid';
    if (asBill) {
        document.getElementById('cash-modal-title').textContent = 'Add receipt';
        document.getElementById('cash-modal-desc').textContent = 'Fill details from the receipt, mark how money arrived, and attach files if needed.';
        document.getElementById('save-cash-btn').textContent = 'Save receipt';
        syncBillPaymentUI('cash');
        resetBillAttachmentUI([]);
    } else {
        document.getElementById('cash-modal-title').textContent = 'Record Income';
        document.getElementById('cash-modal-desc').textContent = 'Top up petty cash or record money received into the bank.';
        document.getElementById('save-cash-btn').textContent = 'Save Income';
    }

    openIncomeFormDefaults(wallet);
    if (asBill) resetBillAttachmentUI([]);
    applyCashModalChrome({ isIncome: true, isBill: asBill });
    setBillModalReadOnly(false);
    modal.classList.add('active');
    setTimeout(() => document.getElementById('income-amt')?.focus(), 50);
};

window.openBillExpense = () => window.openExpense('CASH', { asBill: true });
window.openBillIncome = () => window.openIncome('CASH', { asBill: true });

/** Edit / view an existing finance document in the same Add bill / Add receipt modal. */
window.openFinanceDocumentEdit = (doc, { readOnly = false } = {}) => {
    if (!doc) return;
    const modal = document.getElementById('cash-modal');
    if (!modal) return;
    const isIncome = doc.kind === 'IN';
    portalState.editingTxnId = null;
    portalState.editingFinanceDocId = doc.id;
    portalState.linkBillToTxnId = null;
    portalState.cashModalMode = isIncome ? 'income' : 'expense';
    portalState.cashSaveTarget = 'bill';
    portalState.billModalReadOnly = !!readOnly;

    document.getElementById('expense-form-view').style.display = isIncome ? 'none' : 'grid';
    document.getElementById('income-form-view').style.display = isIncome ? 'grid' : 'none';
    if (readOnly) {
        document.getElementById('cash-modal-title').textContent = isIncome ? 'Receipt details' : 'Bill details';
        document.getElementById('cash-modal-desc').textContent = 'Same form as Bills & receipts. Switch to Edit to make changes.';
    } else {
        document.getElementById('cash-modal-title').textContent = isIncome ? 'Edit receipt' : 'Edit bill';
        document.getElementById('cash-modal-desc').textContent = isIncome
            ? 'Update this receipt. Change payment status or add files if needed.'
            : 'Update category and payment status. Attach invoice or payment proof in Attachments.';
        document.getElementById('save-cash-btn').textContent = 'Save changes';
    }

    const invFromDesc = parseInvoiceFromDescription(doc.description);
    const cleanDesc = stripInvoiceFromDescription(doc.description);

    if (isIncome) {
        openIncomeFormDefaults('CASH', doc.cat || 'Other Income');
        document.getElementById('income-amt').value = doc.amount ?? '';
        document.getElementById('income-date').value = String(doc.doc_date || '').slice(0, 10);
        document.getElementById('income-desc').value = cleanDesc;
        document.getElementById('income-cat-input').value = labelForCat(doc.cat || 'Other Income');
        document.getElementById('income-vendor-input').value = doc.vendor_name || '';
        document.getElementById('cash-cat-select').value = doc.cat || 'Other Income';
        syncMaintenanceIncomeSection(doc.cat || 'Other Income');
        syncIncomeExtraSection(doc.cat || 'Other Income');
    } else {
        openExpenseFormDefaults('CASH');
        document.getElementById('cash-amt').value = doc.amount ?? '';
        document.getElementById('cash-date').value = String(doc.doc_date || '').slice(0, 10);
        document.getElementById('cash-desc').value = cleanDesc;
        document.getElementById('expense-cat-input').value = labelForCat(doc.cat || 'Other');
        document.getElementById('expense-subcat-input').value = doc.sub_category || '';
        document.getElementById('expense-vendor-input').value = doc.vendor_name || '';
        document.getElementById('expense-invoice-input').value = invFromDesc;
        document.getElementById('cash-cat-select').value = doc.cat || 'Other';
        populateSubCatDatalist(doc.cat || 'Other');
        populateVendorDatalist();
    }

    const billInv = document.getElementById('bill-invoice-input');
    if (billInv) billInv.value = invFromDesc;
    const incomeBillInv = document.getElementById('income-bill-invoice-input');
    if (incomeBillInv) incomeBillInv.value = invFromDesc;

    const pay = parseBillPaymentFromNotes(doc.notes);
    syncBillPaymentUI(pay.mode, {
        chequeNo: pay.chequeNo,
        onlineRef: pay.onlineRef,
        paidOn: pay.paidOn || '',
    });

    resetBillAttachmentUI(Array.isArray(doc.attachment_urls) ? doc.attachment_urls : []);
    applyCashModalChrome({ isIncome, isBill: true });
    setBillModalReadOnly(!!readOnly);
    modal.classList.add('active');
    if (!readOnly) {
        setTimeout(() => document.getElementById(isIncome ? 'income-amt' : 'cash-amt')?.focus(), 50);
    }
};

window.openFinanceDocumentView = (doc) => window.openFinanceDocumentEdit(doc, { readOnly: true });

const setBillModalReadOnly = (readOnly) => {
    const modal = document.getElementById('cash-modal');
    if (!modal) return;
    modal.classList.toggle('cash-modal--readonly', !!readOnly);
    const fields = modal.querySelectorAll('input, textarea, select, button.expense-wallet-pill, button.expense-bank-pill');
    fields.forEach((el) => {
        if (el.id === 'save-cash-btn' || el.id === 'cash-modal-unlock-btn') return;
        if (el.closest('.expense-modal__close') || el.getAttribute('onclick')?.includes('cash-modal')) return;
        if (el.type === 'checkbox' && el.id === 'txn-exclude-reports') {
            el.disabled = !!readOnly;
            return;
        }
        if (el.tagName === 'BUTTON') {
            el.disabled = !!readOnly;
            return;
        }
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            if (el.type === 'file') el.disabled = !!readOnly;
            else el.readOnly = !!readOnly;
        } else {
            el.disabled = !!readOnly;
        }
    });
    // Keep close / cancel usable
    modal.querySelectorAll('.expense-modal__close, .expense-modal__footer-actions .btn-outline').forEach((btn) => {
        if (btn.id === 'cash-modal-unlock-btn') return;
        btn.disabled = false;
    });
    const saveBtn = document.getElementById('save-cash-btn');
    const unlockBtn = document.getElementById('cash-modal-unlock-btn');
    if (saveBtn) saveBtn.hidden = !!readOnly;
    if (unlockBtn) {
        unlockBtn.hidden = !readOnly;
        unlockBtn.disabled = false;
    }
    // Attachment remove: allow view, block remove in readonly
    modal.querySelectorAll('#cash-receipt-list .expense-link-btn, .expense-attach-card__remove').forEach((btn) => {
        const isRemove = btn.classList.contains('expense-attach-card__remove') || /remove/i.test(btn.textContent || '');
        btn.disabled = !!readOnly && isRemove;
        btn.hidden = !!readOnly && isRemove;
    });
};

window.openBankSnapshot = () => {
    window.openIncome('BANK', { asBill: false });
    document.getElementById('income-cat-input').value = labelForCat('Reconcile');
    document.getElementById('cash-cat-select').value = 'Reconcile';
    document.getElementById('cash-modal-title').textContent = 'Bank Sync';
    document.getElementById('cash-modal-desc').textContent = 'Reconcile passbook balance with the ledger.';
    document.getElementById('save-cash-btn').textContent = 'Save Sync';
    syncBankWalletUI();
    syncMaintenanceIncomeSection('Reconcile');
    syncIncomeExtraSection('Reconcile');
};

window.openCash = (direction = 'OUT', wallet = 'CASH') => {
    if ((direction || 'OUT').toUpperCase() === 'IN') window.openIncome(wallet, { asBill: true });
    else window.openExpense(wallet, { asBill: true });
};

const populateLedgerLineCatDatalist = (isIncome) => {
    const dl = document.getElementById('ledger-line-cat-datalist');
    if (!dl) return;
    const cats = isIncome ? INCOME_CATS : EXPENSE_CATS;
    dl.innerHTML = cats.map((c) => `<option value="${categoryDisplayLabel(c)}"></option>`).join('');
};

const openLedgerLineModal = (mode = 'expense', txn = null) => {
    const modal = document.getElementById('ledger-line-modal');
    if (!modal) return;
    const isIncome = mode === 'income' || txn?.type === 'IN';
    portalState.ledgerLineMode = isIncome ? 'income' : 'expense';
    portalState.editingTxnId = txn?.id || null;

    const editing = !!txn?.id;
    document.getElementById('ledger-line-title').textContent = editing
        ? (isIncome ? 'Edit income' : 'Edit expense')
        : (isIncome ? 'Record ledger income' : 'Add ledger expense');
    document.getElementById('ledger-line-desc').textContent = editing
        ? 'Update this passbook line. Bills & receipts use the invoice button on the row.'
        : (isIncome
            ? 'Passbook credit. Bills & receipts use the invoice button on the row.'
            : 'Passbook debit. Bills & receipts use the invoice button on the row.');
    document.getElementById('ledger-line-save-btn').textContent = editing ? 'Save changes' : 'Save ledger line';

    document.getElementById('ledger-line-amt').value = txn ? (txn.amount ?? '') : '';
    document.getElementById('ledger-line-date').value = txn?.date
        ? new Date(txn.date).toISOString().slice(0, 10)
        : todayISO();
    document.getElementById('ledger-line-desc-input').value = txn?.description || '';
    document.getElementById('ledger-line-bank-ref').value = txn?.bank_reference || '';
    document.getElementById('ledger-line-exclude-reports').checked = !!txn?.exclude_from_reports;
    document.getElementById('ledger-line-cat').value = labelForCat(
        txn?.cat || (isIncome ? 'Other Income' : 'Other'),
    );
    populateLedgerLineCatDatalist(isIncome);
    const wallet = txn?.wallet || 'BANK';
    syncWalletPills('ledger-line-wallet-pills', wallet);
    const refWrap = document.getElementById('ledger-line-bank-ref-wrap');
    if (refWrap) refWrap.hidden = wallet !== 'BANK';
    const excludeEl = document.getElementById('ledger-line-exclude-reports');
    const excludeWrap = excludeEl?.closest('.ledger-line-form__exclude');
    if (excludeWrap) excludeWrap.hidden = !isApartmentAdminUser();
    if (excludeEl && !isApartmentAdminUser()) excludeEl.checked = false;
    const billBtn = document.getElementById('ledger-line-bill-btn');
    if (billBtn) billBtn.hidden = !editing;
    modal.classList.add('active');
    setTimeout(() => document.getElementById('ledger-line-amt')?.focus(), 50);
};

/** Open Add bill / Add receipt form; on save it links to the ledger line being edited. */
const openBillReceiptFromLedgerLine = () => {
    const txnId = portalState.editingTxnId;
    if (!txnId) {
        alert('Save the ledger line first, then add a bill or receipt.');
        return;
    }
    const isIncome = portalState.ledgerLineMode === 'income';
    const wallet = getActiveWallet('ledger-line-wallet-pills');
    const amt = document.getElementById('ledger-line-amt')?.value || '';
    const dateVal = document.getElementById('ledger-line-date')?.value || todayISO();
    const catLabel = document.getElementById('ledger-line-cat')?.value || '';
    const narration = document.getElementById('ledger-line-desc-input')?.value || '';
    const bankRef = document.getElementById('ledger-line-bank-ref')?.value || '';

    document.getElementById('ledger-line-modal')?.classList.remove('active');

    if (isIncome) {
        window.openIncome(wallet === 'BANK' ? 'BANK' : 'CASH', { asBill: true });
        portalState.linkBillToTxnId = txnId;
        document.getElementById('cash-modal-title').textContent = 'Add receipt';
        document.getElementById('cash-modal-desc').textContent = 'Save to link this receipt to the ledger line.';
        document.getElementById('income-amt').value = amt;
        document.getElementById('income-date').value = dateVal;
        document.getElementById('income-desc').value = narration;
        document.getElementById('income-cat-input').value = catLabel || labelForCat('Other Income');
        const cat = resolveCategory(catLabel, INCOME_CATS);
        document.getElementById('cash-cat-select').value = cat;
        syncMaintenanceIncomeSection(cat);
        syncIncomeExtraSection(cat);
        if (wallet === 'BANK' && bankRef) {
            syncBillPaymentUI('online', { onlineRef: bankRef, paidOn: dateVal });
        } else if (wallet === 'CASH') {
            syncBillPaymentUI('cash', { paidOn: dateVal });
        } else {
            syncBillPaymentUI('cheque', { chequeNo: bankRef, paidOn: dateVal });
        }
    } else {
        window.openExpense(wallet === 'BANK' ? 'BANK' : 'CASH', { asBill: true });
        portalState.linkBillToTxnId = txnId;
        document.getElementById('cash-modal-title').textContent = 'Add bill';
        document.getElementById('cash-modal-desc').textContent = 'Save to link this bill to the ledger line.';
        document.getElementById('cash-amt').value = amt;
        document.getElementById('cash-date').value = dateVal;
        document.getElementById('cash-desc').value = narration;
        document.getElementById('expense-cat-input').value = catLabel || labelForCat('Other');
        const cat = resolveCategory(catLabel, EXPENSE_CATS);
        document.getElementById('cash-cat-select').value = cat;
        populateSubCatDatalist(cat);
        if (wallet === 'BANK' && bankRef) {
            syncBillPaymentUI('cheque', { chequeNo: bankRef, paidOn: dateVal });
        } else if (wallet === 'CASH') {
            syncBillPaymentUI('cash', { paidOn: dateVal });
        } else {
            syncBillPaymentUI('unpaid');
        }
    }
    setBillModalReadOnly(false);
};

window.openLedgerExpense = () => openLedgerLineModal('expense');
window.openLedgerIncome = () => openLedgerLineModal('income');

export const saveLedgerLineData = async () => {
    const isIncome = portalState.ledgerLineMode === 'income';
    const amt = parseFloat(document.getElementById('ledger-line-amt')?.value);
    const dateStr = document.getElementById('ledger-line-date')?.value || todayISO();
    const desc = document.getElementById('ledger-line-desc-input')?.value?.trim() || null;
    const cat = resolveCategory(
        document.getElementById('ledger-line-cat')?.value,
        isIncome ? INCOME_CATS : EXPENSE_CATS,
    );
    const wallet = getActiveWallet('ledger-line-wallet-pills');
    const bank_reference = wallet === 'BANK'
        ? (document.getElementById('ledger-line-bank-ref')?.value?.trim() || null)
        : null;
    const excludeFromReports = cat === BANK_REJECT_CAT
        || (isApartmentAdminUser() && document.getElementById('ledger-line-exclude-reports')?.checked === true);

    if (isNaN(amt) || amt <= 0) return alert('Enter a valid amount.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return alert('No active apartment selected.');

    const editingId = portalState.editingTxnId;
    const existing = editingId
        ? (portalState.finances.txns || []).find((t) => t.id === editingId)
        : null;

    try {
        const result = await postFinanceMutation('saveTransaction', {
            apartment_id,
            transaction: {
                id: editingId || crypto.randomUUID(),
                apartment_id,
                amount: amt,
                cat,
                sub_category: existing?.sub_category || null,
                vendor_name: existing?.vendor_name || null,
                vendor_invoice: existing?.vendor_invoice || null,
                description: desc,
                wallet,
                type: isIncome ? 'IN' : 'OUT',
                date: new Date(`${dateStr}T12:00:00`).toISOString(),
                bank_payment_type: wallet === 'BANK'
                    ? (existing?.bank_payment_type || 'NEFT')
                    : null,
                bank_reference,
                exclude_from_reports: excludeFromReports,
                receipt_urls: existing ? getReceiptPaths(existing) : [],
                bank_proof_urls: existing && wallet === 'BANK' ? getBankProofPaths(existing) : [],
            },
            allocations: [],
            keepReceiptPaths: existing ? getReceiptPaths(existing) : [],
            keepBankProofPaths: existing && wallet === 'BANK' ? getBankProofPaths(existing) : [],
            removeReceiptPaths: [],
            removeBankProofPaths: existing && wallet !== 'BANK' ? getBankProofPaths(existing) : [],
            newReceiptFiles: [],
            newBankProofFiles: [],
        });
        if (result.transaction) applySavedTransactionLocally(result.transaction);
        processFinances();
        renderCashLedger();
        portalState.editingTxnId = null;
        document.getElementById('ledger-line-modal')?.classList.remove('active');
    } catch (err) {
        alert(err?.message || 'Could not save ledger line.');
    }
};
window.saveLedgerLineData = saveLedgerLineData;

export const syncAccountsHeaderActions = (sv) => {
    const bills = sv === 'finance-docs';
    const ledger = sv === 'ledger' || sv === 'bank-recon';
    const standalone = sv === 'activity';
    document.querySelectorAll('[data-accounts-actions]').forEach((el) => {
        const kind = el.dataset.accountsActions;
        if (kind === 'bills') el.hidden = !bills;
        else if (kind === 'ledger') el.hidden = !ledger;
    });
    // Bank Sync is ledger/admin — hide unless the user can view/edit accounts (fail closed).
    const canUseBankSync = hasClientPermission('accounts.edit') || hasClientPermission('accounts.view');
    const bankSync = document.getElementById('btn-accounts-bank-sync')
        || document.querySelector('#accounts-header-actions [onclick*="openBankSnapshot"]');
    if (bankSync) bankSync.hidden = standalone || !canUseBankSync;

    // Activity Log is Administration — hide the Finance tab strip there.
    const tabs = document.querySelector('.accounts-subview-tabs');
    if (tabs) tabs.hidden = standalone;

    const help = ACCOUNTS_PAGE_HELP[sv] || ACCOUNTS_PAGE_HELP.ledger;
    applyFinancePageHeader({
        titleId: 'accounts-page-title',
        descId: 'accounts-page-desc',
        help: standalone
            ? ACCOUNTS_PAGE_HELP.activity
            : help,
    });
    // Close help when switching tabs so content isn't stale under the wrong title.
    const helpPop = document.getElementById('accounts-page-help');
    const helpBtn = document.getElementById('accounts-page-help-btn');
    if (helpPop && !helpPop.hidden) {
        helpPop.hidden = true;
        helpBtn?.setAttribute('aria-expanded', 'false');
    }
};
window.syncAccountsHeaderActions = syncAccountsHeaderActions;

const escTabLabel = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Build top tabs from the same Finance nav list as the sidebar. */
export const renderAccountsSubviewTabs = (activeSubview = 'ledger') => {
    const nav = document.querySelector('.accounts-subview-tabs');
    if (!nav) return;
    const pages = getFinanceAccountsPages();
    nav.innerHTML = pages.map((page) => {
        const active = page.subview === activeSubview;
        return `
          <button type="button"${active ? ' class="active" aria-current="page"' : ''} data-accounts-subview="${page.subview}">
            <i class="fa-solid ${page.icon}" aria-hidden="true"></i>
            <span>${escTabLabel(page.label)}</span>
          </button>`;
    }).join('');
};

const wireAccountsHeaderActionButtons = () => {
    const root = document.getElementById('accounts-header-actions');
    if (!root || root.dataset.wired === '1') return;
    root.dataset.wired = '1';
    document.getElementById('btn-ledger-add-expense')?.addEventListener('click', () => window.openLedgerExpense());
    document.getElementById('btn-ledger-add-income')?.addEventListener('click', () => window.openLedgerIncome());
    document.getElementById('btn-bill-add-expense')?.addEventListener('click', () => window.openBillExpense());
    document.getElementById('btn-bill-add-income')?.addEventListener('click', () => window.openBillIncome());
    document.getElementById('ledger-line-save-btn')?.addEventListener('click', () => {
        void withButtonBusy(document.getElementById('ledger-line-save-btn'), 'Saving…', saveLedgerLineData);
    });
    document.getElementById('ledger-line-bill-btn')?.addEventListener('click', () => {
        openBillReceiptFromLedgerLine();
    });
    document.getElementById('ledger-line-wallet-pills')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-wallet]');
        if (!btn) return;
        syncWalletPills('ledger-line-wallet-pills', btn.dataset.wallet);
        const refWrap = document.getElementById('ledger-line-bank-ref-wrap');
        if (refWrap) refWrap.hidden = btn.dataset.wallet !== 'BANK';
    });
};

export const delTxn = async (id) => {
    if (!canCrud('accounts', 'delete')) {
        alert('You do not have permission to delete ledger entries.');
        return;
    }
    if (confirm('Delete Record?')) {
        await postFinanceMutation('deleteTransaction', {
            apartment_id: portalState.access?.activeApartmentId,
            transaction_id: id,
        });
        removeTransactionLocally(id);
        processFinances();
        renderCashLedger();
        if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();
        if (document.getElementById('subview-reports')?.style.display !== 'none') {
            renderFinanceAnalytics();
        }
    }
};
window.delTxn = delTxn;

window.editTxn = (id) => {
    const t = portalState.finances.txns.find((x) => x.id == id);
    if (!t) return;
    // Ledger edit uses the lean passbook modal — not the bill/receipt form.
    openLedgerLineModal(t.type === 'IN' ? 'income' : 'expense', t);
};

const ROUTE_TO_ACCOUNTS_SUBVIEW = Object.fromEntries(
    Object.entries(ACCOUNTS_SUBVIEW_ROUTES).map(([subview, route]) => [route, subview]),
);

export const syncAccountsSubViewTabs = (route) => {
    const subview = ROUTE_TO_ACCOUNTS_SUBVIEW[route] || 'ledger';
    const nav = document.querySelector('.accounts-subview-tabs');
    if (nav && !nav.querySelector('[data-accounts-subview]')) {
        renderAccountsSubviewTabs(subview);
        wireAccountsSubviewTabClicks();
    }
    document.querySelectorAll('[data-accounts-subview]').forEach((btn) => {
        const active = btn.dataset.accountsSubview === subview;
        btn.classList.toggle('active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
    });
};

const wireAccountsSubviewTabClicks = () => {
    document.querySelectorAll('[data-accounts-subview]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
            const route = ACCOUNTS_SUBVIEW_ROUTES[btn.dataset.accountsSubview];
            if (route && typeof window.switchView === 'function') window.switchView(route);
        });
    });
};

export const initAccountsSubViewTabs = () => {
    renderAccountsSubviewTabs('ledger');
    wireAccountsSubviewTabClicks();
    // Tabs are lazy-mounted with the accounts view — re-apply after they exist so
    // the strip matches sidebar permission filtering (e.g. bills_entry-only roles).
    applyNavPermissions(new Set(portalState.authPermissions || []), !supabase);
    initLedgerTableControls();
    initLedgerBulkBar();
    wireAccountsHeaderActionButtons();
    wireFinancePageHelp({
        btnId: 'accounts-page-help-btn',
        popoverId: 'accounts-page-help',
        getHelp: () => {
            const active = document.querySelector('[data-accounts-subview].active')?.dataset?.accountsSubview;
            const tabsHidden = document.querySelector('.accounts-subview-tabs')?.hidden;
            if (tabsHidden) return ACCOUNTS_PAGE_HELP.activity;
            return ACCOUNTS_PAGE_HELP[active] || ACCOUNTS_PAGE_HELP.ledger;
        },
    });
    syncAccountsHeaderActions('ledger');

    if (!document.documentElement.dataset.crudAccessLedgerWired) {
        document.documentElement.dataset.crudAccessLedgerWired = '1';
        document.addEventListener('crud-access-loaded', () => {
            if (!document.getElementById('view-accounts') && !document.getElementById('view-invoices')) return;
            void (async () => {
                try {
                    const { syncLedgerBulkBar } = await import('./ledgerTable.js');
                    syncLedgerBulkBar();
                } catch { /* ignore */ }
                window.renderCashLedger?.();
                try {
                    const { renderFinanceDocumentsPage } = await import('./financeDocuments.js');
                    if (document.getElementById('subview-finance-docs')) renderFinanceDocumentsPage();
                } catch { /* ignore */ }
                try {
                    const { renderExpensePlanPage } = await import('./expensePlan.js');
                    if (document.getElementById('subview-expense-plan')) renderExpensePlanPage();
                } catch { /* ignore */ }
                window.renderBankReconciliation?.();
                window.renderInvoicesPage?.();
            })();
        });
    }
};

const populateLedgerCategoryFilter = () => {
    const sel = document.getElementById('ledger-cat-filter');
    if (!sel || sel.dataset.populated) return;
    sel.dataset.populated = '1';
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    sel.innerHTML = [
        '<option value="">All categories</option>',
        `<optgroup label="Income">${INCOME_CATS.map((c) => `<option value="${esc(c)}">${esc(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
        `<optgroup label="Expenses">${EXPENSE_CATS.map((c) => `<option value="${esc(c)}">${esc(categoryDisplayLabel(c))}</option>`).join('')}</optgroup>`,
    ].join('');
};

const initLedgerSearch = () => {
    const input = document.getElementById('cash-search');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    let debounce = null;
    const onSearchInput = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => renderCashLedger(), 120);
    };
    input.addEventListener('input', onSearchInput);
    input.addEventListener('search', onSearchInput);
};

const initLedgerCategoryFilter = () => {
    populateLedgerCategoryFilter();
    const sel = document.getElementById('ledger-cat-filter');
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = '1';
    sel.addEventListener('change', () => {
        setLedgerCategoryFilter(sel.value || null);
        renderCashLedger();
    });
};

const showLedgerRecalcStatus = (message = 'Recalculating calculated balances… please wait.') => {
    const el = document.getElementById('ledger-recalc-status');
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
};

const hideLedgerRecalcStatus = () => {
    const el = document.getElementById('ledger-recalc-status');
    if (el) el.hidden = true;
};

const formatOpeningShort = (opening) => {
    if (opening?.amount == null || !opening?.date) return null;
    const amt = `₹${Number(opening.amount).toLocaleString('en-IN')}`;
    const match = String(opening.date).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const dateLabel = match ? `${match[3]}-${match[2]}-${match[1].slice(-2)}` : opening.date;
    return `${amt} · ${dateLabel}`;
};

const syncLedgerOpeningFields = () => {
    const opening = getBankOpeningConfig();
    const dateEl = document.getElementById('ledger-opening-date');
    const amountEl = document.getElementById('ledger-opening-amount');
    const summary = document.getElementById('ledger-opening-summary');
    if (dateEl && document.activeElement !== dateEl) {
        dateEl.value = opening.date || '';
    }
    if (amountEl && document.activeElement !== amountEl) {
        amountEl.value = opening.amount != null ? String(opening.amount) : '';
    }
    if (summary) {
        const short = formatOpeningShort(opening);
        summary.innerHTML = short
            ? `<i class="fa-solid fa-bookmark" aria-hidden="true"></i> Opening <span class="ledger-opening-picker__badge">${short}</span>`
            : '<i class="fa-solid fa-bookmark" aria-hidden="true"></i> Opening';
        summary.classList.toggle('ledger-opening-picker__summary--unset', !short);
        summary.title = short
            ? `Opening balance ${short}`
            : 'Set bank opening balance for Calculated values';
    }
};

const openLedgerOpeningPicker = ({ focusAmount = true } = {}) => {
    const picker = document.getElementById('ledger-opening-picker');
    if (!picker) return;
    syncLedgerOpeningFields();
    picker.open = true;
    if (focusAmount) {
        requestAnimationFrame(() => document.getElementById('ledger-opening-amount')?.focus());
    }
};

const initLedgerOpeningBalance = () => {
    const saveBtn = document.getElementById('ledger-opening-save');
    if (!saveBtn || saveBtn.dataset.wired) return;
    saveBtn.dataset.wired = '1';

    document.getElementById('ledger-bank-hint')?.addEventListener('click', (e) => {
        if (!e.target.closest('#ledger-bank-hint-open')) return;
        openLedgerOpeningPicker();
    });

    saveBtn.addEventListener('click', async () => {
        const date = document.getElementById('ledger-opening-date')?.value;
        const raw = document.getElementById('ledger-opening-amount')?.value?.trim();
        const amount = raw === '' || raw == null ? NaN : parseFloat(raw);
        try {
            await withButtonBusy(saveBtn, 'Saving…', async () => {
                showLedgerRecalcStatus('Saving opening balance and recalculating…');
                try {
                    await saveBankOpeningBalance(date, amount, { pull: true });
                    document.getElementById('ledger-opening-picker')?.removeAttribute('open');
                    processFinances();
                    renderCashLedger();
                } finally {
                    hideLedgerRecalcStatus();
                }
            });
        } catch (err) {
            hideLedgerRecalcStatus();
            alert(err?.message || 'Could not save opening balance.');
        }
    });

    syncLedgerOpeningFields();
};

const initLedgerRecalculate = () => {
    const btn = document.getElementById('ledger-recalc-btn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
        const opening = getBankOpeningConfig();
        if (opening.amount == null) {
            openLedgerOpeningPicker();
            return;
        }
        try {
            await withButtonBusy(btn, 'Recalculating…', async () => {
                showLedgerRecalcStatus('Refreshing ledger calculated balances…');
                try {
                    // Statement-line balances power Passbook compare on matched rows;
                    // ledger Calculated is always recomputed client-side from BANK entries.
                    await recalculateBankStatementBalances();
                    await pullState();
                    processFinances();
                    renderCashLedger();
                } finally {
                    hideLedgerRecalcStatus();
                }
            });
        } catch (err) {
            hideLedgerRecalcStatus();
            alert(err?.message || 'Could not recalculate balances.');
        }
    });
};

const initLedgerTableControls = () => {
    setLedgerViewRefresh(renderCashLedger);
    window.renderCashLedger = renderCashLedger;
    initLedgerSearch();
    initLedgerCategoryFilter();
    initLedgerExport();
    initLedgerOpeningBalance();
    initLedgerRecalculate();
    const host = document.getElementById('cash-ledger-items');
    if (host && !host.dataset.sortWired) {
        host.dataset.sortWired = '1';
        host.addEventListener('click', (e) => {
            const btn = e.target.closest('.ledger-sort-btn');
            if (!btn?.dataset.sort) return;
            toggleLedgerSort(btn.dataset.sort);
            renderCashLedger();
        });
    }
};

window.switchSubView = (sv) => {
    // Old cash-float tab folded into Bills & receipts
    if (sv === 'cash-float') sv = 'finance-docs';
    const views = {
        ledger: 'subview-ledger',
        'finance-docs': 'subview-finance-docs',
        'expense-plan': 'subview-expense-plan',
        reports: 'subview-reports',
        'invoices-raised': 'subview-invoices-raised',
        'bank-recon': 'subview-bank-recon',
        activity: 'subview-activity',
    };
    Object.entries(views).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = key === sv ? 'block' : 'none';
    });

    syncAccountsHeaderActions(sv);

    if (sv === 'reports') renderFinanceAnalytics();
    if (sv === 'finance-docs') {
        import('./financeDocuments.js').then((m) => {
            m.initFinanceDocumentsPage();
            m.renderFinanceDocumentsPage();
        });
    }
    if (sv === 'expense-plan') {
        import('./expensePlan.js').then((m) => {
            m.initExpensePlanPage();
            m.renderExpensePlanPage();
        });
    }
    if (sv === 'invoices-raised') {
        import('./invoicesRaisedPage.js').then((m) => {
            m.initInvoicesRaisedPage();
            m.renderInvoicesRaisedPage();
        });
    }
    if (sv === 'bank-recon') window.renderBankReconciliation?.();
    if (sv === 'activity') {
        const run = window.renderActivityLogPage
            || ((...args) => import('./activityAudit.js').then((m) => m.renderActivityLogPage(...args)));
        Promise.resolve(run()).catch((err) => {
            console.warn('[activity] Failed to load activity log', err);
            const list = document.getElementById('activity-log-list');
            if (list) {
                list.innerHTML = `<p class="maintenance-dues-empty">${err?.message || 'Could not load activity log.'}</p>`;
            }
        });
    }
    if (sv === 'ledger') {
        processFinances();
        renderCashLedger();
        window.renderLedgerSyncPanel?.();
    }
};
