/**
 * Phase 3.1 — Resident portal (linked flats, read-only views)
 */
import { portalState, supabase, pullState } from './store.js';
import { loadResidents, normUnit } from './residents.js';
import { getUnitBlock } from './blockFilter.js';
import {
    invoiceBalance,
    getOpenInvoicesForUnit,
    getInvoiceDisplayLabel,
    invoiceStatus,
} from './maintenanceBilling.js';
import { getNoticesForUser, markNoticeRead } from './notices.js';
import { renderNoticeBodyHtml } from './noticeEditor.js';
import { renderPortalPayments } from './payments.js';
import {
    getPendingApprovalsForMyUnits,
    respondVisitorApproval,
} from './visitorApprovals.js';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

export const getMyResidentLinks = () => {
    const uid = portalState.auth?.id;
    if (!uid) return [];
    return (portalState.portal?.residentLinks || []).filter((l) => l.user_id === uid);
};

export const getMyUnitIds = async () => {
    const links = getMyResidentLinks();
    if (!links.length) return [];
    const residents = await loadResidents();
    const unitNums = new Set();
    links.forEach((link) => {
        const r = residents.find((x) => x.id === link.resident_id);
        if (r?.unit_number) unitNums.add(normUnit(r.unit_number));
    });
    return portalState.units
        .filter((u) => unitNums.has(normUnit(u.number)))
        .map((u) => u.id);
};

export const getMyUnits = async () => {
    const ids = new Set(await getMyUnitIds());
    return portalState.units.filter((u) => ids.has(u.id));
};

export const getMyInvoices = async () => {
    const unitIds = new Set(await getMyUnitIds());
    return (portalState.finances.maintenanceInvoices || []).filter((inv) => {
        if (inv.unit_id && unitIds.has(inv.unit_id)) return true;
        return false;
    });
};

const invoiceRow = (inv, showPay = false) => {
    const bal = invoiceBalance(inv);
    const st = invoiceStatus(inv);
    return `<div class="portal-invoice-row">
      <div class="portal-invoice-row__main">
        <strong>${inv.period_label || 'Invoice'}</strong>
        <span class="portal-invoice-row__flat">${getInvoiceDisplayLabel(inv)}</span>
      </div>
      <div class="portal-invoice-row__meta">
        <span>Due ${inv.due_date || '—'}</span>
        <span class="portal-status portal-status--${st.toLowerCase()}">${st}</span>
        <span>${formatMoney(bal)} due</span>
      </div>
      ${showPay && bal > 0.001 ? `<button type="button" class="btn btn-primary btn--small portal-pay-btn" data-invoice-id="${inv.id}">Pay</button>` : ''}
    </div>`;
};

