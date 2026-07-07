import { readApiJson } from './apiJson.js';

const API_FETCH_OPTS = { credentials: 'include' };

const APARTMENT_SCOPED_TABLES = new Set([
    'units', 'vehicles', 'transactions', 'society_config', 'parking_slots',
    'expense_vendors', 'expense_sub_categories', 'apartment_bank_accounts', 'staff_members',
    'maintenance_invoices', 'maintenance_payment_allocations', 'maintenance_charge_heads',
    'maintenance_invoice_lines', 'maintenance_penalty_rules', 'maintenance_billing_groups',
    'maintenance_billing_group_units', 'maintenance_billing_batches', 'maintenance_billing_batch_skips',
    'maintenance_reminder_log', 'bank_statement_imports', 'bank_statement_lines', 'bank_classification_rules',
    'resident_user_links', 'payment_intents', 'apartment_payment_config', 'society_notices',
    'resident_portal_invites', 'helpdesk_tickets', 'unit_transitions', 'unit_documents',
    'society_assets', 'asset_service_log', 'amenities', 'amenity_bookings', 'visitor_log',
    'staff_attendance', 'payroll_runs', 'visitor_parking_passes', 'parking_fine_rules',
    'parking_violations', 'chart_of_accounts', 'journal_entries', 'journal_lines', 'email_outbox',
    'gate_parcels', 'visitor_log_units', 'ledger_sync_settings', 'ledger_sync_oauth_apps',
    'user_oauth_connections', 'apartment_external_connections', 'residents', 'activity_audit_log',
    'vehicle_audit_log', 'sms_outbox', 'user_notifications', 'apartment_module_settings',
    'user_module_access', 'society_role_page_access', 'user_page_overrides',
]);

function activeApartmentId() {
    try {
        return globalThis.__portalActiveApartmentId || null;
    } catch {
        return null;
    }
}

export function setActiveApartmentIdForApi(id) {
    globalThis.__portalActiveApartmentId = id || null;
}

async function postDb(query) {
    if (
        APARTMENT_SCOPED_TABLES.has(query.table)
        && !(query.filters || []).some((f) => f.column === 'apartment_id' && f.type === 'eq')
    ) {
        let aptId = activeApartmentId();
        if (!aptId) {
            try {
                const { portalState } = await import('./store.js');
                aptId = portalState.access?.activeApartmentId || null;
            } catch { /* store not ready */ }
        }
        if (aptId) {
            query = {
                ...query,
                filters: [{ type: 'eq', column: 'apartment_id', value: aptId }, ...(query.filters || [])],
            };
        }
    }

    const res = await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...API_FETCH_OPTS,
        body: JSON.stringify(query),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) {
        const msg = json?.error?.message || error || 'Database request failed.';
        return { data: null, error: { message: msg } };
    }
    return { data: json.data ?? null, error: json.error ? { message: json.error.message } : null };
}

class QueryBuilder {
    constructor(table) {
        this.table = table;
        this.op = 'select';
        this.selectCols = '*';
        this.filters = [];
        this.orderClauses = [];
        this.limitVal = null;
        this.payload = null;
        this.upsertOptions = null;
        this.returning = null;
        this.returnSelect = null;
    }

    select(cols) {
        if (this.op === 'select') {
            this.selectCols = cols;
        } else {
            this.returnSelect = cols;
        }
        return this;
    }

    insert(data) {
        this.op = 'insert';
        this.payload = data;
        return this;
    }

    update(data) {
        this.op = 'update';
        this.payload = data;
        return this;
    }

    upsert(data, options) {
        this.op = 'upsert';
        this.payload = data;
        this.upsertOptions = options || null;
        return this;
    }

    delete() {
        this.op = 'delete';
        return this;
    }

    eq(column, value) {
        this.filters.push({ type: 'eq', column, value });
        return this;
    }

    neq(column, value) {
        this.filters.push({ type: 'neq', column, value });
        return this;
    }

    in(column, value) {
        this.filters.push({ type: 'in', column, value });
        return this;
    }

    ilike(column, value) {
        this.filters.push({ type: 'ilike', column, value });
        return this;
    }

    gte(column, value) {
        this.filters.push({ type: 'gte', column, value });
        return this;
    }

    lte(column, value) {
        this.filters.push({ type: 'lte', column, value });
        return this;
    }

    is(column, value) {
        this.filters.push({ type: 'is', column, value });
        return this;
    }

    not(column, operator, value) {
        this.filters.push({ type: 'not', column, operator, value });
        return this;
    }

    order(column, opts = {}) {
        this.orderClauses.push({ column, ascending: opts.ascending !== false });
        return this;
    }

