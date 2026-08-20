/**
 * Staff dashboard — progressive section loads after slim workspace boot.
 * Navigation abort cancels in-flight core / summary / ops pulls.
 */
import './dashboard.css';
import { portalState, loadStateDomain } from './store.js';
import { hasClientPermission } from './rbac.js';
import { isModuleEnabled } from './moduleAccess.js';
import { readApiJson } from './apiJson.js';
import { isNavigationCurrent } from './accessLocks.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const formatAsOn = (iso) => {
    if (!iso) return null;
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });
};

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Cached lightweight finance KPIs from /api/dashboard-summary (not full finance domain). */
let dashboardSummaryCache = { apartmentId: null, at: 0, summary: null, promise: null };
let dashboardApartmentDataAt = 0;
let dashboardRenderGeneration = 0;

export function clearDashboardSummaryCache() {
    dashboardSummaryCache = { apartmentId: null, at: 0, summary: null, promise: null };
}

export function seedDashboardSummary(apartmentId, summary) {
    if (!apartmentId || !summary) return;
    dashboardSummaryCache = {
        apartmentId,
        at: Date.now(),
        summary,
        promise: null,
    };
}

async function fetchDashboardSummary({ force = false, signal } = {}) {
    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) return null;
    if (signal?.aborted) return null;

    const freshEnough = dashboardSummaryCache.apartmentId === apartmentId
        && dashboardSummaryCache.summary
        && (Date.now() - dashboardSummaryCache.at) < 60_000;
    if (!force && freshEnough) return dashboardSummaryCache.summary;

    if (!force && dashboardSummaryCache.promise && dashboardSummaryCache.apartmentId === apartmentId) {
        return dashboardSummaryCache.promise;
    }

    dashboardSummaryCache.apartmentId = apartmentId;
    dashboardSummaryCache.promise = (async () => {
        const params = new URLSearchParams({ apartment_id: apartmentId });
        const headers = {};
        try {
            const { supabase } = await import('./store.js');
            const { data } = await supabase?.auth.getSession() || {};
            const token = data?.session?.access_token;
            if (token) headers.Authorization = `Bearer ${token}`;
        } catch { /* cookie fallback */ }
        const res = await fetch(`/api/dashboard-summary?${params}`, {
            method: 'GET',
            credentials: 'include',
            headers,
            signal,
        });
        const { ok, json, error } = await readApiJson(res);
        if (!ok) throw new Error(json?.error || error || 'Dashboard summary failed.');
        const summary = json.summary || null;
        dashboardSummaryCache = {
            apartmentId,
            at: Date.now(),
            summary,
            promise: null,
        };
        return summary;
    })().catch((err) => {
        dashboardSummaryCache.promise = null;
        if (err?.name === 'AbortError' || signal?.aborted) return null;
        console.warn('[dashboard] summary load failed:', err?.message || err);
        return null;
    });

    return dashboardSummaryCache.promise;
}

function getActiveApartmentName() {
    const id = portalState.access?.activeApartmentId;
    const apt = portalState.access?.apartments?.find((a) => a.id === id);
    return apt?.name || portalState.community?.name || 'Your society';
}

function emptyParking() {
    return {
        units: 0, cars: 0, bikes: 0, overlimitCars: 0, overlimitBikes: 0,
        occupancyPct: null, baseCapacity: 0,
    };
}

function computeOpsStats() {
    const tickets = portalState.operations?.helpdeskTickets || [];
    const openTickets = tickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length;
    const transitions = (portalState.operations?.unitTransitions || [])
        .filter((t) => t.status === 'IN_PROGRESS').length;
    const notices = portalState.portal?.notices || [];
    const draftNotices = notices.filter((n) => !n.published_at).length;
    const pendingEmails = (portalState.email?.outbox || []).filter((e) => e.status === 'PENDING').length;
    return { openTickets, transitions, draftNotices, pendingEmails };
}

