/**
 * Staff dashboard — society overview, action items, quick actions.
 */
import './dashboard.css';
import { portalState } from './store.js';
import { hasClientPermission, canReviewAudit } from './rbac.js';
import { fetchPendingAuditEntries } from './activityAudit.js';
import { isModuleEnabled } from './moduleAccess.js';
import { invoiceBalance, invoiceStatus } from './maintenanceBilling.js';
import { countPendingVehicleAudit } from './vehicleAudit.js';
import { effectiveAllocationType } from './registry.js';
import { getActiveLedgerTxns, getLedgerBankBalance } from './ledgerBalance.js';

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

function getActiveApartmentName() {
    const id = portalState.access?.activeApartmentId;
    const apt = portalState.access?.apartments?.find((a) => a.id === id);
    return apt?.name || portalState.community?.name || 'Your society';
}

function computeParkingStats() {
    let overlimitCars = 0;
    let overlimitBikes = 0;
    let cars = 0;
    let bikes = 0;
    let baseCapacity = 0;

    portalState.units.forEach((u) => {
        baseCapacity += (u.car_limit || 0) + (u.bike_limit || 0);
        let baseCars = 0;
        let baseBikes = 0;
        (u.vehicles || []).forEach((v) => {
            if (!v.is_parking_active) return;
            const allocType = effectiveAllocationType(v);
            if (v.type === 'CAR') cars += 1;
            else bikes += 1;
            if (allocType === 'COMMON' || allocType === 'NEIGHBOR') return;
            if (v.type === 'CAR') {
                baseCars += 1;
                if (baseCars > (u.car_limit || 0)) overlimitCars += 1;
            } else {
                baseBikes += 1;
                if (baseBikes > (u.bike_limit || 0)) overlimitBikes += 1;
            }
        });
    });

    const activeTotal = cars + bikes;
    const occupancyPct = baseCapacity > 0
        ? Math.round((activeTotal / baseCapacity) * 100)
        : null;

    return {
        units: portalState.units.length,
        cars,
        bikes,
        overlimitCars,
        overlimitBikes,
        occupancyPct,
        baseCapacity,
    };
}

function computeBillingStats() {
    const invoices = portalState.finances?.maintenanceInvoices || [];
    let outstanding = 0;
    let openCount = 0;
    const flatsWithDues = new Set();

    invoices.forEach((inv) => {
        const bal = invoiceBalance(inv);
        const status = invoiceStatus(inv);
        if (bal > 0.001) {
            outstanding += bal;
            if (inv.unit_id) flatsWithDues.add(inv.unit_id);
        }
        if (status !== 'PAID') openCount += 1;
    });

    return { outstanding, openCount, flatsWithDues: flatsWithDues.size };
}

