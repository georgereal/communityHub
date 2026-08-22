/**
 * Top-level Vercel function for Integrations REST (Mongo).
 * Domain: external provider credentials + Evolyx passbook OCR + ledger spreadsheet sync.
 *
 * Rewrites in vercel.json send /api/integrations/* here.
 *
 * Resources:
 *   GET/POST /api/integrations/connections
 *   GET/POST /api/integrations/passbook/jobs…
 *   GET      /api/integrations/spreadsheet/boot
 *   GET/POST /api/integrations/spreadsheet/settings
 *   GET/POST /api/integrations/spreadsheet/oauth-apps
 *   GET/POST/DELETE /api/integrations/spreadsheet/oauth-connections
 *   GET      /api/integrations/spreadsheet/runs
 *
 * Public Evolyx callback remains POST /api/passbook-webhook (Mongo-backed).
 */
import { handle as connections } from './integrationsMongo/routes/connections.js';
import { handle as passbookJobs } from './integrationsMongo/routes/passbook/jobs.js';
import { handle as passbookJobImported } from './integrationsMongo/routes/passbook/jobs/[id]/imported.js';
import { handle as spreadsheetBoot } from './integrationsMongo/routes/spreadsheet/boot.js';
import { handle as spreadsheetSettings } from './integrationsMongo/routes/spreadsheet/settings.js';
import { handle as spreadsheetOAuthApps } from './integrationsMongo/routes/spreadsheet/oauth-apps.js';
import { handle as spreadsheetOAuthConnections } from './integrationsMongo/routes/spreadsheet/oauth-connections.js';
import { handle as spreadsheetRuns } from './integrationsMongo/routes/spreadsheet/runs.js';

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
    if (a === 'spreadsheet' && b === 'boot' && !c) return { handler: spreadsheetBoot };
    if (a === 'spreadsheet' && b === 'settings' && !c) return { handler: spreadsheetSettings };
    if (a === 'spreadsheet' && b === 'oauth-apps' && !c) return { handler: spreadsheetOAuthApps };
    if (a === 'spreadsheet' && b === 'oauth-connections' && !c) {
        return { handler: spreadsheetOAuthConnections };
    }
    if (a === 'spreadsheet' && b === 'runs' && !c) return { handler: spreadsheetRuns };
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
