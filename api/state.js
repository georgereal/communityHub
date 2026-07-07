import { requireSession } from './serverAuth.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';
import { assertUuid } from './supabaseRest.js';
import { getQueryParam } from './vercelRequest.js';
import { fetchDomainState, STATE_DOMAINS } from './stateDomains.js';

function logState(userId, apartmentId, domain, ms, error) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/state',
        userId,
        apartmentId,
        domain,
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
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const started = Date.now();
    let userId = null;
    let apartmentId = null;
    let domain = 'core';

    try {
        apartmentId = assertUuid(getQueryParam(req, 'apartment_id'), 'apartment_id');
        domain = String(getQueryParam(req, 'domain') || 'core').toLowerCase();
        if (!STATE_DOMAINS.includes(domain) && domain !== 'all') {
            throw Object.assign(
                new Error(`Invalid domain. Use one of: ${STATE_DOMAINS.join(', ')}, all`),
                { status: 400 },
            );
        }

        const { user } = await requireSession(req);
        userId = user.id;

        const service = await getService(req);

        const { data: mapping, error: mapErr } = await service
            .from('user_apartments')
            .select('apartment_id')
            .eq('user_id', user.id)
            .eq('apartment_id', apartmentId)
            .maybeSingle();
        if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
        if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });

        const state = await fetchDomainState(service, domain, apartmentId, user.id);
        logState(userId, apartmentId, domain, Date.now() - started);
        return res.status(200).json({ ok: true, domain, state });
    } catch (err) {
        logState(userId, apartmentId, domain, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'State load failed.' });
    }
}