function computeFinanceStats() {
    const txns = getActiveLedgerTxns(portalState.finances?.txns || []);
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStr = monthStart.toISOString().slice(0, 10);
    let monthIn = 0;
    let monthOut = 0;
    let cashBalance = 0;

    txns.forEach((t) => {
        const amt = parseFloat(t.amount || 0);
        const d = (t.date || '').slice(0, 10);
        if (d >= monthStr) {
            if (t.type === 'IN') monthIn += amt;
            else monthOut += amt;
        }
        if ((t.wallet || 'CASH').toUpperCase() !== 'BANK') {
            cashBalance += t.type === 'IN' ? amt : -amt;
        }
    });

    const bank = getLedgerBankBalance(txns);

    return {
        monthIn,
        monthOut,
        cashBalance,
        bankBalance: bank.balance,
        bankAsOf: bank.asOf,
        bankNeedsOpening: bank.needsOpening,
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

function syncStatusInfo() {
    const s = portalState.finances?.ledgerSyncSettings;
    if (!s?.spreadsheet_url) return null;
    const status = s.last_sync_status || '—';
    const at = s.last_synced_at
        ? new Date(s.last_synced_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        : 'Never';
    return { status, at, message: s.last_sync_message || '' };
}

async function buildActionItems(parking, billing, ops, syncInfo) {
    const items = [];
    const can = (perm) => hasClientPermission(perm);

    const auditPending = can('vehicle_registry.view') ? await countPendingVehicleAudit() : 0;
    if (auditPending > 0 && can('vehicle_registry.view')) {
        items.push({
            severity: 'warn',
            icon: 'fa-clock-rotate-left',
            title: `${auditPending} vehicle change(s) pending sync`,
            detail: 'Review the parking change log and reconcile with Excel.',
            route: 'property-vehicles',
        });
    }

    if (canReviewAudit()) {
        const aptId = portalState.access?.activeApartmentId;
        const pendingAudit = aptId ? (await fetchPendingAuditEntries(aptId, 100)).length : 0;
        if (pendingAudit > 0) {
            items.push({
                severity: 'warn',
                icon: 'fa-clipboard-check',
                title: `${pendingAudit} audit entry(ies) awaiting review`,
                detail: 'Office manager submissions need association office bearer approval.',
                route: 'property-activity',
            });
        }
    }

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

function statCard(label, value, { tone = '', sub = '' } = {}) {
    return `<div class="dashboard-stat metric-card">
      <span class="label">${esc(label)}</span>
      <span class="value dashboard-stat__value${tone ? ` value--${tone}` : ''}">${esc(value)}</span>
      ${sub ? `<span class="dashboard-stat__sub">${esc(sub)}</span>` : ''}
    </div>`;
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

export async function renderDashboard() {
    const root = document.getElementById('dashboard-root');
    if (!root) return;

    const aptName = getActiveApartmentName();
    const parking = computeParkingStats();
    const billing = computeBillingStats();
    const finance = computeFinanceStats();
    const ops = computeOpsStats();
    const syncInfo = syncStatusInfo();
    const actions = await buildActionItems(parking, billing, ops, syncInfo);
    const quickActions = buildQuickActions();

    const occupancy = parking.occupancyPct == null ? '—' : `${parking.occupancyPct}%`;
    const lastPull = portalState.lastPullMeta?.at
        ? new Date(portalState.lastPullMeta.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        : null;

    root.innerHTML = `
      <header class="dashboard-header">
        <div class="dashboard-header__title">
          <p class="dashboard-header__eyebrow">Dashboard</p>
          <h2 class="page-title">${esc(aptName)}</h2>
          <p class="dashboard-header__subtitle">
            ${parking.units} unit(s) in workspace
            ${lastPull ? ` · Data refreshed ${esc(lastPull)}` : ''}
          </p>
        </div>
      </header>

      <section class="dashboard-section" aria-label="Summary">
        <h3 class="dashboard-section__title">At a glance</h3>
        <div class="dashboard-stats">
          ${hasClientPermission('vehicle_registry.view') ? statCard('Active vehicles', `${parking.cars + parking.bikes}`, {
        sub: `${parking.cars} cars · ${parking.bikes} bikes`,
    }) : ''}
          ${hasClientPermission('vehicle_registry.view') ? statCard('Parking occupancy', occupancy, {
        tone: parking.occupancyPct != null && parking.occupancyPct > 90 ? 'danger' : 'accent',
    }) : ''}
          ${hasClientPermission('accounts.view') ? statCard('Outstanding dues', formatMoney(billing.outstanding), {
        tone: billing.outstanding > 0 ? 'danger' : 'success',
        sub: `${billing.openCount} open invoice(s)`,
    }) : ''}
          ${hasClientPermission('accounts.view') ? statCard('MTD collections', formatMoney(finance.monthIn), {
        tone: 'success',
        sub: `Expenses ${formatMoney(finance.monthOut)}`,
    }) : ''}
          ${hasClientPermission('apartment_mgmt.view') ? statCard('Open tickets', String(ops.openTickets), {
        tone: ops.openTickets > 0 ? 'danger' : '',
    }) : ''}
          ${hasClientPermission('accounts.view') ? statCard('Bank balance', finance.bankBalance != null ? formatMoney(finance.bankBalance) : '—', {
        sub: finance.bankNeedsOpening
            ? 'Set opening balance in Bank Reconciliation'
            : (finance.bankAsOf ? `Balance as on ${formatAsOn(finance.bankAsOf)}` : ''),
    }) : ''}
          ${hasClientPermission('accounts.view') ? statCard('Petty cash', formatMoney(finance.cashBalance)) : ''}
        </div>
      </section>

      ${syncInfo && hasClientPermission('setup.view') ? `
      <section class="dashboard-section dashboard-sync-banner dashboard-sync-banner--${esc(String(syncInfo.status).toLowerCase())}">
        <i class="fa-solid fa-table" aria-hidden="true"></i>
        <div>
          <strong>Spreadsheet sync · ${esc(syncInfo.status)}</strong>
          <span>Last run ${esc(syncInfo.at)}${syncInfo.message ? ` — ${esc(syncInfo.message.slice(0, 120))}` : ''}</span>
        </div>
        <button type="button" class="btn btn-outline btn--small" data-dash-route="admin-sync">Open sync</button>
      </section>` : ''}

      <div class="dashboard-columns">
        <section class="dashboard-section dashboard-section--actions" aria-label="Needs attention">
          <h3 class="dashboard-section__title">Needs attention</h3>
          ${actions.length
        ? `<div class="dashboard-action-list">${actions.map(renderActionItem).join('')}</div>`
        : `<p class="dashboard-empty"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> All caught up — nothing urgent right now.</p>`}
        </section>

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

export function initDashboard() {
    document.addEventListener('apartment-data-loaded', () => {
        if (document.getElementById('view-dashboard')?.classList.contains('active')) {
            void renderDashboard();
        }
    });
}
