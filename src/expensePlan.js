/**
 * Expense plan — list-first: planned timeline + details; add via modals.
 */
import { portalState } from './store.js';
import { EXPENSE_CATS, categoryDisplayLabel } from './expenseCategories.js';
import { postFinanceMutation } from './financeApi.js';
import { withButtonBusy } from './buttonBusy.js';
import { getBookBalanceSummary } from './financeAnalytics.js';
import { hasClientPermission } from './rbac.js';
import { canCrud } from './rbacMatrix.js';
import { wireClassifyCombobox, setClassifyInputState } from './classifyCombobox.js';

const formatMoney = (n) =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const todayISO = () => new Date().toISOString().slice(0, 10);

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

let horizonMonths = 6;
let wired = false;
let selectedKey = null;
let lastTimeline = [];
let editingItemId = null;
let editingRecurringId = null;

const canEditPlan = () => hasClientPermission('accounts.edit');
const canDeletePlan = () => canCrud('accounts', 'delete');

const rowActionsHtml = ({ editAttr, editValue, delAttr, delValue }) => {
  if (!canEditPlan()) return '';
  const del = canDeletePlan()
    ? `<button type="button" class="btn btn-outline btn--small btn--icon" ${delAttr}="${esc(delValue)}" title="Delete" aria-label="Delete" style="color:var(--danger);">
      <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
    </button>`
    : '';
  return `<td class="eplan-actions">
    <button type="button" class="btn btn-outline btn--small btn--icon" ${editAttr}="${esc(editValue)}" title="Edit" aria-label="Edit">
      <i class="fa-solid fa-pen" aria-hidden="true"></i>
    </button>
    ${del}
  </td>`;
};

const detailActionsHtml = ({ editAttr, editValue, delAttr, delValue, delLabel }) => {
  if (!canEditPlan()) return '';
  const del = canDeletePlan()
    ? `<button type="button" class="btn btn-outline btn--small btn--danger" ${delAttr}="${esc(delValue)}">
      <i class="fa-solid fa-trash-can" aria-hidden="true"></i> ${esc(delLabel || 'Delete')}
    </button>`
    : '';
  return `<div class="eplan-detail__actions">
    <button type="button" class="btn btn-outline btn--small" ${editAttr}="${esc(editValue)}">
      <i class="fa-solid fa-pen" aria-hidden="true"></i> Edit
    </button>
    ${del}
  </div>`;
};

const getItems = () => portalState.finances.expensePlanItems || [];
const getRecurring = () => portalState.finances.expensePlanRecurring || [];

const applyItemLocally = (item) => {
  if (!portalState.finances.expensePlanItems) portalState.finances.expensePlanItems = [];
  const list = portalState.finances.expensePlanItems;
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
};

const removeItemLocally = (id) => {
  portalState.finances.expensePlanItems = (portalState.finances.expensePlanItems || [])
    .filter((x) => x.id !== id);
};

const applyRecurringLocally = (row) => {
  if (!portalState.finances.expensePlanRecurring) portalState.finances.expensePlanRecurring = [];
  const list = portalState.finances.expensePlanRecurring;
  const idx = list.findIndex((x) => x.id === row.id);
  if (idx >= 0) list[idx] = row;
  else list.push(row);
};

const removeRecurringLocally = (id) => {
  portalState.finances.expensePlanRecurring = (portalState.finances.expensePlanRecurring || [])
    .filter((x) => x.id !== id);
};

const addMonthsClamped = (y, m, day) => {
  const last = new Date(y, m + 1, 0).getDate();
  const d = Math.min(day, last, 28);
  return new Date(y, m, d);
};

