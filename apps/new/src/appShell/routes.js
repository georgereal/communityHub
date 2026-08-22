/**
 * MPA route registry — maps nav routes to real HTML pages.
 * Grow this as modules leave the SPA.
 */
import { FINANCE_PAGES } from '../financeApp/session.js';

/** @type {Record<string, string>} */
export const MPA_ROUTE_PATHS = {
    dashboard: '/home',
    'fn-reports': FINANCE_PAGES.reports.path,
    'fn-ledger': FINANCE_PAGES.ledger.path,
    'fn-docs': FINANCE_PAGES.docs.path,
    'fn-expense-plan': FINANCE_PAGES['expense-plan'].path,
    'fn-invoices-raised': FINANCE_PAGES['invoices-raised'].path,
    'fn-bank-recon': FINANCE_PAGES['bank-recon'].path,
    'pn-residents': '/residents',
    'pn-vehicles': '/parking',
    'pn-units': '/units',
    // No trailing slash — Vercel 404s /admin/foo/ while /admin/foo rewrites to the SPA shell.
    'an-society': '/admin/society',
    'an-people': '/admin/people',
    'an-vendors': '/admin/vendors',
    'an-categories': '/admin/categories',
    'an-staff': '/admin/staff',
    'an-integrations': '/admin/integrations',
    'an-activity': '/admin/activity',
    'an-roles': '/admin/roles',
};

/** SPA hash fallback until a route has an MPA entry. */
export function hrefForRoute(route) {
    if (!route) return '/home';
    return MPA_ROUTE_PATHS[route] || '/home';
}

export function isMpaRoute(route) {
    return Boolean(MPA_ROUTE_PATHS[route]);
}

export function mpaShellKey(pathname) {
    const p = String(pathname || '').replace(/\/$/, '') || '/';
    if (p === '/home' || p.startsWith('/home/')) return 'home';
    if (p === '/admin' || p.startsWith('/admin/')) return 'admin';
    if (p === '/residents' || p.startsWith('/residents/')) return 'residents';
    if (p === '/parking' || p.startsWith('/parking/')) return 'parking';
    if (p === '/units' || p.startsWith('/units/')) return 'units';
    return null;
}

function normalizeMpaHref(href) {
    const url = new URL(href, 'http://local');
    const shell = mpaShellKey(url.pathname);
    // SPA shells: drop trailing slash so Vercel rewrite hits /admin/foo not /admin/foo/
    if (shell && url.pathname.length > 1 && url.pathname.endsWith('/')) {
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    }
    return `${url.pathname}${url.search || ''}`;
}

export function navigateToRoute(route) {
    const href = normalizeMpaHref(hrefForRoute(route));
    if (href.startsWith('/#') || href === '/') {
        window.location.assign(href);
        return;
    }
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    const targetUrl = new URL(href, window.location.origin);
    const target = targetUrl.pathname.replace(/\/$/, '') || '/';

    // Finance pages are separate HTML files — always full document load when leaving/entering.
    const targetIsFinance = target.startsWith('/finance');
    const hereIsFinance = path.startsWith('/finance');
    if (targetIsFinance || hereIsFinance) {
        if (
            path === target
            && document.documentElement.dataset.financeApp === '1'
            && document.documentElement.dataset.adminApp !== '1'
        ) {
            return;
        }
        void import('./forceDocumentNav.js').then((m) => m.forceDocumentNavigation(href));
        return;
    }

    if (path === target) return;

    const here = mpaShellKey(window.location.pathname);
    const there = mpaShellKey(targetUrl.pathname);
    // Same React shell → in-app. Different app → full document load.
    if (here && there && here === there) {
        window.dispatchEvent(new CustomEvent('ch-mpa-inapp-nav', {
            detail: { href: `${targetUrl.pathname}${targetUrl.search || ''}`, route },
        }));
        return;
    }
    window.location.assign(href);
}
