/**
 * Named actions on Property-New / Finance-New / Admin-New.
 * Each row is CRUD on a resource (plus Society Admin where noted).
 */
import { isSocietyAdminUser, isSystemAdminUser } from './rbac.js';
import { canCrud } from './rbacMatrix.js';

/**
 * @typedef {object} Capability
 * @property {string} id
 * @property {string} label
 * @property {'property-new'|'finance-new'|'admin-new'} app
 * @property {[string, 'create'|'read'|'update'|'delete']} [crud]
 * @property {Array<[string, 'create'|'read'|'update'|'delete']>} [anyCrud]
 * @property {boolean} [societyAdmin]
 */

/** @type {Capability[]} */
export const CAPABILITIES = [
    { id: 'units.view', label: 'View units', app: 'property-new', crud: ['apartment_mgmt', 'read'] },
    { id: 'units.create', label: 'Create / import units', app: 'property-new', crud: ['apartment_mgmt', 'create'] },
    { id: 'units.update', label: 'Edit unit directory', app: 'property-new', crud: ['apartment_mgmt', 'update'] },
    { id: 'units.delete', label: 'Delete unit / flat', app: 'property-new', crud: ['apartment_mgmt', 'delete'] },
    { id: 'residents.update', label: 'Add / edit residents', app: 'property-new', crud: ['apartment_mgmt', 'update'] },
    { id: 'residents.delete', label: 'Delete residents', app: 'property-new', crud: ['apartment_mgmt', 'delete'] },
    { id: 'parking.update', label: 'Edit vehicles & pool slots', app: 'property-new', anyCrud: [['vehicle_registry', 'update'], ['apartment_mgmt', 'update']] },
    { id: 'parking.base_slots', label: 'Edit base parking limits', app: 'property-new', crud: ['apartment_mgmt', 'update'] },
    { id: 'parking.delete', label: 'Remove vehicles / pool slots', app: 'property-new', anyCrud: [['vehicle_registry', 'delete'], ['apartment_mgmt', 'delete']] },

    { id: 'accounts.view', label: 'View finance', app: 'finance-new', crud: ['accounts', 'read'] },
    { id: 'accounts.edit', label: 'Edit ledger / recon / billing', app: 'finance-new', crud: ['accounts', 'update'] },
    { id: 'accounts.delete', label: 'Delete finance records', app: 'finance-new', crud: ['accounts', 'delete'] },
    { id: 'accounts.bills_enter', label: 'Enter bills & receipts', app: 'finance-new', crud: ['accounts', 'create'] },
    { id: 'accounts.docs_manage', label: 'Manage finance documents', app: 'finance-new', crud: ['accounts', 'update'] },
    { id: 'accounts.plan_edit', label: 'Edit expense plan', app: 'finance-new', crud: ['accounts', 'update'] },
    { id: 'accounts.bank_sync', label: 'Bank passbook / sync', app: 'finance-new', crud: ['accounts', 'read'] },

    { id: 'setup.edit', label: 'Edit society setup', app: 'admin-new', anyCrud: [['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.society.save', label: 'Save society profile & modules', app: 'admin-new', anyCrud: [['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.bank.save', label: 'Save society bank account', app: 'admin-new', anyCrud: [['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.vendors.edit', label: 'Manage vendors', app: 'admin-new', anyCrud: [['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.categories.edit', label: 'Manage sub-categories', app: 'admin-new', anyCrud: [['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.staff.edit', label: 'Manage staff directory', app: 'admin-new', anyCrud: [['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.integrations.edit', label: 'Edit integrations', app: 'admin-new', anyCrud: [['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.integrations.sync', label: 'Run finance sync connections', app: 'admin-new', anyCrud: [['accounts', 'update'], ['setup', 'update'], ['rbac', 'update']] },
    { id: 'admin.people.assign', label: 'Assign roles', app: 'admin-new', crud: ['rbac', 'update'], societyAdmin: true },
    { id: 'admin.roles.edit', label: 'Edit role CRUD', app: 'admin-new', crud: ['rbac', 'update'], societyAdmin: true },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function capabilityById(id) {
    return BY_ID.get(id) || null;
}

function crudPairOk(resource, action) {
    if (canCrud(resource, action)) return true;
    if (action === 'update' && (canCrud(resource, 'create') || canCrud(resource, 'delete'))) return true;
    return false;
}

function capAllowed(cap) {
    if (cap.crud) return crudPairOk(cap.crud[0], cap.crud[1]);
    if (cap.anyCrud?.length) return cap.anyCrud.some(([resource, action]) => crudPairOk(resource, action));
    return false;
}

export function can(id) {
    if (isSystemAdminUser()) return true;
    const cap = BY_ID.get(id);
    if (!cap) return false;
    if (cap.societyAdmin && !isSocietyAdminUser()) return false;
    return capAllowed(cap);
}

export function assertCan(id) {
    if (!can(id)) {
        const cap = BY_ID.get(id);
        throw new Error(cap ? `Not permitted: ${cap.label}.` : 'Not permitted.');
    }
}
