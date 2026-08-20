/**
 * App navigation: modules, pages, routing, and permission gating
 */

import { isModuleEnabled } from './moduleAccess.js';
import { portalState } from './store.js';
import { pageAccessBlocksRoute } from './pageAccessResolve.js';
import { getUiMode, isNewUi } from './uiMode.js';
import { applyMpaNavCollapsed, isMpaNavCollapsedPref } from './appShell/navPref.js';

const OPERATIONS_ROUTES = [
    'ops-helpdesk', 'ops-transitions', 'ops-notices', 'ops-assets',
    'ops-amenities', 'ops-visitors', 'ops-payroll',
];

const TREASURY_ROUTES = [
    'finance-ledger', 'finance-docs', 'finance-expense-plan', 'finance-bank-recon', 'finance-reports', 'finance-invoices-raised',
];

/** Filled after NAV_MODULES — Income & Expenses tabs share this with the Finance sidebar. */
export let ACCOUNTS_SUBVIEW_ROUTES = {};

export const NAV_MODULES = [
    {
        id: 'home',
        label: 'Dashboard',
        icon: 'fa-house',
        tabbed: true,
        defaultRoute: 'dashboard',
        pages: [
            {
                route: 'dashboard',
                label: 'Dashboard',
                icon: 'fa-house',
                view: 'dashboard',
                permission: 'vehicle_registry.view',
                altPermissions: ['apartment_mgmt.view', 'accounts.view', 'security.view', 'setup.view'],
                legacy: ['home'],
            },
        ],
    },
    {
        id: 'portal',
        label: 'Resident Portal',
        icon: 'fa-house-user',
        pages: [
            { route: 'portal-home', label: 'Home', icon: 'fa-house', view: 'portal', subview: 'home', permission: 'portal.view' },
            { route: 'portal-invoices', label: 'Invoices', icon: 'fa-file-invoice', view: 'portal', subview: 'invoices', permission: 'portal.view' },
            { route: 'portal-payments', label: 'Payments', icon: 'fa-credit-card', view: 'portal', subview: 'payments', permission: 'portal.view' },
            { route: 'portal-vehicles', label: 'Vehicles', icon: 'fa-car', view: 'portal', subview: 'vehicles', permission: 'portal.view' },
            { route: 'portal-notices', label: 'Notices', icon: 'fa-bullhorn', view: 'portal', subview: 'notices', permission: 'portal.view' },
            { route: 'portal-tickets', label: 'Tickets', icon: 'fa-ticket', view: 'portal', subview: 'tickets', permission: 'portal.view' },
        ],
    },
    {
        id: 'security',
        label: 'Security Gate',
        icon: 'fa-shield-halved',
        pages: [
            { route: 'security-gate', label: 'Gate desk', icon: 'fa-door-open', view: 'security', subview: 'gate', permission: 'security.view' },
            { route: 'security-log', label: 'Visitor log', icon: 'fa-clipboard-list', view: 'security', subview: 'log', permission: 'security.view' },
            { route: 'security-passes', label: 'Parking passes', icon: 'fa-ticket', view: 'security', subview: 'passes', permission: 'security.view', altPermissions: ['vehicle_registry.edit'] },
        ],
    },
    {
        id: 'property',
        label: 'Property',
        icon: 'fa-building',
        navEntries: [
            { route: 'property-vehicles' },
            { route: 'property-residents' },
            { route: 'property-units' },
            { route: 'ops-helpdesk' },
            { route: 'ops-transitions' },
            { route: 'ops-notices' },
            { route: 'ops-assets' },
            { route: 'ops-amenities' },
            { route: 'ops-visitors' },
            { route: 'ops-payroll' },
        ],
        pages: [
            {
                route: 'property-vehicles',
                label: 'Parking & Vehicles',
                icon: 'fa-car',
                view: 'registry',
                permission: 'vehicle_registry.view',
                legacy: ['registry'],
            },
            {
                route: 'property-residents',
                label: 'Residents',
                icon: 'fa-user-group',
                view: 'apartment',
                permission: 'apartment_mgmt.view',
                legacy: ['apartment'],
            },
            {
                route: 'property-units',
                label: 'Unit Directory',
                icon: 'fa-door-open',
                view: 'units',
                permission: 'apartment_mgmt.view',
                legacy: ['units'],
            },
            {
                route: 'ops-helpdesk',
                label: 'Helpdesk',
                icon: 'fa-headset',
                view: 'operations',
                subview: 'helpdesk',
                permission: 'apartment_mgmt.view',
            },
            {
                route: 'ops-transitions',
                label: 'Move-in / out',
                icon: 'fa-truck-ramp-box',
                view: 'operations',
                subview: 'transitions',
                permission: 'apartment_mgmt.edit',
            },
            {
                route: 'ops-notices',
                label: 'Notices',
                icon: 'fa-bullhorn',
                view: 'operations',
                subview: 'notices',
                permission: 'apartment_mgmt.edit',
            },
            {
                route: 'ops-assets',
                label: 'Assets',
                icon: 'fa-toolbox',
                view: 'operations',
                subview: 'assets',
                permission: 'apartment_mgmt.view',
            },
            {
                route: 'ops-amenities',
                label: 'Amenities',
                icon: 'fa-calendar-check',
                view: 'operations',
                subview: 'amenities',
                permission: 'apartment_mgmt.view',
            },
            {
                route: 'ops-visitors',
                label: 'Visitors',
                icon: 'fa-id-badge',
                view: 'operations',
                subview: 'visitors',
                permission: 'apartment_mgmt.view',
                altPermissions: ['vehicle_registry.edit'],
            },
            {
                route: 'ops-payroll',
                label: 'Staff & Payroll',
                icon: 'fa-users-gear',
                view: 'operations',
                subview: 'payroll',
                permission: 'accounts.edit',
            },
        ],
    },
    {
        id: 'property-new',
        label: 'Property-New',
        icon: 'fa-user-group',
        navEntries: [
            { route: 'pn-units' },
            { route: 'pn-vehicles' },
            { route: 'pn-residents' },
        ],
        pages: [
            {
                route: 'pn-units',
                label: 'Unit Directory',
                icon: 'fa-door-open',
                view: 'property-new',
                permission: 'apartment_mgmt.view',
            },
            {
                route: 'pn-vehicles',
                label: 'Parking & Vehicles',
                icon: 'fa-car',
                view: 'property-new',
                permission: 'vehicle_registry.view',
            },
            {
                route: 'pn-residents',
                label: 'Residents',
                icon: 'fa-user-group',
                view: 'property-new',
                permission: 'apartment_mgmt.view',
            },
        ],
    },
    {
        id: 'finance',
        label: 'Finance',
        icon: 'fa-coins',
        navEntries: [
            { route: 'finance-reports' },
            {
                tabbed: true,
                label: 'Invoices',
                icon: 'fa-file-invoice',
                defaultRoute: 'finance-billing-pending',
                routes: [
                    'finance-billing-pending',
                    'finance-billing-list',
                    'finance-billing-collections',
                    'finance-billing-batches',
                    'finance-billing-aging',
                ],
            },
            { route: 'finance-ledger' },
            { route: 'finance-docs' },
            { route: 'finance-expense-plan' },
            { route: 'finance-invoices-raised' },
            { route: 'finance-bank-recon' },
        ],
        pages: [
            {
                route: 'finance-reports',
                label: 'Financial reports',
                icon: 'fa-chart-line',
                view: 'accounts',
                subview: 'reports',
                permission: 'accounts.view',
                legacy: ['treasury-reports'],
            },
            {
                route: 'finance-ledger',
                label: 'Ledger',
                icon: 'fa-book',
                view: 'accounts',
                subview: 'ledger',
                permission: 'accounts.view',
                legacy: ['accounts', 'treasury-ledger'],
            },
            {
                route: 'finance-docs',
                label: 'Bills & receipts',
                icon: 'fa-file-invoice',
                view: 'accounts',
                subview: 'finance-docs',
                permission: 'accounts.view',
                altPermissions: ['accounts.bills_entry'],
                legacy: ['finance-cash-float'],
            },
            {
                route: 'finance-expense-plan',
                label: 'Expense plan',
                icon: 'fa-calendar-check',
                view: 'accounts',
                subview: 'expense-plan',
                permission: 'accounts.view',
            },
            {
                route: 'finance-billing-pending',
                label: 'Pending Dues',
                icon: 'fa-file-invoice-dollar',
                view: 'invoices',
                subview: 'pending-dues',
                permission: 'accounts.edit',
                legacy: ['finance-billing', 'invoices', 'treasury-billing'],
            },
            {
                route: 'finance-billing-list',
                label: 'All Invoices',
                icon: 'fa-file-invoice',
                view: 'invoices',
                subview: 'list',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'finance-billing-collections',
                label: 'Collections',
                icon: 'fa-hand-holding-dollar',
                view: 'invoices',
                subview: 'collections',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'finance-billing-batches',
                label: 'Billing Batches',
                icon: 'fa-layer-group',
                view: 'invoices',
                subview: 'batches',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'finance-billing-aging',
                label: 'Aging Report',
                icon: 'fa-hourglass-half',
                view: 'invoices',
                subview: 'aging',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'finance-bank-recon',
                label: 'Bank Reconciliation',
                icon: 'fa-scale-balanced',
                view: 'accounts',
                subview: 'bank-recon',
                permission: 'accounts.edit',
            },
            {
                route: 'finance-invoices-raised',
                label: 'Invoices Raised',
                icon: 'fa-file-invoice',
                view: 'accounts',
                subview: 'invoices-raised',
                permission: 'accounts.view',
            },
        ],
    },
    {
        id: 'finance-new',
        label: 'Finance-New',
        icon: 'fa-coins',
        navEntries: [
            { route: 'fn-reports' },
            {
                tabbed: true,
                label: 'Invoices',
                icon: 'fa-file-invoice',
                defaultRoute: 'fn-billing-pending',
                routes: [
                    'fn-billing-pending',
                    'fn-billing-list',
                    'fn-billing-collections',
                    'fn-billing-batches',
                    'fn-billing-aging',
                ],
            },
            { route: 'fn-ledger' },
            { route: 'fn-docs' },
            { route: 'fn-expense-plan' },
            { route: 'fn-invoices-raised' },
            { route: 'fn-bank-recon' },
        ],
        pages: [
            {
                route: 'fn-reports',
                label: 'Financial reports',
                icon: 'fa-chart-line',
                view: 'finance-new-accounts',
                subview: 'reports',
                permission: 'accounts.view',
            },
            {
                route: 'fn-ledger',
                label: 'Ledger',
                icon: 'fa-book',
                view: 'finance-new-accounts',
                subview: 'ledger',
                permission: 'accounts.view',
            },
            {
                route: 'fn-docs',
                label: 'Bills & receipts',
                icon: 'fa-file-invoice',
                view: 'finance-new-accounts',
                subview: 'finance-docs',
                permission: 'accounts.view',
                altPermissions: ['accounts.bills_entry'],
            },
            {
                route: 'fn-expense-plan',
                label: 'Expense plan',
                icon: 'fa-calendar-check',
                view: 'finance-new-accounts',
                subview: 'expense-plan',
                permission: 'accounts.view',
            },
            {
                route: 'fn-billing-pending',
                label: 'Pending Dues',
                icon: 'fa-file-invoice-dollar',
                view: 'finance-new-invoices',
                subview: 'pending-dues',
                permission: 'accounts.edit',
            },
            {
                route: 'fn-billing-list',
                label: 'All Invoices',
                icon: 'fa-file-invoice',
                view: 'finance-new-invoices',
                subview: 'list',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'fn-billing-collections',
                label: 'Collections',
                icon: 'fa-hand-holding-dollar',
                view: 'finance-new-invoices',
                subview: 'collections',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'fn-billing-batches',
                label: 'Billing Batches',
                icon: 'fa-layer-group',
                view: 'finance-new-invoices',
                subview: 'batches',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'fn-billing-aging',
                label: 'Aging Report',
                icon: 'fa-hourglass-half',
                view: 'finance-new-invoices',
                subview: 'aging',
                permission: 'accounts.edit',
                hideFromNav: true,
            },
            {
                route: 'fn-bank-recon',
                label: 'Bank Reconciliation',
                icon: 'fa-scale-balanced',
                view: 'finance-new-accounts',
                subview: 'bank-recon',
                permission: 'accounts.edit',
            },
            {
                route: 'fn-invoices-raised',
                label: 'Invoices Raised',
                icon: 'fa-file-invoice',
                view: 'finance-new-accounts',
                subview: 'invoices-raised',
                permission: 'accounts.view',
            },
        ],
    },
    {
        id: 'admin-new',
        label: 'Administration',
        icon: 'fa-gear',
        accessModuleId: 'admin',
        navEntries: [
            { route: 'an-society' },
            { route: 'an-people' },
            { route: 'an-staff' },
            { route: 'an-integrations' },
            { route: 'admin-access' },
            { route: 'admin-activity' },
        ],
        pages: [
            {
                route: 'an-society',
                label: 'Society profile',
                icon: 'fa-building',
                view: 'admin-new',
                permission: 'setup.edit',
                altPermissions: ['rbac.edit'],
            },
            {
                route: 'an-people',
                label: 'People & access',
                icon: 'fa-user-shield',
                view: 'admin-new',
                permission: 'setup.edit',
                altPermissions: ['rbac.edit'],
            },
            {
                route: 'an-vendors',
                label: 'Vendors',
                icon: 'fa-truck-field',
                view: 'admin-new',
                permission: 'setup.edit',
                hideFromNav: true,
            },
            {
                route: 'an-categories',
                label: 'Sub-categories',
                icon: 'fa-tags',
                view: 'admin-new',
                permission: 'setup.edit',
                hideFromNav: true,
            },
            {
                route: 'an-staff',
                label: 'Staff directory',
                icon: 'fa-users-gear',
                view: 'admin-new',
                permission: 'setup.edit',
            },
            {
                route: 'an-integrations',
                label: 'Integrations',
                icon: 'fa-plug',
                view: 'admin-new',
                permission: 'setup.edit',
                altPermissions: ['accounts.edit'],
            },
            {
                route: 'admin-access',
                label: 'Roles',
                icon: 'fa-user-lock',
                view: 'access-control',
                permission: 'rbac.edit',
            },
            {
                route: 'admin-activity',
                label: 'Activity Log',
                icon: 'fa-clock-rotate-left',
                view: 'accounts',
                subview: 'activity',
                permission: 'rbac.view',
                altPermissions: ['setup.edit'],
            },
        ],
    },
    {
        id: 'admin',
        label: 'Administration',
        icon: 'fa-gear',
        navEntries: [
            { route: 'admin-access' },
            {
                tabbed: true,
                label: 'Society settings',
                icon: 'fa-building-user',
                defaultRoute: 'admin-society',
                routes: [
                    'admin-society',
                    'admin-bank',
                    'admin-vendors',
                    'admin-subcats',
                    'admin-staff',
                    'admin-connections',
                    'admin-sync',
                ],
            },
            { route: 'admin-activity' },
            { route: 'admin-portfolio' },
            { route: 'admin-email' },
        ],
        pages: [
            {
                route: 'admin-access',
                label: 'Roles',
                icon: 'fa-user-lock',
                view: 'access-control',
                permission: 'rbac.edit',
            },
            {
                route: 'admin-society',
                label: 'Profile',
                icon: 'fa-building-user',
                view: 'setup',
                subview: 'society',
                // Office Bearer (setup.edit) + Society Admin (rbac.edit)
                permission: 'setup.edit',
                altPermissions: ['rbac.edit'],
                legacy: ['admin-settings', 'setup'],
            },
            {
                route: 'admin-activity',
                label: 'Activity Log',
                icon: 'fa-clock-rotate-left',
                view: 'accounts',
                subview: 'activity',
                permission: 'rbac.view',
                altPermissions: ['setup.edit'],
                legacy: ['finance-activity', 'property-activity'],
            },
            {
                route: 'admin-bank',
                label: 'Bank account',
                icon: 'fa-building-columns',
                view: 'setup',
                subview: 'bank',
                permission: 'setup.edit',
                hideFromNav: true,
            },
            {
                route: 'admin-vendors',
                label: 'Vendors',
                icon: 'fa-truck-field',
                view: 'setup',
                subview: 'vendors',
                permission: 'setup.edit',
                hideFromNav: true,
            },
            {
                route: 'admin-subcats',
                label: 'Sub-categories',
                icon: 'fa-tags',
                view: 'setup',
                subview: 'subcats',
                permission: 'setup.edit',
                hideFromNav: true,
            },
            {
                route: 'admin-staff',
                label: 'Staff directory',
                icon: 'fa-users-gear',
                view: 'setup',
                subview: 'staff',
                permission: 'setup.edit',
                hideFromNav: true,
            },
            {
                route: 'admin-connections',
                label: 'External connections',
                icon: 'fa-plug',
                view: 'setup',
                subview: 'connections',
                permission: 'setup.edit',
                hideFromNav: true,
            },
            {
                route: 'admin-sync',
                label: 'Spreadsheet sync',
                icon: 'fa-table-columns',
                view: 'setup',
                subview: 'sync',
                permission: 'accounts.edit',
                altPermissions: ['setup.edit'],
                hideFromNav: true,
            },
            {
                route: 'admin-portfolio',
                label: 'Portfolio Rollup',
                icon: 'fa-layer-group',
                view: 'portfolio',
                permission: 'rbac.view',
                altPermissions: ['setup.edit'],
            },
            {
                route: 'admin-email',
                label: 'Email Outbox',
                icon: 'fa-envelope',
                view: 'email',
                permission: 'accounts.edit',
            },
        ],
    },
];

