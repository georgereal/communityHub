/** Admin-New MPA pages — one concern per route. */
export const ADMIN_PAGES = [
    {
        route: 'an-society',
        path: '/society',
        href: '/admin/society',
        label: 'Society profile',
        subtitle: 'Display name, parking defaults, and which modules staff can see.',
        icon: 'fa-building',
    },
    {
        route: 'an-people',
        path: '/people',
        href: '/admin/people',
        label: 'People & access',
        subtitle: 'Approve sign-in requests and manage who can use this society.',
        icon: 'fa-user-shield',
    },
    {
        route: 'an-vendors',
        path: '/vendors',
        href: '/admin/vendors',
        label: 'Vendors',
        subtitle: 'Payees used on expenses and bills.',
        icon: 'fa-truck-field',
    },
    {
        route: 'an-categories',
        path: '/categories',
        href: '/admin/categories',
        label: 'Sub-categories',
        subtitle: 'Expense labels grouped under each category.',
        icon: 'fa-tags',
    },
    {
        route: 'an-staff',
        path: '/staff',
        href: '/admin/staff',
        label: 'Staff directory',
        subtitle: 'On-site staff records (not login accounts).',
        icon: 'fa-users-gear',
    },
    {
        route: 'an-integrations',
        path: '/integrations',
        href: '/admin/integrations',
        label: 'Integrations',
        subtitle: 'External services for this society — API connections and spreadsheet sync.',
        icon: 'fa-plug',
    },
    {
        route: 'an-activity',
        path: '/activity',
        href: '/admin/activity',
        label: 'Activity',
        subtitle: 'Society-wide audit trail and integration job runs.',
        icon: 'fa-clock-rotate-left',
    },
    {
        route: 'an-roles',
        path: '/roles',
        href: '/admin/roles',
        label: 'Roles',
        subtitle: 'CRUD for each society role. Pages follow Read.',
        icon: 'fa-user-lock',
    },
];

export const ADMIN_PAGE_BY_ROUTE = Object.fromEntries(ADMIN_PAGES.map((p) => [p.route, p]));

export function adminPageFromPathname(pathname = window.location.pathname) {
    const raw = String(pathname || '').replace(/\/$/, '') || '/admin';
    const rest = raw.replace(/^\/admin/, '') || '/';
    return ADMIN_PAGES.find((p) => p.path === rest) || ADMIN_PAGES[0];
}
