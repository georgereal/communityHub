import { requireSession } from './serverAuth.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';
import { assertUuid } from './supabaseRest.js';
import { getQueryParam } from './vercelRequest.js';

function logState(userId, apartmentId, ms, error) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/state',
        userId,
        apartmentId,
        ms,
        ok: !error,
        error: error || null,
    }));
}

async function getService(req) {
    const { authHeader } = await requireSession(req);
    try {
        return createServiceClient();
    } catch {
        return createUserClient(authHeader);
    }
}

export async function fetchApartmentState(service, apartmentId, userId) {
    const uid = userId || '00000000-0000-0000-0000-000000000000';

    const queries = [
        service.from('units').select('*').eq('apartment_id', apartmentId).order('number'),
        service.from('vehicles').select('*').eq('apartment_id', apartmentId),
        service.from('transactions').select('*').eq('apartment_id', apartmentId).order('date', { ascending: false }),
        service.from('society_config').select('*').eq('apartment_id', apartmentId).maybeSingle(),
        service.from('parking_slots').select('*').eq('apartment_id', apartmentId).order('name'),
        service.from('expense_vendors').select('*').eq('apartment_id', apartmentId).order('last_used_at', { ascending: false }),
        service.from('expense_sub_categories').select('*').eq('apartment_id', apartmentId).order('last_used_at', { ascending: false }),
        service.from('apartment_bank_accounts').select('*').eq('apartment_id', apartmentId).maybeSingle(),
        service.from('staff_members').select('*').eq('apartment_id', apartmentId).order('full_name'),
        service.from('maintenance_invoices').select('*').eq('apartment_id', apartmentId).order('due_date'),
        service.from('maintenance_payment_allocations').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_charge_heads').select('*').eq('apartment_id', apartmentId).order('sort_order'),
        service.from('maintenance_invoice_lines').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_penalty_rules').select('*').eq('apartment_id', apartmentId).order('sort_order'),
        service.from('maintenance_billing_groups').select('*').eq('apartment_id', apartmentId).order('sort_order'),
        service.from('maintenance_billing_group_units').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_billing_batches').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('maintenance_billing_batch_skips').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_reminder_log').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('bank_statement_imports').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('bank_statement_lines').select('*').eq('apartment_id', apartmentId).order('line_date', { ascending: true }).order('line_order', { ascending: true }).order('source_row_index', { ascending: true }),
        service.from('bank_classification_rules').select('*').eq('apartment_id', apartmentId).order('priority', { ascending: false }).order('created_at', { ascending: true }),
        service.from('resident_user_links').select('*').eq('apartment_id', apartmentId),
        service.from('payment_intents').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('apartment_payment_config').select('*').eq('apartment_id', apartmentId).maybeSingle(),
        service.from('society_notices').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        userId
            ? service.from('notice_read_log').select('*').eq('user_id', uid)
            : Promise.resolve({ data: [], error: null }),
        service.from('resident_portal_invites').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('helpdesk_tickets').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('unit_transitions').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('unit_documents').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('society_assets').select('*').eq('apartment_id', apartmentId).order('name'),
        service.from('asset_service_log').select('*').eq('apartment_id', apartmentId).order('service_date', { ascending: false }),
        service.from('amenities').select('*').eq('apartment_id', apartmentId).order('name'),
        service.from('amenity_bookings').select('*').eq('apartment_id', apartmentId).order('starts_at', { ascending: false }),
        service.from('visitor_log').select('*').eq('apartment_id', apartmentId).order('entry_at', { ascending: false }),
        service.from('staff_attendance').select('*').eq('apartment_id', apartmentId).order('work_date', { ascending: false }),
        service.from('payroll_runs').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('visitor_parking_passes').select('*').eq('apartment_id', apartmentId).order('valid_until', { ascending: false }),
        service.from('parking_fine_rules').select('*').eq('apartment_id', apartmentId).order('name'),
        service.from('parking_violations').select('*').eq('apartment_id', apartmentId).order('violation_date', { ascending: false }),
        service.from('chart_of_accounts').select('*').eq('apartment_id', apartmentId).order('code'),
        service.from('journal_entries').select('*').eq('apartment_id', apartmentId).order('entry_date', { ascending: false }),
        service.from('journal_lines').select('*').eq('apartment_id', apartmentId),
        service.from('email_outbox').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('gate_parcels').select('*').eq('apartment_id', apartmentId).order('received_at', { ascending: false }),
        service.from('visitor_log_units').select('*').eq('apartment_id', apartmentId),
        service.from('ledger_sync_settings').select('*').eq('apartment_id', apartmentId).maybeSingle(),
        service.from('ledger_sync_oauth_apps').select('id, apartment_id, provider, client_id, tenant_id, redirect_uri, enabled, client_secret_set, updated_at').eq('apartment_id', apartmentId),
        service.from('user_oauth_connections').select('id, provider, account_email, token_expires_at, connected_at, provider_account_id, account_meta').eq('apartment_id', apartmentId).eq('user_id', uid),
        service.rpc('get_ledger_sync_service_status', { p_apartment_id: apartmentId }),
        service.from('apartment_external_connections').select('id, apartment_id, provider, connection_key, display_name, base_url, client_id, workflow_id, enabled, api_key_set, updated_at').eq('apartment_id', apartmentId),
    ];

    const results = await Promise.all(queries);
    const [
        u, v, t, s, p, ev, esc, bank, staff, mi, ma, mch, mil, mpr, mbg, mbgu, mbb, mbbs, mrl, bsi, bsl, bcr,
        rul, pi, pc, sn, nrl, rpi, hd, ut, ud, sa, asl, am, ab, vl, att, pr,
        vpp, pfr, pv, coa, je, jl, em, gp, vlu, lss, loa, uoc, ssa, aec,
    ] = results;

    const units = u.error ? [] : (u.data || []);
    const vehicles = v.error ? [] : (v.data || []);

    return {
        errors: results.filter((r) => r.error).map((r) => r.error.message),
        community: s.data ? {
            name: s.data.name,
            defaults: { cars: s.data.car_default, bikes: s.data.bike_default },
            configId: s.data.id,
        } : { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null },
        units: units.map((unit) => ({
            ...unit,
            vehicles: vehicles.filter((veh) => veh.unit_id == unit.id),
        })),
        slots: (p.data || []).map((slot) => {
            const vMatch = vehicles.find((veh) => veh.id === slot.assigned_vehicle_id);
            return {
                ...slot,
                occupant: vMatch ? vMatch.plate : null,
                unit_num: vMatch ? units.find((ux) => ux.id === vMatch.unit_id)?.number : null,
            };
        }),
        finances: {
            txns: t.data || [],
            vendors: ev.error ? [] : (ev.data || []),
            subCategories: esc.error ? [] : (esc.data || []),
            maintenanceInvoices: mi.error ? [] : (mi.data || []),
            maintenanceAllocations: ma.error ? [] : (ma.data || []),
            maintenanceChargeHeads: mch.error ? [] : (mch.data || []),
            maintenanceInvoiceLines: mil.error ? [] : (mil.data || []),
            maintenancePenaltyRules: mpr.error ? [] : (mpr.data || []),
            maintenanceBillingGroups: mbg.error ? [] : (mbg.data || []),
            maintenanceBillingGroupUnits: mbgu.error ? [] : (mbgu.data || []),
            maintenanceBillingBatches: mbb.error ? [] : (mbb.data || []),
            maintenanceBillingBatchSkips: mbbs.error ? [] : (mbbs.data || []),
            maintenanceReminderLog: mrl.error ? [] : (mrl.data || []),
            bankStatementImports: bsi.error ? [] : (bsi.data || []),
            bankStatementLines: bsl.error ? [] : (bsl.data || []),
            bankClassificationRules: bcr.error ? [] : (bcr.data || []),
            ledgerSyncSettings: lss.error ? null : (lss.data || null),
            ledgerOAuthApps: loa.error ? [] : (loa.data || []),
            myOAuthConnections: uoc.error ? [] : (uoc.data || []),
            syncServiceAccounts: ssa.error ? [] : (ssa.data || []),
        },
        admin: {
            bankAccount: bank.error ? null : (bank.data || null),
            staff: staff.error ? [] : (staff.data || []),
            externalConnections: aec.error ? [] : (aec.data || []),
        },
        portal: {
            residentLinks: rul.error ? [] : (rul.data || []),
            portalInvites: rpi.error ? [] : (rpi.data || []),
            paymentIntents: pi.error ? [] : (pi.data || []),
            paymentConfig: pc.error ? null : (pc.data || null),
            notices: sn.error ? [] : (sn.data || []),
            noticeReadLog: nrl.error ? [] : (nrl.data || []),
        },
        operations: {
            helpdeskTickets: hd.error ? [] : (hd.data || []),
            unitTransitions: ut.error ? [] : (ut.data || []),
            unitDocuments: ud.error ? [] : (ud.data || []),
            societyAssets: sa.error ? [] : (sa.data || []),
            assetServiceLog: asl.error ? [] : (asl.data || []),
            amenities: am.error ? [] : (am.data || []),
            amenityBookings: ab.error ? [] : (ab.data || []),
            visitorLog: vl.error ? [] : (vl.data || []),
            visitorLogUnits: vlu.error ? [] : (vlu.data || []),
            gateParcels: gp.error ? [] : (gp.data || []),
            staffAttendance: att.error ? [] : (att.data || []),
            payrollRuns: pr.error ? [] : (pr.data || []),
        },
        parking: {
            visitorPasses: vpp.error ? [] : (vpp.data || []),
            fineRules: pfr.error ? [] : (pfr.data || []),
            violations: pv.error ? [] : (pv.data || []),
        },
        ledger: {
            accounts: coa.error ? [] : (coa.data || []),
            entries: je.error ? [] : (je.data || []),
            lines: jl.error ? [] : (jl.data || []),
        },
        email: {
            outbox: em.error ? [] : (em.data || []),
        },
        meta: {
            apartmentId,
            unitCount: units.length,
            vehicleCount: vehicles.length,
            unitsError: u.error?.message || null,
            at: new Date().toISOString(),
        },
    };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const started = Date.now();
    let userId = null;
    let apartmentId = null;

    try {
        apartmentId = assertUuid(getQueryParam(req, 'apartment_id'), 'apartment_id');
        const { user } = await requireSession(req);
        userId = user.id;

        const service = await getService(req);

        const { data: mapping, error: mapErr } = await service
            .from('user_apartments')
            .select('apartment_id')
            .eq('user_id', user.id)
            .eq('apartment_id', apartmentId)
            .maybeSingle();
        if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
        if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });

        const state = await fetchApartmentState(service, apartmentId, user.id);
        logState(userId, apartmentId, Date.now() - started);
        return res.status(200).json({ ok: true, state });
    } catch (err) {
        logState(userId, apartmentId, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'State load failed.' });
    }
}
