/**
 * App navigation: modules, pages, routing, and permission gating
 */

const OPERATIONS_ROUTES = [
    'ops-helpdesk', 'ops-transitions', 'ops-notices', 'ops-assets',
    'ops-amenities', 'ops-visitors', 'ops-payroll',
];

const TREASURY_ROUTES = [
    'finance-ledger', 'finance-bank-recon', 'finance-activity', 'finance-reports', 'finance-gl',
];

export const NAV_MODULES = [
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
        id: 'finance',
        label: 'Finance',
        icon: 'fa-coins',
        navEntries: [
            { route: 'finance-billing-list' },
            { route: 'finance-billing-flats' },
            { route: 'finance-billing-collections' },
            { route: 'finance-billing-batches' },
            { route: 'finance-billing-aging' },
            { route: 'finance-parking-fines' },
            { route: 'finance-ledger' },
            { route: 'finance-bank-recon' },
            { route: 'finance-activity' },
            { route: 'finance-reports' },
            { route: 'finance-gl' },
        ],
        pages: [
            {
                route: 'finance-ledger',
                label: 'Income & Expenses',
                icon: 'fa-book',
                view: 'accounts',
                subview: 'ledger',
                permission: 'accounts.view',
                legacy: ['accounts', 'treasury-ledger'],
            },
            {
                route: 'finance-billing-list',
                label: 'Invoices List',
                icon: 'fa-file-invoice',
                view: 'invoices',
                subview: 'list',
                permission: 'accounts.edit',
                legacy: ['finance-billing', 'invoices', 'treasury-billing'],
            },
            {
                route: 'finance-billing-flats',
                label: 'Invoices by Flat',
                icon: 'fa-house-user',
                view: 'invoices',
                subview: 'by-flat',
                permission: 'accounts.edit',
            },
            {
                route: 'finance-billing-collections',
                label: 'Collections',
                icon: 'fa-hand-holding-dollar',
                view: 'invoices',
                subview: 'collections',
                permission: 'accounts.edit',
            },
            {
                route: 'finance-billing-batches',
                label: 'Billing Batches',
                icon: 'fa-layer-group',
                view: 'invoices',
                subview: 'batches',
                permission: 'accounts.edit',
            },
            {
                route: 'finance-billing-aging',
                label: 'Aging Report',
                icon: 'fa-hourglass-half',
                view: 'invoices',
                subview: 'aging',
                permission: 'accounts.edit',
            },
            {
                route: 'finance-parking-fines',
                label: 'Parking Fines',
                icon: 'fa-triangle-exclamation',
                view: 'parking-fines',
                permission: 'vehicle_registry.edit',
                legacy: ['property-parking-fines'],
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
                route: 'finance-activity',
                label: 'Activity Log',
                icon: 'fa-clock-rotate-left',
                view: 'accounts',
                subview: 'activity',
                permission: 'accounts.view',
                altPermissions: ['rbac.view'],
            },
            {
                route: 'finance-reports',
                label: 'Financial Reports',
                icon: 'fa-chart-line',
                view: 'accounts',
                subview: 'reports',
                permission: 'accounts.view',
                legacy: ['treasury-reports'],
            },
            {
                route: 'finance-gl',
                label: 'General Ledger',
                icon: 'fa-book-open',
                view: 'accounts',
                subview: 'gl',
                permission: 'accounts.edit',
            },
        ],
    },
    {
        id: 'admin',
        label: 'Administration',
        icon: 'fa-gear',
        pages: [
            {
                route: 'admin-society',
                label: 'Society Profile',
                icon: 'fa-building-user',
                view: 'setup',
                subview: 'society',
                permission: 'setup.view',
                altPermissions: ['rbac.view', 'system.apartments.manage'],
                legacy: ['admin-settings', 'setup'],
            },
            {
                route: 'admin-bank',
                label: 'Bank Account',
                icon: 'fa-building-columns',
                view: 'setup',
                subview: 'bank',
                permission: 'setup.view',
            },
            {
                route: 'admin-vendors',
                label: 'Vendors',
                icon: 'fa-truck-field',
                view: 'setup',
                subview: 'vendors',
                permission: 'setup.view',
            },
            {
                route: 'admin-subcats',
                label: 'Sub-categories',
                icon: 'fa-tags',
                view: 'setup',
                subview: 'subcats',
                permission: 'setup.view',
            },
            {
                route: 'admin-staff',
                label: 'Staff Directory',
                icon: 'fa-users-gear',
                view: 'setup',
                subview: 'staff',
                permission: 'setup.view',
            },
            {
                route: 'admin-sync',
                label: 'Spreadsheet Sync',
                icon: 'fa-table-columns',
                view: 'setup',
                subview: 'sync',
                permission: 'accounts.edit',
            },
            {
                route: 'admin-portfolio',
                label: 'Portfolio Rollup',
                icon: 'fa-layer-group',
                view: 'portfolio',
                permission: 'setup.view',
                altPermissions: ['rbac.view'],
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

export const DEFAULT_ROUTE = 'property-vehicles';
export const PORTAL_DEFAULT_ROUTE = 'portal-home';
export const SECURITY_DEFAULT_ROUTE = 'security-gate';

export const getDefaultRoute = (role) => {
    if (role === 'resident_viewer') return PORTAL_DEFAULT_ROUTE;
    if (role === 'security') return SECURITY_DEFAULT_ROUTE;
    return DEFAULT_ROUTE;
};

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

export const pageIsVisible = (page, permSet, offline = false) => {
    if (offline && page.permission === 'vehicle_registry.view') return true;
    if (!permSet?.size) return true;
    if (permSet.has(page.permission)) return true;
    return (page.altPermissions || []).some((p) => permSet.has(p));
};

const getModuleNavEntries = (mod) => {
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
    return mod.pages.map((p) => ({ route: p.route }));
};

const navEntryRoute = (entry) => (entry.tabbed ? entry.defaultRoute : entry.route);

const navEntryIsActive = (entry, route) => {
    if (entry.tabbed) return entry.routes.includes(route);
    return entry.route === route;
};

const navEntryIsVisible = (entry, mod, permSet, offline) => {
    if (entry.tabbed) {
        return entry.routes.some((r) => {
            const page = mod.pages.find((p) => p.route === r);
            return page && pageIsVisible(page, permSet, offline);
        });
    }
    const page = mod.pages.find((p) => p.route === entry.route);
    return page && pageIsVisible(page, permSet, offline);
};

const syncModuleExpansion = (route) => {
    NAV_MODULES.forEach((mod) => {
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
    NAV_MODULES.forEach((mod) => {
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;

        if (mod.tabbed) {
            const show = mod.pages.some((page) => pageIsVisible(page, permSet, offline));
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

export const updateNavActiveState = (route) => {
    document.querySelectorAll('.nav-page-btn').forEach((btn) => {
        const tabRoutes = btn.dataset.tabRoutes?.split(',').filter(Boolean) || [];
        const active = btn.dataset.route === route || tabRoutes.includes(route);
        btn.classList.toggle('active', active);
    });

    NAV_MODULES.forEach((mod) => {
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
    const moduleEl = document.getElementById('topbar-nav-module');
    const pageEl = document.getElementById('topbar-nav-page');
    if (!meta) {
        if (moduleEl) moduleEl.textContent = 'Property';
        if (pageEl) pageEl.textContent = 'Parking & Vehicles';
        return;
    }
    if (moduleEl) moduleEl.textContent = meta.module.label;
    if (pageEl) pageEl.textContent = meta.page.label;
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
        return `
            <button type="button" class="nav-page-btn"
              data-route="${page.route}"
              data-nav-route="${page.route}">
              <i class="fa-solid ${page.icon}" aria-hidden="true"></i>
              <span>${page.label}</span>
            </button>`;
    }).join('');
};

export const renderNavModules = () => {
    const container = document.getElementById('nav-modules');
    if (!container) return;

    container.innerHTML = NAV_MODULES.map((mod) => {
        const entryRoute = mod.tabbed ? (mod.defaultRoute || mod.pages[0]?.route) : null;
        return `
      <div class="nav-module${mod.tabbed ? ' nav-module--tabbed' : ''}" data-module="${mod.id}">
        <button type="button" class="nav-module-toggle" aria-expanded="false"
          ${entryRoute ? `data-route="${entryRoute}"` : ''}
          ${mod.tabbed ? '' : `aria-controls="nav-sub-${mod.id}"`}>
          <span class="nav-module-toggle__lead">
            <i class="fa-solid ${mod.icon}" aria-hidden="true"></i>
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
            document.body.classList.remove('nav-expanded');
            onNavigate?.(pageBtn.dataset.route);
            return;
        }

        const toggle = e.target.closest('.nav-module-toggle');
        if (!toggle) return;

        if (toggle.dataset?.route) {
            document.body.classList.remove('nav-expanded');
            onNavigate?.(toggle.dataset.route);
            return;
        }

        const modEl = toggle.closest('.nav-module');
        if (!modEl) return;

        if (!document.body.classList.contains('nav-expanded')) {
            document.body.classList.add('nav-expanded');
            NAV_MODULES.forEach((mod) => {
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
