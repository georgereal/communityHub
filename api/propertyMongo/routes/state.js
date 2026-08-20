import { propertyHandler } from '../http.js';
import { VIEW_PERMS } from '../permissions.js';
import { loadPropertyState } from '../service.js';

export const handle = propertyHandler({
    perms: VIEW_PERMS,
    op: 'state',
    run: ({ apartmentId }) => loadPropertyState(apartmentId),
});
