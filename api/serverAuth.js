import { createServiceClient, createUserClient, getUserFromAuthHeader } from './serverSupabase.js';
import { assertUuid } from './supabaseRest.js';
import { requireAccountsEditor } from './accountsAuth.js';

const SESSION_COOKIE = 'communityhub_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function cookieAttrs() {
    return [
        `Max-Age=${SESSION_TTL_SECONDS}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        process.env.NODE_ENV === 'production' ? 'Secure' : '',
    ].filter(Boolean).join('; ');
}

function parseCookies(cookieHeader = '') {
    return Object.fromEntries(
        String(cookieHeader || '')
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const idx = part.indexOf('=');
                if (idx < 0) return [part, ''];
                return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
            }),
    );
}

function bearerFromHeader(headers = {}) {
    const authHeader = headers.authorization || headers.Authorization || '';
    return typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader
        : '';
}

export function setSessionCookie(res, accessToken) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(accessToken)}; ${cookieAttrs()}`);
}

export function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

export function authHeaderFromRequest(req) {
    const direct = bearerFromHeader(req.headers);
    if (direct) return direct;
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE];
    return token ? `Bearer ${token}` : '';
}

export async function requireSession(req) {
    const authHeader = authHeaderFromRequest(req);
    const { user, error } = await getUserFromAuthHeader(authHeader);
    if (error || !user?.id) {
        throw Object.assign(new Error(error || 'Sign in required.'), { status: 401 });
    }
    return { user, authHeader };
}

export async function userHasPermission(service, userId, apartmentId, permissionKey) {
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

    const { data: mapping, error: mapErr } = await service
        .from('user_apartments')
        .select('apartment_id')
        .eq('user_id', user.id)
        .eq('apartment_id', apartmentId)
        .maybeSingle();
    if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
    if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });

    const allowed = await userHasPermission(service, user.id, apartmentId, permissionKey);
    if (!allowed) throw Object.assign(new Error('Not permitted.'), { status: 403 });

    return { user, authHeader, apartmentId, service };
}
