import { getMongoDb } from '../../../../packages/server/mongoClient.js';
import {
    DEFAULT_ROLE_PERMISSIONS,
    deriveCrudFromPermissionKeys,
    fullCrudMap,
    primaryRoleFromAssignments,
} from './defaults.js';

export const COL_ASSIGNMENTS = 'rbac_assignments';
export const COL_ROLE_PERMS = 'rbac_role_permissions';
export const COL_POLICIES = 'rbac_society_policies';
export const COL_OVERRIDES = 'rbac_user_overrides';
export const COL_META = 'rbac_meta';
export const COL_SOCIETIES = 'rbac_societies';
export const COL_DIRECTORY = 'rbac_directory';

async function collections() {
    const db = await getMongoDb();
    return {
        assignments: db.collection(COL_ASSIGNMENTS),
        rolePerms: db.collection(COL_ROLE_PERMS),
        policies: db.collection(COL_POLICIES),
        overrides: db.collection(COL_OVERRIDES),
        meta: db.collection(COL_META),
        societies: db.collection(COL_SOCIETIES),
        directory: db.collection(COL_DIRECTORY),
    };
}

export async function mongoRbacReady() {
    try {
        const { meta } = await collections();
        const flag = await meta.findOne({ _id: 'migration' });
        return flag?.source === 'mongo';
    } catch {
        return false;
    }
}

export async function ensureRbacIndexes() {
    const { assignments, rolePerms, policies, overrides, societies, directory } = await collections();
    await Promise.all([
        assignments.createIndex({ user_id: 1, apartment_id: 1, scope: 1 }),
        assignments.createIndex({ apartment_id: 1 }),
        rolePerms.createIndex({ role_key: 1 }, { unique: true }),
        policies.createIndex({ apartment_id: 1 }, { unique: true }),
        overrides.createIndex({ user_id: 1, apartment_id: 1 }, { unique: true }),
        societies.createIndex({ apartment_id: 1 }, { unique: true }),
        directory.createIndex({ user_id: 1 }, { unique: true }),
        directory.createIndex({ email: 1 }),
    ]);
}

export async function loadRolePermissionKeys(roleKey) {
    const { rolePerms } = await collections();
    const row = await rolePerms.findOne({ role_key: roleKey });
    if (row?.permission_keys?.length) return row.permission_keys;
    return DEFAULT_ROLE_PERMISSIONS[roleKey] || [];
}

export async function upsertRolePermissions(roleKey, permissionKeys) {
    const { rolePerms } = await collections();
    await rolePerms.updateOne(
        { role_key: roleKey },
        {
            $set: {
                role_key: roleKey,
                permission_keys: [...new Set(permissionKeys || [])],
                updated_at: new Date(),
            },
        },
        { upsert: true },
    );
}

export async function listAssignmentsForUser(userId) {
    const { assignments } = await collections();
    return assignments.find({ user_id: userId }).toArray();
}

export async function listAssignmentsForApartment(apartmentId) {
    const { assignments } = await collections();
    return assignments.find({ apartment_id: apartmentId, scope: 'apartment' }).toArray();
}

export async function upsertSociety({ apartmentId, name }) {
    if (!apartmentId) return;
    const { societies } = await collections();
    await societies.updateOne(
        { apartment_id: apartmentId },
        {
            $set: {
                apartment_id: apartmentId,
                name: name || apartmentId,
                updated_at: new Date(),
            },
        },
        { upsert: true },
    );
}

export async function listSocieties() {
    const { societies } = await collections();
    return societies.find({}).sort({ name: 1 }).toArray();
}

export async function upsertDirectoryProfile({
    userId, email, fullName, role, lastApartmentId,
}) {
    if (!userId) return;
    const { directory } = await collections();
    const $set = {
        user_id: userId,
        updated_at: new Date(),
    };
    if (email != null) $set.email = String(email).trim().toLowerCase();
    if (fullName != null) $set.full_name = fullName;
    if (role != null) $set.role = role;
    if (lastApartmentId != null) $set.last_apartment_id = lastApartmentId;
    await directory.updateOne(
        { user_id: userId },
        { $set, $setOnInsert: { user_id: userId } },
        { upsert: true },
    );
}

export async function getDirectoryProfile(userId) {
    if (!userId) return null;
    const { directory } = await collections();
    return directory.findOne({ user_id: userId });
}

export async function findDirectoryByEmail(email) {
    const key = String(email || '').trim().toLowerCase();
    if (!key) return null;
    const { directory } = await collections();
    return directory.findOne({ email: key });
}

export async function listDirectoryByIds(userIds = []) {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const { directory } = await collections();
    return directory.find({ user_id: { $in: ids } }).toArray();
}

