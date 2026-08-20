import { propertyHandler } from '../propertyMongo/http.js';
import { VIEW_PERMS } from '../propertyMongo/permissions.js';
import { loadPropertyState } from '../propertyMongo/service.js';

export default propertyHandler({
    perms: VIEW_PERMS,
    op: 'state',
    run: ({ apartmentId }) => loadPropertyState(apartmentId),
});
