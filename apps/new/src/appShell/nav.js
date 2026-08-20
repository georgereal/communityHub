/**
 * Sidebar nav for the multi-page app shell — same modules as SPA, MPA-aware hrefs.
 */
import {
    getNavModules,
    findPage,
    applyNavPermissions,
    getModuleNavEntries,
    pageIsVisible,
    isNavHeading,
} from '../navigation.js';
import { portalState } from '../store.js';
import { hrefForRoute, navigateToRoute, isMpaRoute } from './routes.js';
import { applyMpaNavCollapsed } from './navPref.js';
import { getUiMode } from '../uiMode.js';

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderPageButtons(mod) {
    const entries = getModuleNavEntries(mod);
    return entries.map((entry) => {
        if (entry.tabbed) {
            const href = hrefForRoute(entry.defaultRoute);
            return `
            <a class="nav-page-btn nav-page-btn--tabbed"
              href="${esc(href)}"
              title="${esc(entry.label)}"
              aria-label="${esc(entry.label)}"
              data-route="${esc(entry.defaultRoute)}"
              data-nav-route="${esc(entry.defaultRoute)}"
              data-tab-routes="${esc(entry.routes.join(','))}">
              <i class="fa-solid ${esc(entry.icon)}" aria-hidden="true"></i>
              <span>${esc(entry.label)}</span>
            </a>`;
        }
        const page = mod.pages.find((p) => p.route === entry.route);
        if (!page) return '';
        const href = hrefForRoute(page.route);
        const island = getUiMode() !== 'classic' && (mod.classicIsland || String(page.route).startsWith('ops-'));
        const islandMark = island
            ? ' <span class="nav-island-dot" title="Classic (Supabase)" aria-hidden="true"></span>'
            : '';
        return `
            <a class="nav-page-btn${island ? ' nav-page-btn--island' : ''}"
              href="${esc(href)}"
              title="${esc(island ? `${page.label} (classic · Supabase)` : page.label)}"
              aria-label="${esc(page.label)}"
              data-route="${esc(page.route)}"
              data-nav-route="${esc(page.route)}">
              <i class="fa-solid ${esc(page.icon)}" aria-hidden="true"></i>
              <span>${esc(page.label)}</span>${islandMark}
            </a>`;
    }).join('');
}

export function renderAppShellNav({ activeRoute } = {}) {
    const container = document.getElementById('nav-modules');
    if (!container) return;

    container.innerHTML = getNavModules().map((mod) => {
        if (isNavHeading(mod)) {
            return `<p class="nav-old-heading" data-nav-heading="old">${esc(mod.navHeading)}</p>`;
        }
        const entryRoute = mod.tabbed ? (mod.defaultRoute || mod.pages[0]?.route) : null;
        const entryHref = entryRoute ? hrefForRoute(entryRoute) : '#';
        const entries = getModuleNavEntries(mod);
        const isOpen = !mod.tabbed && entries.some((entry) => {
            if (entry.tabbed) return (entry.routes || []).includes(activeRoute);
            return entry.route === activeRoute;
        });
        return `
      <div class="nav-module${mod.tabbed ? ' nav-module--tabbed' : ''}${isOpen ? ' nav-module--open nav-module--active' : ''}${mod.classicIsland ? ' nav-module--island' : ''}" data-module="${esc(mod.id)}">
        <button type="button" class="nav-module-toggle${isOpen ? ' active' : ''}" aria-expanded="${isOpen ? 'true' : 'false'}"
          title="${esc(mod.classicIsland ? `${mod.label} (classic · Supabase)` : mod.label)}"
          aria-label="${esc(mod.label)}"
          ${entryRoute ? `data-route="${esc(entryRoute)}" data-href="${esc(entryHref)}"` : ''}
          ${mod.tabbed ? '' : `aria-controls="nav-sub-${esc(mod.id)}"`}>
          <span class="nav-module-toggle__lead">
            <i class="fa-solid ${esc(mod.icon)}" aria-hidden="true"></i>
            ${mod.classicIsland && getUiMode() !== 'classic' ? '<span class="nav-island-dot nav-island-dot--mod" title="Classic (Supabase)" aria-hidden="true"></span>' : ''}
            <span class="nav-module-toggle__label">${esc(mod.label)}</span>
          </span>
          ${mod.tabbed ? '' : '<i class="fa-solid fa-chevron-down nav-module-toggle__chevron" aria-hidden="true"></i>'}
        </button>
        ${mod.tabbed ? '' : `
        <div class="nav-module-pages" id="nav-sub-${esc(mod.id)}" role="group" aria-label="${esc(mod.label)}">
          ${renderPageButtons(mod)}
        </div>`}
      </div>`;
    }).join('');

    const perms = new Set(portalState.authPermissions || []);
    applyNavPermissions(perms, false);
    setActiveNavRoute(activeRoute);
}

