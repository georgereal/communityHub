import { propertyHandler } from '../../../http.js';
import { VEHICLE_EDIT_PERMS } from '../../../permissions.js';
import { auditFromUser } from '../../../audit.js';
import { assignVehicleToSlot } from '../../../service.js';

export const handle = propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'slots.assign',
    collection: 'property_slots',
    run: async ({ method, body, apartmentId, id , user}) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return assignVehicleToSlot(apartmentId, decodeURIComponent(id), body.vehicleId, auditFromUser(user));
    },
});
