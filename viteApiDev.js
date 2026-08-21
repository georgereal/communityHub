import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';

function readBody(req) {
    return new Promise((resolveBody, reject) => {
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

function attachRes(res) {
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
 */
function resolveApiModule(urlPath) {
    const apiRoot = resolve(process.cwd(), 'api');
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

/**
 * Run Vercel-style api/*.js handlers during `vite` dev.
 */
export function viteApiDevPlugin(env = {}) {
    for (const [key, value] of Object.entries(env)) {
        if (value != null && value !== '' && process.env[key] == null) {
            process.env[key] = value;
        }
    }

    return {
        name: 'vite-api-dev',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const url = req.url?.split('?')[0] || '';
                if (!url.startsWith('/api/')) return next();

                const name = url.slice('/api/'.length);
                if (!name) return next();

                const resolved = resolveApiModule(name);
                if (!resolved) return next();

                try {
                    await readBody(req);
                    if (resolved.routeId) {
                        req.query = { ...(req.query || {}), id: resolved.routeId };
                        req.__routeId = resolved.routeId;
                    }
                    if (resolved.pathParts?.length) {
                        const top = name.split('/')[0];
                        if (top === 'finance') req.__financePath = resolved.pathParts;
                        if (top === 'property') req.__propertyPath = resolved.pathParts;
                        if (top === 'integrations') req.__integrationsPath = resolved.pathParts;
                        req.query = { ...(req.query || {}), path: resolved.pathParts };
                    }
                    const mod = await server.ssrLoadModule(resolved.file);
                    const handler = mod.default;
                    if (typeof handler !== 'function') return next();

                    await handler(req, attachRes(res));
                    if (!res.writableEnded) {
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: 'API handler did not send a response.' }));
                    }
                } catch (err) {
                    console.error(`[vite-api-dev] ${url}`, err);
                    if (!res.writableEnded) {
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: err.message || 'API handler failed.' }));
                    }
                }
            });
        },
    };
}
