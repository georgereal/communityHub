/** Platform role → permission keys (same floor as src/rbac.js). */

const FULL = [
    'vehicle_registry.view', 'vehicle_registry.edit',
    'accounts.view', 'accounts.edit', 'accounts.bills_entry',
    'setup.view', 'setup.edit',
    'rbac.view', 'rbac.edit',
    'apartment_mgmt.view', 'apartment_mgmt.edit',
    'portal.view', 'security.view',
];

const OFFICE_BEARER = [
    'vehicle_registry.view', 'vehicle_registry.edit',
    'accounts.view', 'accounts.edit', 'accounts.bills_entry',
    'setup.view', 'setup.edit',
    'apartment_mgmt.view', 'apartment_mgmt.edit',
    'portal.view', 'security.view',
];

export const DEFAULT_ROLE_PERMISSIONS = {
    system_admin: FULL,
    society_admin: FULL,
    apartment_admin: OFFICE_BEARER,
    property_manager: [
        'vehicle_registry.view', 'vehicle_registry.edit',
        'apartment_mgmt.view', 'apartment_mgmt.edit',
        'portal.view', 'security.view',
        'accounts.view', 'accounts.bills_entry',
    ],
    accounts_manager: [
        'accounts.view', 'accounts.edit', 'accounts.bills_entry',
        'apartment_mgmt.view', 'portal.view',
    ],
    office_staff: ['accounts.bills_entry'],
    security: ['vehicle_registry.view', 'vehicle_registry.edit', 'security.view'],
    resident_viewer: ['portal.view'],
};

export const ROLE_PRIORITY = [
    'society_admin',
    'apartment_admin',
    'accounts_manager',
    'property_manager',
    'office_staff',
    'security',
    'resident_viewer',
];

export const CRUD_RESOURCE_KEYS = [
    'vehicle_registry',
    'apartment_mgmt',
    'accounts',
    'security',
    'portal',
    'setup',
    'rbac',
];

export function primaryRoleFromAssignments(assignments = []) {
    if (!assignments.length) return 'resident_viewer';
    for (const key of ROLE_PRIORITY) {
        if (assignments.some((a) => a.role_key === key)) return key;
    }
    return assignments[0].role_key;
}

export function deriveCrudFromPermissionKeys(permKeys = []) {
    const set = new Set(permKeys || []);
    const map = {};
    for (const key of CRUD_RESOURCE_KEYS) {
        const view = set.has(`${key}.view`);
        const edit = set.has(`${key}.edit`);
        if (key === 'portal' || key === 'security') {
            map[key] = { create: view, read: view, update: view, delete: false };
            continue;
        }
        map[key] = {
            create: edit,
            read: view || edit,
            update: edit,
            delete: false,
        };
    }
    return map;
}

export function fullCrudMap() {
    const map = {};
    for (const key of CRUD_RESOURCE_KEYS) {
        map[key] = { create: true, read: true, update: true, delete: true };
    }
    map.security = { create: true, read: true, update: true, delete: false };
    map.portal = { create: true, read: true, update: true, delete: false };
    return map;
}
