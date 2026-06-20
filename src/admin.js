/**
 * Setup admin: bank account, vendors, sub-categories, staff
 */
import { portalState, supabase, pullState } from './store.js';
import { refreshExpenseReferences } from './finances.js';
import { renderLedgerSyncPanel, renderAdminSyncPanel } from './ledgerSpreadsheetSync.js';
import { closeSyncLogDrawer, teardownSyncLogDrawer } from './ledgerSyncLog.js';
import { withButtonBusy, bindBusyClick } from './buttonBusy.js';

const EXPENSE_CATS = ['Maintenance', 'Security', 'Plumbing', 'Electrical', 'Stationery', 'Other'];
const STAFF_ROLES = ['Manager', 'Security Guard', 'Housekeeping', 'Maintenance', 'Accounts', 'Other'];

const SETUP_SUBVIEWS = ['society', 'bank', 'vendors', 'subcats', 'staff', 'sync'];
let editingVendorId = null;
let editingSubCatId = null;
let editingStaffId = null;

const apartmentId = () => portalState.access?.activeApartmentId;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export const switchSetupSubView = (id = 'society') => {
    const view = SETUP_SUBVIEWS.includes(id) ? id : 'society';
    SETUP_SUBVIEWS.forEach((key) => {
        const el = document.getElementById(`setup-subview-${key}`);
        if (el) el.hidden = key !== view;
    });
    if (view === 'bank') renderBankAdmin();
    if (view === 'vendors') renderVendorsAdmin();
    if (view === 'subcats') renderSubCatsAdmin();
    if (view === 'staff') renderStaffAdmin();
    if (view === 'sync') {
        renderSyncAdmin();
    } else {
        teardownSyncLogDrawer();
    }
};
window.switchSetupSubView = switchSetupSubView;

export const initSetupAdmin = () => {
    bindBusyClick(document.getElementById('admin-bank-save'), 'Saving…', saveBankAccount);
    bindBusyClick(document.getElementById('admin-vendor-save'), 'Saving…', saveVendor);
    bindBusyClick(document.getElementById('admin-subcat-save'), 'Saving…', saveSubCategory);
    bindBusyClick(document.getElementById('admin-staff-save'), 'Saving…', saveStaff);
    document.getElementById('admin-subcat-filter')?.addEventListener('change', renderSubCatsAdmin);
};

export const renderSetupAdmin = () => {
    switchSetupSubView(document.querySelector('.setup-tab--active')?.dataset.setupTab || 'society');
};

// --- Bank account ---

export const renderBankAdmin = () => {
    const bank = portalState.admin?.bankAccount;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    set('admin-bank-name', bank?.bank_name);
    set('admin-bank-branch', bank?.branch);
    set('admin-bank-holder', bank?.account_holder);
    set('admin-bank-number', bank?.account_number);
    set('admin-bank-ifsc', bank?.ifsc);
    set('admin-bank-upi', bank?.upi_id);
    set('admin-bank-notes', bank?.notes);
    const hint = document.getElementById('admin-bank-hint');
    if (hint) {
        hint.textContent = bank?.updated_at
            ? `Last updated ${new Date(bank.updated_at).toLocaleString('en-IN')}`
            : 'No bank account saved yet for this apartment.';
    }
};

