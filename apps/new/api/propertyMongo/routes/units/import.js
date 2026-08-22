import { propertyHandler } from '../../http.js';
import { UNIT_EDIT_PERMS } from '../../permissions.js';
import { auditFromUser } from '../../audit.js';
import { importUnits } from '../../service.js';

export const handle = propertyHandler({
    perms: UNIT_EDIT_PERMS,
    op: 'units.import',
    run: async ({ method, body, apartmentId , user}) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return importUnits(apartmentId, body, auditFromUser(user));
    },
});
