import { requireSession } from '../../packages/server/serverAuth.js';
import { readJsonBody } from '../../packages/server/vercelRequest.js';
import {
    isR2Configured,
    r2PresignedGetUrl,
    r2DeleteObjects,
    attachmentObjectKey,
    isAllowedFinanceDocObjectKey,
} from '../../packages/server/r2Storage.js';

function logStorage(userId, action, bucket, path, ms, error) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/storage',
        userId,
        action,
        bucket,
        path: path || null,
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
    let body = {};

    try {
        const { user } = await requireSession(req);
        userId = user.id;
        body = await readJsonBody(req);
        const { action } = body;

        // Private R2: short-lived presigned GET (notebook pattern). Keys are raw object keys.
        if (action === 'createSignedUrl') {
            const rawPath = body.path || body.key;
            const key = attachmentObjectKey(rawPath) || (typeof rawPath === 'string' ? rawPath.trim() : '');
            if (key && isAllowedFinanceDocObjectKey(key)) {
                if (!isR2Configured()) {
                    throw Object.assign(new Error('Object storage is not configured.'), { status: 503 });
                }
                const expiresIn = Math.min(Number(body.expiresIn) || 120, 600);
                const signedUrl = await r2PresignedGetUrl(key, expiresIn);
                logStorage(userId, action, 'r2', key, Date.now() - started);
                return res.status(200).json({ ok: true, signedUrl, url: signedUrl, expiresInSeconds: expiresIn });
            }
        }

        if (action === 'remove' && Array.isArray(body.paths)) {
            const r2Keys = body.paths.map(attachmentObjectKey).filter((k) => k && isAllowedFinanceDocObjectKey(k));
            if (r2Keys.length) {
                if (!isR2Configured()) {
                    throw Object.assign(new Error('Object storage is not configured.'), { status: 503 });
                }
                await r2DeleteObjects(r2Keys);
            }
            logStorage(userId, action, 'r2', body.paths.join(','), Date.now() - started);
            return res.status(200).json({ ok: true });
        }

        throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
    } catch (err) {
        logStorage(userId, body?.action, body?.bucket, body?.path, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'Storage request failed.' });
    }
}
