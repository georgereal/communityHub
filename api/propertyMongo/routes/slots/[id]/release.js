import { propertyHandler } from '../../../http.js';
import { VEHICLE_EDIT_PERMS } from '../../../permissions.js';
import { releaseSlot } from '../../../service.js';

export const handle = propertyHandler({
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
