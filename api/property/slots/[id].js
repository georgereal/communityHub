import { propertyHandler } from '../../propertyMongo/http.js';
import { VEHICLE_EDIT_PERMS } from '../../propertyMongo/permissions.js';
import { deletePoolSlot } from '../../propertyMongo/service.js';

export default propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'slots.delete',
    collection: 'property_slots',
    run: async ({ method, apartmentId, id }) => {
        if (method !== 'DELETE') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        if (!id) {
            const err = new Error('Slot id is required');
            err.status = 400;
            throw err;
        }
        return deletePoolSlot(apartmentId, decodeURIComponent(id));
    },
});