export function setActiveNavRoute(route) {
    if (!route) return;
    const meta = findPage(route);

    document.querySelectorAll('.nav-page-btn').forEach((btn) => {
        const active = btn.dataset.route === route
            || (btn.dataset.tabRoutes || '').split(',').includes(route);
        btn.classList.toggle('active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
    });

    getNavModules().forEach((mod) => {
        if (isNavHeading(mod)) return;
        const modEl = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
        if (!modEl) return;
        const entries = getModuleNavEntries(mod);
        const hasActive = mod.tabbed
            ? mod.pages.some((p) => p.route === route)
            : entries.some((entry) => {
                if (entry.tabbed) return entry.routes.includes(route);
                return entry.route === route;
            });
        modEl.classList.toggle('nav-module--active', hasActive);
        modEl.querySelector('.nav-module-toggle')?.classList.toggle('active', hasActive);
        if (hasActive && !mod.tabbed) {
            modEl.classList.add('nav-module--open');
            modEl.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', 'true');
        }
    });

    const moduleEl = document.getElementById('topbar-nav-module');
    const pageEl = document.getElementById('topbar-nav-page');
    const chev = document.querySelector('.topbar-breadcrumb > .fa-chevron-right');
    if (meta) {
        const tabbed = meta.module?.tabbed;
        if (moduleEl) moduleEl.textContent = meta.module.label;
        if (pageEl) {
            pageEl.textContent = tabbed ? '' : meta.page.label;
            pageEl.hidden = !!tabbed;
        }
        if (chev) chev.style.display = tabbed ? 'none' : '';
    }
}

export function initAppShellNavInteraction() {
    const container = document.getElementById('nav-modules');
    if (!container || container.dataset.appShellWired) return;
    container.dataset.appShellWired = '1';

    container.addEventListener('click', (e) => {
        const pageBtn = e.target.closest('.nav-page-btn');
        if (pageBtn?.dataset?.route) {
            e.preventDefault();
            if (window.matchMedia('(max-width: 820px)').matches) {
                applyMpaNavCollapsed(true, { persist: false });
            }
            let route = pageBtn.dataset.route;
            const tabRoutes = pageBtn.dataset.tabRoutes?.split(',').filter(Boolean) || [];
            if (tabRoutes.length) {
                const perms = new Set(portalState.authPermissions || []);
                const firstVisible = tabRoutes.find((r) => {
                    const meta = findPage(r);
                    return meta && pageIsVisible(meta.page, perms, false, meta.module.id);
                });
                if (firstVisible) route = firstVisible;
            }
            navigateToRoute(route);
            return;
        }

        const toggle = e.target.closest('.nav-module-toggle');
        if (!toggle) return;

        if (toggle.dataset?.route) {
            e.preventDefault();
            if (window.matchMedia('(max-width: 820px)').matches) {
                applyMpaNavCollapsed(true, { persist: false });
            }
            navigateToRoute(toggle.dataset.route);
            return;
        }

        const modEl = toggle.closest('.nav-module');
        if (!modEl) return;

        if (!document.body.classList.contains('nav-expanded')) {
            applyMpaNavCollapsed(false, { persist: false });
            getNavModules().forEach((mod) => {
                const el = document.querySelector(`.nav-module[data-module="${mod.id}"]`);
                if (!el) return;
                const open = mod.id === modEl.dataset.module;
                el.classList.toggle('nav-module--open', open);
                el.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
            return;
        }

        const isOpen = modEl.classList.toggle('nav-module--open');
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
            document.querySelectorAll('.nav-module').forEach((el) => {
                if (el === modEl) return;
                el.classList.remove('nav-module--open');
                el.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', 'false');
            });
        }
    });
}

export { isMpaRoute, hrefForRoute, navigateToRoute };
