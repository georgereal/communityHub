/**
 * Top-level Vercel function for Integrations REST (Mongo).
 * Domain: external provider credentials + Evolyx passbook OCR jobs.
 * Not under /api/finance — integrations are cross-cutting Admin config.
 *
 * Rewrites in vercel.json send /api/integrations/* here.
 *
 * Resources:
 *   GET  /api/integrations/connections?apartment_id=
 *   POST /api/integrations/connections
 *   GET  /api/integrations/passbook/jobs?apartment_id=
 *   GET  /api/integrations/passbook/jobs/:id?apartment_id=
 *   POST /api/integrations/passbook/jobs          { apartment_id, files, requestId }
 *   POST /api/integrations/passbook/jobs/:id/imported
 *
 * Public Evolyx callback remains POST /api/passbook-webhook (Mongo-backed).
 */
import { handle as connections } from './integrationsMongo/routes/connections.js';
import { handle as passbookJobs } from './integrationsMongo/routes/passbook/jobs.js';
import { handle as passbookJobImported } from './integrationsMongo/routes/passbook/jobs/[id]/imported.js';

function pathPartsFromReq(req) {
    const rewritten = req.query?.__integrationsPath;
    if (typeof rewritten === 'string' && rewritten) {
        return rewritten.split('/').filter(Boolean);
    }
    if (Array.isArray(req.__integrationsPath)) return req.__integrationsPath.map(String);
    if (Array.isArray(req.query?.path)) return req.query.path.map(String);
    try {
        const raw = req.url || '';
        const u = new URL(raw.startsWith('http') ? raw : `http://local${raw}`);
        const idx = u.pathname.indexOf('/api/integrations/');
        if (idx >= 0) {
            return u.pathname.slice(idx + '/api/integrations/'.length).split('/').filter(Boolean);
        }
    } catch { /* ignore */ }
    return [];
}

function resolveIntegrationsRoute(parts) {
    const [a, b, c, d] = parts;
    if (a === 'connections' && !b) return { handler: connections };
    if (a === 'passbook' && b === 'jobs' && c && d === 'imported') {
        return { handler: passbookJobImported, id: c };
    }
    if (a === 'passbook' && b === 'jobs' && c && !d) {
        return { handler: passbookJobs, id: c };
    }
    if (a === 'passbook' && b === 'jobs' && !c) return { handler: passbookJobs };
    return null;
}

export default async function handler(req, res) {
    const parts = pathPartsFromReq(req);
    const route = resolveIntegrationsRoute(parts);
    if (!route) {
        return res.status(404).json({
            error: `No route for /api/integrations/${parts.join('/')}`,
        });
    }
    if (route.id) {
        req.query = { ...(req.query || {}), id: route.id };
        req.__routeId = route.id;
    }
    return route.handler(req, res);
}