function syncStatusInfo(syncFromSummary = null) {
    if (syncFromSummary) {
        if (!syncFromSummary.status && !syncFromSummary.at) return null;
        const at = syncFromSummary.at
            ? new Date(syncFromSummary.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
            : 'Never';
        return {
            status: syncFromSummary.status || '—',
            at,
            message: syncFromSummary.message || '',
        };
    }
    const s = portalState.finances?.ledgerSyncSettings;
    if (!s?.spreadsheet_url) return null;
    const status = s.last_sync_status || '—';
    const at = s.last_synced_at
        ? new Date(s.last_synced_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        : 'Never';
    return { status, at, message: s.last_sync_message || '' };
}

function buildActionItems(parking, billing, ops, syncInfo) {
    const items = [];
    const can = (perm) => hasClientPermission(perm);

    if ((parking.overlimitCars + parking.overlimitBikes) > 0 && can('vehicle_registry.view')) {
        items.push({
            severity: 'danger',
            icon: 'fa-triangle-exclamation',
            title: `${parking.overlimitCars + parking.overlimitBikes} overlimit vehicle(s)`,
            detail: 'Base parking slots exceeded — review registry compliance.',
            route: 'property-vehicles',
        });
    }

    if (billing.outstanding > 0 && can('accounts.view')) {
        items.push({
            severity: 'warn',
            icon: 'fa-file-invoice-dollar',
            title: `${formatMoney(billing.outstanding)} outstanding across ${billing.flatsWithDues} flat(s)`,
            detail: `${billing.openCount} open invoice(s) need collection follow-up.`,
            route: 'finance-billing-list',
        });
    }

    if (ops.openTickets > 0 && can('apartment_mgmt.view')) {
        items.push({
            severity: 'info',
            icon: 'fa-headset',
            title: `${ops.openTickets} open helpdesk ticket(s)`,
            detail: 'Residents or staff are waiting on a response.',
            route: 'ops-helpdesk',
        });
    }

    if (ops.transitions > 0 && can('apartment_mgmt.edit')) {
        items.push({
            severity: 'info',
            icon: 'fa-truck-ramp-box',
            title: `${ops.transitions} move-in/out in progress`,
            detail: 'Complete transition checklists and occupancy updates.',
            route: 'ops-transitions',
        });
    }

    if (ops.draftNotices > 0 && can('apartment_mgmt.edit')) {
        items.push({
            severity: 'info',
            icon: 'fa-bullhorn',
            title: `${ops.draftNotices} notice draft(s) unpublished`,
            detail: 'Publish notices to reach residents.',
            route: 'ops-notices',
        });
    }

    if (syncInfo && ['ERROR', 'FAILED', 'WARN'].includes(String(syncInfo.status).toUpperCase()) && can('setup.view')) {
        items.push({
            severity: 'danger',
            icon: 'fa-arrows-rotate',
            title: `Spreadsheet sync ${syncInfo.status}`,
            detail: syncInfo.message || 'Check sync settings and run history.',
            route: 'admin-sync',
        });
    }

    if (ops.pendingEmails > 0 && can('accounts.edit')) {
        items.push({
            severity: 'warn',
            icon: 'fa-envelope',
            title: `${ops.pendingEmails} email(s) in outbox`,
            detail: 'Pending delivery from the email queue.',
            route: 'admin-email',
        });
    }

    return items;
}

function buildQuickActions() {
    const actions = [];
    const add = (perm, alt, action, moduleKey = null) => {
        if (moduleKey && !isModuleEnabled(moduleKey)) return;
        if (hasClientPermission(perm) || (alt || []).some((p) => hasClientPermission(p))) {
            actions.push(action);
        }
    };

    add('vehicle_registry.view', ['vehicle_registry.edit'], {
        label: 'Parking registry',
        icon: 'fa-car',
        route: 'property-vehicles',
    }, 'property');
    add('accounts.edit', ['accounts.view'], {
        label: 'Add expense',
        icon: 'fa-wallet',
        action: 'expense-cash',
    }, 'finance');
    add('accounts.edit', [], {
        label: 'Income & expenses',
        icon: 'fa-chart-line',
        route: 'finance-ledger',
    }, 'finance');
    add('accounts.view', [], {
        label: 'Maintenance billing',
        icon: 'fa-file-invoice',
        route: 'finance-billing-list',
    }, 'finance');
    add('apartment_mgmt.edit', [], {
        label: 'New notice',
        icon: 'fa-bullhorn',
        route: 'ops-notices',
    }, 'property');
    add('apartment_mgmt.view', [], {
        label: 'Helpdesk',
        icon: 'fa-headset',
        route: 'ops-helpdesk',
    }, 'property');
    add('security.view', [], {
        label: 'Security gate',
        icon: 'fa-door-open',
        route: 'security-gate',
    }, 'security');
    add('setup.view', ['accounts.edit'], {
        label: 'Spreadsheet sync',
        icon: 'fa-table',
        route: 'admin-sync',
    }, 'admin');
    add('apartment_mgmt.view', [], {
        label: 'Unit directory',
        icon: 'fa-door-open',
        route: 'property-units',
    }, 'property');

    return actions;
}

function statCard(label, value, { tone = '', sub = '', loading = false } = {}) {
    return `<div class="dashboard-stat metric-card${loading ? ' dashboard-stat--loading' : ''}">
      <span class="label">${esc(label)}</span>
      <span class="value dashboard-stat__value${tone ? ` value--${tone}` : ''}">${loading ? '…' : esc(value)}</span>
      ${sub ? `<span class="dashboard-stat__sub">${esc(sub)}</span>` : ''}
    </div>`;
}

function skeletonCard(label) {
    return statCard(label, '…', { loading: true, sub: 'Loading…' });
}

function renderActionItem(item) {
    return `<button type="button" class="dashboard-action dashboard-action--${item.severity}" data-dash-route="${esc(item.route)}">
      <span class="dashboard-action__icon"><i class="fa-solid ${item.icon}" aria-hidden="true"></i></span>
      <span class="dashboard-action__body">
        <strong>${esc(item.title)}</strong>
        <span>${esc(item.detail)}</span>
      </span>
      <i class="fa-solid fa-chevron-right dashboard-action__chev" aria-hidden="true"></i>
    </button>`;
}

function wireDashboardClicks(root) {
    root.querySelectorAll('[data-dash-route]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const route = btn.dataset.dashRoute;
            if (route) window.switchView?.(route);
        });
    });
    root.querySelectorAll('[data-dash-action="expense-cash"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            window.switchView?.('finance-ledger');
            window.openExpense?.('CASH');
        });
    });
}