export async function apartmentsForUser(userId) {
    const roles = await listAssignmentsForUser(userId);
    const isSystemAdmin = roles.some((r) => r.scope === 'system' && r.role_key === 'system_admin');
    const societies = await listSocieties();
    if (isSystemAdmin) {
        return societies.map((s) => ({ id: s.apartment_id, name: s.name || s.apartment_id }));
    }
    const ids = new Set(
        roles.filter((r) => r.scope === 'apartment' && r.apartment_id).map((r) => String(r.apartment_id)),
    );
    return societies
        .filter((s) => ids.has(String(s.apartment_id)))
        .map((s) => ({ id: s.apartment_id, name: s.name || s.apartment_id }));
}

export async function userHasMongoSocietyAccess(userId, apartmentId) {
    const roles = await listAssignmentsForUser(userId);
    if (roles.some((r) => r.scope === 'system' && r.role_key === 'system_admin')) return true;
    return roles.some(
        (r) => r.scope === 'apartment' && String(r.apartment_id) === String(apartmentId),
    );
}

export async function replaceApartmentAssignment({ userId, apartmentId, roleKey }) {
    const { assignments } = await collections();
    await assignments.deleteMany({
        user_id: userId,
        apartment_id: apartmentId,
        scope: 'apartment',
    });
    if (roleKey) {
        await assignments.insertOne({
            user_id: userId,
            apartment_id: apartmentId,
            role_key: roleKey,
            scope: 'apartment',
            updated_at: new Date(),
        });
    }
}

export async function loadSocietyPolicy(apartmentId) {
    const { policies } = await collections();
    return policies.findOne({ apartment_id: apartmentId });
}

export async function saveSocietyPolicy(apartmentId, { pages = {}, modules = {}, crud = {} }) {
    const { policies } = await collections();
    const existing = (await policies.findOne({ apartment_id: apartmentId })) || {};
    const mergeRoleMaps = (prev = {}, next = {}) => {
        const out = { ...prev };
        for (const [roleKey, row] of Object.entries(next || {})) {
            out[roleKey] = { ...(out[roleKey] || {}), ...(row || {}) };
        }
        return out;
    };
    await policies.updateOne(
        { apartment_id: apartmentId },
        {
            $set: {
                apartment_id: apartmentId,
                pages: mergeRoleMaps(existing.pages, pages),
                modules: mergeRoleMaps(existing.modules, modules),
                crud: mergeRoleMaps(existing.crud, crud),
                updated_at: new Date(),
            },
        },
        { upsert: true },
    );
}

/**
 * Resolve effective RBAC for a user in an apartment from Mongo.
 * Returns null if Mongo RBAC has not been populated.
 */
export async function resolveRbacForUser(userId, apartmentId) {
    if (!userId) return null;
    const ready = await mongoRbacReady();
    if (!ready) return null;

    const roles = await listAssignmentsForUser(userId);
    const isSystemAdmin = roles.some((r) => r.scope === 'system' && r.role_key === 'system_admin');
    if (isSystemAdmin) {
        const keys = await loadRolePermissionKeys('system_admin');
        return {
            isSystemAdmin: true,
            effectiveRoleKey: 'system_admin',
            permissions: keys.length ? keys : DEFAULT_ROLE_PERMISSIONS.system_admin,
            crudAccess: fullCrudMap(),
            assignments: roles,
        };
    }

    const aptRoles = roles.filter(
        (r) => r.scope === 'apartment' && String(r.apartment_id) === String(apartmentId),
    );
    const effectiveRoleKey = primaryRoleFromAssignments(aptRoles);
    const permissions = aptRoles.length ? await loadRolePermissionKeys(effectiveRoleKey) : [];

    let crudAccess = deriveCrudFromPermissionKeys(permissions);
    if (effectiveRoleKey === 'society_admin') crudAccess = fullCrudMap();
    const policy = apartmentId ? await loadSocietyPolicy(apartmentId) : null;
    if (policy?.crud?.[effectiveRoleKey]) {
        crudAccess = { ...crudAccess, ...policy.crud[effectiveRoleKey] };
    }

    return {
        isSystemAdmin: false,
        effectiveRoleKey: aptRoles.length ? effectiveRoleKey : null,
        permissions,
        crudAccess,
        assignments: roles,
        policy,
    };
}

export async function markMongoAsSource() {
    const { meta } = await collections();
    await meta.updateOne(
        { _id: 'migration' },
        { $set: { _id: 'migration', source: 'mongo', migrated_at: new Date() } },
        { upsert: true },
    );
}
