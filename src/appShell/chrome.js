/**
 * App shell chrome — layout, topbar, apartment switchers, logout, user chip.
 * Finance MPA: cookie logout + finance-only nav (no store.js / Supabase / SPA navigation.js).
 */
import { clearFinanceCtx, readFinanceCtx } from '../financeApp/session.js';
import { clearMpaCtx, readMpaCtx } from './mpaSession.js';
import {
    initFinanceShellNav,
    renderFinanceShellNav,
    setFinanceNavActive,
} from '../financeApp/financeNav.js';
import { goToLogin } from '../authRedirect.js';
import { applyMpaNavCollapsed, isMpaNavCollapsedPref, restoreMpaNavPref } from './navPref.js';

function readShellCtx() {
    if (document.documentElement.dataset.financeApp === '1') {
        return readFinanceCtx();
    }
    return readMpaCtx() || readFinanceCtx();
}

function initialsFrom(name, email) {
    const src = String(name || email || 'CH').trim();
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return src.slice(0, 2).toUpperCase() || 'CH';
}

function fillApartmentSelects(ctx) {
    const apartments = ctx.apartments?.length ? ctx.apartments : [];
    const activeId = ctx.apartmentId || '';
    const html = apartments.map((a) =>
        `<option value="${esc(a.id)}" ${a.id === activeId ? 'selected' : ''}>${esc(a.name || a.id)}</option>`,
    ).join('') || '<option value="">Select society…</option>';

    ['nav-apartment-switch', 'header-apartment-switch', 'user-menu-apartment-switch'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    });

    const nameEl = document.getElementById('topbar-apartment-name');
    const apt = apartments.find((a) => a.id === activeId);
    if (nameEl) {
        nameEl.textContent = apt?.name || ctx.apartmentName || '';
        // Desktop: apartment <select> is the control. Narrow: select is hidden — show name text.
        const narrow = typeof window.matchMedia === 'function'
            && window.matchMedia('(max-width: 820px)').matches;
        nameEl.hidden = !narrow;
    }

    const footerMeta = document.getElementById('app-shell-footer-meta');
    if (footerMeta) footerMeta.textContent = apt?.name || ctx.apartmentName || 'Society operations';
}

function fillUserChrome(ctx) {
    const name = ctx.userName || ctx.userEmail || 'User';
    const email = ctx.userEmail || '';
    const role = 'Member';
    const initials = initialsFrom(name, email);

    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    setText('sidebar-user-name', name);
    setText('sidebar-user-role', role);
    setText('topbar-user-name', name);
    setText('topbar-user-role', email || role);
    setText('sidebar-user-initials', initials);
    setText('topbar-user-initials', initials);
    const avatar = document.getElementById('sidebar-user-initials');
    if (avatar) avatar.title = name;
}

async function signOut() {
    try {
        clearFinanceCtx();
    } catch { /* ignore */ }
    try {
        clearMpaCtx();
    } catch { /* ignore */ }
    try {
        await fetch('/api/auth-session', { method: 'DELETE', credentials: 'include' });
    } catch { /* ignore */ }
    goToLogin('Signed out.');
}

