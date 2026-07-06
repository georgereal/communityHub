/**
 * Sentry Finance Engine (Audit Relational)
 */
import { portalState, persist, supabase, pullState } from './store.js';
import { renderEditableLedgerRows, initLedgerBulkBar } from './ledgerTable.js';
import { renderFinanceAnalytics } from './financeAnalytics.js';
import { renderLedgerContextBar, sortLedgerTxns, toggleLedgerSort, updateLedgerSortIndicators, applyLedgerTableFilters, ledgerHasActiveFilters, setLedgerActivity, setLedgerSearchBusy, setLedgerCategoryFilter } from './ledgerFilter.js';
import {
    collectAllocationDraft,
    formatAllocationSummary,
    syncMaintenanceIncomeSection,
    validateMaintenanceAllocations,
} from './maintenanceBilling.js';
import { ACCOUNTS_SUBVIEW_ROUTES } from './navigation.js';
import { filesToBase64Payload, postFinanceMutation } from './financeApi.js';
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
    document.querySelectorAll(`#${containerId} .expense-wallet-pill`).forEach((btn) => {
        const on = btn.dataset.wallet === wallet;
        btn.classList.toggle('active', on);
        const radio = btn.querySelector('input[type="radio"]');
        if (radio) radio.checked = on;
    });
};

const getActiveWallet = (containerId) => {
    const checked = document.querySelector(`#${containerId} input[type="radio"]:checked`);
    if (checked?.value) return checked.value;
    return document.querySelector(`#${containerId} .expense-wallet-pill.active`)?.dataset.wallet || 'CASH';
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

const renderReceiptUI = () => {
    const list = document.getElementById('cash-receipt-list');
    if (!list) return;

    const kept = portalState.pendingReceiptPaths || [];
    const pending = portalState.pendingReceiptFiles || [];
    const items = [
        ...kept.map((path, i) => ({
            key: `saved-${i}-${path}`,
            label: receiptFileName(path),
            kind: isPdfPath(path) ? 'pdf' : 'image',
            saved: true,
            path,
        })),
        ...pending.map((file, i) => ({
            key: `new-${i}-${file.name}-${file.size}`,
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
            ? `<button type="button" class="expense-link-btn" data-view-path="${encodeURIComponent(item.path)}">view</button>`
            : `<button type="button" class="expense-link-btn" data-view-file="${encodeURIComponent(item.label)}::${item.file?.size || 0}">view</button>`;
        const removeAttr = item.saved
            ? `data-remove-saved="${encodeURIComponent(item.path)}"`
            : `data-remove-file="${encodeURIComponent(item.label)}::${item.file?.size || 0}"`;
        return `<li class="expense-receipt-item">
          <span class="expense-receipt-item__name"><i class="fa-solid ${icon}"></i> ${item.label}</span>
          <span class="expense-receipt-item__actions">${viewBtn}<button type="button" class="expense-link-btn" ${removeAttr}>remove</button></span>
        </li>`;
    }).join('');

    list.querySelectorAll('[data-view-path]').forEach((btn) => {
        btn.addEventListener('click', () => {
            window.viewReceipt(decodeURIComponent(btn.dataset.viewPath));
        });
    });
    list.querySelectorAll('[data-view-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const token = decodeURIComponent(btn.dataset.viewFile);
            const [name, sizeStr] = token.split('::');
            const size = parseInt(sizeStr, 10);
            const file = (portalState.pendingReceiptFiles || []).find((f) => f.name === name && f.size === size);
            if (file) window.previewReceiptFile(file);
        });
    });
    list.querySelectorAll('[data-remove-saved]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const path = decodeURIComponent(btn.dataset.removeSaved);
            portalState.pendingReceiptPaths = (portalState.pendingReceiptPaths || []).filter((p) => p !== path);
            renderReceiptUI();
        });
    });
    list.querySelectorAll('[data-remove-file]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const token = decodeURIComponent(btn.dataset.removeFile);
            const [name, sizeStr] = token.split('::');
            const size = parseInt(sizeStr, 10);
            portalState.pendingReceiptFiles = (portalState.pendingReceiptFiles || []).filter(
                (f) => !(f.name === name && f.size === size),
            );
            renderReceiptUI();
        });
    });
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

    const billInput = document.getElementById('cash-bill');
    if (billInput && !billInput.dataset.wired) {
        billInput.dataset.wired = '1';
        billInput.addEventListener('change', () => {
            const picked = Array.from(billInput.files || []);
            if (picked.length) {
                portalState.pendingReceiptFiles = [...(portalState.pendingReceiptFiles || []), ...picked];
                renderReceiptUI();
            }
            billInput.value = '';
        });
    }

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
};

