/**
 * Route → state domain mapping and lazy loading helpers.
 */
import { findPage } from './navigation.js';

export const STATE_DOMAINS = ['core', 'property', 'finance', 'operations', 'security', 'portal', 'admin', 'parking'];

const VIEW_DOMAINS = {
    dashboard: ['core', 'admin'],
    registry: ['property'],
    accounts: ['finance', 'admin'],
    invoices: ['finance'],
    portal: ['portal', 'finance'],
    security: ['security', 'property'],
    operations: ['operations', 'property'],
    units: ['property'],
    apartment: ['property'],
    'parking-fines': ['parking', 'finance', 'property'],
    portfolio: ['core', 'finance', 'property'],
    email: ['operations'],
    setup: ['admin', 'finance'],
    'access-control': [],
};

const ROUTE_DOMAIN_OVERRIDES = {
    'property-activity': ['operations'],
    'finance-activity': ['operations'],
    'admin-settings': ['admin', 'finance'],
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
