import { portalState, pullState, upsertSocietyConfig } from '../store.js';
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
import { can, assertCan } from '../capabilities.js';
import { readApiJson } from '../apiJson.js';
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
    return can('setup.edit');
}

export function canEditAccounts() {
    return can('accounts.edit');
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
    assertCan('admin.society.save');
    const apartment_id = aptId();
    if (!apartment_id) throw new Error('No active apartment selected.');
    const { error: cfgError } = await upsertSocietyConfig(apartment_id, { name, car_default, bike_default });
    if (cfgError) throw new Error(cfgError.message);
    await fetch('/api/rbac-mongo', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveSociety', apartment_id, name }),
    });
    const { propertyFetch } = await import('../propertyApp/client.js');
    await propertyFetch('/api/property/units/parking-limits', {
        method: 'POST',
        body: { car_limit: car_default, bike_limit: bike_default },
    }).catch(() => {});
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
    assertCan('admin.society.save');
    await saveApartmentModuleSettings(aptId(), settings);
}

export function bankAccount() {
    return portalState.admin?.bankAccount
        || portalState.financeNew?.config?.bankAccount
        || {};
}

export async function saveBank(fields) {
    assertCan('admin.bank.save');
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
    const { postFnMutation } = await import('../financeNew/mongoMutations.js');
    await postFnMutation('patchFinanceConfig', { bankAccount: payload });
    portalState.admin = portalState.admin || {};
    portalState.admin.bankAccount = payload;
}

export function vendors() {
    return portalState.financeNew?.config?.vendors
        || portalState.finances?.vendors
        || [];
}

export async function saveVendor(row) {
    assertCan('admin.vendors.edit');
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
    const { mongoUpsert } = await import('../financeNew/mongoWrite.js');
    await mongoUpsert('expense_vendors', payload);
}

export async function deleteVendor(id) {
    assertCan('admin.vendors.edit');
    const { mongoDelete } = await import('../financeNew/mongoWrite.js');
    await mongoDelete('expense_vendors', { id });
}

export function subCategories() {
    const fn = portalState.financeNew?.finances?.subCategories;
    if (Array.isArray(fn) && fn.length) return fn;
    const cfg = portalState.financeNew?.config?.subCategories;
    if (Array.isArray(cfg) && cfg.length) return cfg;
    return portalState.finances?.subCategories || [];
}

export async function saveSubCategory(row) {
    assertCan('admin.categories.edit');
    const name = row.name?.trim();
    if (!name) throw new Error('Sub-category name is required.');
    const payload = {
        id: row.id || crypto.randomUUID(),
        apartment_id: aptId(),
        category: row.category,
        name,
    };
    const { mongoUpsert } = await import('../financeNew/mongoWrite.js');
    await mongoUpsert('expense_sub_categories', payload);
}

export async function deleteSubCategory(id) {
    assertCan('admin.categories.edit');
    const { mongoDelete } = await import('../financeNew/mongoWrite.js');
    await mongoDelete('expense_sub_categories', { id });
}

export function staffMembers() {
    return portalState.financeNew?.config?.staff || portalState.admin?.staff || [];
}

export async function saveStaff(row) {
    assertCan('admin.staff.edit');
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
    const { mongoUpsert } = await import('../financeNew/mongoWrite.js');
    await mongoUpsert('staff_members', payload);
}

export async function deleteStaff(id) {
    assertCan('admin.staff.edit');
    const { mongoDelete } = await import('../financeNew/mongoWrite.js');
    await mongoDelete('staff_members', { id });
}

