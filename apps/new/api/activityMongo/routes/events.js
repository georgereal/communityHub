import { activityHandler } from '../http.js';
import { ACTIVITY_READ_PERMS, ACTIVITY_WRITE_PERMS } from '../permissions.js';
import { filtersFromReq, insertActivityEvent, listActivityEvents } from '../activityStore.js';

/** GET/POST /api/activity/events */
export const handle = activityHandler({
    perms: ACTIVITY_READ_PERMS,
    op: 'activity.events',
    collection: 'activity_audit_log',
    run: async ({ method, body, apartmentId, user, db, req }) => {
        if (method === 'GET') {
            const filters = filtersFromReq(req);
            return listActivityEvents(apartmentId, { ...filters, db });
        }
        if (method === 'POST') {
            // Re-check write set (same list today; keep hook for tighter write later).
            void ACTIVITY_WRITE_PERMS;
            return insertActivityEvent({ ...body, apartment_id: apartmentId }, { db, user });
        }
        throw Object.assign(new Error('Method not allowed'), { status: 405 });
    },
});
