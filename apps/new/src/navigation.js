/**
 * New UI navigation — MPA routes only. Classic SPA pages are not listed.
 */
import { isModuleEnabled } from './moduleAccess.js';
import { portalState } from './store.js';

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
                permission: 'vehicle_registry.view',
                altPermissions: ['apartment_mgmt.view', 'accounts.view', 'setup.view'],
            },
        ],
    },
    {
        id: 'property',
        label: 'Property',
        icon: 'fa-building',
        navEntries: [
            { route: 'pn-units' },
            { route: 'pn-vehicles' },
            { route: 'pn-residents' },
        ],
        pages: [
            { route: 'pn-units', label: 'Unit Directory', icon: 'fa-door-open', permission: 'apartment_mgmt.view' },
            { route: 'pn-vehicles', label: 'Parking & Vehicles', icon: 'fa-car', permission: 'vehicle_registry.view' },
            { route: 'pn-residents', label: 'Residents', icon: 'fa-user-group', permission: 'apartment_mgmt.view' },
        ],
    },
    {
        id: 'finance',
        label: 'Finance',
        icon: 'fa-coins',
        navEntries: [
            { route: 'fn-reports' },
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
                route: 'fn-invoices-raised',
                label: 'Invoices Raised',
                icon: 'fa-file-invoice',
                view: 'finance-new-accounts',
                subview: 'invoices-raised',
                permission: 'accounts.view',
            },
            {
                route: 'fn-bank-recon',
                label: 'Bank Reconciliation',
                icon: 'fa-scale-balanced',
                view: 'finance-new-accounts',
                subview: 'bank-recon',
                permission: 'accounts.view',
            },
        ],
    },
    {
        id: 'admin',
        label: 'Administration',
        icon: 'fa-gear',
        navEntries: [
            { route: 'an-society' },
            { route: 'an-people' },
            { route: 'an-vendors' },
            { route: 'an-categories' },
            { route: 'an-staff' },
            { route: 'an-integrations' },
            { route: 'an-roles' },
        ],
        pages: [
            { route: 'an-society', label: 'Society profile', icon: 'fa-building', permission: 'setup.view' },
            { route: 'an-people', label: 'People & access', icon: 'fa-user-shield', permission: 'setup.edit', altPermissions: ['rbac.edit'] },
            { route: 'an-vendors', label: 'Vendors', icon: 'fa-truck-field', permission: 'setup.edit', altPermissions: ['accounts.edit'] },
            { route: 'an-categories', label: 'Sub-categories', icon: 'fa-tags', permission: 'setup.edit', altPermissions: ['accounts.edit'] },
            { route: 'an-staff', label: 'Staff directory', icon: 'fa-users-gear', permission: 'setup.edit' },
            { route: 'an-integrations', label: 'Integrations', icon: 'fa-plug', permission: 'setup.view' },
            { route: 'an-roles', label: 'Roles', icon: 'fa-user-lock', permission: 'rbac.edit' },
        ],
    },
];

export function isNavHeading() {
    return false;
}

export function getNavModules() {
    return NAV_MODULES;
}

export function pageAccessBlocksRoute(route) {
    const role = portalState.auth?.effectiveRoleKey;
    const map = role && portalState.pageAccess?.societyRole?.[role];
    if (map && Object.prototype.hasOwnProperty.call(map, route)) return map[route] === false;
    return false;
}

export function pageIsVisible(page, permSet, _offline = false, navModuleId = null) {
    if (navModuleId && !isModuleEnabled(navModuleId)) return false;
    if (pageAccessBlocksRoute(page.route)) return false;
    if (!page?.permission) return false;
    const set = permSet instanceof Set ? permSet : (permSet ? new Set(permSet) : null);
    if (!set?.size) return false;
    if (page.route === 'an-roles') {
        const role = portalState.auth?.effectiveRoleKey;
        const isSocietyAdmin = portalState.auth?.isSystemAdmin === true
            || role === 'society_admin'
            || role === 'system_admin';
        return isSocietyAdmin && set.has('rbac.edit');
    }
    return set.has(page.permission)
        || (page.altPermissions || []).some((p) => set.has(p));
}

export function pageAllowedByPermissions(page, permSet) {
    if (!page?.permission) return false;
    const set = permSet instanceof Set ? permSet : new Set(permSet || []);
    if (!set.size) return false;
    if (set.has(page.permission)) return true;
    return (page.altPermissions || []).some((p) => set.has(p));
}

export const findPage = (route) => {
    for (const mod of NAV_MODULES) {
        const page = mod.pages.find((p) => p.route === route);
        if (page) return { module: mod, page };
    }
    return null;
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

const navEntryRoute = (entry) => (entry.tabbed ? entry.defaultRoute : entry.route);

const navEntryIsVisible = (entry, mod, permSet, offline) => {
    if (!isModuleEnabled(mod.id)) return false;
    if (entry.tabbed) {
        return entry.routes.some((r) => {
            const page = mod.pages.find((p) => p.route === r);
            return page && pageIsVisible(page, permSet, offline, mod.id);
        });
    }
    const page = mod.pages.find((p) => p.route === entry.route);
    return page && pageIsVisible(page, permSet, offline, mod.id);
};

export const applyNavPermissions = (permSet, offline = false) => {
    getNavModules().forEach((mod) => {
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;
        if (mod.tabbed) {
            const show = mod.pages.some((page) => pageIsVisible(page, permSet, offline, mod.id));
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
};

export function getFinanceNewAccountsPages() {
    const mod = NAV_MODULES.find((m) => m.id === 'finance');
    return (mod?.pages || []).filter((p) => p.view === 'finance-new-accounts');
}

export let ACCOUNTS_SUBVIEW_ROUTES = Object.fromEntries(
    getFinanceNewAccountsPages().map((page) => [page.subview, page.route]),
);

export const DEFAULT_ROUTE = 'dashboard';
