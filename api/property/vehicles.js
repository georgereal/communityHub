import { propertyHandler } from '../propertyMongo/http.js';
import { VEHICLE_EDIT_PERMS } from '../propertyMongo/permissions.js';
import { saveVehicle } from '../propertyMongo/service.js';

export default propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'vehicles.create',
    collection: 'property_units',
    run: async ({ method, body, apartmentId }) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return saveVehicle(apartmentId, body, null);
    },
});