export const projectRecurringOccurrences = (templates, fromIso, toIso) => {
  const from = new Date(`${fromIso}T12:00:00`);
  const to = new Date(`${toIso}T12:00:00`);
  const out = [];

  (templates || []).filter((t) => t.active !== false).forEach((t) => {
    const start = new Date(`${String(t.start_date).slice(0, 10)}T12:00:00`);
    const end = t.end_date ? new Date(`${String(t.end_date).slice(0, 10)}T12:00:00`) : null;
    const day = Math.min(28, Math.max(1, parseInt(t.day_of_month, 10) || 1));
    const step = t.cadence === 'yearly' ? 12 : (t.cadence === 'quarterly' ? 3 : 1);

    let y = start.getFullYear();
    let m = start.getMonth();
    let cursor = addMonthsClamped(y, m, day);
    if (cursor < start) {
      m += step;
      cursor = addMonthsClamped(start.getFullYear() + Math.floor(m / 12), ((m % 12) + 12) % 12, day);
      y = cursor.getFullYear();
      m = cursor.getMonth();
    }

    let guard = 0;
    while (guard++ < 120) {
      cursor = addMonthsClamped(y, m, day);
      if (cursor > to) break;
      if (end && cursor > end) break;
      if (cursor >= from && cursor >= start) {
        const iso = cursor.toISOString().slice(0, 10);
        const dueDay = Math.min(28, Math.max(1, parseInt(t.due_day_of_month, 10) || day));
        const dueDate = addMonthsClamped(cursor.getFullYear(), cursor.getMonth(), dueDay)
          .toISOString()
          .slice(0, 10);
        out.push({
          source: 'recurring',
          key: `rec:${t.id}:${iso}`,
          recurring_id: t.id,
          plan_date: iso,
          due_date: dueDate,
          amount: parseFloat(t.amount) || 0,
          cat: t.cat,
          vendor_name: t.vendor_name,
          description: t.description,
          title: t.title || t.description,
          cadence: t.cadence,
          day_of_month: t.day_of_month,
          due_day_of_month: dueDay,
          start_date: t.start_date,
          end_date: t.end_date,
        });
      }
      m += step;
      y += Math.floor(m / 12);
      m = ((m % 12) + 12) % 12;
    }
  });

  return out;
};

const horizonEndIso = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
};

const buildTimeline = () => {
  const from = todayISO();
  const to = horizonEndIso(horizonMonths);
  const oneOff = getItems()
    .filter((i) => i.status === 'planned')
    .filter((i) => {
      const d = String(i.plan_date || '').slice(0, 10);
      return d >= from && d <= to;
    })
    .map((i) => ({
      source: 'oneoff',
      key: `one:${i.id}`,
      id: i.id,
      plan_date: String(i.plan_date).slice(0, 10),
      due_date: i.due_date ? String(i.due_date).slice(0, 10) : String(i.plan_date).slice(0, 10),
      amount: parseFloat(i.amount) || 0,
      cat: i.cat,
      vendor_name: i.vendor_name,
      description: i.description,
      notes: i.notes,
      title: i.description || i.vendor_name || 'Planned',
    }));

  const projected = projectRecurringOccurrences(getRecurring(), from, to);
  return [...oneOff, ...projected].sort((a, b) => {
    const da = String(a.due_date || a.plan_date);
    const db = String(b.due_date || b.plan_date);
    return da.localeCompare(db) || String(a.title || '').localeCompare(String(b.title || ''));
  });
};

const catOptionsList = () => {
  const fromPlan = [
    ...getItems().map((i) => i.cat),
    ...getRecurring().map((t) => t.cat),
  ].filter(Boolean);
  return [...new Set([...EXPENSE_CATS, ...fromPlan])].sort((a, b) =>
    String(categoryDisplayLabel(a) || a).localeCompare(String(categoryDisplayLabel(b) || b)),
  );
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: '2-digit',
  });
};

const closeModal = () => {
  const modal = document.getElementById('eplan-modal');
  if (modal) modal.hidden = true;
  editingItemId = null;
  editingRecurringId = null;
};

const fillOneOffForm = (item) => {
  const dateEl = document.getElementById('eplan-item-date');
  const dueEl = document.getElementById('eplan-item-due');
  const amt = document.getElementById('eplan-item-amount');
  const desc = document.getElementById('eplan-item-desc');
  const vendor = document.getElementById('eplan-item-vendor');
  const cat = document.getElementById('eplan-item-cat');
  if (dateEl) dateEl.value = item?.plan_date ? String(item.plan_date).slice(0, 10) : todayISO();
  if (dueEl) {
    dueEl.value = item?.due_date
      ? String(item.due_date).slice(0, 10)
      : (item?.plan_date ? String(item.plan_date).slice(0, 10) : todayISO());
    if (item) dueEl.dataset.touched = '1';
    else delete dueEl.dataset.touched;
  }
  if (amt) amt.value = item?.amount != null ? String(item.amount) : '';
  if (desc) desc.value = item?.description || item?.title || '';
  if (vendor) vendor.value = item?.vendor_name || '';
  if (cat) {
    const v = item?.cat || '';
    cat.value = v;
    setClassifyInputState(cat, v);
  }
};