const saveBankAccount = async () => {
    if (!supabase) return alert('Supabase required.');
    const apt = apartmentId();
    if (!apt) return alert('Select an apartment first.');
    const bank_name = document.getElementById('admin-bank-name')?.value?.trim();
    if (!bank_name) return alert('Enter the bank name.');
    const payload = {
        id: portalState.admin?.bankAccount?.id || crypto.randomUUID(),
        apartment_id: apt,
        bank_name,
        branch: document.getElementById('admin-bank-branch')?.value?.trim() || null,
        account_holder: document.getElementById('admin-bank-holder')?.value?.trim() || null,
        account_number: document.getElementById('admin-bank-number')?.value?.trim() || null,
        ifsc: document.getElementById('admin-bank-ifsc')?.value?.trim() || null,
        upi_id: document.getElementById('admin-bank-upi')?.value?.trim() || null,
        notes: document.getElementById('admin-bank-notes')?.value?.trim() || null,
        updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('apartment_bank_accounts').upsert(payload, { onConflict: 'apartment_id' });
    if (error) return alert(error.message);
    await pullState();
    renderBankAdmin();
};

// --- Vendors ---

export const renderVendorsAdmin = () => {
    const list = document.getElementById('admin-vendors-list');
    if (!list) return;
    const vendors = portalState.finances?.vendors || [];
    if (!vendors.length) {
        list.innerHTML = '<div class="admin-empty">No vendors yet. Add one or save expenses with vendor names.</div>';
        return;
    }
    list.innerHTML = vendors.map((v) => `
      <div class="admin-row">
        <div class="admin-row__main"><strong>${esc(v.name)}</strong></div>
        <div>${esc(v.contact_phone || '—')}</div>
        <div>${esc(v.contact_email || '—')}</div>
        <div style="text-align:center;">${v.use_count || 0}</div>
        <div style="text-align:right; display:flex; gap:0.35rem; justify-content:flex-end;">
          <button type="button" class="btn btn-outline btn--small" data-edit-vendor="${v.id}"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn btn-outline btn--small" style="color:var(--danger);" data-del-vendor="${v.id}"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-edit-vendor]').forEach((btn) => {
        btn.onclick = () => openVendorModal(vendors.find((v) => v.id === btn.dataset.editVendor));
    });
    list.querySelectorAll('[data-del-vendor]').forEach((btn) => {
        btn.onclick = () => void withButtonBusy(btn, 'Deleting…', () => deleteVendor(btn.dataset.delVendor));
    });
};

window.openVendorModal = (row = null) => {
    editingVendorId = row?.id || null;
    document.getElementById('admin-vendor-modal-title').textContent = row ? 'Edit Vendor' : 'Add Vendor';
    document.getElementById('admin-vendor-name').value = row?.name || '';
    document.getElementById('admin-vendor-phone').value = row?.contact_phone || '';
    document.getElementById('admin-vendor-email').value = row?.contact_email || '';
    document.getElementById('admin-vendor-notes').value = row?.notes || '';
    document.getElementById('admin-vendor-modal').classList.add('active');
};

const closeVendorModal = () => {
    document.getElementById('admin-vendor-modal')?.classList.remove('active');
    editingVendorId = null;
};
window.closeVendorModal = closeVendorModal;

const saveVendor = async () => {
    if (!supabase) return;
    const apt = apartmentId();
    const name = document.getElementById('admin-vendor-name')?.value?.trim();
    if (!name) return alert('Vendor name is required.');
    const payload = {
        id: editingVendorId || crypto.randomUUID(),
        apartment_id: apt,
        name,
        contact_phone: document.getElementById('admin-vendor-phone')?.value?.trim() || null,
        contact_email: document.getElementById('admin-vendor-email')?.value?.trim() || null,
        notes: document.getElementById('admin-vendor-notes')?.value?.trim() || null,
    };
    const { error } = await supabase.from('expense_vendors').upsert(payload, { onConflict: 'apartment_id,name' });
    if (error) return alert(error.message);
    closeVendorModal();
    await pullState();
    await refreshExpenseReferences();
    renderVendorsAdmin();
};

const deleteVendor = async (id) => {
    if (!confirm('Delete this vendor?')) return;
    const { error } = await supabase.from('expense_vendors').delete().eq('id', id);
    if (error) return alert(error.message);
    await pullState();
    await refreshExpenseReferences();
    renderVendorsAdmin();
};

// --- Sub-categories ---

export const renderSubCatsAdmin = () => {
    const list = document.getElementById('admin-subcats-list');
    if (!list) return;
    const filter = document.getElementById('admin-subcat-filter')?.value || '';
    let rows = portalState.finances?.subCategories || [];
    if (filter) rows = rows.filter((r) => r.category === filter);
    if (!rows.length) {
        list.innerHTML = '<div class="admin-empty">No sub-categories yet.</div>';
        return;
    }
    list.innerHTML = rows.map((r) => `
      <div class="admin-row">
        <div>${esc(r.category)}</div>
        <div class="admin-row__main"><strong>${esc(r.name)}</strong></div>
        <div style="text-align:center;">${r.use_count || 0}</div>
        <div style="text-align:right; display:flex; gap:0.35rem; justify-content:flex-end;">
          <button type="button" class="btn btn-outline btn--small" data-edit-subcat="${r.id}"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn btn-outline btn--small" style="color:var(--danger);" data-del-subcat="${r.id}"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-edit-subcat]').forEach((btn) => {
        btn.onclick = () => openSubCatModal(rows.find((r) => r.id === btn.dataset.editSubcat));
    });
    list.querySelectorAll('[data-del-subcat]').forEach((btn) => {
        btn.onclick = () => void withButtonBusy(btn, 'Deleting…', () => deleteSubCategory(btn.dataset.delSubcat));
    });
};

window.openSubCatModal = (row = null) => {
    editingSubCatId = row?.id || null;
    document.getElementById('admin-subcat-modal-title').textContent = row ? 'Edit Sub-category' : 'Add Sub-category';
    document.getElementById('admin-subcat-category').value = row?.category || EXPENSE_CATS[0];
    document.getElementById('admin-subcat-name').value = row?.name || '';
    document.getElementById('admin-subcat-modal').classList.add('active');
};

