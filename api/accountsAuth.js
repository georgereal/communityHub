import { getAuthUser, restMaybeSingle, restSelect, restIn, supabasePublicEnv, assertUuid } from './supabaseRest.js';

export { supabasePublicEnv };

async function userCanAccountsEdit(authHeader, userId, apartmentId) {
    try {
        const { data: roles } = await restSelect(authHeader, 'user_role_assignments', { user_id: userId });
        const aptRoleKeys = (roles || [])
            .filter((r) => r.scope === 'apartment' && String(r.apartment_id) === String(apartmentId))
            .map((r) => r.role_key);

        if (aptRoleKeys.length) {
            const { data: rp } = await restIn(authHeader, 'role_permissions', 'role_key', aptRoleKeys, 'permission_key');
            const perms = new Set((rp || []).map((x) => x.permission_key));
            if (perms.has('accounts.edit')) return true;
        }
    } catch {
        // fall back to v1 profile role
    }

    const { data: prof } = await restMaybeSingle(authHeader, 'profiles', { id: userId }, 'role');
    return ['admin', 'accounts_manager'].includes(prof?.role);
}

/**
 * Authenticate via the caller's session (Bearer JWT) and verify accounts access.
 * Uses Supabase HTTP APIs only — no Realtime/WebSocket SDK on the server.
 */
export async function requireAccountsEditor(authHeader, apartmentId) {
    if (!authHeader?.startsWith('Bearer ')) {
        throw Object.assign(new Error('Sign in required.'), { status: 401 });
    }
    if (!apartmentId) {
        throw Object.assign(new Error('apartment_id is required.'), { status: 400 });
    }
    const apartment_id = assertUuid(apartmentId, 'apartment_id');

    const { user, error: userError } = await getAuthUser(authHeader);
    if (userError || !user?.id) {
        throw Object.assign(new Error('Invalid session.'), { status: 401 });
    }
    const userId = assertUuid(user.id, 'user id');

    const { data: mapping, error: mapErr } = await restMaybeSingle(
        authHeader,
        'user_apartments',
        { apartment_id },
        'apartment_id',
    );

    if (mapErr) throw Object.assign(new Error(mapErr), { status: 500 });
    if (!mapping) {
        throw Object.assign(new Error('No access to this society.'), { status: 403 });
    }

    const allowed = await userCanAccountsEdit(authHeader, userId, apartment_id);
    if (!allowed) {
        throw Object.assign(new Error('Not permitted.'), { status: 403 });
    }

    return { user, authHeader };
}
