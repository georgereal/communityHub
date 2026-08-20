import { propertyHandler } from '../../propertyMongo/http.js';
import { UNIT_EDIT_PERMS } from '../../propertyMongo/permissions.js';
import { saveUnit, deleteUnit } from '../../propertyMongo/service.js';

export default propertyHandler({
    perms: UNIT_EDIT_PERMS,
    op: 'units.item',
    run: async ({ method, body, apartmentId, id }) => {
        if (!id) {
            const err = new Error('Flat id is required');
            err.status = 400;
            throw err;
        }
        if (method === 'PATCH') return saveUnit(apartmentId, body, decodeURIComponent(id));
        if (method === 'DELETE') return deleteUnit(apartmentId, decodeURIComponent(id));
        const err = new Error('Method not allowed');
        err.status = 405;
        throw err;
    },
});