const fillRecurringForm = (t) => {
  const startEl = document.getElementById('eplan-rec-start');
  const titleEl = document.getElementById('eplan-rec-title');
  const amt = document.getElementById('eplan-rec-amount');
  const day = document.getElementById('eplan-rec-day');
  const dueDay = document.getElementById('eplan-rec-due-day');
  const cadence = document.getElementById('eplan-rec-cadence');
  const cat = document.getElementById('eplan-rec-cat');
  if (startEl) startEl.value = t?.start_date ? String(t.start_date).slice(0, 10) : todayISO();
  if (titleEl) titleEl.value = t?.title || '';
  if (amt) amt.value = t?.amount != null ? String(t.amount) : '';
  if (day) day.value = String(t?.day_of_month ?? 1);
  if (dueDay) {
    dueDay.value = String(t?.due_day_of_month ?? t?.day_of_month ?? 1);
    if (t) dueDay.dataset.touched = '1';
    else delete dueDay.dataset.touched;
  }
  if (cadence) cadence.value = t?.cadence || 'monthly';
  if (cat) {
    const v = t?.cat || '';
    cat.value = v;
    setClassifyInputState(cat, v);
  }
};

const openModal = (kind, record = null) => {
  const modal = document.getElementById('eplan-modal');
  const one = document.getElementById('eplan-modal-oneoff');
  const rec = document.getElementById('eplan-modal-recurring');
  const title = document.getElementById('eplan-modal-title');
  const saveOne = document.getElementById('eplan-item-save');
  const saveRec = document.getElementById('eplan-rec-save');
  if (!modal || !one || !rec) return;

  closeDetail();
  editingItemId = null;
  editingRecurringId = null;

  one.hidden = kind !== 'oneoff';
  rec.hidden = kind !== 'recurring';

  if (kind === 'oneoff') {
    editingItemId = record?.id || null;
    fillOneOffForm(record);
    if (title) title.textContent = editingItemId ? 'Edit one-off expense' : 'Add one-off expense';
    if (saveOne) saveOne.textContent = editingItemId ? 'Save changes' : 'Save one-off';
  } else {
    editingRecurringId = record?.id || null;
    fillRecurringForm(record);
    if (title) title.textContent = editingRecurringId ? 'Edit recurring template' : 'Add recurring template';
    if (saveRec) saveRec.textContent = editingRecurringId ? 'Save changes' : 'Save recurring';
  }

  modal.hidden = false;
  const focusId = kind === 'oneoff' ? 'eplan-item-desc' : 'eplan-rec-title';
  setTimeout(() => document.getElementById(focusId)?.focus(), 40);
};

const openEditOneOff = (id) => {
  const item = getItems().find((x) => x.id === id);
  if (!item) return;
  openModal('oneoff', item);
};

const openEditRecurring = (id) => {
  const t = getRecurring().find((x) => x.id === id);
  if (!t) return;
  openModal('recurring', t);
};

const closeDetail = () => {
  selectedKey = null;
  const modal = document.getElementById('eplan-detail-modal');
  if (modal) modal.hidden = true;
  document.querySelectorAll('.eplan-row--selected').forEach((r) => r.classList.remove('eplan-row--selected'));
};

const openDetailModal = (titleText) => {
  const modal = document.getElementById('eplan-detail-modal');
  const title = document.getElementById('eplan-detail-title');
  if (title) title.textContent = titleText || 'Details';
  if (modal) modal.hidden = false;
};

