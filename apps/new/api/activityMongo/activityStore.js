/**
 * Consolidated society activity — Mongo.
 * Sources:
 *   - activity_audit_log  (billing, residents, roles, bank recon, visitors, …)
 *   - vehicle_audit_log   (parking / vehicle registry — was a separate trail)
 */
import { randomUUID } from 'node:crypto';
import { getMongoDb } from '../../../../packages/server/mongoClient.js';
import { getQueryParam } from '../../../../packages/server/vercelRequest.js';
import { badRequest } from './errors.js';
import { COL_ACTIVITY, COL_VEHICLE, ensureActivityIndexes } from './indexes.js';

const nowIso = () => new Date().toISOString();

/** Canonical functionality key for parking / vehicle registry audits. */
export const PARKING_ENTITY = 'PARKING';

const VEHICLE_ACTION_MAP = {
    insert: 'CREATE',
    update: 'UPDATE',
    delete: 'DELETE',
};

function publicActivityEvent(doc) {
    if (!doc) return null;
    return {
        id: doc.id || doc._id,
        source: 'activity',
        apartment_id: doc.apartment_id,
        entity_type: doc.entity_type,
        entity_id: doc.entity_id,
        action: doc.action,
        actor_id: doc.actor_id || null,
        actor_label: doc.actor_label || null,
        summary: doc.summary || null,
        old_data: doc.old_data ?? null,
        new_data: doc.new_data ?? null,
        review_status: doc.review_status || null,
        created_at: doc.created_at,
    };
}

function publicVehicleEvent(doc) {
    if (!doc) return null;
    const rawAction = String(doc.action || '').toLowerCase();
    const action = VEHICLE_ACTION_MAP[rawAction] || String(doc.action || '').toUpperCase();
    const plate = doc.plate || 'vehicle';
    const unit = doc.unit_number ? ` unit ${doc.unit_number}` : '';
    const changeCount = Array.isArray(doc.changes) ? doc.changes.length : 0;
    const changeHint = changeCount
        ? ` (${changeCount} field${changeCount === 1 ? '' : 's'})`
        : '';
    return {
        id: doc.id || doc._id,
        source: 'parking',
        apartment_id: doc.apartment_id,
        entity_type: PARKING_ENTITY,
        entity_id: String(doc.vehicle_id || doc.plate || doc.id || ''),
        action,
        actor_id: null,
        actor_label: doc.changed_by || null,
        summary: `${action === 'CREATE' ? 'Added' : action === 'DELETE' ? 'Removed' : 'Updated'} parking vehicle ${plate}${unit}${changeHint}`,
        old_data: null,
        new_data: {
            plate: doc.plate,
            unit_number: doc.unit_number,
            vehicle_id: doc.vehicle_id,
            source: doc.source,
            changes: doc.changes || [],
        },
        review_status: null,
        created_at: doc.changed_at || doc.created_at,
    };
}

function mapActivityRow(row, migratedAt) {
    const id = row.id || randomUUID();
    return {
        _id: id,
        id,
        apartment_id: row.apartment_id,
        entity_type: row.entity_type,
        entity_id: String(row.entity_id ?? ''),
        action: row.action,
        actor_id: row.actor_id || null,
        actor_label: row.actor_label || null,
        summary: row.summary || null,
        old_data: row.old_data ?? null,
        new_data: row.new_data ?? null,
        review_status: row.review_status || null,
        reviewed_by: row.reviewed_by || null,
        reviewed_at: row.reviewed_at || null,
        review_notes: row.review_notes || null,
        created_at: row.created_at || migratedAt,
        _schema: 'activity_v1',
        _migratedAt: migratedAt,
    };
}

function mapVehicleRow(row, migratedAt) {
    const id = row.id || randomUUID();
    return {
        _id: id,
        id,
        apartment_id: row.apartment_id,
        vehicle_id: row.vehicle_id || null,
        unit_number: row.unit_number || null,
        plate: row.plate || '',
        action: row.action,
        source: row.source || 'ui',
        changed_at: row.changed_at || migratedAt,
        changed_by: row.changed_by || null,
        changes: Array.isArray(row.changes) ? row.changes : [],
        synced_at: row.synced_at || null,
        _schema: 'vehicle_audit_v1',
        _migratedAt: migratedAt,
    };
}

async function fetchAllFromSupabase(service, baseName, apartmentId, { orderBy = 'id' } = {}) {
    for (const table of [`${baseName}_temp`, baseName]) {
        const rows = [];
        let offset = 0;
        const PAGE = 1000;
        let tableOk = false;
        while (true) {
            try {
                let q = service.from(table).select('*').order(orderBy, { ascending: true })
                    .range(offset, offset + PAGE - 1);
                if (apartmentId) q = q.eq('apartment_id', apartmentId);
                const { data, error } = await q;
                if (error) {
                    if (/does not exist|Could not find|relation|schema cache/i.test(error.message)) break;
                    throw error;
                }
                tableOk = true;
                const page = data || [];
                rows.push(...page);
                if (page.length < PAGE) break;
                offset += PAGE;
            } catch (err) {
                if (/does not exist|Could not find|relation|schema cache/i.test(err.message || '')) break;
                throw err;
            }
        }
        if (tableOk) return { table, rows };
    }
    return { table: null, rows: [] };
}

