/**
 * Finance-New MPA sidebar — SPA modules above, Finance-New pages, then classic Finance.
 */
import { FINANCE_PAGES } from './session.js';
import { applyMpaNavCollapsed } from '../appShell/navPref.js';
import { hrefForRoute } from '../appShell/routes.js';
import {
    NAV_MODULES,
    applyNavPermissions,
    getModuleNavEntries,
} from '../navigation.js';
import { portalState } from '../store.js';

const FINANCE_NEW_NAV = [
    { route: 'fn-reports', ...FINANCE_PAGES.reports },
    { route: 'fn-ledger', ...FINANCE_PAGES.ledger },
    { route: 'fn-docs', ...FINANCE_PAGES.docs },
    { route: 'fn-expense-plan', ...FINANCE_PAGES['expense-plan'] },
    { route: 'fn-invoices-raised', ...FINANCE_PAGES['invoices-raised'] },
    { route: 'fn-bank-recon', ...FINANCE_PAGES['bank-recon'] },
];

const CLASSIC_FINANCE_NAV = [
    { route: 'finance-reports', label: 'Financial reports', path: '/#finance-reports', icon: 'fa-chart-line' },
    { route: 'finance-billing-pending', label: 'Invoices', path: '/#finance-billing-pending', icon: 'fa-file-invoice-dollar' },
    { route: 'finance-ledger', label: 'Ledger', path: '/#finance-ledger', icon: 'fa-book' },
    { route: 'finance-docs', label: 'Bills & receipts', path: '/#finance-docs', icon: 'fa-file-invoice' },
    { route: 'finance-expense-plan', label: 'Expense plan', path: '/#finance-expense-plan', icon: 'fa-calendar-check' },
    { route: 'finance-invoices-raised', label: 'Invoices Raised', path: '/#finance-invoices-raised', icon: 'fa-file-invoice' },
    { route: 'finance-bank-recon', label: 'Bank Reconciliation', path: '/#finance-bank-recon', icon: 'fa-scale-balanced' },
];

const SKIP_SPA_IDS = new Set(['finance', 'finance-new', 'property', 'property-new']);

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderPageLinks(items, { activeRoute } = {}) {
    return items.map((item) => {
        const active = item.route === activeRoute;
        const icon = item.icon ? `<i class="fa-solid ${esc(item.icon)}" aria-hidden="true"></i>` : '';
        return `
      <a class="nav-page-btn${active ? ' active' : ''}"
        href="${esc(item.path)}"
        title="${esc(item.label)}"
        aria-label="${esc(item.label)}"
        data-route="${esc(item.route)}"
        data-nav-route="${esc(item.route)}"
        ${active ? 'aria-current="page"' : ''}>
        ${icon}<span>${esc(item.label)}</span>
      </a>`;
    }).join('');
}