const showDetail = (row) => {
  const body = document.getElementById('eplan-detail-body');
  if (!body || !row) return;
  selectedKey = row.key;

  document.querySelectorAll('.eplan-row--selected').forEach((r) => r.classList.remove('eplan-row--selected'));
  document.querySelector(`.eplan-row[data-eplan-key="${CSS.escape(row.key)}"]`)?.classList.add('eplan-row--selected');

  if (row.source === 'oneoff') {
    openDetailModal(row.title || row.description || 'Planned expense');
    body.innerHTML = `
      <p class="eplan-detail__title">${esc(row.title || row.description || 'Planned expense')}</p>
      <dl class="eplan-dl">
        <div class="eplan-dl__block"><dt>What’s it for</dt><dd>${esc(row.description || row.notes || row.title || '—')}</dd></div>
        <div class="eplan-dl__block"><dt>Category</dt><dd>${esc(categoryDisplayLabel(row.cat) || row.cat || '—')}</dd></div>
        <div class="eplan-dl__block"><dt>Vendor</dt><dd>${esc(row.vendor_name || '—')}</dd></div>
        <div class="eplan-dl__block"><dt>Amount</dt><dd>${formatMoney(row.amount)}</dd></div>
        <div class="eplan-dl__meta">
          <div><dt>Type</dt><dd>One-off</dd></div>
          <div><dt>Planned for</dt><dd>${esc(fmtDate(row.plan_date))}</dd></div>
          <div><dt>Due by</dt><dd>${esc(fmtDate(row.due_date || row.plan_date))}</dd></div>
        </div>
      </dl>
      ${detailActionsHtml({
        editAttr: 'data-eplan-edit-item',
        editValue: row.id,
        delAttr: 'data-eplan-del-item',
        delValue: row.id,
        delLabel: 'Remove from plan',
      })}
    `;
    return;
  }

  const tmpl = getRecurring().find((t) => t.id === row.recurring_id);
  openDetailModal(row.title || 'Recurring');
  body.innerHTML = `
    <p class="eplan-detail__title">${esc(row.title || 'Recurring')}</p>
    <dl class="eplan-dl">
      <div class="eplan-dl__block"><dt>What’s it for</dt><dd>${esc(row.title || row.description || '—')}</dd></div>
      <div class="eplan-dl__block"><dt>Category</dt><dd>${esc(categoryDisplayLabel(row.cat) || row.cat || '—')}</dd></div>
      <div class="eplan-dl__block"><dt>Amount</dt><dd>${formatMoney(row.amount)}</dd></div>
      <div class="eplan-dl__meta">
        <div><dt>Type</dt><dd>Recurring</dd></div>
        <div><dt>Planned for</dt><dd>${esc(fmtDate(row.plan_date))}</dd></div>
        <div><dt>Due by</dt><dd>${esc(fmtDate(row.due_date || row.plan_date))}</dd></div>
        <div><dt>Cadence</dt><dd>${esc(row.cadence || tmpl?.cadence || '—')} · day ${esc(row.day_of_month ?? tmpl?.day_of_month ?? '—')} · due ${esc(row.due_day_of_month ?? tmpl?.due_day_of_month ?? row.day_of_month ?? '—')}</dd></div>
        <div><dt>Starts</dt><dd>${esc(fmtDate(row.start_date || tmpl?.start_date))}</dd></div>
        <div><dt>Ends</dt><dd>${esc(row.end_date || tmpl?.end_date ? fmtDate(row.end_date || tmpl.end_date) : 'Ongoing')}</dd></div>
      </div>
    </dl>
    ${row.recurring_id
      ? detailActionsHtml({
        editAttr: 'data-eplan-edit-recurring',
        editValue: row.recurring_id,
        delAttr: 'data-eplan-del-recurring',
        delValue: row.recurring_id,
        delLabel: 'Delete template',
      })
      : ''}
  `;
};

