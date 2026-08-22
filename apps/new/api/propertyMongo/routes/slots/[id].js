import { propertyHandler } from '../../http.js';
import { VEHICLE_EDIT_PERMS } from '../../permissions.js';
import { auditFromUser } from '../../audit.js';
import { deletePoolSlot } from '../../service.js';

export const handle = propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'slots.delete',
    collection: 'property_slots',
    run: async ({ method, apartmentId, id , user}) => {
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
