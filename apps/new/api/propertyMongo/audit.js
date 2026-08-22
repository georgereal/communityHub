/**
 * Property domain → Activity / vehicle audit (best-effort).
 */
import {
    actorLabelFromUser,
    safeLogActivity,
    safeLogVehicleAudit,
} from '../activityMongo/activityStore.js';

export function auditFromUser(user) {
    return {
        actorLabel: actorLabelFromUser(user),
        actorId: user?.id || null,
    };
}

export function logPropertyActivity(apartmentId, {
    entityType,
    entityId,
    action,
    summary,
    oldData = null,
    newData = null,
    audit = {},
}) {
    return safeLogActivity({
        apartment_id: apartmentId,
        entity_type: entityType,
        entity_id: String(entityId || ''),
        action,
        summary,
        old_data: oldData,
        new_data: newData,
        actor_id: audit.actorId || null,
        actor_label: audit.actorLabel || null,
    });
}

export function logParkingVehicle(apartmentId, {
    action,
    vehicleId = null,
    unitNumber = null,
    plate = null,
    changes = [],
    source = 'ui',
    audit = {},
}) {
    return safeLogVehicleAudit({
        apartmentId,
        action,
        vehicleId,
        unitNumber,
        plate,
        changes,
        changedBy: audit.actorLabel || null,
        source,
    });
}