const showTemplateDetail = (t) => {
  const body = document.getElementById('eplan-detail-body');
  if (!body || !t) return;
  selectedKey = `tmpl:${t.id}`;
  document.querySelectorAll('.eplan-row--selected').forEach((r) => r.classList.remove('eplan-row--selected'));
  document.querySelector(`[data-eplan-recurring="${CSS.escape(t.id)}"]`)?.classList.add('eplan-row--selected');
  openDetailModal(t.title || 'Recurring template');
  body.innerHTML = `
    <p class="eplan-detail__title">${esc(t.title)}</p>
    <dl class="eplan-dl">
      <div class="eplan-dl__block"><dt>What’s it for</dt><dd>${esc(t.title)}</dd></div>
      <div class="eplan-dl__block"><dt>Category</dt><dd>${esc(categoryDisplayLabel(t.cat) || t.cat || '—')}</dd></div>
      <div class="eplan-dl__block"><dt>Vendor</dt><dd>${esc(t.vendor_name || '—')}</dd></div>
      <div class="eplan-dl__block"><dt>Amount</dt><dd>${formatMoney(t.amount)}</dd></div>
      <div class="eplan-dl__meta">
        <div><dt>Type</dt><dd>Recurring template</dd></div>
        <div><dt>Cadence</dt><dd>${esc(t.cadence)} · on day ${esc(t.day_of_month)} · due day ${esc(t.due_day_of_month ?? t.day_of_month)}</dd></div>
        <div><dt>Starts</dt><dd>${esc(fmtDate(t.start_date))}</dd></div>
        <div><dt>Ends</dt><dd>${esc(t.end_date ? fmtDate(t.end_date) : 'Ongoing')}</dd></div>
        <div><dt>Active</dt><dd>${t.active !== false ? 'Yes' : 'No'}</dd></div>
      </div>
    </dl>
    ${detailActionsHtml({
      editAttr: 'data-eplan-edit-recurring',
      editValue: t.id,
      delAttr: 'data-eplan-del-recurring',
      delValue: t.id,
      delLabel: 'Delete template',
    })}
  `;
};

const renderSummary = (timeline) => {
  const el = document.getElementById('eplan-summary');
  if (!el) return;
  const total = round2(timeline.reduce((s, r) => s + (r.amount || 0), 0));
  const { book, hasBank, bankBalance, cash, pending } = getBookBalanceSummary();
  const after = round2(book - total);
  el.innerHTML = `
    <div class="ledger-kpi">
      <i class="fa-solid fa-vault" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Book balance</span>
        <span class="ledger-kpi__value">${formatMoney(book)}</span>
        <span class="ledger-kpi__hint">${hasBank
          ? `${formatMoney(bankBalance)} − ${formatMoney(pending.total)} + ${formatMoney(cash)}`
          : formatMoney(cash)}</span>
      </div>
    </div>
    <div class="ledger-kpi">
      <i class="fa-solid fa-calendar-days" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Planned (${horizonMonths} mo)</span>
        <span class="ledger-kpi__value">${formatMoney(total)}</span>
        <span class="ledger-kpi__hint">${timeline.length} item(s)</span>
      </div>
    </div>
    <div class="ledger-kpi">
      <i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">After plan</span>
        <span class="ledger-kpi__value">${formatMoney(after)}</span>
        <span class="ledger-kpi__hint">${after < -0.009 ? 'Shortfall vs book balance' : 'Left if plan clears'}</span>
      </div>
    </div>
  `;
};

