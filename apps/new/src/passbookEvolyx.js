/**
 * Evolyx passbook OCR — New UI client for /api/integrations/passbook/*.
 * Mapping helpers stay shared with classic.
 */
export {
    PASSBOOK_ACCEPT,
    PASSBOOK_MAX_FILES,
    PASSBOOK_MAX_BYTES,
    validatePassbookFiles,
    mapEvolyxTransactionsToStatementLines,
    passbookImportLabel,
    passbookJobImportLabel,
} from '@classic/passbookEvolyx.js';

import { portalState, isPlaceholderApartmentId } from './store.js';
import { readApiJson } from './apiJson.js';
import { validatePassbookFiles } from '@classic/passbookEvolyx.js';

const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = String(dataUrl).split(',')[1] || '';
        resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
});

async function filesToPayload(files) {
    const payload = [];
    for (const file of files) {
        payload.push({
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            base64: await readFileAsBase64(file),
        });
    }
    return payload;
}

export async function parsePassbookFiles(files, { requestId } = {}) {
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id || isPlaceholderApartmentId(apartment_id)) {
        throw new Error('No society selected. Choose your society from the header and try again.');
    }

    validatePassbookFiles(files);
    const filePayload = await filesToPayload(files);
    const res = await fetch('/api/integrations/passbook/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            apartment_id,
            files: filePayload,
            requestId: requestId || crypto.randomUUID(),
        }),
    });

    const { ok, json, error } = await readApiJson(res);
    if (!ok) {
        if (res.status === 404 && /NOT_FOUND|No route/i.test(error || json.error || '')) {
            throw new Error(
                'Integrations passbook API not found. Deploy the latest CommunityHub build, then restart `npm run dev` if testing locally.',
            );
        }
        const detail = json.detail ? `\n\nDetail: ${json.detail}` : '';
        const targetUrl = json.targetUrl ? `\nTarget: ${json.targetUrl}` : '';
        throw new Error((json.error || error || `Passbook parse failed (${res.status}).`) + detail + targetUrl);
    }

    return {
        job: json.job || null,
        executionId: json.executionId || null,
        requestId: json.requestId || null,
        status: json.status || null,
        warning: json.warning || null,
        webhookPublic: json.webhookPublic !== false,
    };
}

export async function fetchPassbookJobs(apartmentId, jobId = null) {
    const params = new URLSearchParams({ apartment_id: apartmentId });
    const path = jobId
        ? `/api/integrations/passbook/jobs/${encodeURIComponent(jobId)}?${params}`
        : `/api/integrations/passbook/jobs?${params}`;
    const res = await fetch(path, { credentials: 'include' });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || `Could not load passbook jobs (${res.status}).`);
    return jobId ? json.job || null : (json.jobs || []);
}

export async function markPassbookJobImported(apartmentId, jobId, importInfo = {}) {
    const res = await fetch(`/api/integrations/passbook/jobs/${encodeURIComponent(jobId)}/imported`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            apartment_id: apartmentId,
            import_count: importInfo.importCount || 0,
            imported_statement_import_id: importInfo.importId || null,
        }),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json.error || error || `Could not update passbook job (${res.status}).`);
    return json.job || null;
}
