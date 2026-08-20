import { propertyHandler } from '../../http.js';
import { UNIT_EDIT_PERMS } from '../../permissions.js';
import { deleteResident } from '../../service.js';

export const handle = propertyHandler({
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
