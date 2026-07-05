import { requireApartmentPermission } from './serverAuth.js';
import { resolveEvolyxPassbookConfig } from './evolyxConnection.js';
import {
    PASSBOOK_JOB_STATUS,
    createPassbookJob,
    summarizeFiles,
    updatePassbookJob,
} from './passbookJobsStore.js';

function evolyxConfigFromResolved(resolved) {
    if (!resolved?.apiKey) {
        throw Object.assign(
            new Error('Passbook OCR is not configured. Set it up under Administration → External Connections.'),
            { status: 503 },
        );
    }
    return resolved;
}

function callbackBaseUrl(req, explicitBaseUrl = '') {
    const configured = String(explicitBaseUrl || '').trim();
    if (configured) {
        try {
            const parsed = new URL(configured);
            if (!/^https?:$/i.test(parsed.protocol)) {
                throw new Error('Webhook app base URL must start with http:// or https://');
            }
            return parsed.toString().replace(/\/$/, '');
        } catch (err) {
            throw Object.assign(new Error(`Invalid webhook app base URL: ${err?.message || 'Malformed URL.'}`), { status: 400 });
        }
    }
    const proto = req.headers['x-forwarded-proto'] || (String(req.headers.host || '').includes('localhost') ? 'http' : 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (!host) throw Object.assign(new Error('Could not determine callback host for async passbook scan.'), { status: 500 });
    return `${proto}://${host}`;
}

async function startEvolyxWorkflow({ files, requestId, config, webhookUrl }) {
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
            new Error(`Could not reach Evolyx at ${baseUrl}. Check Administration -> External Connections -> API base URL and network access.`),
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

/**
 * Proxy passbook images/PDFs to Evolyx OCR workflow (API key stays server-side).
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const apartmentIdRaw = body.apartment_id;
    const requestId = body.requestId || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const files = body.files;
    let job = null;
    let service = null;

    try {
        console.info('[passbook-parse] request', {
            requestId,
            apartmentId: apartmentIdRaw || null,
            fileCount: Array.isArray(files) ? files.length : 0,
        });

        const { apartmentId: apartment_id, authHeader, user, service: userService } = await requireApartmentPermission(req, apartmentIdRaw, 'accounts.edit');
        service = userService;
        const config = evolyxConfigFromResolved(await resolveEvolyxPassbookConfig(apartment_id, { authHeader }));
        job = await createPassbookJob(service, {
            apartmentId: apartment_id,
            userId: user?.id || null,
            config,
            requestId,
            files,
        });
        const callbackToken = job.callback_token;
        const callbackBase = callbackBaseUrl(req, config.webhookBaseUrl);
        const webhook = new URL('api/passbook-webhook', callbackBase.endsWith('/') ? callbackBase : `${callbackBase}/`);
        webhook.searchParams.set('job_id', job.id);
        webhook.searchParams.set('token', String(callbackToken || ''));
        const result = await startEvolyxWorkflow({
            files,
            requestId,
            config,
            webhookUrl: webhook.toString(),
        });
        job = await updatePassbookJob(service, job.id, {
            status: PASSBOOK_JOB_STATUS.SUBMITTED,
            execution_id: result.executionId || null,
            request_id: result.requestId || requestId,
            started_at: new Date().toISOString(),
            provider_response: result,
        });

        console.info('[passbook-parse] accepted', {
            requestId: result.requestId || requestId,
            apartmentId: apartment_id,
            fileCount: Array.isArray(files) ? files.length : 0,
            workflowId: result.workflowId || config.workflowId || null,
            executionId: result.executionId || null,
            jobId: job.id,
        });

        return res.status(202).json({
            success: true,
            status: PASSBOOK_JOB_STATUS.SUBMITTED,
            job: {
                ...job,
                callback_token: undefined,
            },
            executionId: result.executionId,
            requestId: result.requestId,
        });
    } catch (err) {
        const status = err.status || 500;
        if (job?.id && service) {
            try {
                await updatePassbookJob(service, job.id, {
                    status: PASSBOOK_JOB_STATUS.FAILED,
                    completed_at: new Date().toISOString(),
                    last_error: err?.message || 'Passbook parse failed.',
                    last_error_detail: err?.detail || null,
                });
            } catch {
                // best effort
            }
        }
        console.error('[passbook-parse] failure', {
            requestId,
            apartmentId: apartmentIdRaw || null,
            fileCount: Array.isArray(files) ? files.length : 0,
            files: summarizeFiles(files),
            status,
            error: err?.message || 'Passbook parse failed.',
            detail: err?.detail || null,
            targetUrl: err?.targetUrl || null,
            evolyx: err?.evolyx || null,
            stack: err?.stack || null,
        });
        return res.status(status).json({
            error: err.message || 'Passbook parse failed.',
            detail: err.detail || undefined,
            targetUrl: err.targetUrl || undefined,
            evolyx: err.evolyx || undefined,
            requestId,
            jobId: job?.id || undefined,
        });
    }
}
