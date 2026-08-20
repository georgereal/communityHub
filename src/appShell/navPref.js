/**
 * Persist MPA sidebar collapsed/expanded across finance (and other MPA) page loads.
 */
const KEY = 'ch_mpa_nav_collapsed';

export function isMpaNavCollapsedPref() {
    try {
        return localStorage.getItem(KEY) === '1';
    } catch {
        return false;
    }
}

export function applyMpaNavCollapsed(collapsed, { persist = true } = {}) {
    if (collapsed) {
        document.body.classList.remove('nav-expanded');
        document.body.classList.add('nav-collapsed');
    } else {
        document.body.classList.add('nav-expanded');
        document.body.classList.remove('nav-collapsed');
    }
    if (!persist) return;
    try {
        localStorage.setItem(KEY, collapsed ? '1' : '0');
    } catch { /* ignore */ }
}

export function restoreMpaNavPref() {
    const mobile = typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 820px)').matches;
    if (mobile) {
        applyMpaNavCollapsed(true, { persist: false });
        return;
    }
    applyMpaNavCollapsed(isMpaNavCollapsedPref(), { persist: false });
}
