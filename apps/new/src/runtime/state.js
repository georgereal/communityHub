/**
 * New-app in-memory session. No Postgres client, no /api/db.
 */
export const supabase = null;

export let portalState = {
    units: [],
    slots: [],
    finances: { txns: [], vendors: [], subCategories: [] },
    financeNew: null,
    community: { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null },
    access: {
        apartments: [],
        users: [],
        activeApartmentId: null,
        activeUserId: null,
    },
    admin: { bankAccount: null, staff: [], externalConnections: [] },
    auth: {},
    authPermissions: [],
    crudAccess: {},
    moduleAccess: { apartment: {}, user: {}, role: {} },
    pageAccess: { user: {}, societyRole: {} },
};

export function persist() {}

export async function pullState() {
    return true;
}

export async function loadStateDomains() {
    return true;
}

export async function upsertSocietyConfig(apartmentId, { name, car_default, bike_default } = {}) {
    if (name) {
        const apt = portalState.access?.apartments?.find((a) => a.id === apartmentId);
        if (apt) apt.name = name;
        portalState.community.name = name;
    }
    if (car_default != null || bike_default != null) {
        portalState.community.defaults = {
            cars: car_default ?? portalState.community.defaults?.cars ?? 1,
            bikes: bike_default ?? portalState.community.defaults?.bikes ?? 1,
        };
    }
    return { error: null };
}

export function isPlaceholderApartmentId(id) {
    return !id || id === 'apt-default';
}
