import { propertyHandler } from '../../../propertyMongo/http.js';
import { VEHICLE_EDIT_PERMS } from '../../../propertyMongo/permissions.js';
import { releaseSlot } from '../../../propertyMongo/service.js';

export default propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'slots.release',
    collection: 'property_slots',
    run: async ({ method, apartmentId, id }) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return releaseSlot(apartmentId, decodeURIComponent(id));
    },
});
