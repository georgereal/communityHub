import { requireAccountsEditor } from './accountsAuth.js';
import { assertUuid } from './supabaseRest.js';
import { resolveEvolyxPassbookConfig } from './evolyxConnection.js';

const ALLOWED_MIME = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
]);
const MAX_FILES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function evolyxConfigFromResolved(resolved) {
    if (!resolved?.apiKey) {
        throw Object.assign(
            new Error('Passbook OCR is not configured. Set it up under Administration → External Connections.'),
            { status: 503 },
        );
    }
    return resolved;
}

async function evolyxConfig(authHeader, apartmentId) {
    const resolved = await resolveEvolyxPassbookConfig(authHeader, apartmentId);
    return evolyxConfigFromResolved(resolved);
}

function validateFiles(files) {
    if (!Array.isArray(files) || !files.length) {
        throw Object.assign(new Error('At least one passbook file is required.'), { status: 400 });
    }
    if (files.length > MAX_FILES) {
        throw Object.assign(new Error(`Maximum ${MAX_FILES} files per request.`), { status: 400 });
    }

    let total = 0;
    for (const file of files) {
        const name = String(file?.name || 'passbook').trim() || 'passbook';
        const mimeType = String(file?.mimeType || '').toLowerCase();
        const base64 = String(file?.base64 || '');
        if (!ALLOWED_MIME.has(mimeType)) {
            throw Object.assign(new Error(`Unsupported file type for ${name}. Use PDF, JPEG, PNG, or WebP.`), { status: 400 });
        }
        if (!base64) {
            throw Object.assign(new Error(`Missing file content for ${name}.`), { status: 400 });
        }
        const bytes = Buffer.byteLength(base64, 'base64');
        if (bytes > MAX_FILE_BYTES) {
            throw Object.assign(new Error(`${name} exceeds 10 MB.`), { status: 400 });
        }
        total += bytes;
    }
    if (total > MAX_TOTAL_BYTES) {
        throw Object.assign(new Error('Total upload exceeds 50 MB.'), { status: 400 });
    }
}

async function callEvolyxWorkflow({ files, requestId, authHeader, apartmentId }) {
    const { baseUrl, apiKey, workflowId, clientId } = await evolyxConfig(authHeader, apartmentId);
    const url = `${baseUrl}/api/v2/workflows/${workflowId}/execute`;
    const form = new FormData();

    for (const file of files) {
        const buffer = Buffer.from(file.base64, 'base64');
        const blob = new Blob([buffer], { type: file.mimeType });
        form.append('files', blob, file.name || 'passbook');
    }

    const rid = requestId || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'X-API-Key': apiKey,
            'X-Client-Id': clientId,
            'X-Request-Id': rid,
        },
        body: form,
    });

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
        const status = response.status === 429 ? 429 : (response.status >= 400 && response.status < 500 ? response.status : 502);
        throw Object.assign(new Error(msg), { status, evolyx: json });
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

    try {
        const body = req.body || {};
        const { apartment_id: apartmentIdRaw, files, requestId } = body;
        const { authHeader } = await requireAccountsEditor(req.headers.authorization, apartmentIdRaw);
        validateFiles(files);

        const apartment_id = assertUuid(apartmentIdRaw, 'apartment_id');
        const result = await callEvolyxWorkflow({ files, requestId, authHeader, apartment_id });
        return res.status(200).json({
            success: true,
            executionId: result.executionId,
            requestId: result.requestId,
            durationMs: result.durationMs,
            filesProcessed: result.filesProcessed,
            data: result.data || {},
        });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({
            error: err.message || 'Passbook parse failed.',
            evolyx: err.evolyx || undefined,
        });
    }
}
