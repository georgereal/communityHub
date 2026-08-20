import { propertyHandler } from '../../propertyMongo/http.js';
import { UNIT_EDIT_PERMS } from '../../propertyMongo/permissions.js';
import { importUnits } from '../../propertyMongo/service.js';

export default propertyHandler({
    perms: UNIT_EDIT_PERMS,
    op: 'units.import',
    run: async ({ method, body, apartmentId }) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return importUnits(apartmentId, body);
    },
});
