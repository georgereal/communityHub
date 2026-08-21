import { requireAnyApartmentPermission } from '../../../../packages/server/serverAuth.js';
import { getQueryParam, readJsonBody } from '../../../../packages/server/vercelRequest.js';
import { getMongoDb } from '../../../../packages/server/mongoClient.js';
import { logMongoApi } from '../../../../packages/server/mongoLog.js';
import { IntegrationsHttpError } from './errors.js';
import { ensureIntegrationsIndexes } from './indexes.js';

function apartmentIdFrom(req, body = {}) {
    return body.apartment_id || getQueryParam(req, 'apartment_id') || null;
}

function routeId(req) {
    if (typeof req.query?.id === 'string') return req.query.id;
    if (Array.isArray(req.query?.id)) return req.query.id[0];
    return req.__routeId || null;
}

/**
 * Authenticated integrations route wrapper (Property-style).
 * Public webhooks should not use this — call stores directly.
 */
export function integrationsHandler({ perms, op, collection, run }) {
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
            await ensureIntegrationsIndexes(db);
            const result = await run({
                req,
                res,
                method,
                body: body || {},
                apartmentId,
                user: auth.user,
                id: routeId(req),
                db,
            });
            logMongoApi({
                layer: 'api/integrations',
                method,
                path,
                op,
                collection,
                userId,
                apartmentId,
                ms: Date.now() - started,
            });
            const status = result?.__httpStatus || 200;
            if (result && typeof result === 'object' && '__httpStatus' in result) {
                const { __httpStatus, ...payload } = result;
                return res.status(status).json({ ok: true, ...payload });
            }
            return res.status(200).json({ ok: true, ...result });
        } catch (err) {
            const status = err.status || (err instanceof IntegrationsHttpError ? err.status : 500);
            logMongoApi({
                layer: 'api/integrations',
                method,
                path,
                op,
                userId,
                apartmentId,
                ms: Date.now() - started,
                error: err.message,
            });
            return res.status(status).json({
                error: err.message || 'Integrations request failed.',
                detail: err.detail || undefined,
                targetUrl: err.targetUrl || undefined,
                evolyx: err.evolyx || undefined,
            });
        }
    };
}