export const processFinances = () => {
    let cash = 0, bank = 0, outToday = 0; const now = new Date();
    portalState.finances.txns.forEach(t => {
        const amt = parseFloat(t.amount); const d = new Date(t.date); const wallet = t.wallet || 'CASH';
        if (t.type === 'IN') { if (wallet === 'CASH') cash += amt; else bank += amt; }
        else {
            if (wallet === 'CASH') cash -= amt; else bank -= amt;
            if (d.toDateString() === now.toDateString()) outToday += amt;
        }
    });
    const k = (id) => document.getElementById(id);
    if (k('cash-balance')) {
        k('cash-balance').textContent = `₹ ${cash.toLocaleString('en-IN')}`;
        k('bank-balance').textContent = `₹ ${bank.toLocaleString('en-IN')}`;
        k('total-wealth').textContent = `₹ ${(cash + bank).toLocaleString('en-IN')}`;
        k('cash-today-out').textContent = `₹ ${outToday.toLocaleString('en-IN')}`;
        if (k('cash-txn-count')) {
            const n = portalState.finances.txns.length;
            k('cash-txn-count').textContent = n ? `· ${n} ${n === 1 ? 'entry' : 'entries'}` : '';
        }
    }
};

export const renderCashLedger = () => {
    const list = document.getElementById('cash-ledger-items');
    if (!list) return;

    const hasFilters = ledgerHasActiveFilters();
    if (hasFilters) {
        setLedgerActivity('Filtering…', { busy: true });
        setLedgerSearchBusy(true);
    }

    renderLedgerContextBar();
    const filtered = applyLedgerTableFilters([...portalState.finances.txns]);
    const sorted = sortLedgerTxns(filtered);
    updateLedgerSortIndicators();

    const total = portalState.finances.txns.length;
    const showing = sorted.length;

    const countEl = document.getElementById('cash-txn-count');
    if (countEl) {
        countEl.textContent = showing === total
            ? (total ? `· ${total} ${total === 1 ? 'entry' : 'entries'}` : '')
            : `· ${showing} of ${total} entries`;
    }

    renderEditableLedgerRows(sorted, { formatTxnDetail, getAllAttachmentPaths });

    setLedgerSearchBusy(false);
    if (hasFilters) {
        const parts = [`Showing ${showing} of ${total}`];
        if (!showing) parts.push('— no matches');
        setLedgerActivity(parts.join(' '), { busy: false });
    } else {
        setLedgerActivity(null);
    }
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
    if (!supabase) return null;
    const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(pathOrUrl, 3600);
    if (error) throw error;
    return data.signedUrl;
}

let receiptViewerState = { paths: [], index: 0, objectUrls: [] };

const cleanupReceiptViewer = () => {
    receiptViewerState.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    receiptViewerState.objectUrls = [];
};

