/**
 * Structured logs for Mongo REST APIs (property + finance).
 */
export function logMongoApi({
    method,
    path,
    op = null,
    collection = null,
    userId = null,
    apartmentId = null,
    ms = 0,
    error = null,
    extra = null,
    layer = null,
} = {}) {
    const row = {
        ts: new Date().toISOString(),
        layer: layer
            || (String(path || '').startsWith('/api/property') ? 'api/property' : null)
            || (String(path || '').startsWith('/api/finance') ? 'api/finance' : null)
            || 'api/mongo',
        method: method || null,
        path: path || null,
        op: op || null,
        collection: collection || null,
        userId: userId || null,
        apartmentId: apartmentId || null,
        ms,
        ok: !error,
        error: error || null,
    };
    if (extra && typeof extra === 'object') Object.assign(row, extra);
    console.log(JSON.stringify(row));
}
