/**
 * Public Evolyx webhook — Mongo-backed (token + job_id).
 * Path stays /api/passbook-webhook so configured tunnel URLs keep working.
 */
import { getMongoDb } from '../../../packages/server/mongoClient.js';
import {
    PASSBOOK_JOB_STATUS,
    completePassbookJobByWebhook,
    mapEvolyxTransactionsToStatementLines,
} from './integrationsMongo/passbookJobsStore.js';

function coerceWebhookStatus(payload) {
    const raw = String(
        payload?.status
        || payload?.executionStatus
        || payload?.state
        || payload?.result?.status
        || '',
    ).trim().toUpperCase();
    if (payload?.success === false || payload?.error) return PASSBOOK_JOB_STATUS.FAILED;
    if (raw.includes('FAIL') || raw.includes('ERROR')) return PASSBOOK_JOB_STATUS.FAILED;
    if (raw.includes('COMPLETE') || raw.includes('SUCCESS') || raw === 'DONE') return PASSBOOK_JOB_STATUS.COMPLETED;
    if (raw.includes('PROCESS') || raw.includes('RUN')) return PASSBOOK_JOB_STATUS.PROCESSING;
    return payload?.data ? PASSBOOK_JOB_STATUS.COMPLETED : PASSBOOK_JOB_STATUS.PROCESSING;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const url = new URL(req.url, 'http://localhost');
    const jobId = req.query?.job_id || url.searchParams.get('job_id');
    const token = req.query?.token || url.searchParams.get('token');
    if (!jobId || !token) {
        return res.status(400).json({ error: 'Missing job_id or token.' });
    }

    const payload = req.body || {};
    const status = coerceWebhookStatus(payload);
    const resultData = payload?.data || payload?.result?.data || payload?.result || {};
    const mappedLines = status === PASSBOOK_JOB_STATUS.COMPLETED
        ? mapEvolyxTransactionsToStatementLines(resultData)
        : [];

    try {
        const db = await getMongoDb();
        const result = await completePassbookJobByWebhook({
            jobId,
            callbackToken: token,
            payload: {
                status,
                execution_id: payload.executionId || payload.execution_id || null,
                request_id: payload.requestId || payload.request_id || null,
                provider_response: payload,
                last_error: status === PASSBOOK_JOB_STATUS.FAILED
                    ? (payload.error || payload.message || 'OCR workflow failed.')
                    : null,
                last_error_detail: status === PASSBOOK_JOB_STATUS.FAILED
                    ? (payload.detail || payload.errorDetail || null)
                    : null,
                mapped_lines: mappedLines,
                mapped_line_count: mappedLines.length,
            },
            db,
        });
        return res.status(200).json({ ok: true, result });
    } catch (err) {
        console.error('[passbook-webhook] failure', {
            jobId,
            status,
            error: err?.message || 'Webhook update failed.',
            stack: err?.stack || null,
        });
        return res.status(err.status || 500).json({ error: err.message || 'Webhook update failed.' });
    }
}