function stillActive(signal, generation) {
    if (signal?.aborted) return false;
    if (generation != null && !isNavigationCurrent(generation)) return false;
    if (generation != null && generation !== dashboardRenderGeneration) return false;
    return !!document.getElementById('view-dashboard')?.classList.contains('active');
}

function paintGlance(el, { parking, billing, finance, ops, financeReady, parkingReady, opsReady }) {
    if (!el) return;
    const occupancy = !parkingReady
        ? '…'
        : (parking.occupancyPct == null ? '—' : `${parking.occupancyPct}%`);

    el.innerHTML = `
      <h3 class="dashboard-section__title">At a glance</h3>
      <div class="dashboard-stats">
        ${hasClientPermission('vehicle_registry.view')
        ? (parkingReady
            ? statCard('Active vehicles', `${parking.cars + parking.bikes}`, {
                sub: `${parking.cars} cars · ${parking.bikes} bikes`,
            })
            : skeletonCard('Active vehicles'))
        : ''}
        ${hasClientPermission('vehicle_registry.view')
        ? (parkingReady
            ? statCard('Parking occupancy', occupancy, {
                tone: parking.occupancyPct != null && parking.occupancyPct > 90 ? 'danger' : 'accent',
            })
            : skeletonCard('Parking occupancy'))
        : ''}
        ${hasClientPermission('accounts.view')
        ? (financeReady
            ? statCard('Outstanding dues', formatMoney(billing.outstanding), {
                tone: billing.outstanding > 0 ? 'danger' : 'success',
                sub: `${billing.openCount} open invoice(s)`,
            })
            : skeletonCard('Outstanding dues'))
        : ''}
        ${hasClientPermission('accounts.view')
        ? (financeReady
            ? statCard('MTD collections', formatMoney(finance.monthIn), {
                tone: 'success',
                sub: `Expenses ${formatMoney(finance.monthOut)}`,
            })
            : skeletonCard('MTD collections'))
        : ''}
        ${hasClientPermission('apartment_mgmt.view')
        ? (opsReady
            ? statCard('Open tickets', String(ops.openTickets), {
                tone: ops.openTickets > 0 ? 'danger' : '',
            })
            : skeletonCard('Open tickets'))
        : ''}
        ${hasClientPermission('accounts.view')
        ? (financeReady
            ? statCard('Bank balance', finance.bankBalance != null ? formatMoney(finance.bankBalance) : '—', {
                sub: finance.bankNeedsOpening
                    ? 'Set opening balance in Bank Reconciliation'
                    : (finance.bankAsOf ? `Balance as on ${formatAsOn(finance.bankAsOf)}` : ''),
            })
            : skeletonCard('Bank balance'))
        : ''}
        ${hasClientPermission('accounts.view')
        ? (financeReady
            ? statCard('Petty cash', formatMoney(finance.cashBalance))
            : skeletonCard('Petty cash'))
        : ''}
      </div>`;
}

