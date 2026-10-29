const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a UUID path/query param — throws 400 on malformed values. */
export function assertUuid(value, label = 'id') {
    const s = String(value ?? '').trim();
    if (!UUID_RE.test(s)) {
        throw Object.assign(new Error(`Invalid ${label}. Select a society and try again.`), { status: 400 });
    }
    return s;
}
