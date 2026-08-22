import { integrationsHandler } from '../../http.js';
import { SPREADSHEET_EDIT_PERMS } from '../../permissions.js';
import { getSpreadsheetBoot, upsertOAuthApp } from '../../spreadsheetStore.js';

/** GET|POST /api/integrations/spreadsheet/oauth-apps?apartment_id= */
export const handle = integrationsHandler({
    perms: SPREADSHEET_EDIT_PERMS,
    op: 'spreadsheet.oauthApps',
    collection: 'ledger_sync_oauth_apps',
    run: async ({ method, body, apartmentId, user, db }) => {
        if (method === 'GET') {
            const boot = await getSpreadsheetBoot(apartmentId, user?.id, { db });
            return { rows: boot.ledgerOAuthApps };
        }
        if (method === 'POST' || method === 'PUT') {
            const row = await upsertOAuthApp(apartmentId, user?.id, body, { db });
            return { row };
        }
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    },
});
