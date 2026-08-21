/**
 * Legacy /api/passbook-parse — prefer POST /api/integrations/passbook/jobs.
 */
import { requireApartmentPermission } from '../../../packages/server/serverAuth.js';
import { getMongoDb } from '../../../packages/server/mongoClient.js';
import { ensureIntegrationsIndexes } from './integrationsMongo/indexes.js';
import { submitPassbookParse } from './integrationsMongo/passbookService.js';
import { summarizeFiles } from './integrationsMongo/passbookJobsStore.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const apartmentIdRaw = body.apartment_id;
    const requestId = body.requestId || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const files = body.files;

    try {
        console.info('[passbook-parse] request', {
            requestId,
            apartmentId: apartmentIdRaw || null,
            fileCount: Array.isArray(files) ? files.length : 0,
        });

        const { apartmentId, user } = await requireApartmentPermission(req, apartmentIdRaw, 'accounts.edit');
        const db = await getMongoDb();
        await ensureIntegrationsIndexes(db);
        const result = await submitPassbookParse({
            req,
            apartmentId,
            user,
            files,
            requestId,
            db,
        });
        const { __httpStatus, ...payload } = result;
        console.info('[passbook-parse] accepted', {
            requestId: payload.requestId,
            apartmentId,
            jobId: payload.job?.id,
        });
        return res.status(__httpStatus || 202).json(payload);
    } catch (err) {
        const status = err.status || 500;
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
        });
    }
}
