import { portalState, supabase, pullState, upsertSocietyConfig } from '../store.js';
import { EXPENSE_CATS } from '../expenseCategories.js';
import { buildCategoryOptions, defaultExpenseCategory } from '../classifyOptions.js';
import { refreshExpenseReferences } from '../finances.js';
import {
    fetchApartmentModuleSettings,
    saveApartmentModuleSettings,
    MODULE_CATALOG,
    LOCKED_MODULE_KEYS,
} from '../moduleAccess.js';
import {
    fetchPendingAccessRequestsForAdmin,
    approveAccessRequest,
    denyAccessRequest,
} from '../accessRequests.js';
import {
    ROLE_OPTIONS,
    saveUserAccess,
    loadUserRoleAssignments,
    v2KeyToLabel,
    isSocietyAdminUser,
} from '../rbac.js';
import {
    getLinksForApartment,
    getInvitesForApartment,
    unlinkResidentUserLink,
    adminManualLinkAccount,
    sendPortalInvite,
    revokePortalInvite,
} from '../residentLinks.js';
import { getResidents } from '../residents.js';
import {
    CONNECTION_CATALOG,
    ensureExternalConnectionsLoaded,
    getExternalConnections,
} from '../externalConnections.js';

export { EXPENSE_CATS, MODULE_CATALOG, LOCKED_MODULE_KEYS, ROLE_OPTIONS, v2KeyToLabel, CONNECTION_CATALOG };
export { buildCategoryOptions, defaultExpenseCategory };

export const STAFF_ROLES = ['Manager', 'Security Guard', 'Housekeeping', 'Maintenance', 'Accounts', 'Other'];

const aptId = () => portalState.access?.activeApartmentId;

export function canEditSetup() {
    const perms = portalState.authPermissions || [];
    return perms.includes('setup.edit') || perms.includes('rbac.edit');
}

export function canEditAccounts() {
    return (portalState.authPermissions || []).includes('accounts.edit');
}

export async function refreshAdminState() {
    await pullState();
}

/** Load Mongo finance config + ledger so category pickers match Finance-New. */
export async function refreshFinanceCategoryCatalog() {
    const { ensureFinanceNewBoot, loadFinanceNewLedger } = await import('../financeNew/api.js');
    const { applyMongoPacksToClassic } = await import('../financeNew/classicState.js');
    const { getFinanceNew } = await import('../financeNew/state.js');
    await ensureFinanceNewBoot();
    applyMongoPacksToClassic({ config: getFinanceNew().config });
    try {
        await loadFinanceNewLedger();
        applyMongoPacksToClassic({ ledgerEntries: getFinanceNew().ledgerEntries });
    } catch { /* setup users may still manage sub-cats from config */ }
}

export function expenseCategoryOptions() {
    return buildCategoryOptions(false);
}

export function societyProfile() {
    const apt = portalState.access?.apartments?.find((a) => a.id === aptId());
    return {
        name: portalState.community?.name || apt?.name || '',
        car_default: portalState.community?.defaults?.cars ?? 1,
        bike_default: portalState.community?.defaults?.bikes ?? 1,
    };
}

export async function saveSocietyProfile({ name, car_default, bike_default }) {
    const apartment_id = aptId();
    if (!apartment_id) throw new Error('No active apartment selected.');
    const { error: cfgError } = await upsertSocietyConfig(apartment_id, { name, car_default, bike_default });
    if (cfgError) throw new Error(cfgError.message);
    const { error } = await supabase.from('units').update({
        car_limit: car_default,
        bike_limit: bike_default,
    }).eq('apartment_id', apartment_id).neq('number', '');
    if (error) throw new Error(error.message);
    const apt = portalState.access.apartments.find((a) => a.id === apartment_id);
    if (apt) apt.name = name;
    portalState.community.name = name;
    portalState.community.defaults = { cars: car_default, bikes: bike_default };
    await pullState();
}

export async function loadModuleSettings() {
    return fetchApartmentModuleSettings(aptId());
}

export async function saveModules(settings) {
    await saveApartmentModuleSettings(aptId(), settings);
}

export function bankAccount() {
    return portalState.admin?.bankAccount || {};
}

