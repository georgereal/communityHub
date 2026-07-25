/**
 * Sentry Cloud Store (Relational)
 */
import { createApiSupabaseClient, fetchApartmentState, setActiveApartmentIdForApi } from './dbClient.js';
import { authClient, ensureAuthInitialized } from './authClient.js';
import { domainsForRoute, STATE_DOMAINS } from './stateLoader.js';

export { authClient, ensureAuthInitialized };

const authClientRef = authClient;
export const supabase = createApiSupabaseClient(authClientRef);

let pullStateChain = Promise.resolve(true);

/** Domain load bookkeeping on globalThis — survives Vite HMR with accessLocks. */
const domainBook = globalThis.__sentryDomainBook || (globalThis.__sentryDomainBook = {
    loaded: new Set(),
    promises: new Map(),
    accessLoadedKey: null,
});
const loadedDomains = domainBook.loaded;
const domainLoadPromises = domainBook.promises;

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
    finances: { txns: [], vendors: [], subCategories: [], maintenanceInvoices: [], maintenanceAllocations: [], maintenanceChargeHeads: [], maintenanceInvoiceLines: [], maintenancePenaltyRules: [], maintenanceBillingGroups: [], maintenanceBillingGroupUnits: [], maintenanceBillingBatches: [], maintenanceBillingBatchSkips: [], maintenanceReminderLog: [], bankStatementImports: [], bankStatementLines: [], bankClassificationRules: [], nobrokerInvoicesRaised: [], financeDocuments: [], ledgerSyncSettings: null, ledgerOAuthApps: [], myOAuthConnections: [], syncServiceAccounts: [] },
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
        role: {},
    },
    crudAccess: {},
    activeUnitId: null,
    editingTxnId: null,
    editingFinanceDocId: null,
    notifications: { items: [], unreadCount: 0 },
};

export function resetLoadedDomains() {
    loadedDomains.clear();
    domainLoadPromises.clear();
    domainBook.accessLoadedKey = null;
}

export function markDomainLoaded(domain) {
    if (domain) loadedDomains.add(domain);
}

/**
 * Apply /api/workspace-boot payload: core state + module/page access maps.
 */
export function applyBootPayload(boot = {}) {
    if (boot.core) {
        applyStatePatch(boot.core);
        loadedDomains.add('core');
        domainBook.accessLoadedKey = `${boot.activeApartmentId}:${boot.profile?.id || portalState.auth?.id || ''}`;
    }
    if (boot.moduleAccess) {
        portalState.moduleAccess = {
            apartment: boot.moduleAccess.apartment || {},
            user: boot.moduleAccess.user || {},
            role: boot.moduleAccess.role || {},
        };
    }
    if (boot.crudAccess) {
        portalState.crudAccess = boot.crudAccess || {};
    }
    if (boot.pageAccess) {
        portalState.pageAccess = {
            user: boot.pageAccess.user || {},
            societyRole: boot.pageAccess.societyRole || {},
        };
    }
    if (boot.activeApartmentId) {
        setActiveApartmentIdForApi(boot.activeApartmentId);
    }
}

export function getLoadedDomains() {
    return [...loadedDomains];
}

export function isDomainLoaded(domain) {
    return loadedDomains.has(domain);
}

/** Ensure finance domain is in memory (Accounts / Billing / dues-dependent flows). */
export async function ensureFinanceState(opts = {}) {
    return loadStateDomain('finance', opts);
}

async function afterDomainAccessLoads(activeApartmentId, uid) {
    // Prefer auth shell id so a slow/failed getUser() cannot change the cache key
    // and re-trigger module/page fetches after workspace-boot already seeded them.
    const resolvedUid = uid || portalState.auth?.id || '';
    const key = `${activeApartmentId}:${resolvedUid}`;
    if (domainBook.accessLoadedKey === key) return;
    // Same apartment already hydrated (possibly under a slightly different uid key).
    if (domainBook.accessLoadedKey?.startsWith(`${activeApartmentId}:`)) return;
    if (globalThis.__sentryAccessLocks?.societyHydrating) return;

    domainBook.accessLoadedKey = key;

    try {
        const { loadModuleAccess } = await import('./moduleAccess.js');
        await loadModuleAccess(activeApartmentId, resolvedUid || null);
        document.dispatchEvent(new CustomEvent('module-access-loaded'));
    } catch (modErr) {
        console.warn('[store] module access load skipped:', modErr?.message);
        domainBook.accessLoadedKey = null;
    }

    try {
        const { loadUserPageAccess } = await import('./pageAccess.js');
        const roleKey = portalState.auth?.effectiveRoleKey
            || (await import('./rbac.js')).v1RoleToV2Key(portalState.auth?.role);
        await loadUserPageAccess(activeApartmentId, resolvedUid, roleKey);
    } catch (pageErr) {
        console.warn('[store] page access load skipped:', pageErr?.message);
    }
}

