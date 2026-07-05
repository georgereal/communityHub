import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

function serverClientOptions(authHeader = '') {
    return {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
        global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
        realtime: {
            transport: ws,
        },
    };
}

export function getSupabaseEnv() {
    const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseAnonKey) {
        throw Object.assign(
            new Error('Missing Supabase environment variables. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'),
            { status: 500 },
        );
    }

    return { supabaseUrl, supabaseAnonKey, supabaseServiceKey };
}

export function createUserClient(authHeader) {
    const { supabaseUrl, supabaseAnonKey } = getSupabaseEnv();
    return createClient(supabaseUrl, supabaseAnonKey, serverClientOptions(authHeader));
}

export function createServiceClient() {
    const { supabaseUrl, supabaseServiceKey } = getSupabaseEnv();
    if (!supabaseServiceKey) {
        throw Object.assign(
            new Error('Missing Supabase environment variable SUPABASE_SERVICE_ROLE_KEY.'),
            { status: 500 },
        );
    }
    return createClient(supabaseUrl, supabaseServiceKey, serverClientOptions());
}

export async function getUserFromAuthHeader(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) {
        return { user: null, error: 'Sign in required.' };
    }
    const userClient = createUserClient(authHeader);
    const { data: { user }, error } = await userClient.auth.getUser();
    return { user: user || null, error: error?.message || null };
}
