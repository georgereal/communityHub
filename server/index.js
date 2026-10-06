/**
 * Long-running CommunityHub server for Oracle ARM (or any VPS).
 * Serves /api/* via existing Vercel-style handlers + static dist/ with SPA rewrites.
 *
 *   npm run build && npm start
 *   PORT=3000 COMMUNITYHUB_ENV_FILE=/etc/communityhub.env npm start
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, join, normalize } from 'node:path';
import { loadServerEnv } from './loadEnv.js';
import {
    resolveApiModule,
    parseQuery,
    invokeApiHandler,
} from './vercelStyleApi.js';
import { resolveStaticPath, contentTypeFor } from './staticRoutes.js';

loadServerEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = process.cwd();
const DIST = resolve(ROOT, process.env.DIST_DIR || 'dist');

function safeJoinDist(urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0] || '/');
    const rel = decoded.replace(/^\/+/, '');
    const abs = normalize(join(DIST, rel));
    if (!abs.startsWith(DIST)) return null;
    return abs;
}

function sendFile(res, absPath, { cacheImmutable = false } = {}) {
    const st = statSync(absPath);
    if (!st.isFile()) return false;
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeFor(absPath));
    res.setHeader('Content-Length', st.size);
    if (cacheImmutable) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (absPath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    createReadStream(absPath).pipe(res);
    return true;
}

async function handleApi(req, res, pathname) {
    const name = pathname.slice('/api/'.length);
    if (!name) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    const resolved = resolveApiModule(name);
    if (!resolved) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    req.query = { ...parseQuery(req.url || ''), ...(req.query || {}) };
    res.setHeader('Cache-Control', 'no-store');

    try {
        await invokeApiHandler(req, res, resolved, name);
        if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'API handler did not send a response.' }));
        }
    } catch (err) {
        console.error(`[server] ${pathname}`, err);
        if (!res.writableEnded) {
            res.statusCode = err.status || 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message || 'API handler failed.' }));
        }
    }
}

function handleStatic(req, res, pathname) {
    // Prefer real files under dist (assets, finance/*.html, etc.)
    const direct = safeJoinDist(pathname);
    if (direct && existsSync(direct) && statSync(direct).isFile()) {
        const immutable = pathname.startsWith('/assets/');
        return sendFile(res, direct, { cacheImmutable: immutable });
    }

    // Directory index
    if (direct && existsSync(direct) && statSync(direct).isDirectory()) {
        const index = join(direct, 'index.html');
        if (existsSync(index)) return sendFile(res, index);
    }

    const rewritten = resolveStaticPath(pathname);
    if (rewritten) {
        const abs = safeJoinDist(rewritten);
        if (abs && existsSync(abs)) return sendFile(res, abs);
    }

    // Finance MPA client routes under /finance/*
    if (pathname.startsWith('/finance/')) {
        const financeIndex = safeJoinDist('/finance/index.html');
        if (financeIndex && existsSync(financeIndex)) return sendFile(res, financeIndex);
        // Per-page HTML may live at /finance/<page>.html after flatten
        const page = pathname.replace(/^\/finance\//, '').split('/')[0];
        if (page) {
            const pageFile = safeJoinDist(`/finance/${page}.html`);
            if (pageFile && existsSync(pageFile)) return sendFile(res, pageFile);
            const pageIndex = safeJoinDist(`/finance/${page}/index.html`);
            if (pageIndex && existsSync(pageIndex)) return sendFile(res, pageIndex);
        }
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return true;
}

const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0] || '/';

    if (pathname === '/healthz' || pathname === '/api/healthz') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
    }

    handleStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
    console.log(`[server] CommunityHub listening on http://${HOST}:${PORT}`);
    console.log(`[server] dist=${DIST} exists=${existsSync(DIST)}`);
});
