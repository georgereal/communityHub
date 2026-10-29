import {
    setSessionCookie,
    clearSessionCookie,
    authHeaderFromRequest,
    requireSession,
} from '../auth/server.js';
import { assertUuid } from './ids.js';
import { mongoRbacReady, resolveRbacForUser, userHasMongoSocietyAccess } from '../../apps/new/api/rbacMongo/service.js';
import { isNewUiRequest } from './uiMode.js';

export { setSessionCookie, clearSessionCookie, authHeaderFromRequest, requireSession };

async function assertSocietyMembership(req, userId, apartmentId) {
    if (await mongoRbacReady()) {
        const ok = await userHasMongoSocietyAccess(userId, apartmentId);
        if (!ok) throw Object.assign(new Error('No access to this society.'), { status: 403 });
        return;
    }
    throw Object.assign(new Error('Access control unavailable.'), { status: 503 });
}

export async function userHasPermission(service, userId, apartmentId, permissionKey, { mongoOnly = false } = {}) {
    try {
        const mongo = await resolveRbacForUser(userId, apartmentId);
        if (mongo) {
            if (mongo.isSystemAdmin) return true;
            return (mongo.permissions || []).includes(permissionKey);
        }
    } catch { /* no record → no permission */ }
    return false;
}

export async function requireApartmentPermission(req, apartmentIdRaw, permissionKey = 'accounts.edit') {
    const apartmentId = assertUuid(apartmentIdRaw, 'apartment_id');
    const { user, authHeader } = await requireSession(req);
    const service = null;

    await assertSocietyMembership(req, user.id, apartmentId);

    const allowed = await userHasPermission(service, user.id, apartmentId, permissionKey, { mongoOnly: true });
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
    } catch { /* fall through */ }

    if (action === 'delete') return false;
    return userHasPermission(service, userId, apartmentId, `${resourceKey}.edit`, { mongoOnly: true });
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
    const service = null;

    await assertSocietyMembership(req, user.id, apartmentId);

    for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        if (await userHasPermission(service, user.id, apartmentId, key, { mongoOnly: true })) {
            return { user, authHeader, apartmentId, service };
        }
    }
    throw Object.assign(new Error('Not permitted.'), { status: 403 });
}