const OPS_NAV_ROUTES = OPERATIONS_ROUTES;

export function isNavHeading(mod) {
    return Boolean(mod?.navHeading);
}

/**
 * Sidebar modules for the current UI mode.
 * New: Mongo Property + Finance on top; classic screens sit under an Old heading
 * (property ops, resident portal, security gate). Administration stays last.
 * Classic: original Property + Finance SPA.
 */
export function getNavModules() {
    const mode = getUiMode();
    const property = NAV_MODULES.find((m) => m.id === 'property');
    const opsPages = (property?.pages || []).filter((p) => OPS_NAV_ROUTES.includes(p.route));
    const opsEntries = (property?.navEntries || []).filter((e) => e.route && OPS_NAV_ROUTES.includes(e.route));
    const byId = (id) => NAV_MODULES.find((m) => m.id === id);

    if (mode === 'classic') {
        return NAV_MODULES.filter((mod) => mod.id !== 'property-new' && mod.id !== 'finance-new' && mod.id !== 'admin-new');
    }

    const out = [];
    for (const mod of NAV_MODULES) {
        if (mod.id === 'property' || mod.id === 'finance') continue;
        if (mod.id === 'portal' || mod.id === 'security' || mod.id === 'admin') continue;
        if (mod.id === 'property-new') {
            out.push({ ...mod, label: 'Property' });
            continue;
        }
        if (mod.id === 'finance-new') {
            out.push({ ...mod, label: 'Finance' });
            continue;
        }
        out.push(mod);
    }

    const adminNew = byId('admin-new');
    const opsDataPages = (adminNew?.pages || []).filter((p) => ['an-vendors', 'an-categories'].includes(p.route));
    const opsDataEntries = opsDataPages.map((p) => ({ route: p.route }));

    out.push({ navHeading: 'Old', id: '_old-heading' });
    if (opsPages.length || opsDataPages.length) {
        out.push({
            id: 'old-ops',
            accessModuleId: 'property',
            label: 'Operations',
            icon: 'fa-toolbox',
            classicIsland: true,
            oldGroup: true,
            navEntries: [...opsEntries, ...opsDataEntries],
            pages: [...opsPages, ...opsDataPages.map((p) => ({ ...p, hideFromNav: false }))],
        });
    }
    ['portal', 'security'].forEach((id) => {
        const mod = byId(id);
        if (mod) out.push({ ...mod, classicIsland: true, oldGroup: true });
    });
    return out;
}

