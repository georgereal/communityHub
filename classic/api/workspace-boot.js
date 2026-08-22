/**
 * Slim workspace boot — profile, apartments, roles, permissions only.
 * Module/page/society access maps load async after login (see accessSync).
 */
import { requireSession } from '../../packages/server/serverAuth.js';
import { createServiceClient, createUserClient } from '../../packages/server/serverSupabase.js';
import { getQueryParam } from '../../packages/server/vercelRequest.js';
import { isNewUiRequest } from '../../packages/server/uiMode.js';

/** Prefer higher-privilege society role when multiple assignments exist. */
function primaryRoleFromAssignments(assignments = []) {
    if (!assignments.length) return 'resident_viewer';
    const priority = [
        'society_admin',
        'apartment_admin',
        'accounts_manager',
        'property_manager',
        'office_staff',
        'security',
        'resident_viewer',
    ];
    for (const key of priority) {
        if (assignments.some((a) => a.role_key === key)) return key;
    }
    return assignments[0].role_key;
}

function logBoot(userId, apartmentId, ms, error, phases = null) {
    let errorText = null;
    if (error != null) {
        if (typeof error === 'string') errorText = error;
        else if (error?.message) errorText = String(error.message);
        else {
            try { errorText = JSON.stringify(error); } catch { errorText = String(error); }
        }
    }
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/workspace-boot',
        userId,
        apartmentId,
        ms,
        ok: !errorText,
        error: errorText,
        phases,
    }));
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

    const aptRoles = (roles || []).filter((r) => r.scope === 'apartment' && r.apartment_id === apartmentId);
    if (!aptRoles.length) {
        return { isSystemAdmin: false, permissions: [], effectiveRoleKey: null };
    }

    const effectiveRoleKey = primaryRoleFromAssignments(aptRoles);
    const { data: rp } = await service
        .from('role_permissions')
        .select('permission_key')
        .eq('role_key', effectiveRoleKey);

    return {
        isSystemAdmin: false,
        permissions: [...new Set((rp || []).map((x) => x.permission_key))],
        effectiveRoleKey,
    };
}

function apartmentsFromMappings(rows = []) {
    const pool = [];
    const seen = new Set();
    for (const row of rows) {
        const apt = row.apartments;
        const id = apt?.id || row.apartment_id;
        if (!id || seen.has(id)) continue;
        const name = apt?.name;
        if (name === '__SYSTEM__') continue;
        seen.add(id);
        pool.push({ id, name: name || id });
    }
    return pool;
}

const CRUD_RESOURCE_KEYS = [
    'vehicle_registry',
    'apartment_mgmt',
    'accounts',
    'security',
    'portal',
    'setup',
    'rbac',
];

function fullCrudMap() {
    const map = {};
    for (const key of CRUD_RESOURCE_KEYS) {
        map[key] = { create: true, read: true, update: true, delete: true };
    }
    // Gate / portal stay non-destructive by default even for full admins in the matrix UI.
    map.security = { create: true, read: true, update: true, delete: false };
    map.portal = { create: true, read: true, update: true, delete: false };
    return map;
}

function deriveCrudFromPermissionKeys(permKeys = []) {
    const set = new Set(permKeys || []);
    const map = {};
    for (const key of CRUD_RESOURCE_KEYS) {
        const view = set.has(`${key}.view`);
        const edit = set.has(`${key}.edit`);
        if (key === 'portal' || key === 'security') {
            map[key] = { create: view, read: view, update: view, delete: false };
            continue;
        }
        map[key] = {
            create: edit,
            read: view || edit,
            update: edit,
            delete: false,
        };
    }
    return map;
}

