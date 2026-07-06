/**
 * Sentry Cloud Store (Relational)
 */
import { createClient } from '@supabase/supabase-js';
import { createApiSupabaseClient, fetchApartmentState, setActiveApartmentIdForApi } from './dbClient.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const authClient = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
export const supabase = createApiSupabaseClient(authClient);

let pullStateChain = Promise.resolve(true);

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
    finances: { txns: [], vendors: [], subCategories: [], maintenanceInvoices: [], maintenanceAllocations: [], maintenanceChargeHeads: [], maintenanceInvoiceLines: [], maintenancePenaltyRules: [], maintenanceBillingGroups: [], maintenanceBillingGroupUnits: [], maintenanceBillingBatches: [], maintenanceBillingBatchSkips: [], maintenanceReminderLog: [], bankStatementImports: [], bankStatementLines: [], bankClassificationRules: [], ledgerSyncSettings: null, ledgerOAuthApps: [], myOAuthConnections: [], syncServiceAccounts: [] },
    community: { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null },
    access: {
        apartments: [{ id: 'apt-default', name: 'CommunityHub' }],
        users: [{ id: 'usr-default', name: 'Property Lead', email: '', apartment_ids: ['apt-default'] }],
        activeApartmentId: 'apt-default',
        activeUserId: 'usr-default'
    },
    admin: { bankAccount: null, staff: [], externalConnections: [] },
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
    const run = async () => {
    if (!supabase) return false;
    try {
        const activeApartmentId = portalState.access?.activeApartmentId;
        if (!activeApartmentId) throw new Error('No active apartment selected');
        setActiveApartmentIdForApi(activeApartmentId);
        if (isPlaceholderApartmentId(activeApartmentId)) {
            console.warn('[pullState] Refusing to load placeholder apartment id:', activeApartmentId);
            return false;
        }
        console.group('[Store] Pulling state for:', activeApartmentId);

        const { data: { user } } = await supabase.auth.getUser();
        const uid = user?.id;

        console.log('Loading state via API...');
        const state = await withTimeout(
            fetchApartmentState(activeApartmentId),
            90000,
            'Society data load',
        );

        if (state.errors?.length) console.warn('Some queries failed:', state.errors);

        if (state.community) {
            portalState.community = state.community;
        } else {
            portalState.community = { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null };
        }

        portalState.units = state.units || [];
        portalState.lastPullMeta = state.meta || {
            apartmentId: activeApartmentId,
            unitCount: portalState.units.length,
            vehicleCount: 0,
            at: new Date().toISOString(),
        };
        portalState.slots = state.slots || [];
        portalState.finances = { ...portalState.finances, ...(state.finances || {}) };
        portalState.admin = { ...portalState.admin, ...(state.admin || {}) };
        portalState.portal = { ...portalState.portal, ...(state.portal || {}) };
        portalState.operations = { ...portalState.operations, ...(state.operations || {}) };
        portalState.parking = { ...portalState.parking, ...(state.parking || {}) };
        portalState.ledger = { ...portalState.ledger, ...(state.ledger || {}) };
        portalState.email = { ...portalState.email, ...(state.email || {}) };

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

        console.groupEnd();
        return true;
    } catch (err) { console.error('Cloud-Link Broken:', err); return false; }
    };
    pullStateChain = pullStateChain.then(run, run);
    return pullStateChain;
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
