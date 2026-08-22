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
        db.collection('ledger_sync_settings').createIndexes([
            { key: { apartment_id: 1 }, unique: true, name: 'uq_ledger_sync_settings_apartment' },
        ]),
        db.collection('ledger_sync_oauth_apps').createIndexes([
            {
                key: { apartment_id: 1, provider: 1 },
                unique: true,
                name: 'uq_ledger_sync_oauth_apps_apartment_provider',
            },
        ]),
        db.collection('user_oauth_connections').createIndexes([
            {
                key: { user_id: 1, apartment_id: 1, provider: 1 },
                unique: true,
                name: 'uq_user_oauth_connections_user_apt_provider',
            },
            { key: { apartment_id: 1, provider: 1 }, name: 'idx_user_oauth_connections_apartment_provider' },
        ]),
        db.collection('ledger_sync_service_accounts').createIndexes([
            {
                key: { apartment_id: 1, provider: 1 },
                unique: true,
                name: 'uq_ledger_sync_service_accounts_apartment_provider',
            },
        ]),
        db.collection('ledger_sync_runs').createIndexes([
            { key: { apartment_id: 1, started_at: -1 }, name: 'idx_ledger_sync_runs_apartment_started' },
            { key: { id: 1 }, unique: true, name: 'uq_ledger_sync_runs_id' },
        ]),
    ]);
    INDEXED.add(db);
}
