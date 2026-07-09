import { authHeaderFromRequest, requireSession, userHasPermission } from './serverAuth.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';
import { requireAccountsEditor } from './accountsAuth.js';

/** Tables that carry an apartment_id column and require membership checks. */
export const APARTMENT_SCOPED_TABLES = new Set([
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
    'gate_parcels', 'visitor_log_units', 'ledger_sync_settings', 'ledger_sync_runs',
    'ledger_sync_oauth_apps',
    'user_oauth_connections', 'apartment_external_connections', 'residents', 'activity_audit_log',
    'vehicle_audit_log', 'sms_outbox', 'user_notifications', 'apartment_module_settings',
    'user_module_access', 'society_role_page_access', 'user_page_overrides',
]);

export const ALLOWED_TABLES = new Set([
    ...APARTMENT_SCOPED_TABLES,
    'apartments', 'profiles', 'user_apartments', 'user_role_assignments', 'notice_read_log',
    'permissions', 'role_permissions',
    'ledger_sync_run_logs', 'ledger_sync_run_changes',
    'access_requests',
]);

const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete']);

const TABLE_WRITE_PERMISSION = {
    transactions: 'accounts.edit',
    maintenance_invoices: 'accounts.edit',
    maintenance_payment_allocations: 'accounts.edit',
    maintenance_charge_heads: 'accounts.edit',
    maintenance_invoice_lines: 'accounts.edit',
    maintenance_penalty_rules: 'accounts.edit',
    maintenance_billing_groups: 'accounts.edit',
    maintenance_billing_group_units: 'accounts.edit',
    maintenance_billing_batches: 'accounts.edit',
    maintenance_billing_batch_skips: 'accounts.edit',
    maintenance_reminder_log: 'accounts.edit',
    bank_statement_imports: 'accounts.edit',
    bank_statement_lines: 'accounts.edit',
    bank_classification_rules: 'accounts.edit',
    expense_vendors: 'accounts.edit',
    expense_sub_categories: 'accounts.edit',
    apartment_bank_accounts: 'accounts.edit',
    chart_of_accounts: 'accounts.edit',
    journal_entries: 'accounts.edit',
    journal_lines: 'accounts.edit',
    ledger_sync_settings: 'accounts.edit',
    ledger_sync_runs: 'accounts.edit',
    ledger_sync_run_logs: 'accounts.edit',
    ledger_sync_run_changes: 'accounts.edit',
    ledger_sync_oauth_apps: 'accounts.edit',
    user_oauth_connections: 'accounts.edit',
    apartment_external_connections: 'accounts.edit',
    apartments: 'rbac.view',
    user_role_assignments: 'rbac.view',
    society_role_page_access: 'rbac.view',
    user_page_overrides: 'rbac.view',
    apartment_module_settings: 'rbac.view',
    user_module_access: 'rbac.view',
};

function logDbOp({ userId, table, op, apartmentId, ms, error }) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/db',
        userId,
        table,
        op,
        apartmentId: apartmentId || null,
        ms,
        ok: !error,
        error: error || null,
    }));
}

export function extractApartmentId(query) {
    const fromFilters = (query.filters || []).find((f) => f.column === 'apartment_id' && f.type === 'eq');
    if (fromFilters?.value) return fromFilters.value;

    const payload = query.payload;
    if (Array.isArray(payload)) {
        const row = payload.find((r) => r?.apartment_id);
        if (row?.apartment_id) return row.apartment_id;
    } else if (payload?.apartment_id) {
        return payload.apartment_id;
    }
    return query.apartment_id || null;
}

function extractRunId(query) {
    const fromFilters = (query.filters || []).find((f) => f.column === 'run_id' && f.type === 'eq');
    if (fromFilters?.value) return fromFilters.value;

    const payload = query.payload;
    if (Array.isArray(payload)) {
        const row = payload.find((r) => r?.run_id);
        if (row?.run_id) return row.run_id;
    } else if (payload?.run_id) {
        return payload.run_id;
    }
    return null;
}