export async function loadPeopleDirectory() {
    const apartmentId = aptId();
    const { isNewUi } = await import('../uiMode.js');
    if (isNewUi()) {
        if (!apartmentId) return { users: [], requests: [] };
        const res = await fetch(`/api/rbac-mongo?apartment_id=${encodeURIComponent(apartmentId)}`, {
            credentials: 'include',
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Could not load people.');
        const dirMap = new Map((json.directory || []).map((p) => [p.user_id, p]));
        const rolesByUser = new Map();
        (json.assignments || []).forEach((r) => {
            if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, {});
            rolesByUser.get(r.user_id)[r.apartment_id] = r.role_key;
        });
        const users = [...rolesByUser.entries()].map(([id, apartment_roles]) => {
            const p = dirMap.get(id) || {};
            return {
                id,
                name: p.full_name || p.email || id,
                email: p.email || '',
                role: apartment_roles[apartmentId] || p.role || 'resident_viewer',
                apartment_ids: [apartmentId],
                apartment_roles,
                approved: true,
            };
        });
        users.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
        portalState.access.users = users;
        return { users, requests: [] };
    }
    if (!apartmentId) return { users: [], requests: [] };
    return { users: [], requests: [] };
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
    assertCan('admin.people.assign');
    if (!isSocietyAdminUser()) throw new Error('Only a Society Administrator can assign or change roles.');
    const { isNewUi } = await import('../uiMode.js');
    if (isNewUi()) {
        const apartmentId = aptId();
        const res = await fetch('/api/rbac-mongo', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'findDirectory',
                apartment_id: apartmentId,
                email: email.trim(),
            }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Could not look up user.');
        const prof = json.user;
        if (!prof?.user_id) throw new Error('User not found in Mongo directory. Re-run migrate:rbac-mongo after they sign up.');
        const previousAssignments = await loadUserRoleAssignments(prof.user_id);
        await saveUserAccess({
            userId: prof.user_id,
            name: name || prof.full_name,
            email: email.trim(),
            roleKey,
            apartmentIds,
            previousAssignments,
            managedApartmentIds: (portalState.access?.apartments || []).map((a) => a.id),
        });
    }
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
    assertCan('admin.integrations.edit');
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

export async function loadRbacMatrix() {
    const apartmentId = aptId();
    if (!apartmentId) throw new Error('Select a society first.');
    const { isNewUi } = await import('../uiMode.js');
    const { buildRbacMatrixState, MATRIX_ROLE_KEYS, CRUD_RESOURCES, defaultCrudFromPermKeys } = await import('../rbacMatrix.js');
    const { MODULE_CATALOG, LOCKED_MODULE_KEYS } = await import('../moduleAccess.js');
    const { buildPageCatalog, pageAllowedByPermissions, pageCatalogByModule } = await import('../navigation.js');

    if (!isNewUi()) {
        return buildRbacMatrixState(apartmentId);
    }

    const res = await fetch(`/api/rbac-mongo?apartment_id=${encodeURIComponent(apartmentId)}`, {
        credentials: 'include',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Could not load roles from Mongo.');
    const policy = json.policy || { pages: {}, modules: {}, crud: {} };
    const defaults = json.defaultRolePermissions || {};
    const roles = MATRIX_ROLE_KEYS;
    const pages = {};
    const moduleEnabled = {};
    const crud = {};
    roles.forEach((roleKey) => {
        const permKeys = defaults[roleKey] || [];
        pages[roleKey] = {};
        buildPageCatalog().forEach((page) => {
            if (Object.prototype.hasOwnProperty.call(policy.pages?.[roleKey] || {}, page.route)) {
                pages[roleKey][page.route] = policy.pages[roleKey][page.route];
            } else {
                pages[roleKey][page.route] = pageAllowedByPermissions(page, permKeys);
            }
        });
        moduleEnabled[roleKey] = {};
        MODULE_CATALOG.forEach(({ key }) => {
            const stored = policy.modules?.[roleKey]?.[key];
            if (typeof stored === 'boolean') {
                moduleEnabled[roleKey][key] = LOCKED_MODULE_KEYS.has(key) ? true : stored;
            } else {
                moduleEnabled[roleKey][key] = true;
            }
        });
        crud[roleKey] = {};
        CRUD_RESOURCES.forEach(({ key }) => {
            const stored = policy.crud?.[roleKey]?.[key];
            crud[roleKey][key] = stored
                ? { create: false, read: false, update: false, delete: false, ...stored }
                : defaultCrudFromPermKeys(key, permKeys);
        });
    });
    return {
        roles,
        modules: MODULE_CATALOG,
        pageGroups: pageCatalogByModule(true),
        resources: CRUD_RESOURCES,
        pages,
        moduleEnabled,
        crud,
    };
}

export async function saveRbacEditor(draft) {
    assertCan('admin.roles.edit');
    const apartmentId = aptId();
    if (!apartmentId) throw new Error('Select a society first.');
    const {
        saveRbacMatrix,
        derivePagesAndModulesFromCrud,
    } = await import('../rbacMatrix.js');
    const { applyNavPermissions } = await import('../navigation.js');
    const { resolveEffectivePermissions } = await import('../rbac.js');
    const crud = draft.crud || {};
    const derived = derivePagesAndModulesFromCrud(crud, Object.keys(crud));
    await saveRbacMatrix(apartmentId, {
        crud,
        pages: derived.pages,
        moduleEnabled: derived.moduleEnabled,
    });
    applyNavPermissions(new Set(resolveEffectivePermissions()));
}