function applyStatePatch(partial = {}) {
    if (partial.community) portalState.community = partial.community;
    if (partial.units) portalState.units = partial.units;
    if (partial.slots) portalState.slots = partial.slots;
    if (partial.finances) portalState.finances = { ...portalState.finances, ...partial.finances };
    if (partial.admin) portalState.admin = { ...portalState.admin, ...partial.admin };
    if (partial.portal) portalState.portal = { ...portalState.portal, ...partial.portal };
    if (partial.operations) portalState.operations = { ...portalState.operations, ...partial.operations };
    if (partial.parking) portalState.parking = { ...portalState.parking, ...partial.parking };
    if (partial.ledger) portalState.ledger = { ...portalState.ledger, ...partial.ledger };
    if (partial.email) portalState.email = { ...portalState.email, ...partial.email };
    if (partial.meta) portalState.lastPullMeta = partial.meta;
    if (partial.residents?.length) {
        import('./residents.js').then(({ setResidentsFromState }) => setResidentsFromState(partial.residents)).catch(() => {});
    }
}

export async function loadStateDomain(domain, { force = false } = {}) {
    if (!supabase) return false;
    const activeApartmentId = portalState.access?.activeApartmentId;
    if (!activeApartmentId || isPlaceholderApartmentId(activeApartmentId)) return false;

    if (!force && loadedDomains.has(domain)) return true;
    if (!force && domainLoadPromises.has(domain)) return domainLoadPromises.get(domain);
    if (force) domainLoadPromises.delete(domain);

    const run = async () => {
        setActiveApartmentIdForApi(activeApartmentId);
        const partial = await withTimeout(
            fetchApartmentState(activeApartmentId, domain),
            domain === 'finance' ? 90000 : 45000,
            `${domain} data load`,
        );
        if (partial.errors?.length) console.warn(`[store/${domain}] query warnings:`, partial.errors);
        applyStatePatch(partial);
        loadedDomains.add(domain);
        if (domain === 'core') {
            // Avoid auth.getUser() here — it races workspace-boot and times out to Supabase directly.
            await afterDomainAccessLoads(activeApartmentId, portalState.auth?.id);
        }
        if (domain === 'finance' || domain === 'admin') {
            document.dispatchEvent(new CustomEvent('domain-data-loaded', { detail: { domain } }));
        }
        return true;
    };

    const promise = run().catch((err) => {
        console.error(`[store] Failed to load domain ${domain}:`, err);
        domainLoadPromises.delete(domain);
        return false;
    });
    domainLoadPromises.set(domain, promise);
    return promise;
}

export async function loadStateDomains(domains, opts = {}) {
    const unique = [...new Set(domains.filter(Boolean))];
    if (!unique.length) return true;
    const results = await Promise.all(unique.map((d) => loadStateDomain(d, opts)));
    return results.every(Boolean);
}

export async function ensureRouteState(route) {
    let domains = domainsForRoute(route).filter((d) => !loadedDomains.has(d));
    if (!accessLocksAllowHeavy()) {
        domains = domains.filter((d) => d === 'core');
    }
    if (!domains.length) return true;
    return loadStateDomains(domains);
}

function accessLocksAllowHeavy() {
    try {
        return !!globalThis.__sentryAccessLocks?.allowHeavyDomains;
    } catch {
        return true;
    }
}

/**
 * Load apartment state — domain-scoped by default.
 * pullState() with no args refreshes all domains loaded so far (post-mutation).
 * pullState('all') loads every domain (legacy full sync).
 */
export const pullState = async (options) => {
    const opts = typeof options === 'string'
        ? { domain: options }
        : (options || {});

    const run = async () => {
        if (!supabase) return false;
        try {
            const activeApartmentId = portalState.access?.activeApartmentId;
            if (!activeApartmentId) throw new Error('No active apartment selected');
            if (isPlaceholderApartmentId(activeApartmentId)) {
                console.warn('[pullState] Refusing to load placeholder apartment id:', activeApartmentId);
                return false;
            }

            if (opts.domain === 'all') {
                console.log('[Store] Loading all state domains…');
                resetLoadedDomains();
                const ok = await loadStateDomains(STATE_DOMAINS);
                if (ok) STATE_DOMAINS.forEach((d) => loadedDomains.add(d));
                return ok;
            }

            if (opts.domain) {
                return loadStateDomain(opts.domain, { force: !!opts.force });
            }

            if (loadedDomains.size) {
                console.log('[Store] Refreshing loaded domains:', [...loadedDomains]);
                return loadStateDomains([...loadedDomains], { force: true });
            }

            console.log('[Store] Boot pull — core domain only');
            return loadStateDomain('core');
        } catch (err) {
            console.error('Cloud-Link Broken:', err);
            return false;
        }
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