function paintActions(el, items, loading) {
    if (!el) return;
    el.innerHTML = `
      <h3 class="dashboard-section__title">Needs attention</h3>
      ${loading
        ? `<p class="dashboard-empty dashboard-empty--loading"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Checking action items…</p>`
        : (items.length
            ? `<div class="dashboard-action-list">${items.map(renderActionItem).join('')}</div>`
            : `<p class="dashboard-empty"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> All caught up — nothing urgent right now.</p>`)}`;
    if (!loading) wireDashboardClicks(el);
}

function paintSync(el, syncInfo) {
    if (!el) return;
    if (!(syncInfo && hasClientPermission('setup.view'))) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    el.hidden = false;
    el.className = `dashboard-section dashboard-sync-banner dashboard-sync-banner--${esc(String(syncInfo.status).toLowerCase())}`;
    el.innerHTML = `
      <i class="fa-solid fa-table" aria-hidden="true"></i>
      <div>
        <strong>Spreadsheet sync · ${esc(syncInfo.status)}</strong>
        <span>Last run ${esc(syncInfo.at)}${syncInfo.message ? ` — ${esc(syncInfo.message.slice(0, 120))}` : ''}</span>
      </div>
      <button type="button" class="btn btn-outline btn--small" data-dash-route="admin-sync">Open sync</button>`;
    wireDashboardClicks(el);
}

