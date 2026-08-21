import { integrationsHandler } from '../../http.js';
import { INTEGRATIONS_EDIT_PERMS } from '../../permissions.js';
import { submitPassbookParse } from '../../passbookService.js';
import {
    getPassbookJob,
    listPassbookJobs,
    sanitizePassbookJob,
} from '../../passbookJobsStore.js';
import { badRequest } from '../../errors.js';

export const handle = integrationsHandler({
    perms: INTEGRATIONS_EDIT_PERMS,
    op: 'passbook.jobs',
    collection: 'passbook_ocr_jobs',
    run: async ({ req, method, body, apartmentId, user, id, db }) => {
        if (method === 'GET') {
            if (id) {
                const job = await getPassbookJob(apartmentId, id, { db });
                if (!job) {
                    const err = new Error('Passbook OCR job not found.');
                    err.status = 404;
                    throw err;
                }
                return { job: sanitizePassbookJob(job) };
            }
            const jobs = await listPassbookJobs(apartmentId, 30, { db });
            return { jobs: jobs.map(sanitizePassbookJob) };
        }

        if (method === 'POST' && !id) {
            const files = body.files;
            if (!Array.isArray(files) || !files.length) throw badRequest('files[] is required.');
            return submitPassbookParse({
                req,
                apartmentId,
                user,
                files,
                requestId: body.requestId || body.request_id,
                db,
            });
        }

        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    },
});
