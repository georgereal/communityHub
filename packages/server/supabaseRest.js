const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value, label = 'id') {
    const s = String(value ?? '').trim();
    if (!UUID_RE.test(s)) {
        throw Object.assign(new Error(`Invalid ${label}. Select a society and try again.`), { status: 400 });
    }
    return s;
}

export function parseRestError(text) {
    if (!text) return 'Request failed.';
    try {
        const json = JSON.parse(text);
        return json.message || json.error || text;
    } catch {
        return text;
    }
}

function filterParams(filters) {
    const params = new URLSearchParams();
    for (const [col, val] of Object.entries(filters)) {
        if (val == null || val === '') continue;
        params.set(col, `eq.${val}`);
    }
    return params;
}

/** Server-side Supabase access via HTTP (auth + PostgREST). No Realtime/WebSocket SDK. */

export function supabasePublicEnv() {
    const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    const missing = [];
    if (!supabaseUrl) missing.push('VITE_SUPABASE_URL');
    if (!supabaseAnonKey) missing.push('VITE_SUPABASE_ANON_KEY');
    if (missing.length) {
        throw Object.assign(
            new Error(`Missing Supabase env: ${missing.join(', ')}.`),
            { status: 500 },
        );
    }
    return { supabaseUrl, supabaseAnonKey };
}

function apiHeaders(authHeader, { single = false } = {}) {
    const { supabaseAnonKey } = supabasePublicEnv();
    const headers = {
        apikey: supabaseAnonKey,
        Authorization: authHeader,
        'Content-Type': 'application/json',
    };
    if (single) {
        headers.Accept = 'application/vnd.pgrst.object+json';
    }
    return headers;
}

export async function getAuthUser(authHeader) {
    const { supabaseUrl } = supabasePublicEnv();
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: apiHeaders(authHeader),
    });
    if (!res.ok) {
        return { user: null, error: await res.text() };
    }
    const payload = await res.json();
    const user = payload?.user ?? payload;
    if (!user?.id) {
        return { user: null, error: 'No user in auth response.' };
    }
    return { user, error: null };
}

export async function restMaybeSingle(authHeader, table, filters, select = '*') {
    const { supabaseUrl } = supabasePublicEnv();
    const params = filterParams(filters);
    params.set('select', select);
    params.set('limit', '1');
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${params}`, {
        headers: apiHeaders(authHeader, { single: true }),
    });
    if (res.status === 406) return { data: null, error: null };
    const text = await res.text();
    if (!res.ok) {
        return { data: null, error: parseRestError(text) };
    }
    return { data: text ? JSON.parse(text) : null, error: null };
}

export async function restSelect(authHeader, table, filters, select = '*') {
    const { supabaseUrl } = supabasePublicEnv();
    const params = filterParams(filters);
    params.set('select', select);
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${params}`, {
        headers: apiHeaders(authHeader),
    });
    const text = await res.text();
    if (!res.ok) {
        return { data: [], error: parseRestError(text) };
    }
    return { data: text ? JSON.parse(text) : [], error: null };
}

export async function restIn(authHeader, table, col, values, select = '*') {
    const { supabaseUrl } = supabasePublicEnv();
    const clean = (values || []).filter((v) => v != null && v !== '');
    if (!clean.length) return { data: [], error: null };
    const params = new URLSearchParams({
        select,
        [col]: `in.(${clean.join(',')})`,
    });
    const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${params}`, {
        headers: apiHeaders(authHeader),
    });
    const text = await res.text();
    if (!res.ok) {
        return { data: [], error: parseRestError(text) };
    }
    return { data: text ? JSON.parse(text) : [], error: null };
}
