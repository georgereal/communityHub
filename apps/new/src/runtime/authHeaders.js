import { authClient } from '@auth/authClient.js';

export async function bearerAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    try {
        const sessionRes = await authClient?.auth?.getSession?.();
        const token = sessionRes?.data?.session?.access_token;
        if (token) headers.Authorization = `Bearer ${token}`;
    } catch { /* cookie session may still work */ }
    return headers;
}
