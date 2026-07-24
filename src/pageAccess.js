/**
 * Page-level access: society role templates + per-user overrides.
 */
import { portalState, supabase } from './store.js';
import { buildPageCatalog, findCatalogPage, pageAllowedByPermissions } from './navigation.js';
import { ROLE_OPTIONS } from './rbac.js';

export { resolvePageAccess, pageAccessBlocksRoute, pageAccessGrantsRoute } from './pageAccessResolve.js';

const SOCIETY_SCOPED_ROLES = ROLE_OPTIONS.map((r) => r.key);

export { SOCIETY_SCOPED_ROLES };

export async function fetchRolePermissionKeys(roleKey) {
    if (!supabase || !roleKey) return [];
    const { data, error } = await supabase
        .from('role_permissions')
        .select('permission_key')
        .eq('role_key', roleKey);
    if (error) {
        if (/role_permissions/i.test(error.message)) return [];
        throw new Error(error.message);
    }
    return (data || []).map((r) => r.permission_key);
}

export async function fetchSocietyRolePageMap(apartmentId, roleKey) {
    if (!supabase || !apartmentId || !roleKey) return {};
    const { data, error } = await supabase
        .from('society_role_page_access')
        .select('route, allowed')
        .eq('apartment_id', apartmentId)
        .eq('role_key', roleKey);
    if (error) {
        if (/society_role_page_access/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    const map = {};
    (data || []).forEach((row) => { map[row.route] = row.allowed; });
    return map;
}

export async function fetchUserPageOverrides(userId, apartmentId) {
    if (!supabase || !userId || !apartmentId) return {};
    const { data, error } = await supabase
        .from('user_page_overrides')
        .select('route, access')
        .eq('user_id', userId)
        .eq('apartment_id', apartmentId);
    if (error) {
        if (/user_page_overrides/i.test(error.message)) return {};
        throw new Error(error.message);
    }
    const map = {};
    (data || []).forEach((row) => { map[row.route] = row.access; });
    return map;
}

/** Effective allow/deny for a page under a role (society template + platform defaults). */
export async function effectiveRolePageAllowed(apartmentId, roleKey, route, permKeys = null) {
    const page = findCatalogPage(route);
    if (!page) return false;
    const societyMap = await fetchSocietyRolePageMap(apartmentId, roleKey);
    if (Object.prototype.hasOwnProperty.call(societyMap, route)) {
        return societyMap[route];
    }
    const keys = permKeys || await fetchRolePermissionKeys(roleKey);
    return pageAllowedByPermissions(page, keys);
}

/** Load runtime page access for signed-in user. */
export async function loadUserPageAccess(apartmentId, userId, roleKey) {
    portalState.pageAccess = portalState.pageAccess || { user: {}, societyRole: {} };
    if (!supabase || !apartmentId || !userId) {
        portalState.pageAccess.user = {};
        portalState.pageAccess.societyRole = {};
        return portalState.pageAccess;
    }

    const book = globalThis.__sentryPageAccessBook || (globalThis.__sentryPageAccessBook = { inflight: new Map() });
    const key = `${apartmentId}:${userId}:${roleKey || ''}`;
    if (book.inflight.has(key)) return book.inflight.get(key);

    const run = (async () => {
        const [userOverrides, societyMap] = await Promise.all([
            fetchUserPageOverrides(userId, apartmentId),
            roleKey ? fetchSocietyRolePageMap(apartmentId, roleKey) : Promise.resolve({}),
        ]);

        portalState.pageAccess.user = userOverrides;
        portalState.pageAccess.societyRole = roleKey ? { [roleKey]: societyMap } : {};
        return portalState.pageAccess;
    })().finally(() => {
        book.inflight.delete(key);
    });

    book.inflight.set(key, run);
    return run;
}

/**
 * Save society role page template (sparse: only rows that differ from platform defaults).
 * @param {Record<string, boolean>} pageStates route -> checked
 */
export async function saveSocietyRolePageAccess(apartmentId, roleKey, pageStates) {
    if (!supabase || !apartmentId || !roleKey) throw new Error('Apartment and role required.');
    const permKeys = await fetchRolePermissionKeys(roleKey);
    const catalog = buildPageCatalog();

    const toUpsert = [];
    const toDelete = [];

    catalog.forEach((page) => {
        const checked = pageStates[page.route] === true;
        const defaultAllowed = pageAllowedByPermissions(page, permKeys);
        if (checked === defaultAllowed) {
            toDelete.push(page.route);
        } else {
            toUpsert.push({ apartment_id: apartmentId, role_key: roleKey, route: page.route, allowed: checked });
        }
    });

    if (toDelete.length) {
        const { error } = await supabase
            .from('society_role_page_access')
            .delete()
            .eq('apartment_id', apartmentId)
            .eq('role_key', roleKey)
            .in('route', toDelete);
        if (error && !/society_role_page_access/i.test(error.message)) throw new Error(error.message);
    }

    if (toUpsert.length) {
        const { error } = await supabase.from('society_role_page_access').upsert(
            toUpsert.map((row) => ({ ...row, updated_at: new Date().toISOString() })),
            { onConflict: 'apartment_id,role_key,route' },
        );
        if (error) throw new Error(error.message);
    }

    portalState.pageAccess = portalState.pageAccess || { user: {}, societyRole: {} };
    const map = await fetchSocietyRolePageMap(apartmentId, roleKey);
    portalState.pageAccess.societyRole = portalState.pageAccess.societyRole || {};
    portalState.pageAccess.societyRole[roleKey] = map;
}

/**
 * Save user page overrides (sparse: only grant/deny when different from role effective access).
 * @param {Record<string, 'inherit'|'grant'|'deny'|null>} overrideStates
 */
export async function saveUserPageOverrides(userId, apartmentId, roleKey, overrideStates) {
    if (!supabase || !userId || !apartmentId) throw new Error('User and apartment required.');
    const permKeys = await fetchRolePermissionKeys(roleKey);
    const societyMap = await fetchSocietyRolePageMap(apartmentId, roleKey);
    const catalog = buildPageCatalog();

    const toInsert = [];
    const toDelete = [];

    for (const page of catalog) {
        const choice = overrideStates[page.route];
        let roleAllowed = pageAllowedByPermissions(page, permKeys);
        if (Object.prototype.hasOwnProperty.call(societyMap, page.route)) {
            roleAllowed = societyMap[page.route];
        }

        if (!choice || choice === 'inherit') {
            toDelete.push(page.route);
            continue;
        }
        const wantGrant = choice === 'grant';
        if (wantGrant === roleAllowed) {
            toDelete.push(page.route);
        } else {
            toInsert.push({
                user_id: userId,
                apartment_id: apartmentId,
                route: page.route,
                access: wantGrant ? 'grant' : 'deny',
                updated_at: new Date().toISOString(),
            });
        }
    }

    if (toDelete.length) {
        const { error } = await supabase
            .from('user_page_overrides')
            .delete()
            .eq('user_id', userId)
            .eq('apartment_id', apartmentId)
            .in('route', toDelete);
        if (error && !/user_page_overrides/i.test(error.message)) throw new Error(error.message);
    }

    if (toInsert.length) {
        const { error } = await supabase.from('user_page_overrides').upsert(
            toInsert,
            { onConflict: 'user_id,apartment_id,route' },
        );
        if (error) throw new Error(error.message);
    }
}

/** Build initial checkbox state for role editor. */
export async function buildRolePageEditorState(apartmentId, roleKey) {
    const permKeys = await fetchRolePermissionKeys(roleKey);
    const societyMap = await fetchSocietyRolePageMap(apartmentId, roleKey);
    const states = {};
    buildPageCatalog().forEach((page) => {
        if (Object.prototype.hasOwnProperty.call(societyMap, page.route)) {
            states[page.route] = societyMap[page.route];
        } else {
            states[page.route] = pageAllowedByPermissions(page, permKeys);
        }
    });
    return { states, permKeys, societyMap };
}

/** Build tri-state for user override editor. */
export async function buildUserPageOverrideState(userId, apartmentId, roleKey) {
    const permKeys = await fetchRolePermissionKeys(roleKey);
    const [societyMap, overrides] = await Promise.all([
        fetchSocietyRolePageMap(apartmentId, roleKey),
        fetchUserPageOverrides(userId, apartmentId),
    ]);
    const states = {};
    buildPageCatalog().forEach((page) => {
        if (overrides[page.route]) {
            states[page.route] = overrides[page.route] === 'grant' ? 'grant' : 'deny';
        } else {
            states[page.route] = 'inherit';
        }
    });
    return { states, permKeys, societyMap, overrides };
}

export function effectivePageAllowedFromRole(page, permKeys, societyMap) {
    if (Object.prototype.hasOwnProperty.call(societyMap, page.route)) {
        return societyMap[page.route];
    }
    return pageAllowedByPermissions(page, permKeys);
}
