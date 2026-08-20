/**
 * Top-level Vercel function for Property-New REST.
 * Nested `api/property/**` files each become a separate isolate (and Mongo pool).
 * Rewrites in vercel.json send /api/property/* here so one warm client is reused.
 */
import { handle as state } from './propertyMongo/routes/state.js';
import { handle as units } from './propertyMongo/routes/units.js';
import { handle as unitsItem } from './propertyMongo/routes/units/[id].js';
import { handle as unitsImport } from './propertyMongo/routes/units/import.js';
import { handle as unitsParkingLimits } from './propertyMongo/routes/units/parking-limits.js';
import { handle as vehicles } from './propertyMongo/routes/vehicles.js';
import { handle as vehiclesItem } from './propertyMongo/routes/vehicles/[id].js';
import { handle as vehiclesImport } from './propertyMongo/routes/vehicles/import.js';
import { handle as residents } from './propertyMongo/routes/residents.js';
import { handle as residentsItem } from './propertyMongo/routes/residents/[id].js';
import { handle as residentsImport } from './propertyMongo/routes/residents/import.js';
import { handle as slots } from './propertyMongo/routes/slots.js';
import { handle as slotsItem } from './propertyMongo/routes/slots/[id].js';
import { handle as slotsAssign } from './propertyMongo/routes/slots/[id]/assign.js';
import { handle as slotsRelease } from './propertyMongo/routes/slots/[id]/release.js';

function pathPartsFromReq(req) {
    const rewritten = req.query?.__propertyPath;
    if (typeof rewritten === 'string' && rewritten) {
        return rewritten.split('/').filter(Boolean);
    }
    if (Array.isArray(req.__propertyPath)) return req.__propertyPath.map(String);
    if (Array.isArray(req.query?.path)) return req.query.path.map(String);
    try {
        const raw = req.url || '';
        const u = new URL(raw.startsWith('http') ? raw : `http://local${raw}`);
        const idx = u.pathname.indexOf('/api/property/');
        if (idx >= 0) {
            return u.pathname.slice(idx + '/api/property/'.length).split('/').filter(Boolean);
        }
    } catch { /* ignore */ }
    return [];
}

function resolvePropertyRoute(parts) {
    const [a, b, c] = parts;
    if (a === 'state' && !b) return { handler: state };
    if (a === 'units' && b === 'import' && !c) return { handler: unitsImport };
    if (a === 'units' && b === 'parking-limits' && !c) return { handler: unitsParkingLimits };
    if (a === 'units' && b && !c) return { handler: unitsItem, id: b };
    if (a === 'units' && !b) return { handler: units };
    if (a === 'vehicles' && b === 'import' && !c) return { handler: vehiclesImport };
    if (a === 'vehicles' && b && !c) return { handler: vehiclesItem, id: b };
    if (a === 'vehicles' && !b) return { handler: vehicles };
    if (a === 'residents' && b === 'import' && !c) return { handler: residentsImport };
    if (a === 'residents' && b && !c) return { handler: residentsItem, id: b };
    if (a === 'residents' && !b) return { handler: residents };
    if (a === 'slots' && b && c === 'assign') return { handler: slotsAssign, id: b };
    if (a === 'slots' && b && c === 'release') return { handler: slotsRelease, id: b };
    if (a === 'slots' && b && !c) return { handler: slotsItem, id: b };
    if (a === 'slots' && !b) return { handler: slots };
    return null;
}

export default async function handler(req, res) {
    const parts = pathPartsFromReq(req);
    const route = resolvePropertyRoute(parts);
    if (!route) {
        return res.status(404).json({
            error: `No route for /api/property/${parts.join('/')}`,
        });
    }
    if (route.id) {
        req.query = { ...(req.query || {}), id: route.id };
        req.__routeId = route.id;
    }
    return route.handler(req, res);
}
