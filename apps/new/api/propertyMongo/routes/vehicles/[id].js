import { propertyHandler } from '../../http.js';
import { VEHICLE_EDIT_PERMS } from '../../permissions.js';
import { auditFromUser } from '../../audit.js';
import { deleteVehicle, patchVehicle } from '../../service.js';

export const handle = propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'vehicles.item',
    run: async ({ method, body, apartmentId, id , user}) => {
        if (!id) {
            const err = new Error('Vehicle id is required');
            err.status = 400;
            throw err;
        }
        if (method === 'PATCH') return patchVehicle(apartmentId, decodeURIComponent(id), body, auditFromUser(user));
        if (method === 'DELETE') return deleteVehicle(apartmentId, decodeURIComponent(id), auditFromUser(user));
        const err = new Error('Method not allowed');
        err.status = 405;
        throw err;
    },
});
