import { requireSession } from './serverAuth.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';

const ALLOWED_RPC = new Set(['no_admin_exists', 'get_ledger_sync_service_status']);

function logRpc(userId, fn, ms, error) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/rpc',
        userId,
        fn,
        ms,
        ok: !error,
        error: error || null,
    }));
}

async function getService(req) {
    try {
        return createServiceClient();
    } catch {
        const { authHeader } = await requireSession(req);
        return createUserClient(authHeader);
    }
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (!req.body) return {};
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body || '{}');
        } catch {
            return {};
        }
    }
    return req.body;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const started = Date.now();
    let userId = null;
    let fn = '';

    try {
        const { user } = await requireSession(req);
        userId = user.id;
        const body = await readJsonBody(req);
        fn = String(body.fn || '');
        if (!ALLOWED_RPC.has(fn)) {
            throw Object.assign(new Error(`RPC not allowed: ${fn}`), { status: 403 });
        }

        const service = await getService(req);
        const params = body.params || {};
        const { data, error } = await service.rpc(fn, params);
        if (error) throw Object.assign(new Error(error.message), { status: 500 });

        logRpc(userId, fn, Date.now() - started);
        return res.status(200).json({ data, error: null });
    } catch (err) {
        logRpc(userId, fn, Date.now() - started, err.message);
        return res.status(err.status || 500).json({
            data: null,
            error: { message: err.message || 'RPC request failed.' },
        });
    }
}
