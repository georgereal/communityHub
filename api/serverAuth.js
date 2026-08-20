import {
    setSessionCookie,
    clearSessionCookie,
    authHeaderFromRequest,
    requireSession,
} from '../packages/auth/server.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';
import { assertUuid } from './supabaseRest.js';
import { requireAccountsEditor } from './accountsAuth.js';
import { mongoRbacReady, resolveRbacForUser, userHasMongoSocietyAccess } from './rbacMongo/service.js';
import { isNewUiRequest } from './uiMode.js';

export { setSessionCookie, clearSessionCookie, authHeaderFromRequest, requireSession };

async function assertSocietyMembership(req, service, userId, apartmentId) {
    if (isNewUiRequest(req) && await mongoRbacReady()) {
        const ok = await userHasMongoSocietyAccess(userId, apartmentId);
        if (!ok) throw Object.assign(new Error('No access to this society.'), { status: 403 });
        return;
    }
    const { data: mapping, error: mapErr } = await service
        .from('user_apartments')
        .select('apartment_id')
        .eq('user_id', userId)
        .eq('apartment_id', apartmentId)
        .maybeSingle();
    if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
    if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });
}

export async function userHasPermission(service, userId, apartmentId, permissionKey, { mongoOnly = false } = {}) {
    try {
        const mongo = await resolveRbacForUser(userId, apartmentId);
        if (mongo) {
            if (mongo.isSystemAdmin) return true;
            return (mongo.permissions || []).includes(permissionKey);
        }
        if (mongoOnly) return false;
    } catch {
        if (mongoOnly) return false;
    }

    try {
        const { data: roles } = await service
            .from('user_role_assignments')
            .select('role_key, scope, apartment_id')
            .eq('user_id', userId);

        const systemAdmin = (roles || []).some((r) => r.scope === 'system' && r.role_key === 'system_admin');
        if (systemAdmin) return true;

        const aptRoleKeys = (roles || [])
            .filter((r) => r.scope === 'apartment' && String(r.apartment_id) === String(apartmentId))
            .map((r) => r.role_key);

        if (aptRoleKeys.length) {
            const { data: perms } = await service
                .from('role_permissions')
                .select('permission_key')
                .in('role_key', aptRoleKeys);
            if ((perms || []).some((row) => row.permission_key === permissionKey)) return true;
        }
    } catch {
        // fall back to v1 role
    }

    const { data: prof } = await service
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle();

    const v1 = prof?.role || 'resident_viewer';
    if (permissionKey === 'accounts.edit') return ['admin', 'accounts_manager'].includes(v1);
    if (permissionKey === 'rbac.view') return ['admin'].includes(v1);
    return v1 === 'admin';
}

export async function requireApartmentPermission(req, apartmentIdRaw, permissionKey = 'accounts.edit') {
    const apartmentId = assertUuid(apartmentIdRaw, 'apartment_id');
    const { user, authHeader } = await requireSession(req);
    let service;
    try {
        service = createServiceClient();
    } catch (err) {
        if (!/SUPABASE_SERVICE_ROLE_KEY/i.test(err?.message || '')) throw err;
        if (permissionKey !== 'accounts.edit') {
            throw Object.assign(
                new Error('SUPABASE_SERVICE_ROLE_KEY is required for this server route in local development.'),
                { status: 500 },
            );
        }
        const fallback = await requireAccountsEditor(authHeader, apartmentId);
        return {
            user: fallback.user,
            authHeader: fallback.authHeader,
            apartmentId,
            service: createUserClient(fallback.authHeader),
        };
    }

    await assertSocietyMembership(req, service, user.id, apartmentId);

    const mongoOnly = isNewUiRequest(req) && await mongoRbacReady();
    const allowed = await userHasPermission(service, user.id, apartmentId, permissionKey, { mongoOnly });
    if (!allowed) throw Object.assign(new Error('Not permitted.'), { status: 403 });

    return { user, authHeader, apartmentId, service };
}

/**
 * Society CRUD matrix for a resource/action.
 * Delete is opt-in via matrix; Create/Update fall back to *.edit when no matrix row exists.
 */