async function verifyLedgerSyncRunAccess(service, user, runId) {
    if (!runId) {
        throw Object.assign(new Error('run_id scope required for this table.'), { status: 400 });
    }
    const { data: run, error } = await service
        .from('ledger_sync_runs')
        .select('apartment_id')
        .eq('id', runId)
        .maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    if (!run) throw Object.assign(new Error('Sync run not found.'), { status: 404 });

    const { data: mapping, error: mapErr } = await service
        .from('user_apartments')
        .select('apartment_id')
        .eq('user_id', user.id)
        .eq('apartment_id', run.apartment_id)
        .maybeSingle();
    if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
    if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });
    return run.apartment_id;
}

async function resolveService(req, apartmentId, permissionKey) {
    const { user, authHeader } = await requireSession(req);
    try {
        const service = createServiceClient();
        return { user, service, authHeader };
    } catch (err) {
        if (!/SUPABASE_SERVICE_ROLE_KEY/i.test(err?.message || '')) throw err;
        if (permissionKey !== 'accounts.edit' || !apartmentId) throw err;
        const fallback = await requireAccountsEditor(authHeaderFromRequest(req), apartmentId);
        return {
            user: fallback.user,
            service: createUserClient(fallback.authHeader),
            authHeader: fallback.authHeader,
        };
    }
}

export async function authorizeDbQuery(req, query) {
    if (!ALLOWED_TABLES.has(query.table)) {
        throw Object.assign(new Error(`Table not allowed: ${query.table}`), { status: 403 });
    }

    const op = query.op || 'select';
    if (!['select', 'insert', 'update', 'upsert', 'delete'].includes(op)) {
        throw Object.assign(new Error(`Operation not allowed: ${op}`), { status: 400 });
    }

    const apartmentId = extractApartmentId(query);
    const isApartmentScoped = APARTMENT_SCOPED_TABLES.has(query.table);
    const permissionKey = WRITE_OPS.has(op)
        ? (TABLE_WRITE_PERMISSION[query.table] || 'apartment_mgmt.edit')
        : null;

    const { user, service } = await resolveService(req, apartmentId, permissionKey || 'accounts.edit');

    if (query.table === 'access_requests') {
        const payload = Array.isArray(query.payload) ? query.payload[0] : query.payload;
        const userIdFilter = (query.filters || []).find((f) => f.column === 'user_id' && f.type === 'eq')?.value;

        if (op === 'insert') {
            if (payload?.user_id !== user.id) {
                throw Object.assign(new Error('Not permitted.'), { status: 403 });
            }
            return { user, service, apartmentId: payload?.apartment_id || apartmentId };
        }

        if (op === 'select' && userIdFilter === user.id) {
            return { user, service, apartmentId };
        }

        if ((op === 'select' || op === 'update') && apartmentId) {
            const allowed = await userHasPermission(service, user.id, apartmentId, 'rbac.view');
            const { data: prof } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
            if (!allowed && prof?.role !== 'admin') {
                throw Object.assign(new Error('Not permitted.'), { status: 403 });
            }
            return { user, service, apartmentId };
        }

        throw Object.assign(new Error('Not permitted.'), { status: 403 });
    }

    if (isApartmentScoped && apartmentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(apartmentId)) {
        throw Object.assign(new Error('Invalid apartment_id scope.'), { status: 400 });
    }

    if (isApartmentScoped && apartmentId) {
        const { data: mapping, error: mapErr } = await service
            .from('user_apartments')
            .select('apartment_id')
            .eq('user_id', user.id)
            .eq('apartment_id', apartmentId)
            .maybeSingle();
        if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
        if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });
    } else if (isApartmentScoped && !apartmentId) {
        throw Object.assign(new Error('apartment_id scope required for this table.'), { status: 400 });
    }

    if (query.table === 'ledger_sync_run_logs' || query.table === 'ledger_sync_run_changes') {
        await verifyLedgerSyncRunAccess(service, user, extractRunId(query));
    }

    if (WRITE_OPS.has(op) && permissionKey) {
        const allowed = apartmentId
            ? await userHasPermission(service, user.id, apartmentId, permissionKey)
            : await userHasPermission(service, user.id, user.id, permissionKey);
        if (!allowed && permissionKey === 'rbac.view') {
            const { data: prof } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
            if (prof?.role !== 'admin') {
                throw Object.assign(new Error('Not permitted.'), { status: 403 });
            }
        } else if (!allowed && permissionKey !== 'rbac.view') {
            const { data: prof } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
            const v1 = prof?.role || 'resident_viewer';
            const v1Ok = permissionKey === 'accounts.edit'
                ? ['admin', 'accounts_manager'].includes(v1)
                : v1 === 'admin';
            if (!v1Ok) throw Object.assign(new Error('Not permitted.'), { status: 403 });
        }
    }

    if (query.table === 'notice_read_log' && WRITE_OPS.has(op)) {
        const payload = Array.isArray(query.payload) ? query.payload[0] : query.payload;
        if (payload?.user_id && payload.user_id !== user.id) {
            throw Object.assign(new Error('Not permitted.'), { status: 403 });
        }
    }

    if (query.table === 'profiles' && WRITE_OPS.has(op)) {
        const targetId = (query.filters || []).find((f) => f.column === 'id')?.value;
        if (targetId && targetId !== user.id) {
            const allowed = apartmentId
                ? await userHasPermission(service, user.id, apartmentId, 'rbac.view')
                : false;
            const { data: prof } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();
            if (!allowed && prof?.role !== 'admin') {
                throw Object.assign(new Error('Not permitted.'), { status: 403 });
            }
        }
    }

    return { user, service, apartmentId };
}

