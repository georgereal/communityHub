/**
 * Route → state domain mapping and lazy loading helpers.
 */
import { findPage } from './navigation.js';

export const STATE_DOMAINS = ['core', 'property', 'finance', 'operations', 'security', 'portal', 'admin'];

/** Domains loaded when entering each top-level view (via ensureRouteState). */
const VIEW_DOMAINS = {
    // Dashboard: core + ops load progressively from renderDashboard (cancellable).
    dashboard: [],
    registry: ['property'],
    accounts: ['finance', 'admin'],
    invoices: ['finance'],
    // Portal domain already includes open invoices + allocations for residents.
    portal: ['portal'],
    security: ['security', 'property'],
    // Unit move-in/out loads finance on demand when dues are checked.
    operations: ['operations', 'property'],
    units: ['property'],
    apartment: ['property'],
    // Portfolio fetches per-apartment snapshots itself.
    portfolio: ['core'],
    email: ['operations'],
    // Setup shell needs admin (bank/staff/vendors). Full finance only for sync.
    setup: ['admin'],
    'access-control': [],
};

const ROUTE_DOMAIN_OVERRIDES = {
    'admin-activity': ['operations'],
    'admin-settings': ['admin'],
    'admin-sync': ['admin', 'finance'],
};

export function domainsForRoute(route) {
    if (ROUTE_DOMAIN_OVERRIDES[route]) return [...ROUTE_DOMAIN_OVERRIDES[route]];
    const meta = findPage(route);
    if (!meta?.page?.view) return ['core'];
    const base = VIEW_DOMAINS[meta.page.view] || ['core'];
    return [...base];
}

export function domainsForRoutes(routes = []) {
    const set = new Set();
    routes.forEach((route) => domainsForRoute(route).forEach((d) => set.add(d)));
    return [...set];
}
