import { integrationsHandler } from '../http.js';
import { INTEGRATIONS_EDIT_PERMS } from '../permissions.js';
import { listExternalConnections, upsertExternalConnection } from '../connectionsStore.js';

export const handle = integrationsHandler({
    perms: INTEGRATIONS_EDIT_PERMS,
    op: 'connections',
    collection: 'external_connections',
    run: async ({ method, body, apartmentId, user, db }) => {
        if (method === 'GET') {
            const rows = await listExternalConnections(apartmentId, { db });
            return { rows };
        }
        if (method === 'POST' || method === 'PUT') {
            const row = await upsertExternalConnection(apartmentId, user?.id, body, { db });
            return { row };
        }
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    },
});
