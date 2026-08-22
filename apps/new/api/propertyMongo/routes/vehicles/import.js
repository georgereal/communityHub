import { propertyHandler } from '../../http.js';
import { VEHICLE_EDIT_PERMS } from '../../permissions.js';
import { auditFromUser } from '../../audit.js';
import { importVehicles } from '../../service.js';

export const handle = propertyHandler({
    perms: VEHICLE_EDIT_PERMS,
    op: 'vehicles.import',
    run: async ({ method, body, apartmentId , user}) => {
        if (method !== 'POST') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return importVehicles(apartmentId, body.rows || [], auditFromUser(user));
    },
});
