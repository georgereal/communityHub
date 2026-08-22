const INDEXED = new WeakSet();

export const COL_ACTIVITY = 'activity_audit_log';
export const COL_VEHICLE = 'vehicle_audit_log';

export async function ensureActivityIndexes(db) {
    if (INDEXED.has(db)) return;
    await Promise.all([
        db.collection(COL_ACTIVITY).createIndexes([
            { key: { apartment_id: 1, created_at: -1 }, name: 'idx_activity_apartment_created' },
            { key: { apartment_id: 1, entity_type: 1, created_at: -1 }, name: 'idx_activity_apartment_entity' },
            { key: { id: 1 }, unique: true, name: 'uq_activity_id' },
        ]),
        db.collection(COL_VEHICLE).createIndexes([
            { key: { apartment_id: 1, changed_at: -1 }, name: 'idx_vehicle_audit_apartment_changed' },
            { key: { id: 1 }, unique: true, name: 'uq_vehicle_audit_id' },
        ]),
    ]);
    INDEXED.add(db);
}
