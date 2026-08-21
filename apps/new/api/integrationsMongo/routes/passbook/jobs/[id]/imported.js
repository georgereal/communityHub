import { integrationsHandler } from '../../../../http.js';
import { INTEGRATIONS_EDIT_PERMS } from '../../../../permissions.js';
import { markPassbookJobImported, sanitizePassbookJob } from '../../../../passbookJobsStore.js';
import { badRequest } from '../../../../errors.js';

/** POST /api/integrations/passbook/jobs/:id/imported */
export const handle = integrationsHandler({
    perms: INTEGRATIONS_EDIT_PERMS,
    op: 'passbook.jobs.imported',
    collection: 'passbook_ocr_jobs',
    run: async ({ method, body, apartmentId, id, db }) => {
        if (method !== 'POST') {
            throw Object.assign(new Error('Method not allowed'), { status: 405 });
        }
        if (!id) throw badRequest('job id is required.');
        const job = await markPassbookJobImported(apartmentId, id, {
            importCount: body.import_count || body.importCount || 0,
            importId: body.imported_statement_import_id || body.importId || null,
            db,
        });
        return { job: sanitizePassbookJob(job) };
    },
});
