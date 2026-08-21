import { badRequest } from './errors.js';

export function callbackBaseUrl(req, explicitBaseUrl = '') {
    const configured = String(explicitBaseUrl || '').trim();
    if (configured) {
        try {
            const parsed = new URL(configured);
            if (!/^https?:$/i.test(parsed.protocol)) {
                throw new Error('Webhook app base URL must start with http:// or https://');
            }
            return parsed.toString().replace(/\/$/, '');
        } catch (err) {
            throw badRequest(`Invalid webhook app base URL: ${err?.message || 'Malformed URL.'}`);
        }
    }
    const proto = req.headers['x-forwarded-proto'] || (String(req.headers.host || '').includes('localhost') ? 'http' : 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) {
        throw Object.assign(new Error('Could not determine callback host for async passbook scan.'), { status: 500 });
    }
    return `${proto}://${host}`;
}

/** Evolyx (internet) cannot POST back to localhost / private hosts. */
export function isPublicWebhookBase(baseUrl) {
    try {
        const u = new URL(String(baseUrl || ''));
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
        if (host.endsWith('.local')) return false;
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return false;
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Default webhook = this API server (Host / X-Forwarded-*).
 * Optional override = tunnel or alternate public origin (Integrations field).
 */
export function buildPassbookWebhookUrl(req, { webhookBaseUrl = '', jobId, callbackToken }) {
    const override = String(webhookBaseUrl || '').trim();
    let webhook;
    try {
        const trimmed = override.replace(/\/$/, '');
        if (override && /\/api\/passbook-webhook$/i.test(trimmed)) {
            webhook = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
        } else {
            const base = callbackBaseUrl(req, override);
            webhook = new URL('api/passbook-webhook', base.endsWith('/') ? base : `${base}/`);
        }
    } catch (err) {
        throw badRequest(`Invalid webhook override URL: ${err?.message || 'Malformed URL.'}`);
    }
    webhook.searchParams.set('job_id', jobId);
    webhook.searchParams.set('token', String(callbackToken || ''));
    return {
        webhookUrl: webhook.toString(),
        callbackBase: `${webhook.protocol}//${webhook.host}`,
        usedOverride: Boolean(override),
    };
}

export async function startEvolyxWorkflow({ files, requestId, config, webhookUrl }) {
    const { baseUrl, apiKey, clientId, workflowId } = config;
    const url = `${baseUrl}/api/v2/workflows/${encodeURIComponent(workflowId)}/execute`;
    const rid = requestId || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey,
                ...(clientId ? { 'X-Client-Id': clientId } : {}),
                'X-Request-Id': rid,
                'X-Async': 'true',
                ...(webhookUrl ? { 'X-Webhook-URL': webhookUrl } : {}),
            },
            body: JSON.stringify({
                files,
                ...(webhookUrl ? { webhookUrl } : {}),
            }),
        });
    } catch (err) {
        const detail = err?.cause?.code || err?.cause?.message || err?.message || 'Network request failed.';
        throw Object.assign(
            new Error(`Could not reach Evolyx at ${baseUrl}. Check Administration → Integrations → API base URL and network access.`),
            { status: 502, detail, targetUrl: url },
        );
    }

    const text = await response.text();
    let json = {};
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        throw Object.assign(
            new Error(`Evolyx returned invalid JSON (${response.status}).`),
            { status: 502, detail: text.slice(0, 200) },
        );
    }

    if (!response.ok) {
        const msg = json.error || json.message || `Evolyx error (${response.status})`;
        const friendly = response.status === 401
            ? 'Configured passbook API key was rejected by the external OCR service.'
            : response.status === 403
                ? 'Configured client is not allowed to execute this passbook workflow.'
                : response.status === 415
                    ? 'OCR service rejected the upload format.'
                    : msg;
        const status = response.status === 429
            ? 429
            : (response.status >= 400 && response.status < 500 ? response.status : 502);
        throw Object.assign(new Error(msg), {
            status,
            message: friendly,
            detail: json.detail || undefined,
            targetUrl: json.targetUrl || url,
            evolyx: json,
        });
    }

    if (json.success === false) {
        throw Object.assign(new Error(json.error || 'Passbook workflow failed.'), { status: 502, evolyx: json });
    }

    return { ...json, requestId: json.requestId || rid };
}