async function softMigrateCollection({
    db, apartmentId, mongoCol, baseName, mapFn, orderBy,
}) {
    const existing = await db.collection(mongoCol).countDocuments({ apartment_id: apartmentId });
    if (existing > 0) return { migrated: false, count: existing };

    try {
        const { createServiceClient } = await import('../../../../packages/server/serverSupabase.js');
        const service = createServiceClient();
        const migratedAt = nowIso();
        const { table, rows } = await fetchAllFromSupabase(service, baseName, apartmentId, { orderBy });
        const ops = rows
            .filter((r) => r.apartment_id && r.id)
            .map((row) => {
                const doc = mapFn(row, migratedAt);
                return {
                    replaceOne: {
                        filter: { _id: doc._id },
                        replacement: doc,
                        upsert: true,
                    },
                };
            });
        if (ops.length) {
            await db.collection(mongoCol).bulkWrite(ops, { ordered: false });
        }
        return { migrated: ops.length > 0, table, count: ops.length };
    } catch {
        return { migrated: false };
    }
}

export async function maybeMigrateActivityFromSupabase(apartmentId, { db: injected } = {}) {
    const db = injected || await getMongoDb();
    await ensureActivityIndexes(db);
    const [activity, vehicle] = await Promise.all([
        softMigrateCollection({
            db,
            apartmentId,
            mongoCol: COL_ACTIVITY,
            baseName: 'activity_audit_log',
            mapFn: mapActivityRow,
            orderBy: 'created_at',
        }),
        softMigrateCollection({
            db,
            apartmentId,
            mongoCol: COL_VEHICLE,
            baseName: 'vehicle_audit_log',
            mapFn: mapVehicleRow,
            orderBy: 'changed_at',
        }),
    ]);
    return { activity, vehicle };
}

function normalizeActionFilter(action) {
    const a = String(action || '').trim().toUpperCase();
    if (!a) return { activity: '', vehicle: [] };
    // Accept both CREATE and insert-style when filtering parking
    const reverse = Object.entries(VEHICLE_ACTION_MAP)
        .filter(([, v]) => v === a)
        .map(([k]) => k);
    if (['INSERT', 'UPDATE', 'DELETE'].includes(a) && !reverse.length) {
        reverse.push(a.toLowerCase());
    }
    return { activity: a, vehicle: reverse.length ? reverse : [a.toLowerCase()] };
}

export async function listActivityEvents(apartmentId, {
    entityType = '',
    action = '',
    limit = 300,
    db: injected,
} = {}) {
    if (!apartmentId) throw badRequest('apartment_id is required');
    const db = injected || await getMongoDb();
    await ensureActivityIndexes(db);
    // Backfill is `npm run migrate:logs-mongo`. Paging Supabase here used to
    // exceed the 10s function cap when an apartment collection was empty.

    const lim = Math.min(Math.max(Number(limit) || 300, 1), 1000);
    const entity = String(entityType || '').trim().toUpperCase();
    const actionNorm = normalizeActionFilter(action);

    const wantActivity = !entity || entity !== PARKING_ENTITY;
    const wantParking = !entity || entity === PARKING_ENTITY
        || entity === 'VEHICLE'
        || entity === 'PARKING_VIOLATION';

    const fetchCap = lim; // per-source then merge/sort

    const [activityRows, vehicleRows, activityCounts, vehicleCount, activityActions, vehicleActions] = await Promise.all([
        wantActivity
            ? db.collection(COL_ACTIVITY).find({
                apartment_id: apartmentId,
                ...(entity && entity !== PARKING_ENTITY ? { entity_type: entity } : {}),
                ...(actionNorm.activity ? { action: actionNorm.activity } : {}),
            }).sort({ created_at: -1 }).limit(fetchCap).toArray()
            : Promise.resolve([]),
        wantParking
            ? db.collection(COL_VEHICLE).find({
                apartment_id: apartmentId,
                ...(actionNorm.vehicle.length === 1
                    ? { action: actionNorm.vehicle[0] }
                    : actionNorm.vehicle.length
                        ? { action: { $in: actionNorm.vehicle } }
                        : {}),
            }).sort({ changed_at: -1 }).limit(fetchCap).toArray()
            : Promise.resolve([]),
        db.collection(COL_ACTIVITY).aggregate([
            { $match: { apartment_id: apartmentId } },
            { $group: { _id: '$entity_type', count: { $sum: 1 } } },
        ]).toArray(),
        db.collection(COL_VEHICLE).countDocuments({ apartment_id: apartmentId }),
        db.collection(COL_ACTIVITY).distinct('action', { apartment_id: apartmentId }),
        db.collection(COL_VEHICLE).distinct('action', { apartment_id: apartmentId }),
    ]);

    const byEntity = Object.fromEntries(
        (activityCounts || []).filter((c) => c._id).map((c) => [c._id, c.count]),
    );
    const activityTotal = (activityCounts || []).reduce((s, c) => s + (c.count || 0), 0);
    if (vehicleCount > 0) {
        byEntity[PARKING_ENTITY] = vehicleCount;
    }

    const events = [
        ...activityRows.map(publicActivityEvent),
        ...vehicleRows.map(publicVehicleEvent),
    ]
        .filter(Boolean)
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, lim);

    const entityTypes = Object.keys(byEntity).sort();
    const actionSet = new Set();
    for (const a of activityActions || []) {
        if (a) actionSet.add(String(a).toUpperCase());
    }
    for (const a of vehicleActions || []) {
        const mapped = VEHICLE_ACTION_MAP[String(a).toLowerCase()] || String(a).toUpperCase();
        if (mapped) actionSet.add(mapped);
    }

    const total = activityTotal + vehicleCount;
    const oldest = events.length
        ? events.reduce((min, e) => (!min || (e.created_at && e.created_at < min) ? e.created_at : min), null)
        : null;
    const newest = events.length
        ? events.reduce((max, e) => (!max || (e.created_at && e.created_at > max) ? e.created_at : max), null)
        : null;

    return {
        events,
        counts: {
            total,
            by_entity: byEntity,
            activity: activityTotal,
            parking: vehicleCount,
        },
        facets: {
            entity_types: entityTypes,
            actions: [...actionSet].sort(),
        },
        meta: {
            returned: events.length,
            limit: lim,
            window_oldest: oldest,
            window_newest: newest,
            sources: ['activity_audit_log', 'vehicle_audit_log'],
        },
    };
}

