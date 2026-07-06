/**
 * External HTTP calls from browser (via /api/external-proxy) or server (direct fetch).
 * Server-side callers — e.g. Vercel /api/sync — must not use the browser proxy.
 */

function parseProxyResponse(proxy) {
    return {
        ok: proxy.ok,
        status: proxy.status,
        text: proxy.text || '',
        json: async () => proxy.json ?? (proxy.text ? JSON.parse(proxy.text) : {}),
    };
}

function parseDirectResponse(res, text, json) {
    return {
        ok: res.ok,
        status: res.status,
        text,
        json: async () => json ?? (text ? JSON.parse(text) : {}),
    };
}

export async function externalFetch(url, init = {}) {
    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

    if (isBrowser) {
        const { proxyExternalRequest } = await import('./dbClient.js');
        const proxy = await proxyExternalRequest(url, init);
        return parseProxyResponse(proxy);
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    return parseDirectResponse(res, text, json);
}

/** For callers that need { ok, status, json } without async json(). */
export async function externalRequest(url, init = {}) {
    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

    if (isBrowser) {
        const { proxyExternalRequest } = await import('./dbClient.js');
        return proxyExternalRequest(url, init);
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    return { ok: res.ok, status: res.status, text, json };
}