export async function saveBank(fields) {
    if (!supabase) throw new Error('Supabase required.');
    const apartment_id = aptId();
    if (!apartment_id) throw new Error('Select a society first.');
    if (!fields.bank_name?.trim()) throw new Error('Enter the bank name.');
    const payload = {
        id: portalState.admin?.bankAccount?.id || crypto.randomUUID(),
        apartment_id,
        bank_name: fields.bank_name.trim(),
        branch: fields.branch?.trim() || null,
        account_holder: fields.account_holder?.trim() || null,
        account_number: fields.account_number?.trim() || null,
        ifsc: fields.ifsc?.trim() || null,
        upi_id: fields.upi_id?.trim() || null,
        notes: fields.notes?.trim() || null,
        opening_balance_date: fields.opening_balance_date || null,
        opening_balance: fields.opening_balance === '' || fields.opening_balance == null
            ? null
            : Number(fields.opening_balance),
        updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('apartment_bank_accounts').upsert(payload, { onConflict: 'apartment_id' });
    if (error) throw new Error(error.message);
    await pullState();
}

export function vendors() {
    return portalState.finances?.vendors || [];
}

export async function saveVendor(row) {
    const name = row.name?.trim();
    if (!name) throw new Error('Vendor name is required.');
    const payload = {
        id: row.id || crypto.randomUUID(),
        apartment_id: aptId(),
        name,
        contact_phone: row.contact_phone?.trim() || null,
        contact_email: row.contact_email?.trim() || null,
        notes: row.notes?.trim() || null,
    };
    const { error } = await supabase.from('expense_vendors').upsert(payload, { onConflict: 'apartment_id,name' });
    if (error) throw new Error(error.message);
    await pullState();
    await refreshExpenseReferences();
}

export async function deleteVendor(id) {
    const { error } = await supabase.from('expense_vendors').delete().eq('id', id);
    if (error) throw new Error(error.message);
    await pullState();
    await refreshExpenseReferences();
}

export function subCategories() {
    const fn = portalState.financeNew?.finances?.subCategories;
    if (Array.isArray(fn) && fn.length) return fn;
    const cfg = portalState.financeNew?.config?.subCategories;
    if (Array.isArray(cfg) && cfg.length) return cfg;
    return portalState.finances?.subCategories || [];
}

export async function saveSubCategory(row) {
    const name = row.name?.trim();
    if (!name) throw new Error('Sub-category name is required.');
    const payload = {
        id: row.id || crypto.randomUUID(),
        apartment_id: aptId(),
        category: row.category,
        name,
    };
    try {
        const { mongoUpsert } = await import('../financeNew/mongoWrite.js');
        await mongoUpsert('expense_sub_categories', payload);
        return;
    } catch { /* fall through to classic table if Mongo is unavailable */ }
    const { error } = await supabase.from('expense_sub_categories').upsert(payload, { onConflict: 'apartment_id,category,name' });
    if (error) throw new Error(error.message);
    await pullState();
    await refreshExpenseReferences();
}

export async function deleteSubCategory(id) {
    try {
        const { mongoDelete } = await import('../financeNew/mongoWrite.js');
        await mongoDelete('expense_sub_categories', { id });
        return;
    } catch { /* fall through */ }
    const { error } = await supabase.from('expense_sub_categories').delete().eq('id', id);
    if (error) throw new Error(error.message);
    await pullState();
    await refreshExpenseReferences();
}

export function staffMembers() {
    return portalState.admin?.staff || [];
}

export async function saveStaff(row) {
    const full_name = row.full_name?.trim();
    const role_title = row.role_title?.trim();
    if (!full_name) throw new Error('Staff name is required.');
    if (!role_title) throw new Error('Role is required.');
    const payload = {
        id: row.id || crypto.randomUUID(),
        apartment_id: aptId(),
        full_name,
        role_title,
        phone: row.phone?.trim() || null,
        email: row.email?.trim() || null,
        notes: row.notes?.trim() || null,
        active: row.active !== false,
    };
    const { error } = await supabase.from('staff_members').upsert(payload);
    if (error) throw new Error(error.message);
    await pullState();
}

export async function deleteStaff(id) {
    const { error } = await supabase.from('staff_members').delete().eq('id', id);
    if (error) throw new Error(error.message);
    await pullState();
}

export async function loadPeopleDirectory() {
    const apartmentId = aptId();
    if (!supabase || !apartmentId) return { users: [], requests: [] };

    const [{ data: mappings, error: mapErr }, { data: roleRows }, { data: approvedRows }, requests] = await Promise.all([
        supabase.from('user_apartments').select('user_id, apartment_id').eq('apartment_id', apartmentId),
        supabase.from('user_role_assignments').select('user_id, apartment_id, role_key').eq('scope', 'apartment').eq('apartment_id', apartmentId),
        supabase.from('access_requests').select('user_id, requester_email, requester_name, requested_role_key').eq('apartment_id', apartmentId).eq('status', 'APPROVED'),
        fetchPendingAccessRequestsForAdmin(apartmentId),
    ]);
    if (mapErr) throw new Error(mapErr.message);

    const approvedById = new Map((approvedRows || []).map((r) => [r.user_id, r]));
    const userIds = [...new Set([
        ...(mappings || []).map((m) => m.user_id),
        ...(approvedRows || []).map((r) => r.user_id),
    ])].filter(Boolean);

    let profiles = [];
    if (userIds.length) {
        const { data, error: profilesErr } = await supabase
            .from('profiles')
            .select('id, full_name, email, role')
            .in('id', userIds)
            .order('full_name');
        if (profilesErr) throw new Error(profilesErr.message);
        profiles = data || [];
    }

    const rolesByUser = new Map();
    (roleRows || []).forEach((r) => {
        if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, {});
        rolesByUser.get(r.user_id)[r.apartment_id] = r.role_key;
    });

    const profileIds = new Set(profiles.map((p) => p.id));
    const users = profiles.map((p) => ({
        id: p.id,
        name: p.full_name || p.email || p.id,
        email: p.email || '',
        role: rolesByUser.get(p.id)?.[apartmentId] || p.role || 'resident_viewer',
        apartment_ids: [apartmentId],
        apartment_roles: rolesByUser.get(p.id) || {},
        approved: true,
    }));

    approvedById.forEach((row, id) => {
        if (profileIds.has(id)) return;
        users.push({
            id,
            name: row.requester_name || row.requester_email || id,
            email: row.requester_email || '',
            role: row.requested_role_key || 'resident_viewer',
            apartment_ids: [apartmentId],
            apartment_roles: { [apartmentId]: row.requested_role_key },
            approved: true,
        });
    });

    users.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
    portalState.access.users = users;
    return { users, requests };
}

