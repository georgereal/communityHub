/**
 * Sentry Cloud Store (Relational)
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/** Reject hung Supabase calls so boot UI does not spin forever. */
export const withTimeout = (promise, ms, label = 'Request') => Promise.race([
    promise,
    new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
]);

export let portalState = {
    units: [],
    slots: [], // Shared Community Slots
    finances: { txns: [], vendors: [], subCategories: [], maintenanceInvoices: [], maintenanceAllocations: [], maintenanceChargeHeads: [], maintenanceInvoiceLines: [], maintenancePenaltyRules: [], maintenanceBillingGroups: [], maintenanceBillingGroupUnits: [], maintenanceBillingBatches: [], maintenanceBillingBatchSkips: [], maintenanceReminderLog: [], bankStatementImports: [], bankStatementLines: [], ledgerSyncSettings: null, ledgerOAuthApps: [], myOAuthConnections: [], syncServiceAccounts: [] },
    community: { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null },
    access: {
        apartments: [{ id: 'apt-default', name: 'CommunityHub' }],
        users: [{ id: 'usr-default', name: 'Property Lead', email: '', apartment_ids: ['apt-default'] }],
        activeApartmentId: 'apt-default',
        activeUserId: 'usr-default'
    },
    admin: { bankAccount: null, staff: [] },
    portal: {
        residentLinks: [],
        portalInvites: [],
        paymentIntents: [],
        paymentConfig: null,
        notices: [],
        noticeReadLog: [],
    },
    operations: {
        helpdeskTickets: [],
        unitTransitions: [],
        unitDocuments: [],
        societyAssets: [],
        assetServiceLog: [],
        amenities: [],
        amenityBookings: [],
        visitorLog: [],
        visitorLogUnits: [],
        gateParcels: [],
        staffAttendance: [],
        payrollRuns: [],
    },
    parking: {
        visitorPasses: [],
        fineRules: [],
        violations: [],
    },
    ledger: {
        accounts: [],
        entries: [],
        lines: [],
    },
    email: {
        outbox: [],
    },
    moduleAccess: {
        apartment: {},
        user: {},
    },
    activeUnitId: null,
    editingTxnId: null,
    notifications: { items: [], unreadCount: 0 },
};

/**
 * Platinum Cloud Pull: Deep-fetch all relational partitions
 */
