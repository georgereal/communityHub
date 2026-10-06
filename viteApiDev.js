import { resolveApiModule, applyResolvedRoute, readBody, attachRes } from './server/vercelStyleApi.js';

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
                    applyResolvedRoute(req, name, resolved);
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
