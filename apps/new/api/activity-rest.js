/**
 * Top-level Vercel function for Activity REST (Mongo).
 * Society-wide audit trail across modules.
 *
 * Rewrites in vercel.json send /api/activity/* here.
 *
 * Resources:
 *   GET  /api/activity/events?apartment_id=&entity_type=&action=&limit=
 *   POST /api/activity/events
 */
import { handle as events } from './activityMongo/routes/events.js';

function pathPartsFromReq(req) {
    const rewritten = req.query?.__activityPath;
    if (typeof rewritten === 'string' && rewritten) {
        return rewritten.split('/').filter(Boolean);
    }
    if (Array.isArray(req.__activityPath)) return req.__activityPath.map(String);
    if (Array.isArray(req.query?.path)) return req.query.path.map(String);
    try {
        const raw = req.url || '';
        const u = new URL(raw.startsWith('http') ? raw : `http://local${raw}`);
        const idx = u.pathname.indexOf('/api/activity/');
        if (idx >= 0) {
            return u.pathname.slice(idx + '/api/activity/'.length).split('/').filter(Boolean);
        }
    } catch { /* ignore */ }
    return [];
}

function resolveActivityRoute(parts) {
    const [a, b] = parts;
    if (a === 'events' && !b) return { handler: events };
    return null;
}

export default async function handler(req, res) {
    const parts = pathPartsFromReq(req);
    const route = resolveActivityRoute(parts);
    if (!route) {
        return res.status(404).json({
            error: `No route for /api/activity/${parts.join('/')}`,
        });
    }
    return route.handler(req, res);
}