function wireShellControls({ onApartmentChange } = {}) {
    const isMpa = document.documentElement.dataset.financeApp === '1'
        || document.documentElement.dataset.mpaApp === '1';

    if (isMpa) {
        const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
        const mainContent = document.getElementById('main-content');

        const expand = () => applyMpaNavCollapsed(false, { persist: !isMobile() });
        const collapse = () => applyMpaNavCollapsed(true, { persist: !isMobile() });
        const previewExpand = () => applyMpaNavCollapsed(false, { persist: false });
        const previewCollapse = () => {
            if (!isMpaNavCollapsedPref()) return;
            applyMpaNavCollapsed(true, { persist: false });
        };

        restoreMpaNavPref();

        const toggleNav = (e) => {
            e?.stopPropagation();
            if (document.body.classList.contains('nav-expanded')) collapse();
            else expand();
        };
        document.getElementById('nav-toggle')?.addEventListener('click', toggleNav);
        document.getElementById('mobile-nav-toggle')?.addEventListener('click', toggleNav);

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

        mainContent?.addEventListener('click', (e) => {
            if (e.target.closest('#sidebar')) return;
            if (e.target.closest('#nav-toggle, #mobile-nav-toggle')) return;
            if (e.target.closest('#topbar-user-btn, #topbar-user-menu')) return;
            collapse();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                collapse();
                closeUserMenu();
            }
        });
    } else {
        // SPA: classic toggle behaviour
        const toggleNav = () => document.body.classList.toggle('nav-expanded');
        document.getElementById('nav-toggle')?.addEventListener('click', toggleNav);
        document.getElementById('mobile-nav-toggle')?.addEventListener('click', toggleNav);

        if (!document.querySelector('.nav-backdrop')) {
            const d = document.createElement('div');
            d.className = 'nav-backdrop';
            d.setAttribute('aria-hidden', 'true');
            d.onclick = () => document.body.classList.remove('nav-expanded');
            document.body.appendChild(d);
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.body.classList.remove('nav-expanded');
                closeUserMenu();
            }
        });
    }

    const onApt = async (e) => {
        const id = e.target.value;
        const ctx = readShellCtx();
        if (!id || id === ctx?.apartmentId) return;
        if (typeof onApartmentChange === 'function') {
            await onApartmentChange(id);
        }
    };
    ['nav-apartment-switch', 'header-apartment-switch', 'user-menu-apartment-switch'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', onApt);
    });

    document.getElementById('topbar-logout-btn')?.addEventListener('click', () => void signOut());
    document.getElementById('user-menu-logout')?.addEventListener('click', () => void signOut());

    const userBtn = document.getElementById('topbar-user-btn');
    const userMenu = document.getElementById('topbar-user-menu');
    userBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = userMenu && !userMenu.hidden && userMenu.style.display !== 'none';
        if (open) closeUserMenu();
        else openUserMenu();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#topbar-user-btn') && !e.target.closest('#topbar-user-menu')) {
            closeUserMenu();
        }
    });
}

function openUserMenu() {
    const menu = document.getElementById('topbar-user-menu');
    const btn = document.getElementById('topbar-user-btn');
    if (!menu) return;
    menu.hidden = false;
    menu.style.display = '';
    btn?.setAttribute('aria-expanded', 'true');
}

function closeUserMenu() {
    const menu = document.getElementById('topbar-user-menu');
    const btn = document.getElementById('topbar-user-btn');
    if (!menu) return;
    menu.hidden = true;
    menu.style.display = 'none';
    btn?.setAttribute('aria-expanded', 'false');
}

/**
 * @param {{
 *   activeRoute: string,
 *   moduleLabel?: string,
 *   pageLabel?: string,
 *   onApartmentChange?: (apartmentId: string) => Promise<void>|void,
 * }} opts
 */
export function paintAppShellChrome(opts = {}) {
    const ctx = readShellCtx() || {
        apartmentId: '',
        apartmentName: '',
        userName: '',
        userEmail: '',
        apartments: [],
    };

    fillApartmentSelects(ctx);
    fillUserChrome(ctx);

    if (document.documentElement.dataset.financeApp === '1') {
        renderFinanceShellNav({ activeRoute: opts.activeRoute });
        initFinanceShellNav();
        setFinanceNavActive(opts.activeRoute);
    } else {
        void import('./nav.js').then((m) => {
            m.renderAppShellNav({ activeRoute: opts.activeRoute });
            m.initAppShellNavInteraction();
            m.setActiveNavRoute(opts.activeRoute);
        });
    }

    if (opts.moduleLabel) {
        const el = document.getElementById('topbar-nav-module');
        if (el) el.textContent = opts.moduleLabel;
    }
    if (opts.pageLabel) {
        const el = document.getElementById('topbar-nav-page');
        if (el) el.textContent = opts.pageLabel;
    }

    if (!document.documentElement.dataset.appShellChromeWired) {
        document.documentElement.dataset.appShellChromeWired = '1';
        wireShellControls({ onApartmentChange: opts.onApartmentChange });
    }
}

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
