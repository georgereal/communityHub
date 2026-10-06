/**
 * Shared Vercel-style /api routing used by viteApiDev and the long-running Node server.
 */
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function readBody(req) {
    return new Promise((resolveBody, reject) => {
        if (req.body !== undefined) return resolveBody();
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            if (!raw) {
                req.body = undefined;
                return resolveBody();
            }
            try {
                req.body = JSON.parse(raw);
            } catch {
                req.body = raw;
            }
            resolveBody();
        });
        req.on('error', reject);
    });
}

export function attachRes(res) {
    let statusCode = 200;
    const out = {
        status(code) {
            statusCode = code;
            return out;
        },
        setHeader(k, v) {
            res.setHeader(k, v);
            return out;
        },
        json(data) {
            res.statusCode = statusCode;
            if (!res.getHeader('Content-Type')) {
                res.setHeader('Content-Type', 'application/json');
            }
            res.end(JSON.stringify(data));
            return out;
        },
        end(data) {
            res.statusCode = statusCode;
            res.end(data);
            return out;
        },
    };
    return out;
}

function isDir(p) {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Resolve Vercel-style api handlers:
 *   /api/db                         → api/db.js
 *   /api/finance/x                  → api/finance-rest.js
 *   /api/property/slots/:id/assign  → api/property-rest.js
 *   /api/auth-session               → api/auth-rest.js (Hobby consolidation)
 */
export function resolveApiModule(urlPath, apiRoot = resolve(process.cwd(), 'api')) {
    const parts = urlPath.split('/').filter(Boolean);
    if (!parts.length) return null;

    if (parts[0] === 'finance') {
        return { file: resolve(apiRoot, 'finance-rest.js'), pathParts: parts.slice(1) };
    }
    if (parts[0] === 'property') {
        return { file: resolve(apiRoot, 'property-rest.js'), pathParts: parts.slice(1) };
    }
    if (parts[0] === 'integrations') {
        return { file: resolve(apiRoot, 'integrations-rest.js'), pathParts: parts.slice(1) };
    }
    if (parts[0] === 'activity') {
        return { file: resolve(apiRoot, 'activity-rest.js'), pathParts: parts.slice(1) };
    }

    // Domain consolidations (same as vercel.json rewrites — Hobby ≤12 functions).
    if (parts[0] === 'auth-session' && parts.length === 1) {
        return { file: resolve(apiRoot, 'auth-rest.js'), pathParts: ['session'], domain: 'auth' };
    }
    if (parts[0] === 'auth-password' && parts.length === 1) {
        return { file: resolve(apiRoot, 'auth-rest.js'), pathParts: ['password'], domain: 'auth' };
    }
    if (parts[0] === 'auth') {
        return { file: resolve(apiRoot, 'auth-rest.js'), pathParts: parts.slice(1), domain: 'auth' };
    }
    if (parts[0] === 'rbac-mongo' && parts.length === 1) {
        return { file: resolve(apiRoot, 'identity-rest.js'), pathParts: ['rbac'], domain: 'identity' };
    }
    if (parts[0] === 'dashboard-summary' && parts.length === 1) {
        return {
            file: resolve(apiRoot, 'identity-rest.js'),
            pathParts: ['dashboard-summary'],
            domain: 'identity',
        };
    }
    if ((parts[0] === 'workspace-boot' && parts.length === 1)
        || (parts[0] === 'new' && parts[1] === 'workspace-boot' && parts.length === 2)) {
        return {
            file: resolve(apiRoot, 'identity-rest.js'),
            pathParts: ['workspace-boot'],
            domain: 'identity',
        };
    }
    if (parts[0] === 'identity') {
        return { file: resolve(apiRoot, 'identity-rest.js'), pathParts: parts.slice(1), domain: 'identity' };
    }

    const legacyIntegrations = {
        'external-connections': ['_legacy', 'external-connections'],
        'passbook-jobs': ['_legacy', 'passbook-jobs'],
        'passbook-parse': ['_legacy', 'passbook-parse'],
        'external-proxy': ['_legacy', 'external-proxy'],
        'oauth-microsoft': ['_legacy', 'oauth-microsoft'],
        'oauth-service': ['_legacy', 'oauth-service'],
    };
    if (parts.length === 1 && legacyIntegrations[parts[0]]) {
        return {
            file: resolve(apiRoot, 'integrations-rest.js'),
            pathParts: legacyIntegrations[parts[0]],
            domain: 'integrations',
        };
    }

    const exact = resolve(apiRoot, `${parts.join('/')}.js`);
    if (existsSync(exact)) return { file: exact, pathParts: [] };

    if (parts.length === 1) {
        const file = resolve(apiRoot, `${parts[0]}.js`);
        if (existsSync(file)) return { file, pathParts: [] };
    }

    let dir = apiRoot;
    let routeId = null;
    for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        const last = i === parts.length - 1;
        const exactJs = resolve(dir, `${part}.js`);
        const exactDir = resolve(dir, part);
        if (last && existsSync(exactJs)) return { file: exactJs, pathParts: [], routeId };
        if (isDir(exactDir)) {
            dir = exactDir;
            continue;
        }
        const idJs = resolve(dir, '[id].js');
        const idDir = resolve(dir, '[id]');
        if (last && existsSync(idJs)) return { file: idJs, pathParts: [], routeId: part };
        if (isDir(idDir)) {
            routeId = part;
            dir = idDir;
            continue;
        }
        break;
    }

    for (let i = parts.length; i >= 1; i -= 1) {
        const baseParts = parts.slice(0, i);
        const rest = parts.slice(i);
        const catchAll = resolve(apiRoot, ...baseParts, '[...path].js');
        if (existsSync(catchAll)) {
            return { file: catchAll, pathParts: rest };
        }
        const optional = resolve(apiRoot, ...baseParts, '[[...path]].js');
        if (existsSync(optional)) {
            return { file: optional, pathParts: rest };
        }
    }

    return null;
}

