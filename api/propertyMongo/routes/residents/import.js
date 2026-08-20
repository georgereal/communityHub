import { propertyHandler } from '../../http.js';
import { UNIT_EDIT_PERMS } from '../../permissions.js';
import { importResidents } from '../../service.js';

export const handle = propertyHandler({
    perms: UNIT_EDIT_PERMS,
    op: 'residents.import',
    run: async ({ method, body, apartmentId }) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return importResidents(apartmentId, body.rows || body.residents || [], body.mode || 'update_listed');
    },
});
