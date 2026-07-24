/**
 * One-shot workspace boot — profile, society access, roles, permissions,
 * module/page access, core state, and dashboard summary in a single request.
 */
import { requireSession } from './serverAuth.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';
import { getQueryParam } from './vercelRequest.js';
import { fetchCoreState } from './stateDomains.js';
import { buildDashboardSummary } from './dashboard-summary.js';

function logBoot(userId, apartmentId, ms, error) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/workspace-boot',
        userId,
        apartmentId,
        ms,
        ok: !error,
        error: error || null,
    }));
}

async function getService(req) {
    const { authHeader } = await requireSession(req);
    try {
        return createServiceClient();
    } catch {
        return createUserClient(authHeader);
    }
}

function emptyArr(result) {
    return result?.error ? [] : (result?.data || []);
}

async function resolveApartmentPool(service, uid, profile) {
    const { data: mappings, error: mapError } = await service
        .from('user_apartments')
        .select('apartment_id')
        .eq('user_id', uid);
    if (mapError) throw Object.assign(new Error(mapError.message), { status: 500 });

    const mappedIds = [...new Set((mappings || []).map((m) => m.apartment_id).filter(Boolean))];
    let pool = [];
    if (mappedIds.length) {
        const { data, error } = await service.from('apartments').select('id, name').in('id', mappedIds);
        if (error) throw Object.assign(new Error(error.message), { status: 500 });
        pool = (data || []).filter((a) => a.name !== '__SYSTEM__');
    }

    if (!pool.length && profile?.role === 'admin') {
        const { data, error } = await service.from('apartments').select('id, name').order('name');
        if (error) throw Object.assign(new Error(error.message), { status: 500 });
        pool = (data || []).filter((a) => a.name !== '__SYSTEM__');
    }

    return {
        apartments: pool,
        apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id),
    };
}

function pickActiveId(pool, preferredIds = []) {
    for (const id of preferredIds) {
        if (id && pool.some((a) => a.id === id)) return id;
    }
    return pool[0]?.id || null;
}

async function loadPermissionsForRoles(service, roles, apartmentId) {
    const isSystemAdmin = (roles || []).some((r) => r.scope === 'system' && r.role_key === 'system_admin');
    if (isSystemAdmin) {
        const { data } = await service.from('permissions').select('key');
        return {
            isSystemAdmin: true,
            permissions: (data || []).map((p) => p.key),
            effectiveRoleKey: 'system_admin',
        };
    }

    const aptRoleKeys = (roles || [])
        .filter((r) => r.scope === 'apartment' && r.apartment_id === apartmentId)
        .map((r) => r.role_key);
    if (!aptRoleKeys.length) {
        return { isSystemAdmin: false, permissions: [], effectiveRoleKey: null };
    }

    const { data: rp } = await service
        .from('role_permissions')
        .select('permission_key')
        .in('role_key', aptRoleKeys);

    return {
        isSystemAdmin: false,
        permissions: [...new Set((rp || []).map((x) => x.permission_key))],
        effectiveRoleKey: aptRoleKeys[0] || null,
    };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const started = Date.now();
    let userId = null;
    let apartmentId = null;

    try {
        const { user } = await requireSession(req);
        userId = user.id;
        const service = await getService(req);
        const hintApartmentId = getQueryParam(req, 'apartment_id') || null;

        const { data: profile, error: profileErr } = await service
            .from('profiles')
            .select('id, full_name, email, role, last_apartment_id')
            .eq('id', user.id)
            .maybeSingle();
        if (profileErr) throw Object.assign(new Error(profileErr.message), { status: 500 });

        const { apartments, apartmentIds } = await resolveApartmentPool(service, user.id, profile);
        apartmentId = pickActiveId(apartments, [
            hintApartmentId,
            profile?.last_apartment_id,
        ]);

        if (!apartments.length || !apartmentId) {
            logBoot(userId, null, Date.now() - started);
            return res.status(200).json({
                ok: true,
                profile: profile || null,
                apartments: [],
                activeApartmentId: null,
                apartmentIds: [],
                roleAssignments: [],
                permissions: [],
                isSystemAdmin: false,
                effectiveRoleKey: null,
                moduleAccess: { apartment: {}, user: {} },
                pageAccess: { user: {}, societyRole: {} },
                core: null,
                summary: null,
            });
        }

        const [
            rolesRes,
            modAptRes,
            modUserRes,
            pageUserRes,
            core,
            summary,
        ] = await Promise.all([
            service
                .from('user_role_assignments')
                .select('role_key, apartment_id, scope')
                .eq('user_id', user.id),
            service
                .from('apartment_module_settings')
                .select('module_key, enabled')
                .eq('apartment_id', apartmentId),
            service
                .from('user_module_access')
                .select('module_key, enabled')
                .eq('apartment_id', apartmentId)
                .eq('user_id', user.id),
            service
                .from('user_page_overrides')
                .select('route, access')
                .eq('user_id', user.id)
                .eq('apartment_id', apartmentId),
            fetchCoreState(service, apartmentId),
            buildDashboardSummary(service, apartmentId),
        ]);

        if (rolesRes.error) throw Object.assign(new Error(rolesRes.error.message), { status: 500 });

        const roleAssignments = rolesRes.data || [];
        const permInfo = await loadPermissionsForRoles(service, roleAssignments, apartmentId);

        let societyRoleMap = {};
        if (permInfo.effectiveRoleKey && permInfo.effectiveRoleKey !== 'system_admin') {
            const { data: societyPages } = await service
                .from('society_role_page_access')
                .select('route, allowed')
                .eq('apartment_id', apartmentId)
                .eq('role_key', permInfo.effectiveRoleKey);
            (societyPages || []).forEach((row) => {
                societyRoleMap[row.route] = row.allowed;
            });
        }

        const normalizeModules = (rows) => {
            const map = {};
            (rows || []).forEach((r) => {
                map[r.module_key] = !!r.enabled;
            });
            return map;
        };

        const userPageMap = {};
        emptyArr(pageUserRes).forEach((row) => {
            userPageMap[row.route] = row.access;
        });

        // Persist last apartment only when it actually changed (service client — not /api/db).
        if (
            profile
            && profile.last_apartment_id !== apartmentId
            && apartmentId
        ) {
            await service.from('profiles').update({ last_apartment_id: apartmentId }).eq('id', user.id);
        }

        logBoot(userId, apartmentId, Date.now() - started);
        return res.status(200).json({
            ok: true,
            profile: profile || {
                id: user.id,
                email: user.email || '',
                full_name: null,
                role: 'resident_viewer',
                last_apartment_id: apartmentId,
            },
            apartments,
            activeApartmentId: apartmentId,
            apartmentIds,
            roleAssignments,
            permissions: permInfo.permissions,
            isSystemAdmin: permInfo.isSystemAdmin,
            effectiveRoleKey: permInfo.effectiveRoleKey,
            moduleAccess: {
                apartment: modAptRes.error ? {} : normalizeModules(modAptRes.data),
                user: modUserRes.error ? {} : normalizeModules(modUserRes.data),
            },
            pageAccess: {
                user: userPageMap,
                societyRole: permInfo.effectiveRoleKey
                    ? { [permInfo.effectiveRoleKey]: societyRoleMap }
                    : {},
            },
            core,
            summary,
        });
    } catch (err) {
        logBoot(userId, apartmentId, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'Workspace boot failed.' });
    }
}
