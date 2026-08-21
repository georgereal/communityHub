import { getMongoDb } from '../../../../packages/server/mongoClient.js';
import { badRequest, notFound } from './errors.js';
import { ensureIntegrationsIndexes } from './indexes.js';
import { mapEvolyxTransactionsToStatementLines } from './passbookMap.js';

export { mapEvolyxTransactionsToStatementLines };

export const PASSBOOK_JOB_STATUS = {
    INITIALIZED: 'INITIALIZED',
    SUBMITTED: 'SUBMITTED',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    IMPORTED: 'IMPORTED',
};

const nowIso = () => new Date().toISOString();

const ALLOWED_MIME = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
]);

export function sanitizePassbookJob(job) {
    if (!job || typeof job !== 'object') return job;
    const { callback_token, ...safe } = job;
    return safe;
}

export function validatePassbookFiles(files) {
    if (!Array.isArray(files) || !files.length) {
        throw badRequest('At least one passbook file is required.');
    }
    if (files.length > 20) throw badRequest('Maximum 20 files per request.');
    let total = 0;
    for (const file of files) {
        const name = String(file?.name || 'passbook').trim() || 'passbook';
        const mimeType = String(file?.mimeType || '').toLowerCase();
        const base64 = String(file?.base64 || '');
        if (!ALLOWED_MIME.has(mimeType)) {
            throw badRequest(`Unsupported file type for ${name}. Use PDF, JPEG, PNG, or WebP.`);
        }
        if (!base64) throw badRequest(`Missing file content for ${name}.`);
        const bytes = Buffer.byteLength(base64, 'base64');
        if (bytes > 10 * 1024 * 1024) throw badRequest(`${name} exceeds 10 MB.`);
        total += bytes;
    }
    if (total > 50 * 1024 * 1024) throw badRequest('Total upload exceeds 50 MB.');
    return {
        fileCount: files.length,
        totalBytes: total,
        fileNames: files.map((file) => String(file?.name || 'passbook')),
    };
}

export function summarizeFiles(files = []) {
    return (files || []).map((file) => ({
        name: String(file?.name || 'passbook'),
        mimeType: String(file?.mimeType || ''),
        bytes: file?.base64 ? Buffer.byteLength(String(file.base64), 'base64') : 0,
    }));
}

function stripMongo(doc) {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
}

export async function createPassbookJob({ apartmentId, userId, config, requestId, files, db: injected }) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    const stats = validatePassbookFiles(files);
    const now = nowIso();
    const row = {
        id: crypto.randomUUID(),
        apartment_id: apartmentId,
        provider: 'EVOLYX',
        status: PASSBOOK_JOB_STATUS.INITIALIZED,
        workflow_id: config.workflowId,
        request_id: requestId,
        // omit execution_id until Evolyx assigns one (unique partial index)
        created_by: userId || null,
        callback_token: crypto.randomUUID(),
        file_count: stats.fileCount,
        total_bytes: stats.totalBytes,
        file_names: stats.fileNames,
        mapped_line_count: 0,
        import_count: 0,
        imported_statement_import_id: null,
        imported_at: null,
        started_at: null,
        completed_at: null,
        last_error: null,
        last_error_detail: null,
        provider_response: null,
        mapped_lines: [],
        created_at: now,
        updated_at: now,
        _schema: 'integrations_v1',
    };
    await db.collection('passbook_ocr_jobs').insertOne(row);
    return stripMongo(row);
}

export async function updatePassbookJob(jobId, patch, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    const now = nowIso();
    const next = { ...patch, updated_at: now };
    const update = { $set: next };
    if (Object.prototype.hasOwnProperty.call(patch, 'execution_id')) {
        if (patch.execution_id == null || patch.execution_id === '') {
            delete next.execution_id;
            update.$unset = { execution_id: '' };
        }
    }
    const { matchedCount } = await db.collection('passbook_ocr_jobs').updateOne(
        { id: jobId },
        update,
    );
    if (!matchedCount) throw Object.assign(new Error('Passbook OCR job update failed.'), { status: 500 });
    const doc = await db.collection('passbook_ocr_jobs').findOne({ id: jobId });
    return stripMongo(doc);
}

export async function listPassbookJobs(apartmentId, limit = 30, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);
    const rows = await db.collection('passbook_ocr_jobs')
        .find({ apartment_id: apartmentId })
        .project({ callback_token: 0, mapped_lines: 0, provider_response: 0 })
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
    return rows.map(stripMongo);
}

export async function getPassbookJob(apartmentId, jobId, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    const doc = await db.collection('passbook_ocr_jobs').findOne({
        apartment_id: apartmentId,
        id: jobId,
    });
    return stripMongo(doc);
}

export async function markPassbookJobImported(apartmentId, jobId, { importCount = 0, importId = null, db: injected } = {}) {
    const existing = await getPassbookJob(apartmentId, jobId, { db: injected });
    if (!existing) throw notFound('Passbook OCR job not found.');
    const nextStatus = existing.status === PASSBOOK_JOB_STATUS.FAILED
        ? PASSBOOK_JOB_STATUS.FAILED
        : PASSBOOK_JOB_STATUS.IMPORTED;
    return updatePassbookJob(jobId, {
        status: nextStatus,
        import_count: importCount || existing.import_count || 0,
        imported_statement_import_id: importId || null,
        imported_at: nowIso(),
    }, { db: injected });
}

export async function completePassbookJobByWebhook({ jobId, callbackToken, payload, db: injected }) {
    const db = injected || await getMongoDb();
    await ensureIntegrationsIndexes(db);

    let status = String(payload.status || PASSBOOK_JOB_STATUS.FAILED).toUpperCase();
    if (!['SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'IMPORTED'].includes(status)) {
        status = PASSBOOK_JOB_STATUS.FAILED;
    }

    const existing = await db.collection('passbook_ocr_jobs').findOne({
        id: jobId,
        callback_token: callbackToken,
    });
    if (!existing) {
        throw Object.assign(new Error('Passbook OCR job not found or token invalid.'), { status: 404 });
    }

    const now = nowIso();
    const merged = {
        status,
        request_id: payload.request_id || existing.request_id || null,
        provider_response: payload.provider_response || existing.provider_response || null,
        last_error: payload.last_error ?? null,
        last_error_detail: payload.last_error_detail ?? null,
        mapped_lines: payload.mapped_lines || [],
        mapped_line_count: Math.max(payload.mapped_line_count || 0, 0),
        completed_at: ['COMPLETED', 'FAILED', 'IMPORTED'].includes(status)
            ? now
            : existing.completed_at || null,
        started_at: existing.started_at || now,
        updated_at: now,
    };
    const nextExecutionId = payload.execution_id || existing.execution_id || null;
    const update = { $set: merged };
    if (nextExecutionId) {
        merged.execution_id = nextExecutionId;
    } else if (Object.prototype.hasOwnProperty.call(existing, 'execution_id')) {
        update.$unset = { execution_id: '' };
    }
    await db.collection('passbook_ocr_jobs').updateOne(
        { id: jobId, callback_token: callbackToken },
        update,
    );
    return {
        id: existing.id,
        status: merged.status,
        execution_id: nextExecutionId,
        mapped_line_count: merged.mapped_line_count,
    };
}
