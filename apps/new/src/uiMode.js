/**
 * App UI mode — production is New MPAs only (classic SPA archived).
 * Legacy `ch_ui_mode=classic` in storage is cleared on load.
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
    ['an-activity', 'admin-activity'],
    ['an-roles', 'admin-access'],
];

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

function persistNewMode() {
    try {
        localStorage.setItem(STORAGE_KEY, 'new');
    } catch { /* ignore */ }
    writeCookie(COOKIE, 'new');
    document.documentElement.dataset.uiMode = 'new';
}

/** @deprecated Classic UI removed — always `new`. */
export function getUiMode() {
    return 'new';
}

export function isNewUi() {
    return true;
}

/** Map legacy classic route keys to New MPA routes (for bookmarks / deep links). */
export function remapRouteForMode(route, mode = getUiMode()) {
    const key = String(route || '').trim();
    if (!key) return key;
    if (mode === 'classic') return key;
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

/** @deprecated Header toggle removed — no-op. */
export function setUiMode(_mode, { navigate: _navigate = true } = {}) {
    persistNewMode();
}

/** @deprecated Header toggle removed — clears legacy classic preference once. */
export function paintUiModeButtons() {
    persistNewMode();
}

/** @deprecated Header toggle removed — clears legacy classic preference once. */
export function wireUiModeToggle() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        const cookie = readCookie(COOKIE);
        if (stored === 'classic' || cookie === 'classic') persistNewMode();
    } catch { /* ignore */ }
    paintUiModeButtons();
}
