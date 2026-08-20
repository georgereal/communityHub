/**
 * New Home dashboard — Mongo /api/dashboard-summary only.
 */
import { portalState } from '../store.js';
import { hasClientPermission } from '../rbac.js';
import { navigateToRoute } from '../appShell/routes.js';
import { bearerAuthHeaders } from '../runtime/authHeaders.js';
import { readApiJson } from '../apiJson.js';

const roundRupee = (n) => Math.round(Number(n) || 0);

const formatMoney = (n) => `₹${roundRupee(n).toLocaleString('en-IN')}`;

/** Signed amount for month net: +₹24,190 / −₹1,200 */
function formatSignedMoney(n) {
    const v = roundRupee(n);
    if (v > 0) return `+${formatMoney(v)}`;
    if (v < 0) return `−${formatMoney(Math.abs(v))}`;
    return formatMoney(0);
}

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function aptName() {
    const id = portalState.access?.activeApartmentId;
    const apt = portalState.access?.apartments?.find((a) => a.id === id);
    return apt?.name || portalState.community?.name || 'Your society';
}

function can(perm) {
    return hasClientPermission(perm);
}

function pct(n) {
    return n == null ? '—' : `${n}%`;
}

function parkingTypeRow(label, count, basePct, poolOcc, poolTotal, poolName) {
    const parts = [`${count}`];
    if (basePct != null) parts.push(`${pct(basePct)} base`);
    if (poolTotal > 0) parts.push(`${poolName} ${poolOcc}/${poolTotal}`);
    return { label, value: parts.join(' · ') };
}

/**
 * Compact glance card: one hero figure + short caption + labeled meta rows.
 * @param {{ title: string, icon: string, route?: string, hero: string, heroHint?: string, heroTone?: string, rows?: Array<{ label: string, value: string, tone?: string }> }} opts
 */
function glanceCard({ title, icon, route, hero, heroHint = '', heroTone = '', rows = [] }) {
    const tag = route ? 'button' : 'div';
    const extra = route
        ? ` type="button" class="home-glance-card home-glance-card--link" data-home-route="${esc(route)}"`
        : ' class="home-glance-card"';
    const rowsHtml = rows.length
        ? `<dl class="home-glance-card__rows">${rows.map((r) => `
            <div class="home-glance-card__row">
              <dt>${esc(r.label)}</dt>
              <dd class="${r.tone ? `home-glance-card__val--${esc(r.tone)}` : ''}">${esc(r.value)}</dd>
            </div>`).join('')}</dl>`
        : '';
    return `<${tag}${extra}>
      <div class="home-glance-card__head">
        <span class="home-glance-card__icon" aria-hidden="true"><i class="fa-solid ${esc(icon)}"></i></span>
        <span class="home-glance-card__title">${esc(title)}</span>
      </div>
      <div class="home-glance-card__hero-block">
        <p class="home-glance-card__hero${heroTone ? ` home-glance-card__hero--${heroTone}` : ''}">${esc(hero)}</p>
        ${heroHint ? `<p class="home-glance-card__hint">${esc(heroHint)}</p>` : ''}
      </div>
      ${rowsHtml}
    </${tag}>`;
}

async function fetchSummary() {
    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) return null;
    const headers = await bearerAuthHeaders();
    const res = await fetch(`/api/dashboard-summary?apartment_id=${encodeURIComponent(apartmentId)}`, {
        credentials: 'include',
        headers,
    });
    const { ok, json, error } = await readApiJson(res);
    if (!ok) throw new Error(json?.error || error || 'Dashboard summary failed.');
    return json.summary || null;
}

function quickActions() {
    const actions = [];
    if (can('vehicle_registry.view') || can('vehicle_registry.edit')) {
        actions.push({ label: 'Parking registry', icon: 'fa-car', route: 'pn-vehicles' });
    }
    if (can('accounts.edit') || can('accounts.view')) {
        actions.push({ label: 'Add expense', icon: 'fa-wallet', route: 'fn-ledger' });
        actions.push({ label: 'Income & expenses', icon: 'fa-chart-line', route: 'fn-ledger' });
    }
    if (can('accounts.view')) {
        actions.push({ label: 'Maintenance billing', icon: 'fa-file-invoice', route: 'fn-billing-list' });
    }
    if (can('apartment_mgmt.view')) {
        actions.push({ label: 'Unit directory', icon: 'fa-door-open', route: 'pn-units' });
    }
    return actions;
}

function attentionItems(parking, billing) {
    const items = [];
    const over = (parking.overlimitCars || 0) + (parking.overlimitBikes || 0);
    if (over > 0 && can('vehicle_registry.view')) {
        items.push({
            severity: 'danger',
            icon: 'fa-triangle-exclamation',
            title: `${over} overlimit vehicle(s)`,
            detail: 'Base parking slots exceeded — review registry compliance.',
            route: 'pn-vehicles',
        });
    }
    if (billing.outstanding > 0 && can('accounts.view')) {
        items.push({
            severity: 'warn',
            icon: 'fa-file-invoice-dollar',
            title: `${formatMoney(billing.outstanding)} outstanding across ${billing.flatsWithDues} flat(s)`,
            detail: `${billing.openCount} open invoice(s) need collection follow-up.`,
            route: 'fn-billing-list',
        });
    }
    return items;
}