const renderTimeline = (timeline) => {
  const el = document.getElementById('eplan-timeline');
  const meta = document.getElementById('eplan-timeline-meta');
  if (meta) meta.textContent = `${timeline.length} in next ${horizonMonths} months`;
  if (!el) return;
  if (!timeline.length) {
    el.innerHTML = '<p class="fa-panel__hint">Nothing planned in this horizon yet. Use <strong>Add one-off</strong> or <strong>Add recurring</strong>.</p>';
    return;
  }
  const showActions = canEditPlan();
  const rows = timeline.map((r) => {
    const selected = r.key === selectedKey ? ' eplan-row--selected' : '';
    const badge = r.source === 'recurring'
      ? '<span class="eplan-badge eplan-badge--recurring">Recurring</span>'
      : '<span class="eplan-badge">One-off</span>';
    const due = r.due_date || r.plan_date;
    const overdue = due && due < todayISO();
    const actions = r.source === 'oneoff'
      ? rowActionsHtml({
        editAttr: 'data-eplan-edit-item',
        editValue: r.id,
        delAttr: 'data-eplan-del-item',
        delValue: r.id,
      })
      : rowActionsHtml({
        editAttr: 'data-eplan-edit-recurring',
        editValue: r.recurring_id,
        delAttr: 'data-eplan-del-recurring',
        delValue: r.recurring_id,
      });
    return `<tr class="eplan-row${selected}${overdue ? ' eplan-row--overdue' : ''}" data-eplan-key="${esc(r.key)}" title="View details">
      <td class="eplan-col-what">
        <div class="eplan-what">${esc(r.title || '—')}</div>
        <div class="eplan-what-meta">${badge}</div>
      </td>
      <td>${esc(categoryDisplayLabel(r.cat) || r.cat || '—')}</td>
      <td class="cash-float-amt">${formatMoney(r.amount)}</td>
      <td>${esc(fmtDate(r.plan_date))}</td>
      <td class="${overdue ? 'eplan-due--late' : ''}">${esc(fmtDate(due))}</td>
      ${actions}
    </tr>`;
  }).join('');
  el.innerHTML = `<table class="fa-pivot-table cash-float-table eplan-table">
    <thead><tr>
      <th class="eplan-col-what">What’s it for</th>
      <th>Category</th>
      <th class="cash-float-amt">Amount</th>
      <th>Planned</th>
      <th>Due by</th>
      ${showActions ? '<th class="eplan-actions"></th>' : ''}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
};

const renderRecurringList = () => {
  const el = document.getElementById('eplan-recurring-list');
  const meta = document.getElementById('eplan-recurring-meta');
  const rows = getRecurring();
  if (meta) meta.textContent = `${rows.length} template${rows.length === 1 ? '' : 's'}`;
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<p class="fa-panel__hint">No recurring templates yet.</p>';
    return;
  }
  const showActions = canEditPlan();
  el.innerHTML = `<table class="fa-pivot-table cash-float-table eplan-table">
    <thead><tr>
      <th>Title</th><th>Cadence</th><th>On / Due</th><th class="cash-float-amt">Amount</th><th>Active</th>
      ${showActions ? '<th class="eplan-actions"></th>' : ''}
    </tr></thead>
    <tbody>${rows.map((t) => `<tr class="eplan-row eplan-row--template" data-eplan-recurring="${esc(t.id)}" title="View details">
      <td>${esc(t.title)}</td>
      <td>${esc(t.cadence)}</td>
      <td>${esc(t.day_of_month)} / ${esc(t.due_day_of_month ?? t.day_of_month)}</td>
      <td class="cash-float-amt">${formatMoney(t.amount)}</td>
      <td>${t.active !== false ? 'Yes' : 'No'}</td>
      ${rowActionsHtml({
        editAttr: 'data-eplan-edit-recurring',
        editValue: t.id,
        delAttr: 'data-eplan-del-recurring',
        delValue: t.id,
      })}
    </tr>`).join('')}</tbody>
  </table>`;
};

export const renderExpensePlanPage = () => {
  const horizonEl = document.getElementById('eplan-horizon');
  if (horizonEl && !horizonEl.dataset.touched) {
    horizonEl.value = String(horizonMonths);
  }
  const edit = canEditPlan();
  const addOne = document.getElementById('eplan-add-oneoff');
  const addRec = document.getElementById('eplan-add-recurring');
  if (addOne) addOne.hidden = !edit;
  if (addRec) addRec.hidden = !edit;

  lastTimeline = buildTimeline();
  renderSummary(lastTimeline);
  renderTimeline(lastTimeline);
  renderRecurringList();

  if (selectedKey) {
    const row = lastTimeline.find((r) => r.key === selectedKey);
    if (row) showDetail(row);
    else if (selectedKey.startsWith('tmpl:')) {
      const t = getRecurring().find((x) => `tmpl:${x.id}` === selectedKey);
      if (t) showTemplateDetail(t);
      else closeDetail();
    } else closeDetail();
  }
};

const saveOneOff = async () => {
  const apt = portalState.access?.activeApartmentId;
  if (!apt) throw new Error('Select an apartment first.');
  const plan_date = document.getElementById('eplan-item-date')?.value;
  const due_date = document.getElementById('eplan-item-due')?.value || plan_date;
  const amount = parseFloat(document.getElementById('eplan-item-amount')?.value || '');
  const cat = document.getElementById('eplan-item-cat')?.value?.trim() || 'Other';
  const description = document.getElementById('eplan-item-desc')?.value?.trim() || '';
  const vendor_name = document.getElementById('eplan-item-vendor')?.value?.trim() || '';
  if (!plan_date || !Number.isFinite(amount)) throw new Error('Planned date and amount are required.');
  if (!description) throw new Error('Say what this expense is for.');

  const result = await postFinanceMutation('saveExpensePlanItem', {
    apartment_id: apt,
    ...(editingItemId ? { id: editingItemId } : {}),
    plan_date,
    due_date,
    amount,
    cat,
    description,
    vendor_name,
  });
  if (result.item) applyItemLocally(result.item);
  closeModal();
  renderExpensePlanPage();
  if (result.item) {
    const key = `one:${result.item.id}`;
    const row = lastTimeline.find((r) => r.key === key)
      || {
        source: 'oneoff',
        key,
        id: result.item.id,
        plan_date: result.item.plan_date,
        due_date: result.item.due_date || result.item.plan_date,
        amount: result.item.amount,
        cat: result.item.cat,
        vendor_name: result.item.vendor_name,
        description: result.item.description,
        title: result.item.description || result.item.vendor_name || 'Planned',
      };
    showDetail(row);
  }
};

const saveRecurring = async () => {
  const apt = portalState.access?.activeApartmentId;
  if (!apt) throw new Error('Select an apartment first.');
  const title = document.getElementById('eplan-rec-title')?.value?.trim();
  const amount = parseFloat(document.getElementById('eplan-rec-amount')?.value || '');
  const cadence = document.getElementById('eplan-rec-cadence')?.value || 'monthly';
  const day_of_month = parseInt(document.getElementById('eplan-rec-day')?.value || '1', 10);
  const due_day_of_month = parseInt(document.getElementById('eplan-rec-due-day')?.value || String(day_of_month), 10);
  const start_date = document.getElementById('eplan-rec-start')?.value || todayISO();
  const cat = document.getElementById('eplan-rec-cat')?.value?.trim() || 'Other';
  if (!title || !Number.isFinite(amount)) throw new Error('Title and amount are required.');

  const existing = editingRecurringId
    ? getRecurring().find((x) => x.id === editingRecurringId)
    : null;

  const result = await postFinanceMutation('saveExpensePlanRecurring', {
    apartment_id: apt,
    ...(editingRecurringId ? { id: editingRecurringId } : {}),
    title,
    amount,
    cadence,
    day_of_month,
    due_day_of_month,
    start_date,
    end_date: existing?.end_date || null,
    cat,
    active: existing ? existing.active !== false : true,
  });
  if (result.recurring) applyRecurringLocally(result.recurring);
  closeModal();
  const panel = document.getElementById('eplan-templates-panel');
  if (panel) panel.open = true;
  renderExpensePlanPage();
  if (result.recurring) showTemplateDetail(result.recurring);
};

export const initExpensePlanPage = () => {
  const root = document.getElementById('subview-expense-plan');
  if (!root || wired) {
    renderExpensePlanPage();
    return;
  }
  wired = true;

  wireClassifyCombobox(document.getElementById('eplan-item-cat-wrap'), {
    getOptions: catOptionsList,
  });
  wireClassifyCombobox(document.getElementById('eplan-rec-cat-wrap'), {
    getOptions: catOptionsList,
  });

  // Keep due day in sync with on-day as a default when user hasn't touched due day.
  document.getElementById('eplan-rec-day')?.addEventListener('input', (e) => {
    const due = document.getElementById('eplan-rec-due-day');
    if (due && !due.dataset.touched) due.value = e.target.value || '1';
  });
  document.getElementById('eplan-rec-due-day')?.addEventListener('input', (e) => {
    e.target.dataset.touched = '1';
  });
  document.getElementById('eplan-item-date')?.addEventListener('change', (e) => {
    const due = document.getElementById('eplan-item-due');
    if (due && !due.dataset.touched) due.value = e.target.value;
  });
  document.getElementById('eplan-item-due')?.addEventListener('change', (e) => {
    e.target.dataset.touched = '1';
  });

  document.getElementById('eplan-horizon')?.addEventListener('change', (e) => {
    e.target.dataset.touched = '1';
    horizonMonths = parseInt(e.target.value, 10) || 6;
    renderExpensePlanPage();
  });

  document.getElementById('eplan-add-oneoff')?.addEventListener('click', () => openModal('oneoff'));
  document.getElementById('eplan-add-recurring')?.addEventListener('click', () => openModal('recurring'));
  document.getElementById('eplan-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('eplan-modal-backdrop')?.addEventListener('click', closeModal);
  document.getElementById('eplan-detail-close')?.addEventListener('click', closeDetail);
  document.getElementById('eplan-detail-backdrop')?.addEventListener('click', closeDetail);

  document.getElementById('eplan-item-save')?.addEventListener('click', () => {
    const btn = document.getElementById('eplan-item-save');
    void withButtonBusy(btn, 'Saving…', saveOneOff)
      .catch((err) => alert(err?.message || 'Could not save.'));
  });

  document.getElementById('eplan-rec-save')?.addEventListener('click', () => {
    const btn = document.getElementById('eplan-rec-save');
    void withButtonBusy(btn, 'Saving…', saveRecurring)
      .catch((err) => alert(err?.message || 'Could not save.'));
  });

  root.addEventListener('click', (e) => {
    const editItem = e.target.closest('[data-eplan-edit-item]');
    if (editItem) {
      e.preventDefault();
      e.stopPropagation();
      openEditOneOff(editItem.getAttribute('data-eplan-edit-item'));
      return;
    }
    const editRec = e.target.closest('[data-eplan-edit-recurring]');
    if (editRec) {
      e.preventDefault();
      e.stopPropagation();
      openEditRecurring(editRec.getAttribute('data-eplan-edit-recurring'));
      return;
    }

    const delItem = e.target.closest('[data-eplan-del-item]');
    if (delItem) {
      e.preventDefault();
      e.stopPropagation();
      if (!canDeletePlan()) {
        alert('You do not have permission to delete expense plan items.');
        return;
      }
      const id = delItem.getAttribute('data-eplan-del-item');
      if (!id || !confirm('Remove this planned item?')) return;
      void withButtonBusy(delItem, '…', async () => {
        await postFinanceMutation('deleteExpensePlanItem', {
          apartment_id: portalState.access?.activeApartmentId,
          id,
        });
        removeItemLocally(id);
        closeDetail();
        renderExpensePlanPage();
      }).catch((err) => alert(err?.message || 'Could not delete.'));
      return;
    }
    const delRec = e.target.closest('[data-eplan-del-recurring]');
    if (delRec) {
      e.preventDefault();
      e.stopPropagation();
      if (!canDeletePlan()) {
        alert('You do not have permission to delete expense plan templates.');
        return;
      }
      const id = delRec.getAttribute('data-eplan-del-recurring');
      if (!id || !confirm('Delete this recurring template? Future planned occurrences will disappear.')) return;
      void withButtonBusy(delRec, '…', async () => {
        await postFinanceMutation('deleteExpensePlanRecurring', {
          apartment_id: portalState.access?.activeApartmentId,
          id,
        });
        removeRecurringLocally(id);
        closeDetail();
        renderExpensePlanPage();
      }).catch((err) => alert(err?.message || 'Could not delete.'));
      return;
    }

    const row = e.target.closest('tr.eplan-row[data-eplan-key]');
    if (row && !e.target.closest('button')) {
      const hit = lastTimeline.find((r) => r.key === row.dataset.eplanKey);
      if (hit) showDetail(hit);
      return;
    }
    const tmplRow = e.target.closest('tr[data-eplan-recurring]');
    if (tmplRow && !e.target.closest('button')) {
      const t = getRecurring().find((x) => x.id === tmplRow.dataset.eplanRecurring);
      if (t) showTemplateDetail(t);
    }
  });

  renderExpensePlanPage();
};