export async function approveRequest(request, roleKey) {
    await approveAccessRequest(request, { roleKey });
    await pullState();
}

export async function denyRequest(request) {
    await denyAccessRequest(request);
    await pullState();
}

export async function assignUserAccess({ email, name, roleKey, apartmentIds }) {
    if (!isSocietyAdminUser()) throw new Error('Only a Society Administrator can assign or change roles.');
    const { data: prof, error } = await supabase.from('profiles').select('id, full_name, email, role').eq('email', email.trim()).single();
    if (error || !prof) throw new Error('User not found. Ask them to sign up first.');
    const previousAssignments = await loadUserRoleAssignments(prof.id);
    await saveUserAccess({
        userId: prof.id,
        name: name || prof.full_name,
        email: email.trim(),
        roleKey,
        apartmentIds,
        previousAssignments,
        managedApartmentIds: (portalState.access?.apartments || []).map((a) => a.id),
    });
    await pullState();
}

export function portalLinks() {
    return getLinksForApartment();
}

export function portalInvites() {
    return getInvitesForApartment();
}

export function residentsList() {
    return getResidents();
}

export async function unlinkPortal(linkId) {
    await unlinkResidentUserLink(linkId);
}

export async function manualPortalLink(payload) {
    await adminManualLinkAccount(payload);
}

export async function invitePortal(payload) {
    await sendPortalInvite(payload);
}

export async function revokeInvite(id) {
    await revokePortalInvite(id);
}

export async function loadConnections() {
    return ensureExternalConnectionsLoaded({ force: true });
}

export function connections() {
    return getExternalConnections();
}

export async function saveConnection(payload) {
    const res = await fetch('/api/external-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || 'Save failed.');
    portalState.admin = portalState.admin || {};
    portalState.admin.externalConnections = [
        ...getExternalConnections().filter((item) => !(item.provider === payload.provider && item.connection_key === payload.connection_key)),
        json.row,
    ];
    return json.row;
}

export function userDisplayRole(user) {
    const apt = aptId();
    const key = user?.apartment_roles?.[apt] || user?.role;
    return v2KeyToLabel(key) || key || 'Viewer';
}