export const renderPortalHome = async () => {
    const el = document.getElementById('portal-subview-home');
    if (!el) return;
    const units = await getMyUnits();
    if (!units.length) {
        el.innerHTML = `<div class="portal-empty">
          <p>No flats linked to your account yet.</p>
          <p class="portal-empty__hint">Link your login to a resident record, or wait for an email invitation from the office.</p>
          <div class="portal-link-actions">
            <button type="button" class="btn btn-primary btn--small" id="portal-link-email-btn">
              <i class="fa-solid fa-envelope"></i> Link by email match
            </button>
            <div class="portal-link-manual">
              <input type="text" id="portal-link-unit" class="portal-link-input" placeholder="Flat e.g. D-507" />
              <button type="button" class="btn btn-outline btn--small" id="portal-link-unit-btn">Link flat</button>
            </div>
            <p class="portal-empty__hint portal-empty__hint--small">Works if your login email matches the resident record or you received an invitation to that email.</p>
          </div>
        </div>`;
        return;
    }

    let totalDue = 0;
    const unitIds = units.map((u) => u.id);
    const openByUnit = {};
    unitIds.forEach((id) => {
        const open = getOpenInvoicesForUnit(id);
        openByUnit[id] = open;
        open.forEach((inv) => { totalDue += invoiceBalance(inv); });
    });

    const notices = await getNoticesForUser();
    const unread = notices.filter((n) => !n._read).length;
    const visitorApprovals = await getPendingApprovalsForMyUnits(getMyUnitIds);
    const unitById = (id) => portalState.units.find((u) => u.id === id)?.number || '—';

    const approvalSection = visitorApprovals.length ? `
      <h3 class="portal-section-title">Visitor at gate — your approval needed</h3>
      <div class="portal-visitor-approvals">
        ${visitorApprovals.map((row) => `<div class="portal-visitor-approval" data-visitor-unit="${row.id}">
          <strong>${row.visitor.visitor_name}</strong>
          <span class="visitor-row__purpose visitor-row__purpose--${(row.visitor.purpose || '').toLowerCase()}">${row.visitor.purpose}</span>
          <p class="portal-visitor-approval__meta">
            Flat ${unitById(row.unit_id)}
            ${row.visitor.vehicle_reg ? ` · Vehicle ${row.visitor.vehicle_reg}` : ''}
            ${row.visitor.visitor_phone ? ` · ${row.visitor.visitor_phone}` : ''}
          </p>
          <div class="portal-visitor-approval__actions">
            <button type="button" class="btn btn-primary btn--small" data-approve-visitor="${row.id}">Approve entry</button>
            <button type="button" class="btn btn-outline btn--small" data-deny-visitor="${row.id}">Deny</button>
          </div>
        </div>`).join('')}
      </div>` : '';

    el.innerHTML = `
      ${approvalSection}
      <div class="portal-home-grid">
        <div class="portal-home-card portal-home-card--highlight">
          <h3>Outstanding dues</h3>
          <p class="portal-home-stat">${formatMoney(totalDue)}</p>
          <button type="button" class="btn btn-outline btn--small" data-portal-nav="portal-invoices">View invoices</button>
        </div>
        <div class="portal-home-card">
          <h3>My flats</h3>
          <p class="portal-home-stat">${units.map((u) => u.number).join(', ')}</p>
        </div>
        <div class="portal-home-card">
          <h3>Notices</h3>
          <p class="portal-home-stat">${unread ? `${unread} unread` : 'Up to date'}</p>
          <button type="button" class="btn btn-outline btn--small" data-portal-nav="portal-notices">Notice board</button>
        </div>
      </div>
      <h3 class="portal-section-title">Open invoices</h3>
      <div class="portal-invoice-list">
        ${unitIds.flatMap((id) => openByUnit[id].map((inv) => invoiceRow(inv, true))).join('')
            || '<p class="portal-empty">No open invoices — you\'re all caught up.</p>'}
      </div>`;

    el.querySelectorAll('[data-portal-nav]').forEach((btn) => {
        btn.onclick = () => window.switchView(btn.dataset.portalNav);
    });
    el.querySelectorAll('.portal-pay-btn').forEach((btn) => {
        btn.onclick = () => window.portalPayInvoice?.(btn.dataset.invoiceId);
    });
    el.querySelectorAll('[data-approve-visitor]').forEach((btn) => {
        btn.onclick = async () => {
            try {
                await respondVisitorApproval(btn.dataset.approveVisitor, true);
                await renderPortalHome();
            } catch (e) {
                alert(e.message);
            }
        };
    });
    el.querySelectorAll('[data-deny-visitor]').forEach((btn) => {
        btn.onclick = async () => {
            const reason = prompt('Reason for denying entry (optional):') || '';
            try {
                await respondVisitorApproval(btn.dataset.denyVisitor, false, reason);
                await renderPortalHome();
            } catch (e) {
                alert(e.message);
            }
        };
    });
};

export const renderPortalInvoices = async () => {
    const el = document.getElementById('portal-subview-invoices');
    if (!el) return;
    const invoices = await getMyInvoices();
    if (!invoices.length) {
        el.innerHTML = '<p class="portal-empty">No invoices for your linked flats.</p>';
        return;
    }
    const sorted = [...invoices].sort((a, b) => (b.due_date || '').localeCompare(a.due_date || ''));
    el.innerHTML = `<div class="portal-invoice-list">${sorted.map((inv) => invoiceRow(inv, true)).join('')}</div>`;
    el.querySelectorAll('.portal-pay-btn').forEach((btn) => {
        btn.onclick = () => window.portalPayInvoice?.(btn.dataset.invoiceId);
    });
};

export const renderPortalVehicles = async () => {
    const el = document.getElementById('portal-subview-vehicles');
    if (!el) return;
    const units = await getMyUnits();
    const unitIds = new Set(units.map((u) => u.id));
    const vehicles = portalState.units
        .filter((u) => unitIds.has(u.id))
        .flatMap((u) => (u.vehicles || []).map((v) => ({ ...v, unit_number: u.number })));

    if (!vehicles.length) {
        el.innerHTML = '<p class="portal-empty">No vehicles registered for your flats.</p>';
        return;
    }

    el.innerHTML = `<div class="portal-vehicle-list">
      ${vehicles.map((v) => `<div class="portal-vehicle-row">
        <div><strong>${v.plate || '—'}</strong> <span class="portal-vehicle-row__unit">${v.unit_number}</span></div>
        <div class="portal-vehicle-row__meta">
          <span>${v.type || 'Vehicle'}</span>
          <span class="portal-status portal-status--${(v.status || 'active').toLowerCase()}">${v.status || 'Active'}</span>
        </div>
      </div>`).join('')}
    </div>`;
};