export function homePageHtml() {
    return `
      <div class="app-shell-page-body dashboard" id="home-dashboard-root">
        <p class="home-mpa-status">Loading society data…</p>
      </div>`;
}

export async function renderHomeDashboard() {
    const root = document.getElementById('home-dashboard-root');
    if (!root) return;
    const name = aptName();
    root.innerHTML = `<p class="home-mpa-status">Loading society data…</p>`;

    let summary = null;
    try {
        summary = await fetchSummary();
    } catch (err) {
        root.innerHTML = `<p class="home-mpa-status" role="alert">${esc(err.message || 'Failed to load dashboard.')}</p>`;
        return;
    }

    const parking = summary?.parking || {
        units: 0, cars: 0, bikes: 0, overlimitCars: 0, overlimitBikes: 0, occupancyPct: null,
    };
    const billing = summary?.billing || { outstanding: 0, openCount: 0, flatsWithDues: 0 };
    const finance = summary?.finance || {
        monthIn: 0, monthOut: 0, cashBalance: 0, bankBalance: null, bankAsOf: null, bankNeedsOpening: false,
    };
    const items = attentionItems(parking, billing);
    const actions = quickActions();

    root.innerHTML = `
      <header class="dashboard-header">
        <div class="dashboard-header__title">
          <p class="dashboard-header__eyebrow">Dashboard</p>
          <h2 class="page-title">${esc(name)}</h2>
          <p class="dashboard-header__subtitle">
            ${parking.units} unit${parking.units === 1 ? '' : 's'}
          </p>
        </div>
      </header>
      <section class="dashboard-section" aria-label="Summary">
        <h3 class="dashboard-section__title">At a glance</h3>
        <div class="home-glance">
          ${can('vehicle_registry.view') ? glanceCard({
        title: 'Parking',
        icon: 'fa-car',
        route: 'pn-vehicles',
        hero: String(parking.cars + parking.bikes),
        heroHint: 'active vehicles',
        rows: [
            parkingTypeRow('Cars', parking.cars, parking.carOccupancyPct, parking.ehOcc || 0, parking.ehTotal || 0, 'EH'),
            parkingTypeRow('Bikes', parking.bikes, parking.bikeOccupancyPct, parking.bhOcc || 0, parking.bhTotal || 0, 'BH'),
        ],
    }) : ''}
          ${can('accounts.view') ? (() => {
        const bank = finance.bankBalance;
        const petty = Number(finance.cashBalance) || 0;
        const monthNet = (Number(finance.monthIn) || 0) - (Number(finance.monthOut) || 0);
        const dues = Number(billing.outstanding) || 0;
        const liquid = bank != null ? bank + petty : null;
        return glanceCard({
            title: 'Finance',
            icon: 'fa-coins',
            route: 'fn-reports',
            // What the society has on hand (bank + float).
            hero: liquid != null ? formatMoney(liquid) : '—',
            heroHint: bank != null
                ? `bank ${formatMoney(bank)} · petty ${formatMoney(petty)}`
                : `petty ${formatMoney(petty)}`,
            heroTone: liquid != null && liquid < 0 ? 'danger' : '',
            rows: [
                {
                    label: 'This month',
                    value: `${formatSignedMoney(monthNet)} net`,
                    tone: monthNet > 0 ? 'success' : (monthNet < 0 ? 'danger' : ''),
                },
                {
                    label: 'Outstanding',
                    value: dues > 0
                        ? `${formatMoney(dues)} · ${billing.openCount} invoice(s)`
                        : 'All clear',
                    tone: dues > 0 ? 'danger' : 'success',
                },
            ],
        });
    })() : ''}
        </div>
      </section>
      <div class="dashboard-columns">
        <section class="dashboard-section dashboard-section--actions" aria-label="Needs attention">
          <h3 class="dashboard-section__title">Needs attention</h3>
          ${items.length
        ? `<div class="dashboard-action-list">${items.map((item) => `
            <button type="button" class="dashboard-action dashboard-action--${item.severity}" data-home-route="${esc(item.route)}">
              <span class="dashboard-action__icon"><i class="fa-solid ${item.icon}" aria-hidden="true"></i></span>
              <span class="dashboard-action__body">
                <strong>${esc(item.title)}</strong>
                <span>${esc(item.detail)}</span>
              </span>
              <i class="fa-solid fa-chevron-right dashboard-action__chev" aria-hidden="true"></i>
            </button>`).join('')}</div>`
        : `<p class="dashboard-empty"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> All caught up — nothing urgent right now.</p>`}
        </section>
        <section class="dashboard-section" aria-label="Quick actions">
          <h3 class="dashboard-section__title">Quick actions</h3>
          <div class="dashboard-quick-actions">
            ${actions.map((qa) => `
              <button type="button" class="dashboard-quick-btn" data-home-route="${esc(qa.route)}">
                <i class="fa-solid ${qa.icon}"></i>
                <span>${esc(qa.label)}</span>
              </button>`).join('')}
          </div>
        </section>
      </div>`;

    root.querySelectorAll('[data-home-route]').forEach((btn) => {
        btn.addEventListener('click', () => navigateToRoute(btn.dataset.homeRoute));
    });
}
