/**
 * Shared request helpers for Vercel serverless functions (Node.js runtime).
 */

export function getQueryParam(req, name) {
    const fromQuery = req.query?.[name];
    if (fromQuery != null && fromQuery !== '') {
        return Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
    }
    try {
        const rawUrl = req.url || '';
        const path = rawUrl.startsWith('http') ? rawUrl : `https://${req.headers?.host || 'localhost'}${rawUrl}`;
        return new URL(path).searchParams.get(name);
    } catch {
        return null;
    }
}

export async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        return req.body;
    }
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body || '{}');
        } catch {
            return {};
        }
    }
    return req.body || {};
}

export function sendJson(res, status, payload) {
    res.statusCode = status;
    if (!res.getHeader?.('Content-Type')) {
        res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify(payload));
}