export async function renderDashboard({ signal, generation } = {}) {
    const root = document.getElementById('dashboard-root');
    if (!root) return;

    dashboardRenderGeneration = generation ?? (dashboardRenderGeneration + 1);
    const gen = dashboardRenderGeneration;
    const aptName = getActiveApartmentName();
    const wantsFinance = hasClientPermission('accounts.view') || hasClientPermission('setup.view');
    const wantsParking = hasClientPermission('vehicle_registry.view');
    const wantsOps = hasClientPermission('apartment_mgmt.view') || hasClientPermission('apartment_mgmt.edit');
    const quickActions = buildQuickActions();

    const parking = emptyParking();

    root.innerHTML = `
      <header class="dashboard-header">
        <div class="dashboard-header__title">
          <p class="dashboard-header__eyebrow">Dashboard</p>
          <h2 class="page-title">${esc(aptName)}</h2>
          <p class="dashboard-header__subtitle" data-dash-subtitle>
            Loading society data…
          </p>
        </div>
      </header>

      <section class="dashboard-section" aria-label="Summary" data-dash-glance></section>
      <section class="dashboard-section dashboard-sync-banner" data-dash-sync hidden></section>

      <div class="dashboard-columns">
        <section class="dashboard-section dashboard-section--actions" aria-label="Needs attention" data-dash-actions></section>
        <section class="dashboard-section" aria-label="Quick actions">
          <h3 class="dashboard-section__title">Quick actions</h3>
          <div class="dashboard-quick-actions">
            ${quickActions.map((qa) => `
              <button type="button" class="dashboard-quick-btn" data-dash-route="${qa.route || ''}" data-dash-action="${qa.action || ''}">
                <i class="fa-solid ${qa.icon}" aria-hidden="true"></i>
                <span>${esc(qa.label)}</span>
              </button>`).join('')}
          </div>
        </section>
      </div>`;

    wireDashboardClicks(root);

    const glanceEl = root.querySelector('[data-dash-glance]');
    const actionsEl = root.querySelector('[data-dash-actions]');
    const syncEl = root.querySelector('[data-dash-sync]');
    const subtitleEl = root.querySelector('[data-dash-subtitle]');

    let state = {
        parking,
        parkingReady: false,
        billing: { outstanding: 0, openCount: 0, flatsWithDues: 0 },
        finance: {
            monthIn: 0, monthOut: 0, cashBalance: 0,
            bankBalance: null, bankAsOf: null, bankNeedsOpening: false,
        },
        financeReady: false,
        ops: { openTickets: 0, transitions: 0, draftNotices: 0, pendingEmails: 0 },
        opsReady: !wantsOps,
        syncInfo: null,
    };

    const refreshSections = () => {
        if (!stillActive(signal, gen)) return;
        paintGlance(glanceEl, state);
        const items = buildActionItems(state.parking, state.billing, state.ops, state.syncInfo);
        const actionsLoading = (wantsParking && !state.parkingReady)
            || (wantsFinance && !state.financeReady)
            || (wantsOps && !state.opsReady);
        paintActions(actionsEl, items, actionsLoading);
        paintSync(syncEl, state.syncInfo);
    };

    refreshSections();

    const tasks = [];

    tasks.push((async () => {
        const summary = await fetchDashboardSummary({ signal });
        if (!stillActive(signal, gen)) return;
        if (summary?.parking) state.parking = summary.parking;
        state.parkingReady = true;
        if (summary?.billing) state.billing = summary.billing;
        if (summary?.finance) state.finance = summary.finance;
        state.syncInfo = syncStatusInfo(summary?.sync);
        state.financeReady = wantsFinance ? !!summary : true;
        if (subtitleEl) {
            const n = state.parking.units;
            const lastPull = summary?.meta?.at;
            const label = lastPull
                ? new Date(lastPull).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
                : null;
            subtitleEl.textContent = label
                ? `${n} unit(s) in workspace · Data refreshed ${label}`
                : `${n} unit(s) in workspace`;
        }
        refreshSections();
    })());

    if (wantsOps) {
        tasks.push((async () => {
            await loadStateDomain('operations', { signal });
            if (!stillActive(signal, gen)) return;
            state.ops = computeOpsStats();
            state.opsReady = true;
            refreshSections();
        })());
    }

    await Promise.allSettled(tasks);
}

export function initDashboard() {
    document.addEventListener('apartment-data-loaded', () => {
        const now = Date.now();
        if (now - dashboardApartmentDataAt < 2000) return;
        dashboardApartmentDataAt = now;
        clearDashboardSummaryCache();
        if (document.getElementById('view-dashboard')?.classList.contains('active')) {
            void renderDashboard();
        }
    });
}