export function routeIsClassicIsland(route) {
    if (OPS_NAV_ROUTES.includes(route)) return true;
    const meta = findPage(route);
    const id = meta?.module?.id;
    if (id === 'portal' || id === 'security' || id === 'admin') return true;
    if (id === 'admin-new' && String(route || '').startsWith('admin-')) return true;
    return false;
}

/** Setup page tabs — same routes as Administration → Society settings. */
export const SETUP_SUBVIEW_ROUTES = {
    society: 'admin-society',
    bank: 'admin-bank',
    vendors: 'admin-vendors',
    subcats: 'admin-subcats',
    staff: 'admin-staff',
    connections: 'admin-connections',
    sync: 'admin-sync',
};

export function getSetupTabPages() {
    const mod = NAV_MODULES.find((m) => m.id === 'admin');
    if (!mod) return [];
    const entry = (mod.navEntries || []).find((e) => e.tabbed && e.routes?.includes('admin-society'));
    const routes = entry?.routes || Object.values(SETUP_SUBVIEW_ROUTES);
    const byRoute = new Map(mod.pages.map((p) => [p.route, p]));
    return routes.map((r) => byRoute.get(r)).filter((p) => p?.view === 'setup' && p.subview);
}
/**
 * Finance sidebar pages that live in the Income & Expenses shell (`view: accounts`).
 * Order follows `finance.navEntries` so the top tab strip stays in sync with the sidebar
 * (Invoices is a separate view and is intentionally excluded).
 */
