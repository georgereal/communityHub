/**
 * Supabase Postgres / Storage clients for Classic and leftover helpers.
 * App session verification is Firebase — see serverFirebaseAuth.js.
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

export { getUserFromAuthHeader } from './serverFirebaseAuth.js';

/** Reuse one service client in the Node/Vite process — avoids per-request TLS setup. */
let serviceClientSingleton = null;

function serverClientOptions(authHeader = '') {
    return {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
        global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
        // Node 20 has no global WebSocket — supabase-js refuses to construct without this.
        realtime: {
            transport: ws,
        },
    };
}

export function getSupabaseEnv() {
    const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const supabaseAnonKey = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '');
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const jwtSecret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || '';

    if (!supabaseUrl || !supabaseAnonKey) {
        throw Object.assign(
            new Error('Missing Supabase environment variables. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'),
            { status: 500 },
        );
    }

    return { supabaseUrl, supabaseAnonKey, supabaseServiceKey, jwtSecret };
}

export function createUserClient(authHeader) {
    const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();
    return createClient(supabaseUrl, supabaseAnonKey, serverClientOptions(authHeader));
}

export function createServiceClient() {
    if (serviceClientSingleton) return serviceClientSingleton;
    const { supabaseUrl, supabaseServiceKey } = getSupabaseEnv();
    if (!supabaseServiceKey) {
        throw Object.assign(
            new Error('Missing Supabase environment variable SUPABASE_SERVICE_ROLE_KEY.'),
            { status: 500 },
        );
    }
    serviceClientSingleton = createClient(supabaseUrl, supabaseServiceKey, serverClientOptions());
    return serviceClientSingleton;
}
