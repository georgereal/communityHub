const INDEXED = new WeakSet();

/** Unique only when Evolyx has assigned a real execution_id (nulls must not collide). */
const PASSBOOK_EXECUTION_INDEX = {
    key: { execution_id: 1 },
    unique: true,
    name: 'uq_passbook_jobs_execution',
    partialFilterExpression: {
        execution_id: { $type: 'string', $gt: '' },
    },
};

export async function ensureIntegrationsIndexes(db) {
    if (INDEXED.has(db)) return;

    const jobs = db.collection('passbook_ocr_jobs');
    try {
        const existing = await jobs.indexExists('uq_passbook_jobs_execution');
        if (existing) {
            // Drop legacy sparse unique (indexes null) so we can recreate as partial.
            const info = await jobs.indexInformation({ full: true });
            const spec = (info || []).find((i) => i.name === 'uq_passbook_jobs_execution');
            const isPartial = Boolean(spec?.partialFilterExpression);
            if (!isPartial) {
                await jobs.dropIndex('uq_passbook_jobs_execution');
            }
        }
    } catch {
        // index may not exist yet
    }

    await Promise.all([
        db.collection('external_connections').createIndexes([
            {
                key: { apartment_id: 1, provider: 1, connection_key: 1 },
                unique: true,
                name: 'uq_external_connections_apartment_provider_key',
            },
            { key: { apartment_id: 1, provider: 1 }, name: 'idx_external_connections_apartment_provider' },
        ]),
        jobs.createIndexes([
            { key: { apartment_id: 1, created_at: -1 }, name: 'idx_passbook_jobs_apartment_created' },
            PASSBOOK_EXECUTION_INDEX,
            { key: { id: 1 }, unique: true, name: 'uq_passbook_jobs_id' },
        ]),
    ]);
    INDEXED.add(db);
}