export function getFinanceAccountsPages() {
    const mod = NAV_MODULES.find((m) => m.id === 'finance');
    if (!mod) return [];
    const byRoute = new Map(mod.pages.map((p) => [p.route, p]));
    const ordered = [];
    for (const entry of mod.navEntries || []) {
        if (entry.tabbed) continue;
        const page = byRoute.get(entry.route);
        if (page?.view === 'accounts' && page.subview) ordered.push(page);
    }
    return ordered;
}

/** Finance-New accounts shell tabs (excludes invoice billing view). */
export function getFinanceNewAccountsPages() {
    const mod = NAV_MODULES.find((m) => m.id === 'finance-new');
    if (!mod) return [];
    const byRoute = new Map(mod.pages.map((p) => [p.route, p]));
    const ordered = [];
    for (const entry of mod.navEntries || []) {
        if (entry.tabbed) continue;
        const page = byRoute.get(entry.route);
        if (page?.view === 'finance-new-accounts' && page.subview) ordered.push(page);
    }
    return ordered;
}

ACCOUNTS_SUBVIEW_ROUTES = Object.fromEntries(
    getFinanceAccountsPages().map((page) => [page.subview, page.route]),
);

export function buildPageCatalog() {
    return NAV_MODULES.flatMap((mod) =>
        mod.pages.map((page) => ({
            route: page.route,
            label: page.label,
            moduleId: mod.id,
            moduleLabel: mod.label,
            moduleIcon: mod.icon,
            permission: page.permission,
            altPermissions: page.altPermissions || [],
            hideFromNav: Boolean(page.hideFromNav),
        })),
    );
}

