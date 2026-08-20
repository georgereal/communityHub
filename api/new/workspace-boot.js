/**
 * New UI workspace boot — Mongo identity + RBAC. Auth JWT only from Supabase.
 */
import { requireSession } from '../serverAuth.js';
import { getQueryParam } from '../vercelRequest.js';
import {
    apartmentsForUser,
    getDirectoryProfile,
    listAssignmentsForUser,
    resolveRbacForUser,
    upsertDirectoryProfile,
} from '../rbacMongo/service.js';

function pickActiveId(pool, preferredIds = []) {
    for (const id of preferredIds) {
        if (id && pool.some((a) => a.id === id)) return id;
    }
    return pool[0]?.id || null;
}

function logBoot(userId, apartmentId, ms, error, phases = null) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/new/workspace-boot',
        userId,
        apartmentId,
        ms,
        ok: !error,
        error: error || null,
        phases,
    }));
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
        const { user } = await requireSession(req);
        userId = user.id;
        phases.auth = Date.now() - tAuth;

        const hintApartmentId = getQueryParam(req, 'apartment_id') || null;
        const tIdent = Date.now();
        const [dir, apartments] = await Promise.all([
            getDirectoryProfile(user.id),
            apartmentsForUser(user.id),
        ]);
        apartmentId = pickActiveId(apartments, [hintApartmentId, dir?.last_apartment_id]);
        const resolved = await resolveRbacForUser(user.id, apartmentId);
        phases.identity = Date.now() - tIdent;
        const roleAssignments = resolved?.assignments
            || await listAssignmentsForUser(user.id);

        const profile = {
            id: user.id,
            email: dir?.email || user.email || '',
            full_name: dir?.full_name || null,
            role: dir?.role || 'resident_viewer',
            last_apartment_id: apartmentId,
        };

        if (dir && apartmentId && dir.last_apartment_id !== apartmentId) {
            void upsertDirectoryProfile({ userId: user.id, lastApartmentId: apartmentId });
        }

        const roleKey = resolved?.effectiveRoleKey || null;
        const isSystemAdmin = resolved?.isSystemAdmin === true;

        logBoot(userId, apartmentId, Date.now() - started, null, phases);
        return res.status(200).json({
            ok: true,
            source: 'mongo',
            profile,
            apartments,
            activeApartmentId: apartmentId,
            apartmentIds: apartments.map((a) => a.id),
            roleAssignments,
            permissions: resolved?.permissions || [],
            isSystemAdmin,
            effectiveRoleKey: roleKey,
            moduleAccess: {
                apartment: {},
                user: {},
                role: isSystemAdmin || roleKey === 'system_admin'
                    ? { home: true, portal: true, security: true, property: true, finance: true, admin: true }
                    : (roleKey && resolved?.policy?.modules?.[roleKey]) || {},
            },
            pageAccess: roleKey && resolved?.policy?.pages
                ? { user: {}, societyRole: { [roleKey]: resolved.policy.pages[roleKey] || {} } }
                : { user: {}, societyRole: {} },
            crudAccess: resolved?.crudAccess || {},
            core: null,
            summary: null,
        });
    } catch (err) {
        const message = err?.message || 'Workspace boot failed.';
        logBoot(userId, apartmentId, Date.now() - started, message, phases);
        return res.status(err.status || 500).json({ error: message });
    }
}
