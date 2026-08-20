import { propertyHandler } from '../../propertyMongo/http.js';
import { UNIT_EDIT_PERMS } from '../../propertyMongo/permissions.js';
import { bulkPatchParkingLimits } from '../../propertyMongo/service.js';

export default propertyHandler({
    perms: UNIT_EDIT_PERMS,
    op: 'units.parking-limits',
    run: async ({ method, body, apartmentId }) => {
        if (method !== 'POST' && method !== 'PATCH') {
            const err = new Error('Method not allowed');
            err.status = 405;
            throw err;
        }
        return bulkPatchParkingLimits(apartmentId, body.unitIds || body.ids || [], body);
    },
});