    limit(n) {
        this.limitVal = n;
        return this;
    }

    single() {
        this.returning = 'single';
        return this;
    }

    maybeSingle() {
        this.returning = 'maybeSingle';
        return this;
    }

    toQuery() {
        const q = {
            table: this.table,
            op: this.op,
            filters: this.filters,
        };
        if (this.op === 'select') q.select = this.selectCols;
        if (this.orderClauses.length) q.order = this.orderClauses;
        if (this.limitVal != null) q.limit = this.limitVal;
        if (this.payload != null) q.payload = this.payload;
        if (this.upsertOptions) q.upsertOptions = this.upsertOptions;
        if (this.returning) q.returning = this.returning;
        if (this.returnSelect) q.select = this.returnSelect;
        return q;
    }

    then(onFulfilled, onRejected) {
        return postDb(this.toQuery()).then(onFulfilled, onRejected);
    }

    catch(onRejected) {
        return this.then(null, onRejected);
    }

    finally(onFinally) {
        return this.then(
            (v) => Promise.resolve(onFinally?.()).then(() => v),
            (e) => Promise.resolve(onFinally?.()).then(() => { throw e; }),
        );
    }
}

function from(table) {
    return new QueryBuilder(table);
}

async function rpc(fn, params = {}) {
    const res = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...API_FETCH_OPTS,
        body: JSON.stringify({ fn, params }),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) {
        const msg = json?.error?.message || error || 'RPC request failed.';
        return { data: null, error: { message: msg } };
    }
    return { data: json.data ?? null, error: json.error ? { message: json.error.message } : null };
}

function createStorageBucket(bucket) {
    return {
        async upload(path, file, options = {}) {
            let base64;
            let mimeType = options.contentType || file.type || 'application/octet-stream';

            if (typeof file === 'string') {
                base64 = file;
            } else if (file instanceof Blob) {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(new Error('Could not read file.'));
                    reader.readAsDataURL(file);
                });
                base64 = String(dataUrl).split(',')[1] || '';
            } else {
                throw new Error('Unsupported upload payload.');
            }

            const res = await fetch('/api/storage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                ...API_FETCH_OPTS,
                body: JSON.stringify({
                    action: 'upload',
                    bucket,
                    path,
                    base64,
                    mimeType,
                    upsert: options.upsert !== false,
                }),
            });
            const { ok, json, error } = await readApiJson(res);
            if (!ok) return { data: null, error: { message: json?.error || error || 'Upload failed.' } };
            return { data: { path: json.path }, error: null };
        },

        async remove(paths) {
            const res = await fetch('/api/storage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                ...API_FETCH_OPTS,
                body: JSON.stringify({ action: 'remove', bucket, paths }),
            });
            const { ok, json, error } = await readApiJson(res);
            if (!ok) return { data: null, error: { message: json?.error || error || 'Remove failed.' } };
            return { data: json, error: null };
        },

        async createSignedUrl(path, expiresIn = 3600) {
            const res = await fetch('/api/storage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                ...API_FETCH_OPTS,
                body: JSON.stringify({ action: 'createSignedUrl', bucket, path, expiresIn }),
            });
            const { ok, json, error } = await readApiJson(res);
            if (!ok) return { data: null, error: { message: json?.error || error || 'Signed URL failed.' } };
            return { data: { signedUrl: json.signedUrl }, error: null };
        },
    };
}

/**
 * Wrap the real Supabase client so auth stays client-side while DB/storage/RPC route through API.
 */
export function createApiSupabaseClient(realClient) {
    if (!realClient) return null;

    return {
        auth: realClient.auth,
        from,
        rpc,
        storage: {
            from: createStorageBucket,
        },
    };
}

export async function fetchApartmentState(apartmentId, domain = 'core') {
    const params = new URLSearchParams({
        apartment_id: apartmentId,
        domain,
    });
    const res = await fetch(`/api/state?${params}`, {
        method: 'GET',
        ...API_FETCH_OPTS,
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json?.error || error || 'State load failed.');
    return json.state;
}

export async function proxyExternalRequest(url, init = {}) {
    const res = await fetch('/api/external-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...API_FETCH_OPTS,
        body: JSON.stringify({
            url,
            method: init.method || 'GET',
            headers: init.headers || {},
            body: init.body,
            contentType: init.headers?.['Content-Type'] || init.headers?.['content-type'] || null,
        }),
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json?.error || error || 'External request failed.');
    return {
        ok: json.ok,
        status: json.status,
        text: json.text,
        json: json.json,
        async json() {
            if (json.json != null) return json.json;
            try {
                return JSON.parse(json.text || '{}');
            } catch {
                return {};
            }
        },
    };
}