async function loadCrudAccessMap(service, apartmentId, roleKey, isSystemAdmin, permissionKeys = []) {
    if (isSystemAdmin || roleKey === 'system_admin' || roleKey === 'society_admin') {
        return fullCrudMap();
    }
    if (!apartmentId || !roleKey) return deriveCrudFromPermissionKeys(permissionKeys);

    const { data, error } = await service
        .from('society_role_crud_access')
        .select('resource_key, can_create, can_read, can_update, can_delete')
        .eq('apartment_id', apartmentId)
        .eq('role_key', roleKey);
    if (error) {
        console.warn('[workspace-boot] CRUD matrix read failed:', error.message);
        return deriveCrudFromPermissionKeys(permissionKeys);
    }
    if (!data?.length) {
        // No society overrides yet — delete stays off until Roles → CRUD grants it.
        return deriveCrudFromPermissionKeys(permissionKeys);
    }

    const map = deriveCrudFromPermissionKeys(permissionKeys);
    data.forEach((row) => {
        map[row.resource_key] = {
            create: !!row.can_create,
            read: !!row.can_read,
            update: !!row.can_update,
            delete: !!row.can_delete,
        };
    });
    return map;
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const started = Date.now();
    const phases = {};
    let userId = null;
    let apartmentId = null;

    try {
        const tAuth = Date.now();
        const { user, authHeader } = await requireSession(req);
        userId = user.id;
        phases.auth = Date.now() - tAuth;

        const hintApartmentId = getQueryParam(req, 'apartment_id') || null;

        if (isNewUiRequest(req)) {
            const { default: mongoBoot } = await import('./new/workspace-boot.js');
            return mongoBoot(req, res);
        }

        // Classic (Postgres) identity + RBAC.
        let service;
        try {
            service = createServiceClient();
        } catch {
            service = createUserClient(authHeader);
        }

        // One round-trip wave: profile + memberships (with apartment names) + roles.
        const tIdent = Date.now();
        const [profileRes, mapRes, rolesRes] = await Promise.all([
            service
                .from('profiles')
                .select('id, full_name, email, role, last_apartment_id')
                .eq('id', user.id)
                .maybeSingle(),
            service
                .from('user_apartments')
                .select('apartment_id, apartments(id, name)')
                .eq('user_id', user.id),
            service
                .from('user_role_assignments')
                .select('role_key, apartment_id, scope')
                .eq('user_id', user.id),
        ]);
        phases.identity = Date.now() - tIdent;

        if (profileRes.error) throw Object.assign(new Error(profileRes.error.message), { status: 500 });
        if (mapRes.error) throw Object.assign(new Error(mapRes.error.message), { status: 500 });
        if (rolesRes.error) throw Object.assign(new Error(rolesRes.error.message), { status: 500 });

        const profile = profileRes.data || null;
        let roleAssignments = rolesRes.data || [];
        let apartments = apartmentsFromMappings(mapRes.data || []);
        let apartmentIds = [...new Set((mapRes.data || []).map((m) => m.apartment_id).filter(Boolean))];

        // Admin fallback: list all societies only when membership join returned nothing.
        if (!apartments.length && profile?.role === 'admin') {
            const tPool = Date.now();
            const { data, error } = await service.from('apartments').select('id, name').order('name');
            phases.pool = Date.now() - tPool;
            if (error) throw Object.assign(new Error(error.message), { status: 500 });
            apartments = (data || []).filter((a) => a.name !== '__SYSTEM__');
            apartmentIds = apartments.map((a) => a.id);
        }

        apartmentId = pickActiveId(apartments, [hintApartmentId, profile?.last_apartment_id]);

        if (!apartments.length || !apartmentId) {
            logBoot(userId, null, Date.now() - started, null, phases);
            return res.status(200).json({
                ok: true,
                profile: profile || null,
                apartments: [],
                activeApartmentId: null,
                apartmentIds: [],
                roleAssignments,
                permissions: [],
                isSystemAdmin: false,
                effectiveRoleKey: null,
                moduleAccess: { apartment: {}, user: {}, role: {} },
                pageAccess: { user: {}, societyRole: {} },
                crudAccess: {},
                core: null,
                summary: null,
            });
        }

        const tPerms = Date.now();
        const permInfo = await loadPermissionsForRoles(service, roleAssignments, apartmentId);
        const crudAccess = await loadCrudAccessMap(
            service,
            apartmentId,
            permInfo.effectiveRoleKey,
            permInfo.isSystemAdmin,
            permInfo.permissions,
        );
        phases.permissions = Date.now() - tPerms;
        phases.crudAccess = 0;

        // Fire-and-forget last-apartment write.
        if (profile && profile.last_apartment_id !== apartmentId && apartmentId) {
            void service.from('profiles').update({ last_apartment_id: apartmentId }).eq('id', user.id);
        }

        logBoot(userId, apartmentId, Date.now() - started, null, phases);
        return res.status(200).json({
            ok: true,
            source: 'postgres',
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
                apartment: {},
                user: {},
                role: permInfo.isSystemAdmin || permInfo.effectiveRoleKey === 'system_admin'
                    ? { home: true, portal: true, security: true, property: true, finance: true, admin: true }
                    : {},
            },
            pageAccess: { user: {}, societyRole: {} },
            crudAccess,
            core: null,
            summary: null,
        });
    } catch (err) {
        const message = err?.message || (typeof err === 'string' ? err : 'Workspace boot failed.');
        logBoot(userId, apartmentId, Date.now() - started, message, phases);
        return res.status(err.status || 500).json({ error: message });
    }
}