export function applyResolvedRoute(req, name, resolved) {
    if (resolved.routeId) {
        req.query = { ...(req.query || {}), id: resolved.routeId };
        req.__routeId = resolved.routeId;
    }
    if (!resolved.pathParts?.length) return;

    const top = name.split('/')[0];
    if (top === 'finance' || resolved.domain === 'finance') {
        req.__financePath = resolved.pathParts;
        req.query = {
            ...(req.query || {}),
            path: resolved.pathParts,
            __financePath: resolved.pathParts.join('/'),
        };
    } else if (top === 'property' || resolved.domain === 'property') {
        req.__propertyPath = resolved.pathParts;
        req.query = {
            ...(req.query || {}),
            path: resolved.pathParts,
            __propertyPath: resolved.pathParts.join('/'),
        };
    } else if (top === 'integrations' || resolved.domain === 'integrations') {
        req.__integrationsPath = resolved.pathParts;
        req.query = {
            ...(req.query || {}),
            path: resolved.pathParts,
            __integrationsPath: resolved.pathParts.join('/'),
        };
    } else if (top === 'activity' || resolved.domain === 'activity') {
        req.__activityPath = resolved.pathParts;
        req.query = {
            ...(req.query || {}),
            path: resolved.pathParts,
            __activityPath: resolved.pathParts.join('/'),
        };
    } else if (resolved.domain === 'auth') {
        req.query = {
            ...(req.query || {}),
            __authPath: resolved.pathParts.join('/'),
        };
    } else if (resolved.domain === 'identity') {
        req.query = {
            ...(req.query || {}),
            __identityPath: resolved.pathParts.join('/'),
        };
    } else {
        req.query = { ...(req.query || {}), path: resolved.pathParts };
    }
}

export function parseQuery(url) {
    try {
        const u = new URL(url, 'http://localhost');
        const query = {};
        for (const [k, v] of u.searchParams.entries()) {
            if (query[k] === undefined) query[k] = v;
            else if (Array.isArray(query[k])) query[k].push(v);
            else query[k] = [query[k], v];
        }
        return query;
    } catch {
        return {};
    }
}

const handlerCache = new Map();

export async function loadApiHandler(file, { cache = true } = {}) {
    if (cache && handlerCache.has(file)) return handlerCache.get(file);
    const mod = await import(pathToFileURL(file).href);
    const handler = mod.default;
    if (cache && typeof handler === 'function') handlerCache.set(file, handler);
    return handler;
}

/**
 * Invoke a resolved API module against a Node/Connect-style req/res.
 * @param {object} opts
 * @param {(file: string) => Promise<Function>} [opts.loadModule] — override loader (Vite SSR)
 */
export async function invokeApiHandler(req, res, resolved, name, opts = {}) {
    applyResolvedRoute(req, name, resolved);
    await readBody(req);
    const load = opts.loadModule || ((file) => loadApiHandler(file, { cache: opts.cache !== false }));
    const handler = await load(resolved.file);
    if (typeof handler !== 'function') {
        throw Object.assign(new Error('API handler is not a function'), { status: 500 });
    }
    await handler(req, attachRes(res));
}
