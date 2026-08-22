import { requireAnyApartmentPermission } from '../../../../packages/server/serverAuth.js';
import { getQueryParam, readJsonBody } from '../../../../packages/server/vercelRequest.js';
import { getMongoDb } from '../../../../packages/server/mongoClient.js';
import { logMongoApi } from '../../../../packages/server/mongoLog.js';
import { ActivityHttpError } from './errors.js';
import { ensureActivityIndexes } from './indexes.js';

function apartmentIdFrom(req, body = {}) {
    return body.apartment_id || getQueryParam(req, 'apartment_id') || null;
}

export function activityHandler({ perms, op, collection, run }) {
    return async function handler(req, res) {
        const started = Date.now();
        const method = (req.method || 'GET').toUpperCase();
        const path = String(req.url || '').split('?')[0];
        let apartmentId = null;
        let userId = null;
        try {
            const body = ['GET', 'HEAD'].includes(method)
                ? {}
                : (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
                    ? req.body
                    : await readJsonBody(req));
            const apartment_id = apartmentIdFrom(req, body);
            const auth = await requireAnyApartmentPermission(req, apartment_id, perms);
            apartmentId = auth.apartmentId;
            userId = auth.user?.id || null;
            const db = await getMongoDb();
            await ensureActivityIndexes(db);
            const result = await run({
                req,
                res,
                method,
                body: body || {},
                apartmentId,
                user: auth.user,
                db,
            });
            logMongoApi({
                layer: 'api/activity',
                method,
                path,
                op,
                collection,
                userId,
                apartmentId,
                ms: Date.now() - started,
            });
            return res.status(200).json({ ok: true, ...result });
        } catch (err) {
            const status = err.status || (err instanceof ActivityHttpError ? err.status : 500);
            logMongoApi({
                layer: 'api/activity',
                method,
                path,
                op,
                userId,
                apartmentId,
                ms: Date.now() - started,
                error: err.message,
            });
            return res.status(status).json({ error: err.message || 'Activity request failed.' });
        }
    };
}
