/**
 * Persist MPA sidebar collapsed/expanded across finance (and other MPA) page loads.
 */
const KEY = 'ch_mpa_nav_collapsed';

export function isMpaNavCollapsedPref() {
    try {
        const v = localStorage.getItem(KEY);
        if (v === null || v === '') return true;
        return v === '1';
    } catch {
        return true;
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

/** Hover-expand / click-collapse rail (New UI SPA + MPA). */
export function wireHoverSidebar() {
    if (document.documentElement.dataset.hoverNavWired === '1') return;
    document.documentElement.dataset.hoverNavWired = '1';

    const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
    const expand = () => applyMpaNavCollapsed(false, { persist: !isMobile() });
    const collapse = () => applyMpaNavCollapsed(true, { persist: !isMobile() });
    const previewExpand = () => applyMpaNavCollapsed(false, { persist: false });
    const previewCollapse = () => {
        if (!isMpaNavCollapsedPref()) return;
        applyMpaNavCollapsed(true, { persist: false });
    };

    const sidebar = document.getElementById('sidebar');
    let leaveTimer = 0;
    sidebar?.addEventListener('mouseenter', () => {
        if (isMobile() || !isMpaNavCollapsedPref()) return;
        clearTimeout(leaveTimer);
        previewExpand();
    });
    sidebar?.addEventListener('mouseleave', () => {
        if (isMobile() || !isMpaNavCollapsedPref()) return;
        clearTimeout(leaveTimer);
        leaveTimer = window.setTimeout(previewCollapse, 160);
    });

    document.getElementById('main-content')?.addEventListener('click', (e) => {
        if (e.target.closest('#sidebar')) return;
        if (e.target.closest('#nav-toggle, #mobile-nav-toggle')) return;
        if (e.target.closest('#topbar-user-btn, #topbar-user-menu')) return;
        if (!isMobile()) collapse();
    });
}

export function syncHamburgerToHoverNav() {
    const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
    const toggle = () => {
        if (document.body.classList.contains('nav-expanded')) {
            applyMpaNavCollapsed(true, { persist: !isMobile() });
        } else {
            applyMpaNavCollapsed(false, { persist: !isMobile() });
        }
    };
    document.getElementById('nav-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });
    document.getElementById('mobile-nav-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });
}
