import { propertyHandler } from '../propertyMongo/http.js';
import { UNIT_EDIT_PERMS } from '../propertyMongo/permissions.js';
import { saveResident } from '../propertyMongo/service.js';

export default propertyHandler({
    perms: UNIT_EDIT_PERMS,
    op: 'residents.save',
    run: async ({ method, body, apartmentId }) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return saveResident(apartmentId, body, body.id || body.resident_id || null);
    },
});
