import { requireSession } from '../../../packages/server/serverAuth.js';
import { readJsonBody } from '../../../packages/server/vercelRequest.js';

const ALLOWED_HOSTS = new Set([
    'graph.microsoft.com',
    'sheets.googleapis.com',
    'oauth2.googleapis.com',
    'www.googleapis.com',
]);

function logExternal(userId, url, method, ms, status, error) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/external-proxy',
        userId,
        url,
        method,
        status: status || null,
        ms,
        ok: !error,
        error: error || null,
    }));
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const started = Date.now();
    let userId = null;
    let targetUrl = '';

    try {
        const { user } = await requireSession(req);
        userId = user.id;
        const body = await readJsonBody(req);
        targetUrl = String(body.url || '');
        const method = String(body.method || 'GET').toUpperCase();

        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch {
            throw Object.assign(new Error('Invalid URL.'), { status: 400 });
        }

        if (!ALLOWED_HOSTS.has(parsed.hostname)) {
            throw Object.assign(new Error(`Host not allowed: ${parsed.hostname}`), { status: 403 });
        }

        const headers = { ...(body.headers || {}) };
        const init = { method, headers };
        if (body.body != null && method !== 'GET' && method !== 'HEAD') {
            init.body = typeof body.body === 'string' ? body.body : JSON.stringify(body.body);
            const hasContentType = headers['Content-Type'] || headers['content-type'];
            if (!hasContentType) {
                init.headers = {
                    ...headers,
                    'Content-Type': typeof body.body === 'string' && body.contentType
                        ? body.contentType
                        : 'application/json',
                };
            }
        }

        const upstream = await fetch(targetUrl, init);
        const text = await upstream.text();
        let json = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = null;
            }
        }

        logExternal(userId, targetUrl, method, Date.now() - started, upstream.status);

        return res.status(200).json({
            ok: upstream.ok,
            status: upstream.status,
            text,
            json,
        });
    } catch (err) {
        logExternal(userId, targetUrl, 'POST', Date.now() - started, null, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'External proxy failed.' });
    }
}