export const pullState = async () => {
    if (!supabase) return false;
    try {
        const activeApartmentId = portalState.access?.activeApartmentId;
        if (!activeApartmentId) throw new Error('No active apartment selected');
        if (isPlaceholderApartmentId(activeApartmentId)) {
            console.warn('[pullState] Refusing to load placeholder apartment id:', activeApartmentId);
            return false;
        }
        console.group('[Store] Pulling state for:', activeApartmentId);

        const { data: { user } } = await supabase.auth.getUser();
        const uid = user?.id;

        console.log('Running parallel queries...');
        const queriesPromise = Promise.all([
            supabase.from('units').select('*').eq('apartment_id', activeApartmentId).order('number'),
            supabase.from('vehicles').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('transactions').select('*').eq('apartment_id', activeApartmentId).order('date', { ascending: false }),
            supabase.from('society_config').select('*').eq('apartment_id', activeApartmentId).maybeSingle(),
            supabase.from('parking_slots').select('*').eq('apartment_id', activeApartmentId).order('name'),
            supabase.from('expense_vendors').select('*').eq('apartment_id', activeApartmentId).order('last_used_at', { ascending: false }),
            supabase.from('expense_sub_categories').select('*').eq('apartment_id', activeApartmentId).order('last_used_at', { ascending: false }),
            supabase.from('apartment_bank_accounts').select('*').eq('apartment_id', activeApartmentId).maybeSingle(),
            supabase.from('staff_members').select('*').eq('apartment_id', activeApartmentId).order('full_name'),
            supabase.from('maintenance_invoices').select('*').eq('apartment_id', activeApartmentId).order('due_date'),
            supabase.from('maintenance_payment_allocations').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_charge_heads').select('*').eq('apartment_id', activeApartmentId).order('sort_order'),
            supabase.from('maintenance_invoice_lines').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_penalty_rules').select('*').eq('apartment_id', activeApartmentId).order('sort_order'),
            supabase.from('maintenance_billing_groups').select('*').eq('apartment_id', activeApartmentId).order('sort_order'),
            supabase.from('maintenance_billing_group_units').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_billing_batches').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('maintenance_billing_batch_skips').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_reminder_log').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('bank_statement_imports').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('bank_statement_lines').select('*').eq('apartment_id', activeApartmentId).order('line_date', { ascending: false }),
            supabase.from('resident_user_links').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('payment_intents').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('apartment_payment_config').select('*').eq('apartment_id', activeApartmentId).maybeSingle(),
            supabase.from('society_notices').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            uid
                ? supabase.from('notice_read_log').select('*').eq('user_id', uid)
                : Promise.resolve({ data: [], error: null }),
            supabase.from('resident_portal_invites').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('helpdesk_tickets').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('unit_transitions').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('unit_documents').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('society_assets').select('*').eq('apartment_id', activeApartmentId).order('name'),
            supabase.from('asset_service_log').select('*').eq('apartment_id', activeApartmentId).order('service_date', { ascending: false }),
            supabase.from('amenities').select('*').eq('apartment_id', activeApartmentId).order('name'),
            supabase.from('amenity_bookings').select('*').eq('apartment_id', activeApartmentId).order('starts_at', { ascending: false }),
            supabase.from('visitor_log').select('*').eq('apartment_id', activeApartmentId).order('entry_at', { ascending: false }),
            supabase.from('staff_attendance').select('*').eq('apartment_id', activeApartmentId).order('work_date', { ascending: false }),
            supabase.from('payroll_runs').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('visitor_parking_passes').select('*').eq('apartment_id', activeApartmentId).order('valid_until', { ascending: false }),
            supabase.from('parking_fine_rules').select('*').eq('apartment_id', activeApartmentId).order('name'),
            supabase.from('parking_violations').select('*').eq('apartment_id', activeApartmentId).order('violation_date', { ascending: false }),
            supabase.from('chart_of_accounts').select('*').eq('apartment_id', activeApartmentId).order('code'),
            supabase.from('journal_entries').select('*').eq('apartment_id', activeApartmentId).order('entry_date', { ascending: false }),
            supabase.from('journal_lines').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('email_outbox').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('gate_parcels').select('*').eq('apartment_id', activeApartmentId).order('received_at', { ascending: false }),
            supabase.from('visitor_log_units').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('ledger_sync_settings').select('*').eq('apartment_id', activeApartmentId).maybeSingle(),
            supabase.from('ledger_sync_oauth_apps').select('id, apartment_id, provider, client_id, tenant_id, redirect_uri, enabled, client_secret_set, updated_at').eq('apartment_id', activeApartmentId),
            supabase.from('user_oauth_connections').select('id, provider, account_email, token_expires_at, connected_at, provider_account_id, account_meta').eq('apartment_id', activeApartmentId).eq('user_id', uid || '00000000-0000-0000-0000-000000000000'),
            supabase.rpc('get_ledger_sync_service_status', { p_apartment_id: activeApartmentId }),
        ]);
        const results = await withTimeout(queriesPromise, 90000, 'Society data load');

        const [
            u, v, t, s, p, ev, esc, bank, staff, mi, ma, mch, mil, mpr, mbg, mbgu, mbb, mbbs, mrl, bsi, bsl,
            rul, pi, pc, sn, nrl, rpi, hd, ut, ud, sa, asl, am, ab, vl, att, pr,
            vpp, pfr, pv, coa, je, jl, em, gp, vlu, lss, loa, uoc, ssa,
        ] = results;

        console.log('Queries finished.');
        const errors = results.filter(r => r.error).map(r => r.error.message);
        if (errors.length) console.warn('Some queries failed:', errors);

        if (s.data) {
            portalState.community = {
                name: s.data.name,
                defaults: { cars: s.data.car_default, bikes: s.data.bike_default },
                configId: s.data.id,
            };
        } else if (portalState.community) {
            portalState.community.configId = null;
        } else {
            portalState.community = { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null };
        }

        if (u.error) console.error('[pullState] units query failed:', u.error.message);
        if (v.error) console.error('[pullState] vehicles query failed:', v.error.message);

        const units = u.error ? [] : (u.data || []);
        const vehicles = v.error ? [] : (v.data || []);
        portalState.units = units.map(unit => ({ ...unit, vehicles: vehicles.filter(veh => veh.unit_id === unit.id) }));
        portalState.lastPullMeta = {
            apartmentId: activeApartmentId,
            unitCount: units.length,
            vehicleCount: vehicles.length,
            unitsError: u.error?.message || null,
            at: new Date().toISOString(),
        };
        portalState.finances.txns = t.data || [];
        portalState.finances.vendors = ev.error ? [] : (ev.data || []);
        portalState.finances.subCategories = esc.error ? [] : (esc.data || []);
        portalState.finances.maintenanceInvoices = mi.error ? [] : (mi.data || []);
        portalState.finances.maintenanceAllocations = ma.error ? [] : (ma.data || []);
        portalState.finances.maintenanceChargeHeads = mch.error ? [] : (mch.data || []);
        portalState.finances.maintenanceInvoiceLines = mil.error ? [] : (mil.data || []);
        portalState.finances.maintenancePenaltyRules = mpr.error ? [] : (mpr.data || []);
        portalState.finances.maintenanceBillingGroups = mbg.error ? [] : (mbg.data || []);
        portalState.finances.maintenanceBillingGroupUnits = mbgu.error ? [] : (mbgu.data || []);
        portalState.finances.maintenanceBillingBatches = mbb.error ? [] : (mbb.data || []);
        portalState.finances.maintenanceBillingBatchSkips = mbbs.error ? [] : (mbbs.data || []);
        portalState.finances.maintenanceReminderLog = mrl.error ? [] : (mrl.data || []);
        portalState.finances.bankStatementImports = bsi.error ? [] : (bsi.data || []);
        portalState.finances.bankStatementLines = bsl.error ? [] : (bsl.data || []);
        portalState.admin.bankAccount = bank.error ? null : (bank.data || null);
        portalState.admin.staff = staff.error ? [] : (staff.data || []);

        if (!portalState.portal) portalState.portal = {};
        portalState.portal.residentLinks = rul.error ? [] : (rul.data || []);
        portalState.portal.portalInvites = rpi.error ? [] : (rpi.data || []);
        portalState.portal.paymentIntents = pi.error ? [] : (pi.data || []);
        portalState.portal.paymentConfig = pc.error ? null : (pc.data || null);
        portalState.portal.notices = sn.error ? [] : (sn.data || []);
        portalState.portal.noticeReadLog = nrl.error ? [] : (nrl.data || []);

        if (!portalState.operations) portalState.operations = {};
        portalState.operations.helpdeskTickets = hd.error ? [] : (hd.data || []);
        portalState.operations.unitTransitions = ut.error ? [] : (ut.data || []);
        portalState.operations.unitDocuments = ud.error ? [] : (ud.data || []);
        portalState.operations.societyAssets = sa.error ? [] : (sa.data || []);
        portalState.operations.assetServiceLog = asl.error ? [] : (asl.data || []);
        portalState.operations.amenities = am.error ? [] : (am.data || []);
        portalState.operations.amenityBookings = ab.error ? [] : (ab.data || []);
        portalState.operations.visitorLog = vl.error ? [] : (vl.data || []);
        portalState.operations.visitorLogUnits = vlu.error ? [] : (vlu.data || []);
        portalState.operations.gateParcels = gp.error ? [] : (gp.data || []);
        portalState.operations.staffAttendance = att.error ? [] : (att.data || []);
        portalState.operations.payrollRuns = pr.error ? [] : (pr.data || []);

        if (!portalState.parking) portalState.parking = {};
        portalState.parking.visitorPasses = vpp.error ? [] : (vpp.data || []);
        portalState.parking.fineRules = pfr.error ? [] : (pfr.data || []);
        portalState.parking.violations = pv.error ? [] : (pv.data || []);

        if (!portalState.ledger) portalState.ledger = {};
        portalState.ledger.accounts = coa.error ? [] : (coa.data || []);
        portalState.ledger.entries = je.error ? [] : (je.data || []);
        portalState.ledger.lines = jl.error ? [] : (jl.data || []);

        if (!portalState.email) portalState.email = {};
        portalState.email.outbox = em.error ? [] : (em.data || []);

        portalState.finances.ledgerSyncSettings = lss.error ? null : (lss.data || null);
        portalState.finances.ledgerOAuthApps = loa.error ? [] : (loa.data || []);
        portalState.finances.myOAuthConnections = uoc.error ? [] : (uoc.data || []);
        portalState.finances.syncServiceAccounts = ssa.error ? [] : (ssa.data || []);

        // Hydrate slots with vehicle plate numbers
        portalState.slots = (p.data || []).map(slot => {
            const vMatch = vehicles.find(veh => veh.id === slot.assigned_vehicle_id);
            return { ...slot, occupant: vMatch ? vMatch.plate : null, unit_num: vMatch ? units.find(ux => ux.id === vMatch.unit_id)?.number : null };
        });

        try {
            const { loadModuleAccess } = await import('./moduleAccess.js');
            await loadModuleAccess(activeApartmentId, uid);
            document.dispatchEvent(new CustomEvent('module-access-loaded'));
        } catch (modErr) {
            console.warn('[pullState] module access load skipped:', modErr?.message);
        }

        try {
            const { loadUserPageAccess } = await import('./pageAccess.js');
            const roleKey = portalState.auth?.effectiveRoleKey
                || (await import('./rbac.js')).v1RoleToV2Key(portalState.auth?.role);
            await loadUserPageAccess(activeApartmentId, uid, roleKey);
        } catch (pageErr) {
            console.warn('[pullState] page access load skipped:', pageErr?.message);
        }

        return true;
    } catch (err) { console.error('Cloud-Link Broken:', err); return false; }
};