const closeSubCatModal = () => {
    document.getElementById('admin-subcat-modal')?.classList.remove('active');
    editingSubCatId = null;
};
window.closeSubCatModal = closeSubCatModal;

const saveSubCategory = async () => {
    if (!supabase) return;
    const apt = apartmentId();
    const category = document.getElementById('admin-subcat-category')?.value;
    const name = document.getElementById('admin-subcat-name')?.value?.trim();
    if (!name) return alert('Sub-category name is required.');
    const payload = {
        id: editingSubCatId || crypto.randomUUID(),
        apartment_id: apt,
        category,
        name,
    };
    const { error } = await supabase.from('expense_sub_categories').upsert(payload, { onConflict: 'apartment_id,category,name' });
    if (error) return alert(error.message);
    closeSubCatModal();
    await pullState();
    await refreshExpenseReferences();
    renderSubCatsAdmin();
};

const deleteSubCategory = async (id) => {
    if (!confirm('Delete this sub-category?')) return;
    const { error } = await supabase.from('expense_sub_categories').delete().eq('id', id);
    if (error) return alert(error.message);
    await pullState();
    await refreshExpenseReferences();
    renderSubCatsAdmin();
};

// --- Staff ---

export const renderStaffAdmin = () => {
    const list = document.getElementById('admin-staff-list');
    if (!list) return;
    const staff = portalState.admin?.staff || [];
    if (!staff.length) {
        list.innerHTML = '<div class="admin-empty">No staff records yet.</div>';
        return;
    }
    list.innerHTML = staff.map((s) => `
      <div class="admin-row${s.active ? '' : ' admin-row--muted'}">
        <div class="admin-row__main"><strong>${esc(s.full_name)}</strong></div>
        <div>${esc(s.role_title)}</div>
        <div>${esc(s.phone || '—')}</div>
        <div>${esc(s.email || '—')}</div>
        <div style="text-align:center;">${s.active ? 'Active' : 'Inactive'}</div>
        <div style="text-align:right; display:flex; gap:0.35rem; justify-content:flex-end;">
          <button type="button" class="btn btn-outline btn--small" data-edit-staff="${s.id}"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn btn-outline btn--small" style="color:var(--danger);" data-del-staff="${s.id}"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-edit-staff]').forEach((btn) => {
        btn.onclick = () => openStaffModal(staff.find((s) => s.id === btn.dataset.editStaff));
    });
    list.querySelectorAll('[data-del-staff]').forEach((btn) => {
        btn.onclick = () => void withButtonBusy(btn, 'Deleting…', () => deleteStaff(btn.dataset.delStaff));
    });
};

window.openStaffModal = (row = null) => {
    editingStaffId = row?.id || null;
    document.getElementById('admin-staff-modal-title').textContent = row ? 'Edit Staff' : 'Add Staff';
    document.getElementById('admin-staff-name').value = row?.full_name || '';
    document.getElementById('admin-staff-role').value = row?.role_title || STAFF_ROLES[0];
    document.getElementById('admin-staff-phone').value = row?.phone || '';
    document.getElementById('admin-staff-email').value = row?.email || '';
    document.getElementById('admin-staff-notes').value = row?.notes || '';
    document.getElementById('admin-staff-active').checked = row?.active !== false;
    document.getElementById('admin-staff-modal').classList.add('active');
};

const closeStaffModal = () => {
    document.getElementById('admin-staff-modal')?.classList.remove('active');
    editingStaffId = null;
};
window.closeStaffModal = closeStaffModal;

const saveStaff = async () => {
    if (!supabase) return;
    const apt = apartmentId();
    const full_name = document.getElementById('admin-staff-name')?.value?.trim();
    const role_title = document.getElementById('admin-staff-role')?.value?.trim();
    if (!full_name) return alert('Staff name is required.');
    if (!role_title) return alert('Role is required.');
    const payload = {
        id: editingStaffId || crypto.randomUUID(),
        apartment_id: apt,
        full_name,
        role_title,
        phone: document.getElementById('admin-staff-phone')?.value?.trim() || null,
        email: document.getElementById('admin-staff-email')?.value?.trim() || null,
        notes: document.getElementById('admin-staff-notes')?.value?.trim() || null,
        active: document.getElementById('admin-staff-active')?.checked !== false,
    };
    const { error } = await supabase.from('staff_members').upsert(payload);
    if (error) return alert(error.message);
    closeStaffModal();
    await pullState();
    renderStaffAdmin();
};

const deleteStaff = async (id) => {
    if (!confirm('Delete this staff record?')) return;
    const { error } = await supabase.from('staff_members').delete().eq('id', id);
    if (error) return alert(error.message);
    await pullState();
    renderStaffAdmin();
};

// --- Spreadsheet Sync ---

export const renderSyncAdmin = () => {
    renderAdminSyncPanel();
};
