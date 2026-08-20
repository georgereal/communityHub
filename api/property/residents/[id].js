import { propertyHandler } from '../../propertyMongo/http.js';
import { UNIT_EDIT_PERMS } from '../../propertyMongo/permissions.js';
import { deleteResident } from '../../propertyMongo/service.js';

export default propertyHandler({
    perms: UNIT_EDIT_PERMS,
    op: 'residents.delete',
    run: async ({ method, apartmentId, id }) => {
        if (method !== 'DELETE') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return deleteResident(apartmentId, decodeURIComponent(id));
    },
});
