/**
 * Sidebar nav for the multi-page app shell — same modules as SPA, MPA-aware hrefs.
 */
import {
    NAV_MODULES,
    findPage,
    applyNavPermissions,
    getModuleNavEntries,
    pageIsVisible,
} from '../navigation.js';
import { portalState } from '../store.js';
import { hrefForRoute, navigateToRoute, isMpaRoute } from './routes.js';
import { applyMpaNavCollapsed } from './navPref.js';

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
        return `
            <a class="nav-page-btn"
              href="${esc(href)}"
              title="${esc(page.label)}"
              aria-label="${esc(page.label)}"
              data-route="${esc(page.route)}"
              data-nav-route="${esc(page.route)}">
              <i class="fa-solid ${esc(page.icon)}" aria-hidden="true"></i>
              <span>${esc(page.label)}</span>
            </a>`;
    }).join('');
}

export function renderAppShellNav({ activeRoute } = {}) {
    const container = document.getElementById('nav-modules');
    if (!container) return;

    container.innerHTML = NAV_MODULES.map((mod) => {
        const entryRoute = mod.tabbed ? (mod.defaultRoute || mod.pages[0]?.route) : null;
        const entryHref = entryRoute ? hrefForRoute(entryRoute) : '#';
        return `
      <div class="nav-module${mod.tabbed ? ' nav-module--tabbed' : ''}" data-module="${esc(mod.id)}">
        <button type="button" class="nav-module-toggle" aria-expanded="false"
          title="${esc(mod.label)}"
          aria-label="${esc(mod.label)}"
          ${entryRoute ? `data-route="${esc(entryRoute)}" data-href="${esc(entryHref)}"` : ''}
          ${mod.tabbed ? '' : `aria-controls="nav-sub-${esc(mod.id)}"`}>
          <span class="nav-module-toggle__lead">
            <i class="fa-solid ${esc(mod.icon)}" aria-hidden="true"></i>
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

    NAV_MODULES.forEach((mod) => {
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
    if (meta) {
        if (moduleEl) moduleEl.textContent = meta.module.label;
        if (pageEl) pageEl.textContent = meta.page.label;
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
            NAV_MODULES.forEach((mod) => {
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
