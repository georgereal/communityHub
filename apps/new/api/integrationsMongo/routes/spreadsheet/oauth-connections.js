import { integrationsHandler } from '../../http.js';
import { SPREADSHEET_EDIT_PERMS } from '../../permissions.js';
import {
    deleteUserOAuthConnection,
    getUserOAuthConnectionWithTokens,
    upsertUserOAuthConnection,
} from '../../spreadsheetStore.js';

/**
 * User OAuth tokens for spreadsheet sync.
 * GET  /api/integrations/spreadsheet/oauth-connections?apartment_id=&provider=  (includes tokens for caller)
 * POST /api/integrations/spreadsheet/oauth-connections
 * DELETE with body { apartment_id, provider }
 */
export const handle = integrationsHandler({
    perms: SPREADSHEET_EDIT_PERMS,
    op: 'spreadsheet.oauthConnections',
    collection: 'user_oauth_connections',
    run: async ({ req, method, body, apartmentId, user, db }) => {
        const provider = String(
            body.provider
            || req.query?.provider
            || (Array.isArray(req.query?.provider) ? req.query.provider[0] : '')
            || '',
        ).trim().toUpperCase();

        if (method === 'GET') {
            if (!provider) throw Object.assign(new Error('provider is required.'), { status: 400 });
            const row = await getUserOAuthConnectionWithTokens(apartmentId, user?.id, provider, { db });
            return { row: row || null };
        }
        if (method === 'POST' || method === 'PUT') {
            const row = await upsertUserOAuthConnection(apartmentId, user?.id, body, { db });
            return { row };
        }
        if (method === 'DELETE') {
            if (!provider) throw Object.assign(new Error('provider is required.'), { status: 400 });
            await deleteUserOAuthConnection(apartmentId, user?.id, provider, { db });
            return { deleted: true };
        }
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    },
});
