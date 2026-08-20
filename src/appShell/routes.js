/**
 * MPA route registry — maps nav routes to real HTML pages.
 * Grow this as modules leave the SPA.
 */
import { FINANCE_PAGES } from '../financeApp/session.js';

/** @type {Record<string, string>} */
export const MPA_ROUTE_PATHS = {
    'fn-reports': FINANCE_PAGES.reports.path,
    'fn-ledger': FINANCE_PAGES.ledger.path,
    'fn-docs': FINANCE_PAGES.docs.path,
    'fn-expense-plan': FINANCE_PAGES['expense-plan'].path,
    'fn-invoices-raised': FINANCE_PAGES['invoices-raised'].path,
    'fn-bank-recon': FINANCE_PAGES['bank-recon'].path,
    'pn-residents': '/residents/',
    'pn-vehicles': '/parking/',
    'pn-units': '/units/',
};

/** SPA hash fallback until a route has an MPA entry. */
export function hrefForRoute(route) {
    if (!route) return '/';
    const mpa = MPA_ROUTE_PATHS[route];
    if (mpa) return mpa;
    return `/#${route}`;
}

export function isMpaRoute(route) {
    return Boolean(MPA_ROUTE_PATHS[route]);
}

export function navigateToRoute(route) {
    const href = hrefForRoute(route);
    if (href.startsWith('/#') || href === '/') {
        window.location.assign(href);
        return;
    }
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    const target = href.replace(/\/$/, '') || '/';
    if (path === target) return;
    window.location.assign(href);
}