const showReceiptAtIndex = async (index) => {
    const paths = receiptViewerState.paths;
    if (!paths.length) return;
    const idx = Math.max(0, Math.min(index, paths.length - 1));
    receiptViewerState.index = idx;

    const path = paths[idx];
    const img = document.getElementById('receipt-img');
    const pdf = document.getElementById('receipt-pdf');
    const caption = document.getElementById('receipt-viewer-caption');
    const nav = document.getElementById('receipt-nav');
    const openTab = document.getElementById('receipt-open-tab');

    let url;
    if (path instanceof File) {
        url = URL.createObjectURL(path);
        receiptViewerState.objectUrls.push(url);
    } else {
        url = await resolveReceiptUrl(path);
    }

    const name = path instanceof File ? path.name : receiptFileName(path);
    const pdfDoc = path instanceof File ? isPdfFile(path) : isPdfPath(path);

    if (caption) caption.textContent = paths.length > 1 ? `${name} (${idx + 1} of ${paths.length})` : name;

    if (nav) {
        if (paths.length > 1) {
            nav.hidden = false;
            nav.innerHTML = paths.map((p, i) => {
                const label = p instanceof File ? p.name : receiptFileName(p);
                return `<button type="button" class="receipt-viewer__tab${i === idx ? ' active' : ''}" data-receipt-tab="${i}">${label}</button>`;
            }).join('');
            nav.querySelectorAll('[data-receipt-tab]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    cleanupReceiptViewer();
                    showReceiptAtIndex(parseInt(btn.dataset.receiptTab, 10));
                });
            });
        } else {
            nav.hidden = true;
            nav.innerHTML = '';
        }
    }

    if (pdfDoc) {
        if (img) img.hidden = true;
        if (pdf) {
            pdf.hidden = false;
            pdf.src = url;
        }
    } else {
        if (pdf) { pdf.hidden = true; pdf.removeAttribute('src'); }
        if (img) {
            img.hidden = false;
            img.src = url;
        }
    }

    if (openTab) {
        openTab.href = url;
        openTab.hidden = !url;
    }
};

