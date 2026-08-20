import { requireApartmentPermission, requireAnyApartmentPermission } from '../../../packages/server/serverAuth.js';
import { getQueryParam, readJsonBody } from '../../../packages/server/vercelRequest.js';
import { logMongoApi } from '../../../packages/server/mongoLog.js';
import {
    ensureRbacIndexes,
    findDirectoryByEmail,
    listAssignmentsForApartment,
    listDirectoryByIds,
    loadRolePermissionKeys,
    loadSocietyPolicy,
    replaceApartmentAssignment,
    resolveRbacForUser,
    saveSocietyPolicy,
    upsertDirectoryProfile,
    upsertRolePermissions,
    upsertSociety,
} from './rbacMongo/service.js';
import { DEFAULT_ROLE_PERMISSIONS } from './rbacMongo/defaults.js';

export default async function handler(req, res) {
    const started = Date.now();
    let apartmentId = null;
    let userId = null;
    let op = req.method;
    try {
        if (req.method === 'GET') {
            apartmentId = getQueryParam(req, 'apartment_id');
            const auth = await requireAnyApartmentPermission(req, apartmentId, ['rbac.view', 'rbac.edit', 'setup.edit']);
            userId = auth.user.id;
            await ensureRbacIndexes();
            const [policy, assignments, self] = await Promise.all([
                loadSocietyPolicy(auth.apartmentId),
                listAssignmentsForApartment(auth.apartmentId),
                resolveRbacForUser(auth.user.id, auth.apartmentId),
            ]);
            const directory = await listDirectoryByIds(assignments.map((a) => a.user_id));
            logMongoApi({
                layer: 'api/rbac-mongo',
                method: 'GET',
                path: '/api/rbac-mongo',
                op: 'read',
                userId,
                apartmentId: auth.apartmentId,
                ms: Date.now() - started,
            });
            return res.status(200).json({
                ok: true,
                apartment_id: auth.apartmentId,
                policy: policy || { pages: {}, modules: {}, crud: {} },
                assignments,
                directory,
                self,
                defaultRolePermissions: DEFAULT_ROLE_PERMISSIONS,
            });
        }

        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        const body = await readJsonBody(req);
        const action = body.action;
        op = action;
        apartmentId = body.apartment_id;
        const perm = action === 'saveSociety' ? 'setup.edit' : 'rbac.edit';
        const auth = await requireApartmentPermission(req, apartmentId, perm);
        userId = auth.user.id;
        await ensureRbacIndexes();

        if (action === 'saveAssignment') {
            await replaceApartmentAssignment({
                userId: body.user_id,
                apartmentId: auth.apartmentId,
                roleKey: body.role_key,
            });
            if (body.user_id) {
                await upsertDirectoryProfile({
                    userId: body.user_id,
                    email: body.email,
                    fullName: body.full_name,
                    role: body.role_key || undefined,
                });
            }
        } else if (action === 'findDirectory') {
            const row = await findDirectoryByEmail(body.email);
            logMongoApi({
                layer: 'api/rbac-mongo',
                method: 'POST',
                path: '/api/rbac-mongo',
                op,
                userId,
                apartmentId: auth.apartmentId,
                ms: Date.now() - started,
            });
            return res.status(200).json({ ok: true, user: row || null });
        } else if (action === 'saveSociety') {
            await upsertSociety({ apartmentId: auth.apartmentId, name: body.name });
        } else if (action === 'savePolicy') {
            await saveSocietyPolicy(auth.apartmentId, {
                pages: body.pages || {},
                modules: body.modules || {},
                crud: body.crud || {},
            });
        } else if (action === 'saveRolePermissions') {
            await upsertRolePermissions(body.role_key, body.permission_keys || []);
            const keys = await loadRolePermissionKeys(body.role_key);
            logMongoApi({
                layer: 'api/rbac-mongo',
                method: 'POST',
                path: '/api/rbac-mongo',
                op,
                userId,
                apartmentId: auth.apartmentId,
                ms: Date.now() - started,
            });
            return res.status(200).json({ ok: true, permission_keys: keys });
        } else {
            throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
        }

        logMongoApi({
            layer: 'api/rbac-mongo',
            method: 'POST',
            path: '/api/rbac-mongo',
            op,
            userId,
            apartmentId: auth.apartmentId,
            ms: Date.now() - started,
        });
        return res.status(200).json({ ok: true });
    } catch (err) {
        logMongoApi({
            layer: 'api/rbac-mongo',
            method: req.method,
            path: '/api/rbac-mongo',
            op,
            userId,
            apartmentId,
            ms: Date.now() - started,
            error: err.message,
        });
        return res.status(err.status || 500).json({ error: err.message || 'RBAC request failed.' });
    }
}
