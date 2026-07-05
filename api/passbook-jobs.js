import { requireApartmentPermission } from './serverAuth.js';
import {
    getPassbookJob,
    listPassbookJobs,
    updatePassbookJob,
    PASSBOOK_JOB_STATUS,
    sanitizePassbookJob,
} from './passbookJobsStore.js';

export default async function handler(req, res) {
    const apartmentIdRaw = req.method === 'GET'
        ? req.query?.apartment_id || new URL(req.url, 'http://localhost').searchParams.get('apartment_id')
        : req.body?.apartment_id;

    try {
        const { apartmentId, service } = await requireApartmentPermission(req, apartmentIdRaw, 'accounts.edit');

        if (req.method === 'GET') {
            const jobId = req.query?.job_id || new URL(req.url, 'http://localhost').searchParams.get('job_id');
            if (jobId) {
                const job = await getPassbookJob(service, apartmentId, jobId);
                if (!job) return res.status(404).json({ error: 'Passbook OCR job not found.' });
                return res.status(200).json({ ok: true, job: sanitizePassbookJob(job) });
            }
            const jobs = await listPassbookJobs(service, apartmentId);
            return res.status(200).json({ ok: true, jobs: jobs.map(sanitizePassbookJob) });
        }

        if (req.method === 'POST') {
            const body = req.body || {};
            if (body.action !== 'mark_imported') {
                return res.status(400).json({ error: 'Unknown passbook jobs action.' });
            }
            const jobId = body.job_id;
            if (!jobId) return res.status(400).json({ error: 'job_id is required.' });
            const existing = await getPassbookJob(service, apartmentId, jobId);
            if (!existing) return res.status(404).json({ error: 'Passbook OCR job not found.' });
            const nextStatus = existing.status === PASSBOOK_JOB_STATUS.FAILED
                ? PASSBOOK_JOB_STATUS.FAILED
                : PASSBOOK_JOB_STATUS.IMPORTED;
            const job = await updatePassbookJob(service, jobId, {
                status: nextStatus,
                import_count: body.import_count || existing.import_count || 0,
                imported_statement_import_id: body.imported_statement_import_id || null,
                imported_at: new Date().toISOString(),
            });
            return res.status(200).json({ ok: true, job: sanitizePassbookJob(job) });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || 'Passbook jobs request failed.' });
    }
}
