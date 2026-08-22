import { integrationsHandler } from '../../http.js';
import { SPREADSHEET_READ_PERMS } from '../../permissions.js';
import { listSpreadsheetRuns } from '../../spreadsheetStore.js';
import { getQueryParam } from '../../../../../../packages/server/vercelRequest.js';

/** GET /api/integrations/spreadsheet/runs?apartment_id=&limit= */
export const handle = integrationsHandler({
    perms: SPREADSHEET_READ_PERMS,
    op: 'spreadsheet.runs',
    collection: 'ledger_sync_runs',
    run: async ({ method, apartmentId, db, req }) => {
        if (method !== 'GET') {
            throw Object.assign(new Error('Method not allowed'), { status: 405 });
        }
        const limit = getQueryParam(req, 'limit') || 100;
        return listSpreadsheetRuns(apartmentId, { limit, db });
    },
});