export const persist = () => {
    try {
        const snapshot = JSON.parse(JSON.stringify(portalState));
        if (isPlaceholderApartmentId(snapshot.access?.activeApartmentId)) {
            snapshot.access.activeApartmentId = null;
        }
        if (snapshot.access?.apartments?.length) {
            const real = snapshot.access.apartments.filter((a) => !isPlaceholderApartmentId(a.id));
            if (real.length) snapshot.access.apartments = real;
        }
        localStorage.setItem('sentry_portal_v5_platinum', JSON.stringify(snapshot));
    } catch (err) {
        console.error('[persist] Failed to save local cache', err);
    }
};

export const isPlaceholderApartmentId = (id) => !id || id === 'apt-default';

/** Insert or update society_config (id is required on first insert). */
export const upsertSocietyConfig = async (apartment_id, { name, car_default, bike_default }) => {
    if (!supabase) return { error: new Error('Supabase is required.') };

    const row = {
        id: portalState.community.configId || crypto.randomUUID(),
        apartment_id,
        name,
        car_default,
        bike_default,
    };

    const { data, error } = await supabase
        .from('society_config')
        .upsert(row, { onConflict: 'apartment_id' })
        .select('id');

    const savedId = data?.[0]?.id;
    if (!error && savedId) portalState.community.configId = savedId;
    return { data, error };
};

