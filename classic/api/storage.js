import { requireSession } from '../../packages/server/serverAuth.js';
import { createServiceClient, createUserClient } from '../../packages/server/serverSupabase.js';
import { readJsonBody } from '../../packages/server/vercelRequest.js';
import {
    isR2Configured,
    r2PresignedGetUrl,
    r2DeleteObjects,
    attachmentObjectKey,
    isAllowedFinanceDocObjectKey,
} from '../../packages/server/r2Storage.js';

const RECEIPT_BUCKET = 'transaction-receipts';
const ALLOWED_BUCKETS = new Set([RECEIPT_BUCKET]);

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

async function getService(req) {
    const { authHeader } = await requireSession(req);
    try {
        return createServiceClient();
    } catch {
        return createUserClient(authHeader);
    }
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
        const { action, bucket = RECEIPT_BUCKET } = body;

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
            const other = body.paths.filter((p) => {
                const k = attachmentObjectKey(p);
                return p && !(k && isAllowedFinanceDocObjectKey(k));
            });
            if (r2Keys.length) {
                if (!isR2Configured()) {
                    throw Object.assign(new Error('Object storage is not configured.'), { status: 503 });
                }
                await r2DeleteObjects(r2Keys);
            }
            if (other.length) {
                if (!ALLOWED_BUCKETS.has(bucket)) {
                    throw Object.assign(new Error(`Bucket not allowed: ${bucket}`), { status: 403 });
                }
                const service = await getService(req);
                const { error } = await service.storage.from(bucket).remove(other);
                if (error) throw Object.assign(new Error(error.message), { status: 500 });
            }
            logStorage(userId, action, 'r2+supabase', body.paths.join(','), Date.now() - started);
            return res.status(200).json({ ok: true });
        }

        if (!ALLOWED_BUCKETS.has(bucket)) {
            throw Object.assign(new Error(`Bucket not allowed: ${bucket}`), { status: 403 });
        }

        const service = await getService(req);

        if (action === 'upload') {
            const { path, base64, mimeType } = body;
            if (!path || !base64) throw Object.assign(new Error('path and base64 required.'), { status: 400 });
            const buffer = Buffer.from(String(base64), 'base64');
            const { error } = await service.storage.from(bucket).upload(path, buffer, {
                upsert: body.upsert !== false,
                contentType: mimeType || undefined,
            });
            if (error) throw Object.assign(new Error(error.message), { status: 500 });
            logStorage(userId, action, bucket, path, Date.now() - started);
            return res.status(200).json({ ok: true, path });
        }

        if (action === 'remove') {
            const paths = Array.isArray(body.paths) ? body.paths : [];
            if (!paths.length) return res.status(200).json({ ok: true });
            const { error } = await service.storage.from(bucket).remove(paths);
            if (error) throw Object.assign(new Error(error.message), { status: 500 });
            logStorage(userId, action, bucket, paths.join(','), Date.now() - started);
            return res.status(200).json({ ok: true });
        }

        if (action === 'createSignedUrl') {
            const { path, expiresIn = 3600 } = body;
            if (!path) throw Object.assign(new Error('path required.'), { status: 400 });
            const { data, error } = await service.storage.from(bucket).createSignedUrl(path, expiresIn);
            if (error) throw Object.assign(new Error(error.message), { status: 500 });
            logStorage(userId, action, bucket, path, Date.now() - started);
            return res.status(200).json({ ok: true, signedUrl: data.signedUrl });
        }

        throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
    } catch (err) {
        logStorage(userId, body?.action, body?.bucket, body?.path, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'Storage request failed.' });
    }
}
