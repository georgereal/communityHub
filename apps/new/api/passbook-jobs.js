/**
 * Legacy /api/passbook-jobs — prefer /api/integrations/passbook/jobs.
 */
import { requireApartmentPermission } from '../../../packages/server/serverAuth.js';
import { getMongoDb } from '../../../packages/server/mongoClient.js';
import { ensureIntegrationsIndexes } from './integrationsMongo/indexes.js';
import {
    getPassbookJob,
    listPassbookJobs,
    markPassbookJobImported,
    sanitizePassbookJob,
} from './integrationsMongo/passbookJobsStore.js';

export default async function handler(req, res) {
    const apartmentIdRaw = req.method === 'GET'
        ? req.query?.apartment_id || new URL(req.url, 'http://localhost').searchParams.get('apartment_id')
        : req.body?.apartment_id;

    try {
        const { apartmentId } = await requireApartmentPermission(req, apartmentIdRaw, 'accounts.edit');
        const db = await getMongoDb();
        await ensureIntegrationsIndexes(db);

        if (req.method === 'GET') {
            const jobId = req.query?.job_id || new URL(req.url, 'http://localhost').searchParams.get('job_id');
            if (jobId) {
                const job = await getPassbookJob(apartmentId, jobId, { db });
                if (!job) return res.status(404).json({ error: 'Passbook OCR job not found.' });
                return res.status(200).json({ ok: true, job: sanitizePassbookJob(job) });
            }
            const jobs = await listPassbookJobs(apartmentId, 30, { db });
            return res.status(200).json({ ok: true, jobs: jobs.map(sanitizePassbookJob) });
        }

        if (req.method === 'POST') {
            const body = req.body || {};
            if (body.action !== 'mark_imported') {
                return res.status(400).json({ error: 'Unknown passbook jobs action.' });
            }
            const jobId = body.job_id;
            if (!jobId) return res.status(400).json({ error: 'job_id is required.' });
            const job = await markPassbookJobImported(apartmentId, jobId, {
                importCount: body.import_count || 0,
                importId: body.imported_statement_import_id || null,
                db,
            });
            return res.status(200).json({ ok: true, job: sanitizePassbookJob(job) });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'Passbook jobs request failed.' });
    }
}