export async function userCanCrud(service, userId, apartmentId, resourceKey, action = 'read') {
    try {
        const mongo = await resolveRbacForUser(userId, apartmentId);
        if (mongo) {
            if (mongo.isSystemAdmin) return true;
            const stored = mongo.crudAccess?.[resourceKey];
            if (stored && Object.prototype.hasOwnProperty.call(stored, action)) {
                return !!stored[action];
            }
            return false;
        }
    } catch {
        // fall through to Supabase
    }

    try {
        const { data: roles } = await service
            .from('user_role_assignments')
            .select('role_key, scope, apartment_id')
            .eq('user_id', userId);

        const systemAdmin = (roles || []).some((r) => r.scope === 'system' && r.role_key === 'system_admin');
        if (systemAdmin) return true;

        const aptRoleKeys = (roles || [])
            .filter((r) => r.scope === 'apartment' && String(r.apartment_id) === String(apartmentId))
            .map((r) => r.role_key);
        if (aptRoleKeys.includes('society_admin') || aptRoleKeys.includes('system_admin')) return true;

        const roleKey = aptRoleKeys[0];
        if (!roleKey) {
            if (action === 'delete') return false;
            if (action === 'read') {
                return userHasPermission(service, userId, apartmentId, `${resourceKey}.view`)
                    || userHasPermission(service, userId, apartmentId, `${resourceKey}.edit`);
            }
            return userHasPermission(service, userId, apartmentId, `${resourceKey}.edit`);
        }

        const { data: rows } = await service
            .from('society_role_crud_access')
            .select('resource_key, can_create, can_read, can_update, can_delete')
            .eq('apartment_id', apartmentId)
            .eq('role_key', roleKey);

        if (rows?.length) {
            const row = rows.find((r) => r.resource_key === resourceKey);
            if (row) {
                const map = {
                    create: row.can_create,
                    read: row.can_read,
                    update: row.can_update,
                    delete: row.can_delete,
                };
                return !!map[action];
            }
        }

        if (action === 'delete') return false;
        if (action === 'read') {
            return userHasPermission(service, userId, apartmentId, `${resourceKey}.view`)
                || userHasPermission(service, userId, apartmentId, `${resourceKey}.edit`);
        }
        return userHasPermission(service, userId, apartmentId, `${resourceKey}.edit`);
    } catch {
        if (action === 'delete') return false;
        return userHasPermission(service, userId, apartmentId, `${resourceKey}.edit`);
    }
}

export async function requireApartmentCrud(req, apartmentIdRaw, resourceKey, action, fallbackPermission = 'accounts.edit') {
    const auth = await requireApartmentPermission(req, apartmentIdRaw, fallbackPermission);
    const allowed = await userCanCrud(auth.service, auth.user.id, auth.apartmentId, resourceKey, action);
    if (!allowed) {
        throw Object.assign(new Error(`Not permitted to ${action} ${resourceKey}.`), { status: 403 });
    }
    return auth;
}

/** Accept if the user has any of the listed permissions. */
export async function requireAnyApartmentPermission(req, apartmentIdRaw, permissionKeys = ['accounts.edit']) {
    const keys = [...new Set((Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys]).filter(Boolean))];
    if (!keys.length) keys.push('accounts.edit');

    const apartmentId = assertUuid(apartmentIdRaw, 'apartment_id');
    const { user, authHeader } = await requireSession(req);
    let service;
    try {
        service = createServiceClient();
    } catch (err) {
        if (!/SUPABASE_SERVICE_ROLE_KEY/i.test(err?.message || '')) throw err;
        if (!keys.includes('accounts.edit')) {
            throw Object.assign(
                new Error('SUPABASE_SERVICE_ROLE_KEY is required for this server route in local development.'),
                { status: 500 },
            );
        }
        const fallback = await requireAccountsEditor(authHeader, apartmentId);
        return {
            user: fallback.user,
            authHeader: fallback.authHeader,
            apartmentId,
            service: createUserClient(fallback.authHeader),
        };
    }

    await assertSocietyMembership(req, service, user.id, apartmentId);

    const mongoOnly = isNewUiRequest(req) && await mongoRbacReady();
    for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        if (await userHasPermission(service, user.id, apartmentId, key, { mongoOnly })) {
            return { user, authHeader, apartmentId, service };
        }
    }
    throw Object.assign(new Error('Not permitted.'), { status: 403 });
}
