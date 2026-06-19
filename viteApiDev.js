import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

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

/**
 * Run Vercel-style api/*.js handlers during `vite` dev (POST /api/*).
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
                if (!name || name.includes('/')) return next();

                const file = resolve(process.cwd(), 'api', `${name}.js`);
                if (!existsSync(file)) return next();

                try {
                    await readBody(req);
                    const mod = await server.ssrLoadModule(file);
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