export const saveCashData = async () => {
    const isIncome = portalState.cashModalMode === 'income';
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
    if (isIncome && cat === 'Maintenance Collection') {
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
        vendor_invoice = invoiceEl?.value?.trim() || null;
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

    const excludeFromReports = document.getElementById('txn-exclude-reports')?.checked === true
        || cat === BANK_REJECT_CAT;

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
        await postFinanceMutation('saveTransaction', {
            apartment_id,
            transaction: payload,
            allocations,
            keepReceiptPaths: receipt_urls,
            keepBankProofPaths: bank_proof_urls,
            removeReceiptPaths: removedPaths,
            removeBankProofPaths: removedBankPaths,
            newReceiptFiles: !isIncome ? await filesToBase64Payload(portalState.pendingReceiptFiles || []) : [],
            newBankProofFiles: wallet === 'BANK' ? await filesToBase64Payload(portalState.pendingBankProofFiles || []) : [],
        });

        if (isIncome && cat === 'Maintenance Collection') {
            document.dispatchEvent(new CustomEvent('maintenance-payment-saved', {
                detail: { unitNumber: document.getElementById('maintenance-unit-input')?.value?.trim() || '' },
            }));
        }

        await pullState();
        populateVendorDatalist();
        populateSubCatDatalist(cat);
        processFinances();
        renderCashLedger();
        if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();
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
    cleanupReceiptViewer();
    receiptViewerState = { paths: [file], index: 0, objectUrls: [] };
    try {
        await showReceiptAtIndex(0);
        document.getElementById('receipt-modal')?.classList.add('active');
    } catch (err) {
        alert(err?.message || 'Could not preview file.');
    }
};

window.viewReceipt = async (pathOrUrl, index = 0) => {
    if (!pathOrUrl) return;
    cleanupReceiptViewer();
    receiptViewerState = { paths: [pathOrUrl], index: 0, objectUrls: [] };
    try {
        await showReceiptAtIndex(index);
        document.getElementById('receipt-modal')?.classList.add('active');
    } catch (err) {
        alert(err?.message || 'Could not load receipt.');
    }
};

window.viewReceipts = async (txnId, index = 0) => {
    const t = portalState.finances.txns.find((x) => x.id == txnId);
    const paths = getAllAttachmentPaths(t);
    if (!paths.length) return alert('No attachments for this expense.');
    cleanupReceiptViewer();
    receiptViewerState = { paths, index: 0, objectUrls: [] };
    try {
        await showReceiptAtIndex(index);
        document.getElementById('receipt-modal')?.classList.add('active');
    } catch (err) {
        alert(err?.message || 'Could not load receipts.');
    }
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

window.openExpense = (wallet = 'CASH') => {
    const modal = document.getElementById('cash-modal');
    if (!modal) return;
    portalState.editingTxnId = null;
    portalState.cashModalMode = 'expense';

    document.getElementById('expense-form-view').style.display = 'grid';
    document.getElementById('income-form-view').style.display = 'none';
    document.getElementById('cash-modal-title').textContent = 'Add Expense';
    document.getElementById('cash-modal-desc').textContent = 'Record money spent from petty cash or the bank account.';
    document.getElementById('save-cash-btn').textContent = 'Save Expense';

    openExpenseFormDefaults(wallet);
    modal.classList.add('active');
    setTimeout(() => document.getElementById('cash-amt')?.focus(), 50);
};

const openIncomeFormDefaults = (wallet = 'CASH', catKey = 'Maintenance Collection') => {
    document.getElementById('income-amt').value = '';
    document.getElementById('income-desc').value = '';
    document.getElementById('income-date').value = todayISO();
    document.getElementById('income-cat-input').value = labelForCat(catKey);
    document.getElementById('maintenance-unit-input').value = '';
    document.getElementById('income-vendor-input').value = '';
    document.getElementById('income-reference-input').value = '';
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

window.openIncome = (wallet = 'CASH') => {
    const modal = document.getElementById('cash-modal');
    if (!modal) return;
    portalState.editingTxnId = null;
    portalState.cashModalMode = 'income';

    document.getElementById('expense-form-view').style.display = 'none';
    document.getElementById('income-form-view').style.display = 'grid';
    document.getElementById('cash-modal-title').textContent = 'Record Income';
    document.getElementById('cash-modal-desc').textContent = 'Top up petty cash or record money received into the bank.';
    document.getElementById('save-cash-btn').textContent = 'Save Income';

    openIncomeFormDefaults(wallet);
    modal.classList.add('active');
    setTimeout(() => document.getElementById('income-amt')?.focus(), 50);
};

window.openBankSnapshot = () => {
    window.openIncome('BANK');
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
    if ((direction || 'OUT').toUpperCase() === 'IN') window.openIncome(wallet);
    else window.openExpense(wallet);
};

export const delTxn = async (id) => {
    if (confirm('Delete Record?')) {
        await postFinanceMutation('deleteTransaction', {
            apartment_id: portalState.access?.activeApartmentId,
            transaction_id: id,
        });
        await pullState();
        processFinances();
        renderCashLedger();
    }
};
window.delTxn = delTxn;

window.editTxn = (id) => {
    const t = portalState.finances.txns.find(x => x.id == id);
    if (!t) return;
    portalState.editingTxnId = id;
    const isIncome = t.type === 'IN';
    portalState.cashModalMode = isIncome ? 'income' : 'expense';
    const dateVal = t.date ? new Date(t.date).toISOString().slice(0, 10) : todayISO();

    if (isIncome) {
        document.getElementById('expense-form-view').style.display = 'none';
        document.getElementById('income-form-view').style.display = 'grid';
        document.getElementById('cash-modal-title').textContent = 'Edit Income';
        document.getElementById('save-cash-btn').textContent = 'Save Changes';
        document.getElementById('income-amt').value = t.amount;
        document.getElementById('income-desc').value = t.description || '';
        document.getElementById('income-date').value = dateVal;
        document.getElementById('income-cat-input').value = labelForCat(t.cat);
        syncWalletPills('income-wallet-pills', t.wallet || 'CASH');
        syncBankTypePills(t.bank_payment_type || 'CHEQUE');
        document.getElementById('income-bank-ref').value = t.bank_reference || '';
        document.getElementById('txn-exclude-reports').checked = !!t.exclude_from_reports;
        resetBankProofUI(getBankProofPaths(t));
        syncBankWalletUI();
        resetReceiptUI([]);
        syncMaintenanceIncomeSection(t.cat, id);
        syncIncomeExtraSection(t.cat, t);
    } else {
        document.getElementById('expense-form-view').style.display = 'grid';
        document.getElementById('income-form-view').style.display = 'none';
        document.getElementById('cash-modal-title').textContent = 'Edit Expense';
        document.getElementById('save-cash-btn').textContent = 'Save Changes';
        document.getElementById('cash-amt').value = t.amount;
        document.getElementById('cash-desc').value = t.description || '';
        document.getElementById('expense-vendor-input').value = t.vendor_name || '';
        document.getElementById('expense-invoice-input').value = t.vendor_invoice || '';
        document.getElementById('cash-date').value = dateVal;
        document.getElementById('expense-cat-input').value = labelForCat(t.cat);
        document.getElementById('expense-subcat-input').value = t.sub_category || '';
        populateSubCatDatalist(t.cat);
        syncWalletPills('expense-wallet-pills', t.wallet || 'CASH');
        syncBankTypePills(t.bank_payment_type || 'CHEQUE');
        document.getElementById('expense-bank-ref').value = t.bank_reference || '';
        document.getElementById('txn-exclude-reports').checked = !!t.exclude_from_reports;
        resetBankProofUI(getBankProofPaths(t));
        syncExpenseWalletUI();
        resetReceiptUI(getReceiptPaths(t));
    }

    document.getElementById('cash-cat-select').value = t.cat;
    document.getElementById('cash-wallet-select').value = t.wallet || 'CASH';
    document.getElementById('cash-modal').classList.add('active');
};

const ROUTE_TO_ACCOUNTS_SUBVIEW = Object.fromEntries(
    Object.entries(ACCOUNTS_SUBVIEW_ROUTES).map(([subview, route]) => [route, subview]),
);

export const syncAccountsSubViewTabs = (route) => {
    const subview = ROUTE_TO_ACCOUNTS_SUBVIEW[route] || 'ledger';
    document.querySelectorAll('[data-accounts-subview]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.accountsSubview === subview);
    });
};

export const initAccountsSubViewTabs = () => {
    document.querySelectorAll('[data-accounts-subview]').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
            const route = ACCOUNTS_SUBVIEW_ROUTES[btn.dataset.accountsSubview];
            if (route && typeof window.switchView === 'function') window.switchView(route);
        });
    });
    initLedgerTableControls();
    initLedgerBulkBar();
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
    input.addEventListener('input', () => {
        setLedgerSearchBusy(true);
        clearTimeout(debounce);
        debounce = setTimeout(() => window.renderCashLedger?.(), 120);
    });
};

