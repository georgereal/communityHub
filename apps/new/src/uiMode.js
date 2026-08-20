/**
 * App UI mode: `new` (default, Mongo identity + RBAC + property/finance) vs `classic` (Postgres screens).
 * Auth session stays on Supabase. Cookie `ch_ui_mode` is what the API reads.
 */
const STORAGE_KEY = 'ch_ui_mode';
const COOKIE = 'ch_ui_mode';

const ROUTE_PAIRS = [
    ['pn-units', 'property-units'],
    ['pn-vehicles', 'property-vehicles'],
    ['pn-residents', 'property-residents'],
    ['fn-reports', 'finance-reports'],
    ['fn-ledger', 'finance-ledger'],
    ['fn-docs', 'finance-docs'],
    ['fn-expense-plan', 'finance-expense-plan'],
    ['fn-invoices-raised', 'finance-invoices-raised'],
    ['fn-bank-recon', 'finance-bank-recon'],
    ['fn-billing-pending', 'finance-billing-pending'],
    ['fn-billing-list', 'finance-billing-list'],
    ['fn-billing-collections', 'finance-billing-collections'],
    ['fn-billing-batches', 'finance-billing-batches'],
    ['fn-billing-aging', 'finance-billing-aging'],
    ['an-people', 'admin-society'],
    ['an-society', 'admin-society'],
    ['an-vendors', 'admin-vendors'],
    ['an-categories', 'admin-subcats'],
    ['an-staff', 'admin-staff'],
    ['an-integrations', 'admin-connections'],
    ['an-roles', 'admin-access'],
];

const NEW_TO_CLASSIC = Object.fromEntries(ROUTE_PAIRS);
const CLASSIC_TO_NEW = Object.fromEntries(ROUTE_PAIRS.map(([n, c]) => [c, n]));

function readCookie(name) {
    try {
        const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : '';
    } catch {
        return '';
    }
}

function writeCookie(name, value) {
    try {
        document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    } catch { /* ignore */ }
}

export function getUiMode() {
    try {
        const fromStore = localStorage.getItem(STORAGE_KEY);
        if (fromStore === 'classic' || fromStore === 'new') return fromStore;
    } catch { /* ignore */ }
    const fromCookie = readCookie(COOKIE);
    if (fromCookie === 'classic' || fromCookie === 'new') return fromCookie;
    return 'new';
}

export function isNewUi() {
    return getUiMode() !== 'classic';
}

export function remapRouteForMode(route, mode = getUiMode()) {
    const key = String(route || '').trim();
    if (!key) return key;
    if (mode === 'classic') return NEW_TO_CLASSIC[key] || key;
    return CLASSIC_TO_NEW[key] || key;
}

export function currentAppRoute() {
    const hash = String(window.location.hash || '').replace(/^#/, '').trim();
    if (hash) return hash;
    const path = `${window.location.pathname || '/'}`.replace(/\/$/, '') || '/';
    try {
        const paths = window.__mpaRoutePaths;
        if (paths && typeof paths === 'object') {
            for (const [route, href] of Object.entries(paths)) {
                const p = String(href).replace(/\/$/, '') || '/';
                if (p === path) return route;
            }
        }
    } catch { /* ignore */ }
    return '';
}

function persistMode(mode) {
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch { /* ignore */ }
    writeCookie(COOKIE, mode);
    document.documentElement.dataset.uiMode = mode;
}

export function setUiMode(mode, { navigate = true } = {}) {
    const next = mode === 'classic' ? 'classic' : 'new';
    persistMode(next);
    paintUiModeButtons();
    document.dispatchEvent(new CustomEvent('ui-mode-changed', { detail: { mode: next } }));
    if (!navigate) return;
    void goToRouteWithReload(next);
}

function locationKey() {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    return `${path}${window.location.hash || ''}`;
}

function hrefKey(href) {
    try {
        const u = new URL(href, window.location.origin);
        const path = u.pathname.replace(/\/$/, '') || '/';
        return `${path}${u.hash || ''}`;
    } catch {
        return href;
    }
}

async function goToRouteWithReload(mode) {
    let href = '/#dashboard';
    try {
        const { hrefForRoute, MPA_ROUTE_PATHS } = await import('./appShell/routes.js');
        let route = currentAppRoute();
        if (!route) {
            const path = window.location.pathname.replace(/\/$/, '') || '/';
            for (const [r, pathHref] of Object.entries(MPA_ROUTE_PATHS)) {
                const p = String(pathHref).replace(/\/$/, '') || '/';
                if (p === path) {
                    route = r;
                    break;
                }
            }
        }
        route = remapRouteForMode(route || 'dashboard', mode) || 'dashboard';
        href = hrefForRoute(route);
    } catch {
        href = '/#dashboard';
    }
    if (hrefKey(href) === locationKey()) {
        window.location.reload();
        return;
    }
    window.location.assign(href);
}

export function paintUiModeButtons() {
    const mode = getUiMode();
    const classic = mode === 'classic';
    document.documentElement.dataset.uiMode = mode;
    document.querySelectorAll('[data-ui-mode-toggle]').forEach((btn) => {
        btn.setAttribute('aria-pressed', classic ? 'true' : 'false');
        btn.title = classic
            ? 'Using classic (Postgres). Click to switch to New (Mongo).'
            : 'Using New (Mongo identity, RBAC, property, finance). Click to switch to classic (Postgres).';
        btn.setAttribute('aria-label', classic ? 'Switch to New' : 'Switch to classic');
        const label = btn.querySelector('[data-ui-mode-label]');
        if (label) label.textContent = classic ? 'Classic' : 'New';
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = classic ? 'fa-solid fa-clock-rotate-left' : 'fa-solid fa-bolt';
        }
    });
}

function onUiModeToggleClick(e) {
    const btn = e.target.closest?.('[data-ui-mode-toggle]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    setUiMode(getUiMode() === 'classic' ? 'new' : 'classic');
}

export function wireUiModeToggle() {
    persistMode(getUiMode());
    paintUiModeButtons();
    if (document.documentElement.dataset.uiModeWired) return;
    document.documentElement.dataset.uiModeWired = '1';
    document.addEventListener('click', onUiModeToggleClick, true);
}
