import { integrationsHandler } from '../../http.js';
import { SPREADSHEET_EDIT_PERMS } from '../../permissions.js';
import { getSpreadsheetBoot, upsertSpreadsheetSettings } from '../../spreadsheetStore.js';

/** GET|POST /api/integrations/spreadsheet/settings?apartment_id= */
export const handle = integrationsHandler({
    perms: SPREADSHEET_EDIT_PERMS,
    op: 'spreadsheet.settings',
    collection: 'ledger_sync_settings',
    run: async ({ method, body, apartmentId, user, db }) => {
        if (method === 'GET') {
            const boot = await getSpreadsheetBoot(apartmentId, user?.id, { db });
            return { settings: boot.ledgerSyncSettings };
        }
        if (method === 'POST' || method === 'PUT') {
            const settings = await upsertSpreadsheetSettings(apartmentId, user?.id, body, { db });
            return { settings };
        }
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    },
});