export function pageCatalogByModule(includeHidden = true) {
    const groups = new Map();
    buildPageCatalog().forEach((entry) => {
        if (!includeHidden && entry.hideFromNav) return;
        if (!groups.has(entry.moduleId)) {
            groups.set(entry.moduleId, {
                moduleId: entry.moduleId,
                moduleLabel: entry.moduleLabel,
                moduleIcon: entry.moduleIcon,
                pages: [],
            });
        }
        groups.get(entry.moduleId).pages.push(entry);
    });
    return Array.from(groups.values());
}

export function pageAllowedByPermissions(page, permSet) {
    if (!page?.permission) return false;
    const set = permSet instanceof Set ? permSet : new Set(permSet || []);
    if (!set.size) return false;
    if (set.has(page.permission)) return true;
    return (page.altPermissions || []).some((p) => set.has(p));
}

export function findCatalogPage(route) {
    return buildPageCatalog().find((p) => p.route === route) || null;
}

export const DEFAULT_ROUTE = 'dashboard';
export const PORTAL_DEFAULT_ROUTE = 'portal-home';
export const SECURITY_DEFAULT_ROUTE = 'security-gate';

export const getDefaultRoute = (role) => findFirstAllowedRoute(role);

export function findFirstAllowedRoute(role = portalState.auth?.role) {
    if (role === 'resident_viewer') return PORTAL_DEFAULT_ROUTE;
    if (role === 'security') return SECURITY_DEFAULT_ROUTE;
    const raw = portalState.authPermissions;
    // Unresolved or empty → no invented access; still try portal if that role, else dashboard for alert path
    const perms = Array.isArray(raw) && raw.length ? new Set(raw) : new Set();
    for (const mod of getNavModules()) {
        if (isNavHeading(mod) || !mod.pages?.length) continue;
        const accessId = mod.accessModuleId || mod.id;
        for (const page of mod.pages) {
            if (pageIsVisible(page, perms, false, accessId)) return page.route;
        }
    }
    return DEFAULT_ROUTE;
}