export const renderPortalNotices = async () => {
    const el = document.getElementById('portal-subview-notices');
    if (!el) return;
    const notices = await getNoticesForUser();
    if (!notices.length) {
        el.innerHTML = '<p class="portal-empty">No notices at this time.</p>';
        return;
    }
    el.innerHTML = `<div class="portal-notice-list">
      ${notices.map((n) => `<article class="portal-notice-card ${n._read ? '' : 'portal-notice-card--unread'}" data-notice-id="${n.id}">
        <header>
          <h3>${n.title}</h3>
          <span class="portal-notice-priority portal-notice-priority--${(n.priority || 'normal').toLowerCase()}">${n.priority}</span>
        </header>
        <div class="portal-notice-body">${renderNoticeBodyHtml(n.body)}</div>
        <footer>${n.published_at ? new Date(n.published_at).toLocaleDateString('en-IN') : ''}</footer>
      </article>`).join('')}
    </div>`;
    el.querySelectorAll('.portal-notice-card').forEach((card) => {
        card.onclick = async () => {
            await markNoticeRead(card.dataset.noticeId);
            card.classList.remove('portal-notice-card--unread');
        };
    });
};

export const renderPortalTickets = () => {
    const el = document.getElementById('portal-subview-tickets');
    if (!el) return;
    const uid = portalState.auth?.id;
    const tickets = (portalState.operations?.helpdeskTickets || [])
        .filter((t) => t.created_by === uid);
    el.innerHTML = `
      <div class="portal-tickets-toolbar">
        <button type="button" class="btn btn-primary btn--small" id="portal-new-ticket-btn"><i class="fa-solid fa-plus"></i> Raise ticket</button>
      </div>
      ${tickets.length ? `<div class="portal-ticket-list">
        ${tickets.map((t) => `<div class="portal-ticket-row">
          <strong>${t.subject}</strong>
          <span class="portal-status portal-status--${t.status.toLowerCase()}">${t.status}</span>
          <span>${t.category}</span>
          <span>${new Date(t.created_at).toLocaleDateString('en-IN')}</span>
        </div>`).join('')}
      </div>` : '<p class="portal-empty">No tickets yet.</p>'}`;
    document.getElementById('portal-new-ticket-btn')?.addEventListener('click', () => window.openPortalTicketModal?.());
};

export const renderPortalSubview = async (subview) => {
    if (subview === 'home') await renderPortalHome();
    else if (subview === 'invoices') await renderPortalInvoices();
    else if (subview === 'payments') await renderPortalPayments();
    else if (subview === 'vehicles') await renderPortalVehicles();
    else if (subview === 'notices') await renderPortalNotices();
    else if (subview === 'tickets') renderPortalTickets();
};

export const initResidentPortal = () => {
    document.getElementById('portal-ticket-save')?.addEventListener('click', () => void savePortalTicket());
    document.getElementById('portal-ticket-cancel')?.addEventListener('click', () => {
        document.getElementById('portal-ticket-modal')?.classList.remove('active');
    });
};

window.openPortalTicketModal = async () => {
    const units = await getMyUnits();
    const sel = document.getElementById('portal-ticket-unit');
    if (sel) {
        sel.innerHTML = units.map((u) => `<option value="${u.id}">${u.number}</option>`).join('');
    }
    document.getElementById('portal-ticket-modal')?.classList.add('active');
};

async function savePortalTicket() {
    if (!supabase) return alert('Supabase required.');
    const apartment_id = portalState.access?.activeApartmentId;
    const subject = document.getElementById('portal-ticket-subject')?.value?.trim();
    const category = document.getElementById('portal-ticket-category')?.value?.trim() || 'General';
    const description = document.getElementById('portal-ticket-desc')?.value?.trim();
    const unit_id = document.getElementById('portal-ticket-unit')?.value || null;
    if (!subject) return alert('Enter a subject.');

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('helpdesk_tickets').insert({
        id: crypto.randomUUID(),
        apartment_id,
        unit_id,
        category,
        subject,
        description,
        created_by: user?.id,
    });
    if (error) return alert(error.message);
    await pullState();
    document.getElementById('portal-ticket-modal')?.classList.remove('active');
    renderPortalTickets();
    alert('Ticket submitted.');
}

export { getUnitBlock };