const initLedgerCategoryFilter = () => {
    populateLedgerCategoryFilter();
    const sel = document.getElementById('ledger-cat-filter');
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = '1';
    sel.addEventListener('change', () => {
        setLedgerCategoryFilter(sel.value || null);
        window.renderCashLedger?.();
    });
};

const initLedgerTableControls = () => {
    initLedgerSearch();
    initLedgerCategoryFilter();
    document.querySelectorAll('.ledger-sort-btn').forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
            setLedgerActivity('Sorting…', { busy: true });
            toggleLedgerSort(btn.dataset.sort);
            renderCashLedger();
        });
    });
};

window.switchSubView = (sv) => {
    const views = {
        ledger: 'subview-ledger',
        reports: 'subview-reports',
        'bank-recon': 'subview-bank-recon',
        activity: 'subview-activity',
        gl: 'subview-gl',
    };
    Object.entries(views).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = key === sv ? 'block' : 'none';
    });

    if (sv === 'reports') renderFinanceAnalytics();
    if (sv === 'bank-recon') window.renderBankReconciliation?.();
    if (sv === 'activity') window.renderActivityLogPage?.();
    if (sv === 'gl') window.renderGeneralLedger?.();
    if (sv === 'ledger') window.renderLedgerSyncPanel?.();
};