const legacyMap = new Map();
NAV_MODULES.forEach((mod) => {
    mod.pages.forEach((page) => {
        (page.legacy || []).forEach((old) => legacyMap.set(old, page.route));
    });
});

export const resolveRoute = (raw, role) => {
    const key = String(raw || '').trim().replace(/^#/, '');
    if (!key) return getDefaultRoute(role);
    if (findPage(key)) return key;
    if (legacyMap.has(key)) return legacyMap.get(key);
    return getDefaultRoute(role);
};

export const findPage = (route) => {
    for (const mod of NAV_MODULES) {
        const page = mod.pages.find((p) => p.route === route);
        if (page) return { module: mod, page };
    }
    return null;
};

export const pageIsVisible = (page, permSet, _offline = false, navModuleId = null) => {
    if (navModuleId && !isModuleEnabled(navModuleId)) return false;
    if (pageAccessBlocksRoute(page.route)) return false;
    // Pages must declare a permission — missing key = no access
    if (!page?.permission) return false;
    const set = permSet instanceof Set ? permSet : (permSet ? new Set(permSet) : null);
    // Empty / unresolved permissions → deny (least privilege; never "show everything")
    if (!set?.size) return false;
    // Roles is Society Admin only — page-access grants cannot unlock it
    if (page.route === 'admin-access') {
        const role = portalState.auth?.effectiveRoleKey;
        const isSocietyAdmin = portalState.auth?.isSystemAdmin === true
            || role === 'society_admin'
            || role === 'system_admin';
        return isSocietyAdmin && set.has('rbac.edit');
    }
    return set.has(page.permission)
        || (page.altPermissions || []).some((p) => set.has(p));
};

export const getModuleNavEntries = (mod) => {
    if (mod.tabbed) {
        return [{
            tabbed: true,
            label: mod.label,
            icon: mod.icon,
            defaultRoute: mod.defaultRoute || mod.pages[0]?.route,
            routes: mod.pages.map((p) => p.route),
        }];
    }
    if (mod.navEntries?.length) return mod.navEntries;
    return mod.pages.filter((p) => !p.hideFromNav).map((p) => ({ route: p.route }));
};

const navEntryRoute = (entry) => (entry.tabbed ? entry.defaultRoute : entry.route);

const navEntryIsActive = (entry, route) => {
    if (entry.tabbed) return entry.routes.includes(route);
    return entry.route === route;
};

const navEntryIsVisible = (entry, mod, permSet, offline) => {
    if (!isModuleEnabled(mod.id)) return false;
    if (entry.tabbed) {
        return entry.routes.some((r) => {
            const page = mod.pages.find((p) => p.route === r);
            return page && pageIsVisible(page, permSet, offline, mod.accessModuleId || mod.id);
        });
    }
    const page = mod.pages.find((p) => p.route === entry.route);
    return page && pageIsVisible(page, permSet, offline, mod.accessModuleId || mod.id);
};

const syncModuleExpansion = (route) => {
    getNavModules().forEach((mod) => {
        if (isNavHeading(mod)) return;
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;
        if (mod.tabbed) {
            modEl.classList.remove('nav-module--open');
            modEl.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', 'false');
            return;
        }
        const entries = getModuleNavEntries(mod);
        const isActive = entries.some((entry) => navEntryIsActive(entry, route));
        modEl.classList.toggle('nav-module--open', isActive);
        modEl.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', isActive ? 'true' : 'false');
    });
};

export const applyNavPermissions = (permSet, offline = false) => {
    getNavModules().forEach((mod) => {
        if (isNavHeading(mod)) return;
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;
        const accessId = mod.accessModuleId || mod.id;

        if (mod.tabbed) {
            const show = mod.pages.some((page) => pageIsVisible(page, permSet, offline, accessId));
            modEl.style.display = show ? 'block' : 'none';
            return;
        }

        const entries = getModuleNavEntries(mod);
        let visiblePages = 0;
        entries.forEach((entry) => {
            const btn = modEl.querySelector(`.nav-page-btn[data-nav-route="${navEntryRoute(entry)}"]`);
            if (!btn) return;
            const show = navEntryIsVisible(entry, mod, permSet, offline);
            btn.style.display = show ? 'flex' : 'none';
            if (show) visiblePages += 1;
        });

        modEl.style.display = visiblePages ? 'block' : 'none';
    });

    document.querySelectorAll('[data-nav-heading]').forEach((el) => {
        const any = getNavModules().some((mod) => {
            if (!mod.oldGroup) return false;
            const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
            return modEl && modEl.style.display !== 'none';
        });
        el.style.display = any ? '' : 'none';
    });

    Object.entries(ACCOUNTS_SUBVIEW_ROUTES).forEach(([subview, route]) => {
        const btn = document.querySelector(`[data-accounts-subview="${subview}"]`);
        if (!btn) return;
        const meta = findPage(route);
        const show = meta && pageIsVisible(meta.page, permSet, offline, meta.module.id);
        btn.style.display = show ? 'inline-flex' : 'none';
    });

    Object.entries(SETUP_SUBVIEW_ROUTES).forEach(([subview, route]) => {
        const btn = document.querySelector(`[data-setup-subview="${subview}"]`);
        if (!btn) return;
        const meta = findPage(route);
        const show = meta && pageIsVisible(meta.page, permSet, offline, meta.module.id);
        btn.style.display = show ? 'inline-flex' : 'none';
    });

    // Refresh accounts header (Bank Sync etc.) once permissions + lazy tabs are present.
    if (document.getElementById('view-accounts') && typeof window.syncAccountsHeaderActions === 'function') {
        const active = document.querySelector('[data-accounts-subview].active');
        window.syncAccountsHeaderActions(active?.dataset?.accountsSubview || 'ledger');
    }
};

export const updateNavActiveState = (route) => {
    document.querySelectorAll('.nav-page-btn').forEach((btn) => {
        const tabRoutes = btn.dataset.tabRoutes?.split(',').filter(Boolean) || [];
        const active = btn.dataset.route === route || tabRoutes.includes(route);
        btn.classList.toggle('active', active);
    });

    getNavModules().forEach((mod) => {
        if (isNavHeading(mod)) return;
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;
        const entries = getModuleNavEntries(mod);
        const hasActive = mod.tabbed
            ? mod.pages.some((p) => p.route === route)
            : entries.some((entry) => navEntryIsActive(entry, route));
        modEl.classList.toggle('nav-module--active', hasActive);
        modEl.querySelector('.nav-module-toggle')?.classList.toggle('active', hasActive);
    });

    syncModuleExpansion(route);
};

export const updateNavBreadcrumb = (route) => {
    const meta = findPage(route);
    const shown = getNavModules().find((m) => m.pages.some((p) => p.route === route));
    const moduleEl = document.getElementById('topbar-nav-module');
    const pageEl = document.getElementById('topbar-nav-page');
    const chev = document.querySelector('.topbar-breadcrumb > .fa-chevron-right');
    const showPage = (text) => {
        if (pageEl) {
            pageEl.textContent = text || '';
            pageEl.hidden = !text;
        }
        if (chev) chev.style.display = text ? '' : 'none';
    };
    if (!meta) {
        if (moduleEl) moduleEl.textContent = 'Property';
        showPage('Parking & Vehicles');
        return;
    }
    if (shown?.tabbed) {
        if (moduleEl) moduleEl.textContent = shown.label;
        showPage('');
        return;
    }
    if (moduleEl) moduleEl.textContent = shown?.label || meta.module.label;
    showPage(meta.page.label);
};

const renderNavPageButtons = (mod) => {
    const entries = getModuleNavEntries(mod);
    return entries.map((entry) => {
        if (entry.tabbed) {
            return `
            <button type="button" class="nav-page-btn nav-page-btn--tabbed"
              data-route="${entry.defaultRoute}"
              data-nav-route="${entry.defaultRoute}"
              data-tab-routes="${entry.routes.join(',')}">
              <i class="fa-solid ${entry.icon}" aria-hidden="true"></i>
              <span>${entry.label}</span>
            </button>`;
        }
        const page = mod.pages.find((p) => p.route === entry.route);
        if (!page) return '';
        const island = getUiMode() !== 'classic' && routeIsClassicIsland(page.route);
        const islandHint = island ? ' title="Classic screen (Supabase)"' : '';
        const islandMark = island
            ? ' <span class="nav-island-dot" title="Classic (Supabase)" aria-hidden="true"></span>'
            : '';
        return `
            <button type="button" class="nav-page-btn${island ? ' nav-page-btn--island' : ''}"
              data-route="${page.route}"
              data-nav-route="${page.route}"${islandHint}>
              <i class="fa-solid ${page.icon}" aria-hidden="true"></i>
              <span>${page.label}</span>${islandMark}
            </button>`;
    }).join('');
};

export const renderNavModules = () => {
    const container = document.getElementById('nav-modules');
    if (!container) return;

    container.innerHTML = getNavModules().map((mod) => {
        if (isNavHeading(mod)) {
            return `<p class="nav-old-heading" data-nav-heading="old">${mod.navHeading}</p>`;
        }
        const entryRoute = mod.tabbed ? (mod.defaultRoute || mod.pages[0]?.route) : null;
        const islandTitle = mod.classicIsland ? ` title="${mod.label} (classic · Supabase)"` : '';
        return `
      <div class="nav-module${mod.tabbed ? ' nav-module--tabbed' : ''}${mod.classicIsland ? ' nav-module--island' : ''}" data-module="${mod.id}">
        <button type="button" class="nav-module-toggle" aria-expanded="false"
          ${entryRoute ? `data-route="${entryRoute}"` : ''}
          ${mod.tabbed ? '' : `aria-controls="nav-sub-${mod.id}"`}${islandTitle}>
          <span class="nav-module-toggle__lead">
            <i class="fa-solid ${mod.icon}" aria-hidden="true"></i>
            ${mod.classicIsland && getUiMode() !== 'classic' ? '<span class="nav-island-dot nav-island-dot--mod" title="Classic (Supabase)" aria-hidden="true"></span>' : ''}
            <span class="nav-module-toggle__label">${mod.label}</span>
          </span>
          ${mod.tabbed ? '' : '<i class="fa-solid fa-chevron-down nav-module-toggle__chevron" aria-hidden="true"></i>'}
        </button>
        ${mod.tabbed ? '' : `
        <div class="nav-module-pages" id="nav-sub-${mod.id}" role="group" aria-label="${mod.label}">
          ${renderNavPageButtons(mod)}
        </div>`}
      </div>
    `;
    }).join('');
};

export const initNavInteraction = (onNavigate) => {
    const container = document.getElementById('nav-modules');
    if (!container || container.dataset.wired) return;
    container.dataset.wired = '1';

    container.addEventListener('click', (e) => {
        const pageBtn = e.target.closest('.nav-page-btn');
        if (pageBtn?.dataset?.route) {
            if (isNewUi()) {
                const mobile = window.matchMedia('(max-width: 820px)').matches;
                if (mobile || isMpaNavCollapsedPref()) {
                    applyMpaNavCollapsed(true, { persist: !mobile });
                }
            } else {
                document.body.classList.remove('nav-expanded');
            }
            const tabRoutes = pageBtn.dataset.tabRoutes?.split(',').filter(Boolean) || [];
            let route = pageBtn.dataset.route;
            if (tabRoutes.length) {
                const perms = new Set(portalState.authPermissions || []);
                const firstVisible = tabRoutes.find((r) => {
                    const meta = findPage(r);
                    return meta && pageIsVisible(meta.page, perms, false, meta.module.id);
                });
                if (firstVisible) route = firstVisible;
            }
            onNavigate?.(route);
            return;
        }

        const toggle = e.target.closest('.nav-module-toggle');
        if (!toggle) return;

        if (toggle.dataset?.route) {
            if (isNewUi()) {
                const mobile = window.matchMedia('(max-width: 820px)').matches;
                if (mobile || isMpaNavCollapsedPref()) {
                    applyMpaNavCollapsed(true, { persist: !mobile });
                }
            } else {
                document.body.classList.remove('nav-expanded');
            }
            onNavigate?.(toggle.dataset.route);
            return;
        }

        const modEl = toggle.closest('.nav-module');
        if (!modEl) return;

        if (!document.body.classList.contains('nav-expanded')) {
            if (isNewUi()) applyMpaNavCollapsed(false, { persist: false });
            else document.body.classList.add('nav-expanded');
            getNavModules().forEach((mod) => {
                const el = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
                if (!el) return;
                const open = mod.id === modEl.dataset.module;
                el.classList.toggle('nav-module--open', open);
                el.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
            return;
        }

        const isOpen = modEl.classList.toggle('nav-module--open');
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

        if (isOpen) {
            document.querySelectorAll('.nav-module').forEach((el) => {
                if (el === modEl) return;
                el.classList.remove('nav-module--open');
                el.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', 'false');
            });
        }
    });
};
