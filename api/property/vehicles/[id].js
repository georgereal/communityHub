import { propertyHandler } from '../../propertyMongo/http.js';
import { VEHICLE_EDIT_PERMS } from '../../propertyMongo/permissions.js';
import { deleteVehicle, patchVehicle } from '../../propertyMongo/service.js';

export default propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'vehicles.item',
    run: async ({ method, body, apartmentId, id }) => {
        if (!id) {
            const err = new Error('Vehicle id is required');
            err.status = 400;
            throw err;
        }
        if (method === 'PATCH') return patchVehicle(apartmentId, decodeURIComponent(id), body);
        if (method === 'DELETE') return deleteVehicle(apartmentId, decodeURIComponent(id));
        const err = new Error('Method not allowed');
        err.status = 405;
        throw err;
    },
});
