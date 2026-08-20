import { requireAnyApartmentPermission } from '../serverAuth.js';
import { getQueryParam, readJsonBody } from '../vercelRequest.js';
import { logMongoApi } from '../mongoLog.js';
import { PropertyHttpError } from './errors.js';
import { connectPropertyMongo } from './mongoose.js';
import { ensurePropertyIndexes } from './service.js';

function apartmentIdFrom(req, body = {}) {
    return body.apartment_id || getQueryParam(req, 'apartment_id') || null;
}

function routeId(req) {
    if (typeof req.query?.id === 'string') return req.query.id;
    if (Array.isArray(req.query?.id)) return req.query.id[0];
    return req.__routeId || null;
}

export function propertyHandler({ perms, op, collection = 'property_units', run }) {
    return async function handler(req, res) {
        const started = Date.now();
        const method = (req.method || 'GET').toUpperCase();
        const path = String(req.url || '').split('?')[0];
        let apartmentId = null;
        let userId = null;
        try {
            const body = ['GET', 'HEAD'].includes(method) ? {} : (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
                ? req.body
                : await readJsonBody(req));
            const apartment_id = apartmentIdFrom(req, body);
            const auth = await requireAnyApartmentPermission(req, apartment_id, perms);
            apartmentId = auth.apartmentId;
            userId = auth.user?.id || null;
            await connectPropertyMongo();
            await ensurePropertyIndexes();
            const result = await run({
                req,
                method,
                body: body || {},
                apartmentId,
                id: routeId(req),
            });
            logMongoApi({
                layer: 'api/property',
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
            const status = err.status || (err instanceof PropertyHttpError ? err.status : 500);
            logMongoApi({
                layer: 'api/property',
                method,
                path,
                op,
                userId,
                apartmentId,
                ms: Date.now() - started,
                error: err.message,
            });
            return res.status(status).json({ error: err.message || 'Property request failed.' });
        }
    };
}
