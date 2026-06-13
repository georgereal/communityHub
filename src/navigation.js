/**
 * App navigation: modules, pages, routing, and permission gating
 */

export const NAV_MODULES = [
    {
        id: 'property',
        label: 'Property',
        icon: 'fa-building',
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
        ],
    },
    {
        id: 'finance',
        label: 'Finance',
        icon: 'fa-coins',
        pages: [
            {
                route: 'finance-ledger',
                label: 'Cash & Bank Ledger',
                icon: 'fa-book',
                view: 'accounts',
                subview: 'ledger',
                permission: 'accounts.view',
                legacy: ['accounts', 'treasury-ledger'],
            },
            {
                route: 'finance-billing',
                label: 'Maintenance Billing',
                icon: 'fa-file-invoice',
                view: 'invoices',
                permission: 'accounts.edit',
                legacy: ['invoices', 'treasury-billing'],
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
        ],
    },
    {
        id: 'admin',
        label: 'Administration',
        icon: 'fa-gear',
        pages: [
            {
                route: 'admin-settings',
                label: 'Society Settings',
                icon: 'fa-sliders',
                view: 'setup',
                permission: 'setup.view',
                altPermissions: ['rbac.view', 'system.apartments.manage'],
                legacy: ['setup'],
            },
        ],
    },
];

export const DEFAULT_ROUTE = 'property-vehicles';

const legacyMap = new Map();
NAV_MODULES.forEach((mod) => {
    mod.pages.forEach((page) => {
        (page.legacy || []).forEach((old) => legacyMap.set(old, page.route));
    });
});

export const resolveRoute = (raw) => {
    const key = String(raw || '').trim().replace(/^#/, '');
    if (!key) return DEFAULT_ROUTE;
    if (findPage(key)) return key;
    if (legacyMap.has(key)) return legacyMap.get(key);
    return DEFAULT_ROUTE;
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

const syncModuleExpansion = (route) => {
    NAV_MODULES.forEach((mod) => {
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;
        const isActive = mod.pages.some((p) => p.route === route);
        modEl.classList.toggle('nav-module--open', isActive);
        modEl.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', isActive ? 'true' : 'false');
    });
};

export const applyNavPermissions = (permSet, offline = false) => {
    NAV_MODULES.forEach((mod) => {
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;

        let visiblePages = 0;
        mod.pages.forEach((page) => {
            const btn = modEl.querySelector(`.nav-page-btn[data-route="${page.route}"]`);
            if (!btn) return;
            const show = pageIsVisible(page, permSet, offline);
            btn.style.display = show ? 'flex' : 'none';
            if (show) visiblePages += 1;
        });

        modEl.style.display = visiblePages ? 'block' : 'none';
    });
};

export const updateNavActiveState = (route) => {
    document.querySelectorAll('.nav-page-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.route === route);
    });

    NAV_MODULES.forEach((mod) => {
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;
        const hasActive = mod.pages.some((p) => p.route === route);
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

export const renderNavModules = () => {
    const container = document.getElementById('nav-modules');
    if (!container) return;

    container.innerHTML = NAV_MODULES.map((mod) => `
      <div class="nav-module" data-module="${mod.id}">
        <button type="button" class="nav-module-toggle" aria-expanded="false" aria-controls="nav-sub-${mod.id}">
          <span class="nav-module-toggle__lead">
            <i class="fa-solid ${mod.icon}" aria-hidden="true"></i>
            <span class="nav-module-toggle__label">${mod.label}</span>
          </span>
          <i class="fa-solid fa-chevron-down nav-module-toggle__chevron" aria-hidden="true"></i>
        </button>
        <div class="nav-module-pages" id="nav-sub-${mod.id}" role="group" aria-label="${mod.label}">
          ${mod.pages.map((page) => `
            <button type="button" class="nav-page-btn" data-route="${page.route}">
              <i class="fa-solid ${page.icon}" aria-hidden="true"></i>
              <span>${page.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');
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