export async function insertActivityEvent(payload, { db: injected, user } = {}) {
    const apartmentId = payload.apartment_id;
    if (!apartmentId) throw badRequest('apartment_id is required');
    const entityType = String(payload.entity_type || payload.entityType || '').toUpperCase();
    const entityId = String(payload.entity_id || payload.entityId || '').trim();
    const action = String(payload.action || '').toUpperCase();
    if (!entityType) throw badRequest('entity_type is required');
    if (!entityId) throw badRequest('entity_id is required');
    if (!action) throw badRequest('action is required');

    const db = injected || await getMongoDb();
    await ensureActivityIndexes(db);

    const id = payload.id || randomUUID();
    const created_at = payload.created_at || nowIso();
    const doc = {
        _id: id,
        id,
        apartment_id: apartmentId,
        entity_type: entityType,
        entity_id: entityId,
        action,
        actor_id: payload.actor_id || user?.id || null,
        actor_label: payload.actor_label || user?.email || user?.user_metadata?.full_name || null,
        summary: payload.summary || null,
        old_data: payload.old_data ?? payload.oldData ?? null,
        new_data: payload.new_data ?? payload.newData ?? null,
        review_status: payload.review_status || 'APPROVED',
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        created_at,
        _schema: 'activity_v1',
    };

    await db.collection(COL_ACTIVITY).replaceOne({ _id: id }, doc, { upsert: true });
    return { event: publicActivityEvent(doc) };
}

/**
 * Write parking/vehicle registry audit (classic-compatible vehicle_audit_log shape).
 * Fire-and-forget safe for callers — never throws to the mutation path.
 */
export async function insertVehicleAudit({
    apartmentId,
    action,
    vehicleId = null,
    unitNumber = null,
    plate = null,
    changes = [],
    changedBy = null,
    source = 'ui',
    db: injected,
} = {}) {
    if (!apartmentId || !action) return null;
    const db = injected || await getMongoDb();
    await ensureActivityIndexes(db);
    const id = randomUUID();
    const doc = {
        _id: id,
        id,
        apartment_id: apartmentId,
        vehicle_id: vehicleId || null,
        unit_number: unitNumber || null,
        plate: String(plate || '').trim() || 'unknown',
        action: String(action).toLowerCase(),
        source: source || 'ui',
        changed_at: nowIso(),
        changed_by: changedBy || null,
        changes: Array.isArray(changes) ? changes : [],
        synced_at: null,
        _schema: 'vehicle_audit_v1',
    };
    await db.collection(COL_VEHICLE).replaceOne({ _id: id }, doc, { upsert: true });
    return { id };
}

/** Best-effort society activity write (does not throw). */
export async function safeLogActivity(payload, { user } = {}) {
    try {
        return await insertActivityEvent(payload, { user });
    } catch (err) {
        console.warn('[audit] safeLogActivity', err.message || err);
        return null;
    }
}

/** Best-effort parking audit write (does not throw). */
export async function safeLogVehicleAudit(payload) {
    try {
        return await insertVehicleAudit(payload);
    } catch (err) {
        console.warn('[audit] safeLogVehicleAudit', err.message || err);
        return null;
    }
}

export function filtersFromReq(req) {
    return {
        entityType: getQueryParam(req, 'entity_type') || getQueryParam(req, 'entityType') || '',
        action: getQueryParam(req, 'action') || '',
        limit: getQueryParam(req, 'limit') || 300,
    };
}

export function actorLabelFromUser(user) {
    if (!user) return null;
    return user.email || user.user_metadata?.full_name || user.id || null;
}