function renderSpaPageButtons(mod) {
    return getModuleNavEntries(mod).map((entry) => {
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

function renderPropertyPair() {
    const propertyNew = NAV_MODULES.find((m) => m.id === 'property-new');
    const propertyClassic = NAV_MODULES.find((m) => m.id === 'property');
    const newHtml = propertyNew ? renderSpaModule(propertyNew) : '';
    const classicHtml = propertyClassic ? `
      <div class="nav-module" data-module="property">
        <button type="button" class="nav-module-toggle" aria-expanded="false" title="Property (classic)" aria-label="Property (classic)">
          <span class="nav-module-toggle__lead">
            <i class="fa-solid ${esc(propertyClassic.icon)}" aria-hidden="true"></i>
            <span class="nav-module-toggle__label">Property (classic)</span>
          </span>
          <i class="fa-solid fa-chevron-down nav-module-toggle__chevron" aria-hidden="true"></i>
        </button>
        <div class="nav-module-pages" id="nav-sub-property" role="group" aria-label="Classic Property pages">
          ${renderSpaPageButtons(propertyClassic)}
        </div>
      </div>` : '';
    return `${newHtml}${classicHtml}`;
}

function renderSpaModule(mod) {
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
          ${renderSpaPageButtons(mod)}
        </div>`}
      </div>`;
}

function spaModulesAroundFinance() {
    const before = [];
    const after = [];
    let seenFinance = false;
    NAV_MODULES.forEach((mod) => {
        if (mod.id === 'finance' || mod.id === 'finance-new') {
            seenFinance = true;
            return;
        }
        if (SKIP_SPA_IDS.has(mod.id)) return;
        if (!seenFinance) before.push(mod);
        else after.push(mod);
    });
    return { before, after };
}

export function renderFinanceShellNav({ activeRoute } = {}) {
    const container = document.getElementById('nav-modules');
    if (!container) return;

    const { before, after } = spaModulesAroundFinance();

    container.innerHTML = `
      ${before.map(renderSpaModule).join('')}
      ${renderPropertyPair()}

      <div class="nav-module nav-module--open nav-module--active" data-module="fn-mpa">
        <button type="button" class="nav-module-toggle active" aria-expanded="true" title="Finance-New" aria-label="Finance-New">
          <span class="nav-module-toggle__lead">
            <i class="fa-solid fa-coins" aria-hidden="true"></i>
            <span class="nav-module-toggle__label">Finance-New</span>
          </span>
          <i class="fa-solid fa-chevron-down nav-module-toggle__chevron" aria-hidden="true"></i>
        </button>
        <div class="nav-module-pages" role="group" aria-label="Finance-New pages">
          ${renderPageLinks(FINANCE_NEW_NAV, { activeRoute })}
        </div>
      </div>

      <div class="nav-module" data-module="finance-classic">
        <button type="button" class="nav-module-toggle" aria-expanded="false" title="Finance (classic)" aria-label="Finance (classic)">
          <span class="nav-module-toggle__lead">
            <i class="fa-solid fa-database" aria-hidden="true"></i>
            <span class="nav-module-toggle__label">Finance (classic)</span>
          </span>
          <i class="fa-solid fa-chevron-down nav-module-toggle__chevron" aria-hidden="true"></i>
        </button>
        <div class="nav-module-pages" role="group" aria-label="Classic Finance pages">
          ${renderPageLinks(CLASSIC_FINANCE_NAV)}
        </div>
      </div>

      ${after.map(renderSpaModule).join('')}`;

    applyNavPermissions(new Set(portalState.authPermissions || []), false);
}

export function setFinanceNavActive(route) {
    document.querySelectorAll('#nav-modules .nav-page-btn[data-route]').forEach((btn) => {
        const active = btn.dataset.route === route
            || (btn.dataset.tabRoutes || '').split(',').includes(route);
        btn.classList.toggle('active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
    });

    document.querySelectorAll('#nav-modules .nav-module').forEach((mod) => {
        const hasActive = !!mod.querySelector(`.nav-page-btn.active`);
        const isFn = mod.dataset.module === 'fn-mpa';
        mod.classList.toggle('nav-module--active', isFn || hasActive);
        const toggle = mod.querySelector('.nav-module-toggle');
        if (toggle) toggle.classList.toggle('active', isFn || hasActive);
    });
}

export function initFinanceShellNav() {
    const container = document.getElementById('nav-modules');
    if (!container || container.dataset.financeNavWired) return;
    container.dataset.financeNavWired = '1';

    container.addEventListener('click', (e) => {
        const pageBtn = e.target.closest('a.nav-page-btn[href]');
        if (pageBtn) {
            if (window.matchMedia('(max-width: 820px)').matches) {
                applyMpaNavCollapsed(true, { persist: false });
            }
            return;
        }

        const toggle = e.target.closest('.nav-module-toggle');
        if (!toggle) return;
        const mod = toggle.closest('.nav-module');
        if (!mod) return;

        if (toggle.dataset?.href && toggle.dataset.href !== '#') {
            window.location.assign(toggle.dataset.href);
            return;
        }

        if (!document.body.classList.contains('nav-expanded')) {
            applyMpaNavCollapsed(false, { persist: false });
        }

        if (mod.dataset.module === 'fn-mpa') {
            mod.classList.add('nav-module--open');
            toggle.setAttribute('aria-expanded', 'true');
            return;
        }

        const isOpen = mod.classList.toggle('nav-module--open');
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
            container.querySelectorAll('.nav-module').forEach((el) => {
                if (el === mod || el.dataset.module === 'fn-mpa') return;
                el.classList.remove('nav-module--open');
                el.querySelector('.nav-module-toggle')?.setAttribute('aria-expanded', 'false');
            });
        }
    });
}