export const migrateAndRecover = async ({ skipLocalApartmentRestore = false, skipCloudPull = false, signedIn = false } = {}) => {
    const local = localStorage.getItem('sentry_portal_v5_platinum');
    if (local && !skipLocalApartmentRestore && !signedIn) {
        try {
            const savedState = JSON.parse(local);
            const savedAptId = savedState.access?.activeApartmentId;
            if (savedAptId && !isPlaceholderApartmentId(savedAptId)) {
                portalState.access.activeApartmentId = savedAptId;
            }
        } catch (e) { console.error('Local state recovery failed', e); }
    }

    const cloudLink = skipCloudPull ? true : await pullState();

    // When signed in, never replace cloud state with stale offline cache.
    if (!cloudLink && local && !skipLocalApartmentRestore && !signedIn) {
        const saved = JSON.parse(local);
        const preservedAuth = portalState.auth;
        const preservedAccess = portalState.access;
        const preservedUnits = portalState.units?.length ? portalState.units : null;
        portalState = saved;
        if (preservedAuth) portalState.auth = preservedAuth;
        if (preservedAccess?.activeApartmentId && !isPlaceholderApartmentId(preservedAccess.activeApartmentId)) {
            portalState.access = {
                ...(portalState.access || {}),
                ...preservedAccess,
                apartments: preservedAccess.apartments?.length
                    ? preservedAccess.apartments
                    : portalState.access?.apartments,
            };
        }
        if (preservedUnits?.length) portalState.units = preservedUnits;
        return true;
    }

    if (!portalState.access && !signedIn) {
        portalState.access = {
            apartments: [{ id: 'apt-default', name: portalState.community?.name || 'Offline' }],
            users: [{ id: 'usr-default', name: 'Offline user', email: '', apartment_ids: ['apt-default'] }],
            activeApartmentId: 'apt-default',
            activeUserId: 'usr-default'
        };
    }
    return cloudLink;
};
