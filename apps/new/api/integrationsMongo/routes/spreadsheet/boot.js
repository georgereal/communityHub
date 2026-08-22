import { integrationsHandler } from '../../http.js';
import { SPREADSHEET_READ_PERMS } from '../../permissions.js';
import { getSpreadsheetBoot } from '../../spreadsheetStore.js';

/** GET /api/integrations/spreadsheet/boot?apartment_id= */
export const handle = integrationsHandler({
    perms: SPREADSHEET_READ_PERMS,
    op: 'spreadsheet.boot',
    collection: 'ledger_sync_settings',
    run: async ({ method, apartmentId, user, db }) => {
        if (method !== 'GET') {
            throw Object.assign(new Error('Method not allowed'), { status: 405 });
        }
        return getSpreadsheetBoot(apartmentId, user?.id, { db });
    },
});