function applyFilters(builder, filters = []) {
    let q = builder;
    for (const f of filters) {
        if (f.type === 'eq') q = q.eq(f.column, f.value);
        else if (f.type === 'neq') q = q.neq(f.column, f.value);
        else if (f.type === 'in') q = q.in(f.column, f.value);
        else if (f.type === 'ilike') q = q.ilike(f.column, f.value);
        else if (f.type === 'gte') q = q.gte(f.column, f.value);
        else if (f.type === 'lte') q = q.lte(f.column, f.value);
        else if (f.type === 'is') q = q.is(f.column, f.value);
        else if (f.type === 'not') q = q.not(f.column, f.operator, f.value);
    }
    return q;
}

export async function executeDbQuery(service, query) {
    const table = query.table;
    const op = query.op || 'select';
    const filters = query.filters || [];
    const order = query.order || [];
    const selectCols = query.select ?? '*';

    if (op === 'select') {
        let q = service.from(table).select(selectCols);
        q = applyFilters(q, filters);
        for (const o of order) {
            q = q.order(o.column, { ascending: o.ascending !== false });
        }
        if (query.limit) q = q.limit(query.limit);

        if (query.returning === 'single') return q.single();
        if (query.returning === 'maybeSingle') return q.maybeSingle();
        return q;
    }

    if (op === 'insert') {
        let q = service.from(table).insert(query.payload);
        if (query.select) q = q.select(query.select);
        if (query.returning === 'single') return q.single();
        if (query.returning === 'maybeSingle') return q.maybeSingle();
        return q;
    }

    if (op === 'update') {
        let q = service.from(table).update(query.payload);
        q = applyFilters(q, filters);
        if (query.select) q = q.select(query.select);
        if (query.returning === 'single') return q.single();
        if (query.returning === 'maybeSingle') return q.maybeSingle();
        return q;
    }

    if (op === 'upsert') {
        const opts = query.upsertOptions || {};
        let q = service.from(table).upsert(query.payload, opts.onConflict ? { onConflict: opts.onConflict } : undefined);
        if (query.select) q = q.select(query.select);
        if (query.returning === 'single') return q.single();
        if (query.returning === 'maybeSingle') return q.maybeSingle();
        return q;
    }

    if (op === 'delete') {
        let q = service.from(table).delete();
        q = applyFilters(q, filters);
        return q;
    }

    throw Object.assign(new Error(`Unsupported operation: ${op}`), { status: 400 });
}

export async function runDbQuery(req, query) {
    const started = Date.now();
    let userId = null;
    try {
        const auth = await authorizeDbQuery(req, query);
        userId = auth.user.id;
        const result = await executeDbQuery(auth.service, query);
        logDbOp({
            userId,
            table: query.table,
            op: query.op,
            apartmentId: auth.apartmentId,
            ms: Date.now() - started,
        });
        return result;
    } catch (err) {
        logDbOp({
            userId,
            table: query?.table,
            op: query?.op,
            apartmentId: extractApartmentId(query || {}),
            ms: Date.now() - started,
            error: err.message,
        });
        throw err;
    }
}
