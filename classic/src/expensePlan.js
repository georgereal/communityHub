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

/** Local YYYY-MM-DD (avoid UTC shift from toISOString). */
const toIsoLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const cadenceStepMonths = (cadence) =>
  cadence === 'yearly' ? 12 : (cadence === 'quarterly' ? 3 : 1);

/** Equal split that sums exactly to total (paise-safe via paise ints). */
const splitEqualAmounts = (total, n) => {
  const count = Math.max(1, parseInt(n, 10) || 1);
  const cents = Math.round((Number(total) || 0) * 100);
  const base = Math.floor(cents / count);
  const amounts = Array.from({ length: count }, () => round2(base / 100));
  amounts[count - 1] = round2((cents - base * (count - 1)) / 100);
  return amounts;
};

/** Add `months` to an ISO date, keeping the original day when possible (capped at 28). */
const addMonthsToIso = (iso, months) => {
  const start = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  const day = Math.min(28, start.getDate());
  const y = start.getFullYear();
  const m = start.getMonth() + (parseInt(months, 10) || 0);
  return toIsoLocal(addMonthsClamped(y + Math.floor(m / 12), ((m % 12) + 12) % 12, day));
};

/**
 * Occurrence plan dates: first is always the start date; later ones step by cadence
 * from that start (same calendar day, capped at 28).
 */
const listOccurrenceDates = ({
  startDate,
  cadence = 'monthly',
  termCount = null,
  maxN = 24,
} = {}) => {
  const startIso = String(startDate || todayISO()).slice(0, 10);
  const step = cadenceStepMonths(cadence);
  const limit = termCount != null && termCount !== ''
    ? Math.min(120, Math.max(1, parseInt(termCount, 10) || 1))
    : Math.min(120, Math.max(1, parseInt(maxN, 10) || 24));

  const dates = [];
  for (let i = 0; i < limit; i += 1) {
    dates.push(i === 0 ? startIso : addMonthsToIso(startIso, i * step));
  }
  return dates;
};

const endDateFromTerm = (startDate, cadence, termCount) => {
  if (!termCount) return null;
  const dates = listOccurrenceDates({ startDate, cadence, termCount });
  return dates.length ? dates[dates.length - 1] : null;
};

const parsePeriodAmounts = (raw) => {
  if (Array.isArray(raw)) return raw.map((v) => round2(parseFloat(v) || 0));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((v) => round2(parseFloat(v) || 0));
    } catch {
      /* ignore */
    }
  }
  return null;
};

const dueIsoForPlan = (planIso, dueDayOfMonth) => {
  const plan = new Date(`${String(planIso).slice(0, 10)}T12:00:00`);
  const dueDay = Math.min(28, Math.max(1, parseInt(dueDayOfMonth, 10) || plan.getDate()));
  let due = addMonthsClamped(plan.getFullYear(), plan.getMonth(), dueDay);
  if (due < plan) {
    // Due day before plan day in the same month → due on plan date
    due = plan;
  }
  return toIsoLocal(due);
};

export const projectRecurringOccurrences = (templates, fromIso, toIso) => {
  const from = new Date(`${fromIso}T12:00:00`);
  const to = new Date(`${toIso}T12:00:00`);
  const out = [];

  (templates || []).filter((t) => t.active !== false).forEach((t) => {
    const startIso = String(t.start_date || '').slice(0, 10);
    if (!startIso) return;
    const termCount = t.term_count != null && t.term_count !== ''
      ? Math.max(1, parseInt(t.term_count, 10) || 0)
      : null;
    const periodAmounts = parsePeriodAmounts(t.period_amounts);
    const defaultAmt = parseFloat(t.amount) || 0;
    const dueDay = t.due_day_of_month ?? t.day_of_month;

    // Fixed term: exact start + stepped dates. Ongoing: project far enough for the horizon.
    const dates = listOccurrenceDates({
      startDate: startIso,
      cadence: t.cadence,
      termCount: termCount || 120,
    });

    dates.forEach((iso, occIndex) => {
      if (termCount != null && occIndex >= termCount) return;
      if (t.end_date && iso > String(t.end_date).slice(0, 10)) return;
      const cursor = new Date(`${iso}T12:00:00`);
      if (cursor < from || cursor > to) return;
      const amount = periodAmounts && periodAmounts[occIndex] != null
        ? round2(periodAmounts[occIndex])
        : defaultAmt;
      out.push({
        source: 'recurring',
        key: `rec:${t.id}:${iso}`,
        recurring_id: t.id,
        plan_date: iso,
        due_date: dueIsoForPlan(iso, dueDay),
        amount,
        cat: t.cat,
        vendor_name: t.vendor_name,
        description: t.description,
        title: t.title || t.description,
        cadence: t.cadence,
        day_of_month: t.day_of_month,
        due_day_of_month: dueDay,
        start_date: t.start_date,
        end_date: t.end_date,
        term_count: termCount,
        amount_mode: t.amount_mode || 'per_period',
        occ_index: occIndex,
      });
    });
  });

  return out;
};

const horizonEndIso = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
};

/** Planned one-offs + recurring occurrences in the next `months` (for cash-position / reports). */
export const getExpensePlanHorizonSummary = (months = 6) => {
  const from = todayISO();
  const to = horizonEndIso(Math.max(1, parseInt(months, 10) || 6));
  const oneOff = getItems()
    .filter((i) => i.status === 'planned')
    .filter((i) => {
      const d = String(i.plan_date || '').slice(0, 10);
      return d >= from && d <= to;
    });
  const projected = projectRecurringOccurrences(getRecurring(), from, to);
  const total = round2(
    oneOff.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0)
    + projected.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
  );
  return {
    months: Math.max(1, parseInt(months, 10) || 6),
    from,
    to,
    oneOffCount: oneOff.length,
    recurringCount: projected.length,
    count: oneOff.length + projected.length,
    total,
  };
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
  window.__eplanEditingPeriodAmounts = [];
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

const readRecurringFormMeta = () => {
  const cadence = document.getElementById('eplan-rec-cadence')?.value || 'monthly';
  const day_of_month = parseInt(document.getElementById('eplan-rec-day')?.value || '1', 10);
  const start_date = document.getElementById('eplan-rec-start')?.value || todayISO();
  const termRaw = document.getElementById('eplan-rec-term')?.value?.trim();
  const term_count = termRaw ? Math.min(120, Math.max(1, parseInt(termRaw, 10) || 0)) : null;
  const amount_mode = document.getElementById('eplan-rec-amount-mode')?.value || 'per_period';
  const amountInput = parseFloat(document.getElementById('eplan-rec-amount')?.value || '');
  return {
    cadence,
    day_of_month,
    start_date,
    term_count: term_count || null,
    amount_mode,
    amountInput: Number.isFinite(amountInput) ? amountInput : null,
  };
};

const collectManualPeriodAmounts = () => {
  const inputs = [...document.querySelectorAll('#eplan-rec-periods-list [data-eplan-period-amt]')];
  return inputs.map((el) => round2(parseFloat(el.value) || 0));
};

const refreshRecurringAmountUi = () => {
  const mode = document.getElementById('eplan-rec-amount-mode')?.value || 'per_period';
  const label = document.getElementById('eplan-rec-amount-label');
  const amountWrap = document.getElementById('eplan-rec-amount-wrap');
  const hint = document.getElementById('eplan-rec-split-hint');
  const periods = document.getElementById('eplan-rec-periods');
  const meta = readRecurringFormMeta();

  if (label) {
    label.textContent = mode === 'total_split'
      ? 'Total amount'
      : (mode === 'manual' ? 'Reference amount (optional)' : 'Amount each period');
  }
  if (amountWrap) amountWrap.hidden = mode === 'manual';

  const needsTerm = mode === 'total_split' || mode === 'manual';
  if (hint) {
    if (needsTerm && !meta.term_count) {
      hint.hidden = false;
      hint.textContent = 'Set Term (periods) so amounts can be split across the schedule.';
    } else if (mode === 'total_split' && meta.term_count && meta.amountInput != null) {
      const each = splitEqualAmounts(meta.amountInput, meta.term_count);
      hint.hidden = false;
      hint.textContent = `${meta.term_count} periods · ${formatMoney(each[0])} each`
        + (each.some((a) => a !== each[0]) ? ` (last ${formatMoney(each[each.length - 1])} to balance)` : '');
    } else if (mode === 'per_period' && !meta.term_count) {
      hint.hidden = false;
      hint.textContent = 'Leave Term blank for ongoing, or set how many periods this should run.';
    } else {
      hint.hidden = true;
      hint.textContent = '';
    }
  }

  if (periods) {
    const showSchedule = Boolean(meta.term_count) && (mode === 'manual' || mode === 'total_split' || mode === 'per_period');
    periods.hidden = !showSchedule;
    if (showSchedule) renderPeriodSchedule();
  }
};

const renderPeriodSchedule = () => {
  const list = document.getElementById('eplan-rec-periods-list');
  const sumEl = document.getElementById('eplan-rec-periods-sum');
  if (!list) return;
  const meta = readRecurringFormMeta();
  if (!meta.term_count) {
    list.innerHTML = '';
    if (sumEl) sumEl.textContent = '';
    return;
  }

  const dates = listOccurrenceDates({
    startDate: meta.start_date,
    cadence: meta.cadence,
    termCount: meta.term_count,
  });

  const mode = meta.amount_mode;
  const existingManual = collectManualPeriodAmounts();
  let amounts;
  if (mode === 'total_split' && meta.amountInput != null) {
    amounts = splitEqualAmounts(meta.amountInput, dates.length);
  } else if (mode === 'manual') {
    if (existingManual.length === dates.length) {
      amounts = existingManual;
    } else if (window.__eplanEditingPeriodAmounts?.length) {
      amounts = dates.map((_, i) => round2(window.__eplanEditingPeriodAmounts[i] ?? 0));
    } else if (meta.amountInput != null) {
      amounts = splitEqualAmounts(meta.amountInput, dates.length);
    } else {
      amounts = dates.map(() => 0);
    }
    window.__eplanEditingPeriodAmounts = amounts.slice();
  } else {
    const each = meta.amountInput != null ? round2(meta.amountInput) : 0;
    amounts = dates.map(() => each);
  }

  const editable = mode === 'manual';
  list.innerHTML = dates.map((iso, i) => `
    <div class="eplan-rec-period-row">
      <span class="eplan-rec-period-row__idx">#${i + 1}</span>
      <span class="eplan-rec-period-row__date">${esc(fmtDate(iso))}</span>
      ${editable
        ? `<input type="number" class="expense-combobox eplan-rec-period-row__amt" data-eplan-period-amt="${i}" step="1" min="0" value="${amounts[i]}" />`
        : `<span class="eplan-rec-period-row__amt cash-float-amt">${formatMoney(amounts[i])}</span>`}
    </div>`).join('');

  const total = round2(amounts.reduce((s, a) => s + a, 0));
  if (sumEl) sumEl.textContent = `Sum ${formatMoney(total)}`;

  if (editable) {
    list.querySelectorAll('[data-eplan-period-amt]').forEach((input) => {
      input.addEventListener('input', () => {
        const vals = collectManualPeriodAmounts();
        window.__eplanEditingPeriodAmounts = vals;
        if (sumEl) sumEl.textContent = `Sum ${formatMoney(round2(vals.reduce((s, a) => s + a, 0)))}`;
      });
    });
  }
};

const fillRecurringForm = (t) => {
  const startEl = document.getElementById('eplan-rec-start');
  const titleEl = document.getElementById('eplan-rec-title');
  const amt = document.getElementById('eplan-rec-amount');
  const day = document.getElementById('eplan-rec-day');
  const dueDay = document.getElementById('eplan-rec-due-day');
  const cadence = document.getElementById('eplan-rec-cadence');
  const term = document.getElementById('eplan-rec-term');
  const modeEl = document.getElementById('eplan-rec-amount-mode');
  const cat = document.getElementById('eplan-rec-cat');

  const mode = t?.amount_mode || 'per_period';
  const periodAmounts = parsePeriodAmounts(t?.period_amounts) || [];
  window.__eplanEditingPeriodAmounts = periodAmounts.slice();

  if (startEl) startEl.value = t?.start_date ? String(t.start_date).slice(0, 10) : todayISO();
  if (titleEl) titleEl.value = t?.title || '';
  if (modeEl) modeEl.value = mode;
  if (amt) {
    if (mode === 'total_split' && t?.total_amount != null) amt.value = String(t.total_amount);
    else if (t?.amount != null) amt.value = String(t.amount);
    else amt.value = '';
  }
  if (day) day.value = String(t?.day_of_month ?? 1);
  if (dueDay) {
    dueDay.value = String(t?.due_day_of_month ?? t?.day_of_month ?? 1);
    if (t) dueDay.dataset.touched = '1';
    else delete dueDay.dataset.touched;
  }
  if (cadence) cadence.value = t?.cadence || 'monthly';
  if (term) term.value = t?.term_count != null ? String(t.term_count) : '';
  if (cat) {
    const v = t?.cat || '';
    cat.value = v;
    setClassifyInputState(cat, v);
  }
  refreshRecurringAmountUi();
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
  document.querySelectorAll(`.eplan-row[data-eplan-key="${CSS.escape(row.key)}"]`)
    .forEach((r) => r.classList.add('eplan-row--selected'));

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
      <div class="eplan-dl__block"><dt>Amount</dt><dd>${
        t.total_amount != null
          ? `${formatMoney(t.total_amount)} total · ~${formatMoney(t.amount)} / period`
          : `${formatMoney(t.amount)} / period`
      }</dd></div>
      <div class="eplan-dl__meta">
        <div><dt>Type</dt><dd>Recurring template</dd></div>
        <div><dt>Cadence</dt><dd>${esc(t.cadence)} · on day ${esc(t.day_of_month)} · due day ${esc(t.due_day_of_month ?? t.day_of_month)}</dd></div>
        <div><dt>Term</dt><dd>${t.term_count ? `${esc(t.term_count)} period${t.term_count === 1 ? '' : 's'}` : 'Ongoing'}${t.end_date ? ` · ends ${esc(fmtDate(t.end_date))}` : ''}</dd></div>
        <div><dt>Amount mode</dt><dd>${esc(t.amount_mode === 'total_split' ? 'Total split' : (t.amount_mode === 'manual' ? 'Manual per period' : 'Same each period'))}</dd></div>
        <div><dt>Starts</dt><dd>${esc(fmtDate(t.start_date))}</dd></div>
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

const monthLabel = (y, m) =>
  new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

/** Forward months from current month for the expense-plan horizon. */
const buildForwardMonthRange = (count) => {
  const months = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push({
      y: d.getFullYear(),
      m: d.getMonth(),
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: monthLabel(d.getFullYear(), d.getMonth()),
    });
  }
  return months;
};

const monthKeyFromIso = (iso) => {
  const s = String(iso || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : '';
};

/** Pivot row identity: one row per one-off, or per recurring template. */
const pivotRowKey = (r) => (
  r.source === 'recurring' && r.recurring_id
    ? `rec:${r.recurring_id}`
    : `one:${r.id || r.key}`
);

const buildMonthPivot = (timeline, months) => {
  const monthIndex = new Map(months.map((mo, i) => [mo.key, i]));
  const rowsMap = new Map();

  timeline.forEach((item) => {
    const mk = monthKeyFromIso(item.plan_date);
    const mi = monthIndex.get(mk);
    if (mi == null) return;
    const key = pivotRowKey(item);
    if (!rowsMap.has(key)) {
      rowsMap.set(key, {
        key,
        label: item.title || item.description || 'Planned',
        cat: item.cat || 'Other',
        catLabel: categoryDisplayLabel(item.cat || 'Other') || item.cat || 'Other',
        source: item.source,
        recurring_id: item.recurring_id || null,
        id: item.id || null,
        sampleKey: item.key,
        cells: months.map(() => 0),
        total: 0,
      });
    }
    const row = rowsMap.get(key);
    const amt = round2(parseFloat(item.amount) || 0);
    row.cells[mi] = round2(row.cells[mi] + amt);
    row.total = round2(row.total + amt);
  });

  const rows = [...rowsMap.values()].sort((a, b) =>
    String(a.catLabel).localeCompare(String(b.catLabel))
    || b.total - a.total
    || String(a.label).localeCompare(String(b.label)),
  );

  const groups = [];
  const byCat = new Map();
  rows.forEach((r) => {
    const ck = r.cat || 'Other';
    if (!byCat.has(ck)) {
      const g = {
        key: `cat:${ck}`,
        cat: ck,
        label: r.catLabel,
        rows: [],
        cells: months.map(() => 0),
        total: 0,
      };
      byCat.set(ck, g);
      groups.push(g);
    }
    const g = byCat.get(ck);
    g.rows.push(r);
    r.cells.forEach((v, i) => {
      g.cells[i] = round2(g.cells[i] + v);
    });
    g.total = round2(g.total + r.total);
  });

  const colTotals = months.map((_, i) =>
    round2(groups.reduce((s, g) => s + (g.cells[i] || 0), 0)),
  );
  const grandTotal = round2(colTotals.reduce((s, v) => s + v, 0));
  const maxCell = Math.max(0, ...rows.flatMap((r) => r.cells), ...colTotals);
  return { groups, rows, colTotals, grandTotal, maxCell };
};

/** Collapsed category keys in the month pivot (session UI state). */
const collapsedPivotCats = new Set();

const heatClass = (value, maxCell) => {
  if (value <= 0.001 || maxCell <= 0.001) return '';
  const ratio = value / maxCell;
  if (ratio >= 0.66) return ' eplan-pivot-heat--high';
  if (ratio >= 0.33) return ' eplan-pivot-heat--mid';
  return ' eplan-pivot-heat--low';
};

const renderMonthPivot = (timeline) => {
  const el = document.getElementById('eplan-month-pivot');
  const meta = document.getElementById('eplan-pivot-meta');
  if (!el) return;

  const months = buildForwardMonthRange(horizonMonths);
  const { groups, colTotals, grandTotal, maxCell } = buildMonthPivot(timeline, months);
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  if (meta) {
    meta.textContent = groups.length
      ? `${groups.length} categor${groups.length === 1 ? 'y' : 'ies'} · ${formatMoney(grandTotal)}`
      : 'No planned amounts in this horizon';
  }

  if (!groups.length) {
    el.innerHTML = '<p class="fa-panel__hint">Nothing to pivot yet. Add one-off or recurring spends for this horizon.</p>';
    return;
  }

  const monthTh = (m, i) => {
    const isCurrent = m.key === currentKey;
    return `<th class="fa-num eplan-pivot-month${isCurrent ? ' eplan-pivot-month--current' : ''}" data-month-idx="${i}">
      <span class="eplan-pivot-month__label">${esc(m.label)}</span>
      ${isCurrent ? '<span class="eplan-pivot-month__now">Now</span>' : ''}
    </th>`;
  };

  const amountTd = (v, { strong = false, isCurrent = false, isTotal = false } = {}) => {
    if (v <= 0.001) {
      return `<td class="fa-num eplan-pivot-cell${isCurrent ? ' eplan-pivot-col--current' : ''}${isTotal ? ' fa-col-total' : ''}"><span class="eplan-pivot-empty">—</span></td>`;
    }
    const heat = heatClass(v, maxCell);
    const content = strong ? `<strong>${formatMoney(v)}</strong>` : formatMoney(v);
    const barPct = maxCell > 0 ? Math.max(8, Math.round((v / maxCell) * 100)) : 0;
    return `<td class="fa-num eplan-pivot-cell${heat}${isCurrent ? ' eplan-pivot-col--current' : ''}${isTotal ? ' fa-col-total' : ''}">
      <span class="eplan-pivot-val">${content}</span>
      <span class="eplan-pivot-bar" style="width:${barPct}%" aria-hidden="true"></span>
    </td>`;
  };

  const bodyHtml = groups.map((g) => {
    const collapsed = collapsedPivotCats.has(g.key);
    const groupRow = `<tr class="eplan-pivot-group" data-eplan-pivot-group="${esc(g.key)}" title="Click to ${collapsed ? 'expand' : 'collapse'}">
      <td class="eplan-pivot-sticky eplan-pivot-group__label" colspan="1">
        <button type="button" class="eplan-pivot-toggle" aria-expanded="${collapsed ? 'false' : 'true'}">
          <i class="fa-solid fa-chevron-${collapsed ? 'right' : 'down'}" aria-hidden="true"></i>
        </button>
        <strong>${esc(g.label)}</strong>
        <span class="eplan-pivot-group__count">${g.rows.length}</span>
      </td>
      ${g.cells.map((v, i) => amountTd(v, { strong: true, isCurrent: months[i].key === currentKey })).join('')}
      ${amountTd(g.total, { strong: true, isTotal: true })}
    </tr>`;

    if (collapsed) return groupRow;

    const childRows = g.rows.map((r) => {
      const badge = r.source === 'recurring'
        ? '<span class="eplan-badge eplan-badge--recurring">Recurring</span>'
        : '<span class="eplan-badge">One-off</span>';
      return `<tr class="eplan-row eplan-pivot-row eplan-pivot-row--nested" data-eplan-pivot-key="${esc(r.key)}" data-eplan-key="${esc(r.sampleKey)}" title="View details">
        <td class="eplan-col-what eplan-pivot-sticky eplan-pivot-nested-label">
          <div class="eplan-what">${esc(r.label)}</div>
          <div class="eplan-what-meta">${badge}</div>
        </td>
        ${r.cells.map((v, i) => amountTd(v, { isCurrent: months[i].key === currentKey })).join('')}
        ${amountTd(r.total, { strong: true, isTotal: true })}
      </tr>`;
    }).join('');

    return groupRow + childRows;
  }).join('');

  el.innerHTML = `
    <div class="eplan-pivot-shell">
      <table class="fa-pivot-table eplan-month-pivot-table" aria-label="Planned expenses by month">
        <thead>
          <tr>
            <th class="eplan-pivot-sticky eplan-pivot-corner">
              <span class="eplan-pivot-corner__rows">Category / line</span>
              <span class="eplan-pivot-corner__cols">Months →</span>
            </th>
            ${months.map((m, i) => monthTh(m, i)).join('')}
            <th class="fa-num fa-col-total eplan-pivot-total-head">Total</th>
          </tr>
        </thead>
        <tbody>${bodyHtml}</tbody>
        <tfoot>
          <tr class="eplan-pivot-foot">
            <td class="eplan-pivot-sticky"><strong>Monthly total</strong></td>
            ${colTotals.map((v, i) => amountTd(v, { strong: true, isCurrent: months[i].key === currentKey })).join('')}
            ${amountTd(grandTotal, { strong: true, isTotal: true })}
          </tr>
        </tfoot>
      </table>
    </div>`;

  el.querySelectorAll('[data-eplan-pivot-group]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = tr.getAttribute('data-eplan-pivot-group');
      if (!key) return;
      if (collapsedPivotCats.has(key)) collapsedPivotCats.delete(key);
      else collapsedPivotCats.add(key);
      renderMonthPivot(lastTimeline);
    });
  });
};

const renderSummary = (timeline) => {
  const el = document.getElementById('eplan-summary');
  if (!el) return;
  const total = round2(timeline.reduce((s, r) => s + (r.amount || 0), 0));
  const { book, hasBank, bankBalance, cash, pending } = getBookBalanceSummary();
  const after = round2(book - total);
  const pendingHint = pending.total > 0.009
    ? `${pending.openCount || 0} bill commitment${(pending.openCount || 0) === 1 ? '' : 's'}${pending.unclearedCount ? ` · ${pending.unclearedCount} uncleared` : ''}`
    : 'No open bill commitments loaded';
  el.innerHTML = `
    <div class="ledger-kpi">
      <i class="fa-solid fa-vault" aria-hidden="true"></i>
      <div class="ledger-kpi__body">
        <span class="ledger-kpi__label">Book balance</span>
        <span class="ledger-kpi__value">${formatMoney(book)}</span>
        <span class="ledger-kpi__hint">${hasBank
          ? `${formatMoney(bankBalance)} − ${formatMoney(pending.total)} + ${formatMoney(cash)}`
          : formatMoney(cash)}</span>
        <span class="ledger-kpi__hint">${pendingHint}</span>
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
      <th>Title</th><th>Cadence</th><th>Term</th><th class="cash-float-amt">Amount</th><th>Active</th>
      ${showActions ? '<th class="eplan-actions"></th>' : ''}
    </tr></thead>
    <tbody>${rows.map((t) => {
      const termLabel = t.term_count
        ? `${t.term_count}×`
        : 'Ongoing';
      const amtLabel = t.total_amount != null
        ? formatMoney(t.total_amount)
        : formatMoney(t.amount);
      const amtHint = t.total_amount != null
        ? `title="${esc(`${formatMoney(t.amount)} each`)}"`
        : '';
      return `<tr class="eplan-row eplan-row--template" data-eplan-recurring="${esc(t.id)}" title="View details">
      <td>${esc(t.title)}</td>
      <td>${esc(t.cadence)}</td>
      <td>${esc(termLabel)}</td>
      <td class="cash-float-amt" ${amtHint}>${amtLabel}</td>
      <td>${t.active !== false ? 'Yes' : 'No'}</td>
      ${rowActionsHtml({
        editAttr: 'data-eplan-edit-recurring',
        editValue: t.id,
        delAttr: 'data-eplan-del-recurring',
        delValue: t.id,
      })}
    </tr>`;
    }).join('')}</tbody>
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
  renderMonthPivot(lastTimeline);
  renderTimeline(lastTimeline);
  renderRecurringList();

  // Book balance needs unpaid / cheque-ready bills from aggregates (lazy-loaded).
  void (async () => {
    try {
      const { ensureFinanceDocumentsAggregates } = await import('./financeDocuments.js');
      await ensureFinanceDocumentsAggregates();
    } catch (err) {
      console.warn('[expensePlan] aggregates:', err?.message || err);
    }
    renderSummary(lastTimeline);
  })();

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
  const cadence = document.getElementById('eplan-rec-cadence')?.value || 'monthly';
  const day_of_month = parseInt(document.getElementById('eplan-rec-day')?.value || '1', 10);
  const due_day_of_month = parseInt(document.getElementById('eplan-rec-due-day')?.value || String(day_of_month), 10);
  const start_date = document.getElementById('eplan-rec-start')?.value || todayISO();
  const cat = document.getElementById('eplan-rec-cat')?.value?.trim() || 'Other';
  const amount_mode = document.getElementById('eplan-rec-amount-mode')?.value || 'per_period';
  const termRaw = document.getElementById('eplan-rec-term')?.value?.trim();
  const term_count = termRaw ? Math.min(120, Math.max(1, parseInt(termRaw, 10) || 0)) : null;
  const amountInput = parseFloat(document.getElementById('eplan-rec-amount')?.value || '');

  if (!title) throw new Error('Title is required.');
  if (amount_mode === 'total_split' || amount_mode === 'manual') {
    if (!term_count) throw new Error('Set Term (periods) for total split or manual amounts.');
  }

  let amount = 0;
  let total_amount = null;
  let period_amounts = null;

  if (amount_mode === 'per_period') {
    if (!Number.isFinite(amountInput)) throw new Error('Amount each period is required.');
    amount = amountInput;
    if (term_count) {
      period_amounts = Array.from({ length: term_count }, () => round2(amount));
      total_amount = round2(amount * term_count);
    }
  } else if (amount_mode === 'total_split') {
    if (!Number.isFinite(amountInput) || amountInput < 0) throw new Error('Total amount is required.');
    total_amount = amountInput;
    period_amounts = splitEqualAmounts(amountInput, term_count);
    amount = period_amounts[0] || 0;
  } else {
    period_amounts = collectManualPeriodAmounts();
    if (period_amounts.length !== term_count) {
      // rebuild from schedule if list empty
      renderPeriodSchedule();
      period_amounts = collectManualPeriodAmounts();
    }
    if (period_amounts.length !== term_count) {
      throw new Error('Enter an amount for each period.');
    }
    total_amount = round2(period_amounts.reduce((s, a) => s + a, 0));
    amount = period_amounts[0] || 0;
  }

  const end_date = term_count
    ? endDateFromTerm(start_date, cadence, term_count)
    : null;

  const existing = editingRecurringId
    ? getRecurring().find((x) => x.id === editingRecurringId)
    : null;

  const result = await postFinanceMutation('saveExpensePlanRecurring', {
    apartment_id: apt,
    ...(editingRecurringId ? { id: editingRecurringId } : {}),
    title,
    amount,
    total_amount,
    amount_mode,
    term_count,
    period_amounts,
    cadence,
    day_of_month,
    due_day_of_month,
    start_date,
    end_date,
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
    refreshRecurringAmountUi();
  });
  document.getElementById('eplan-rec-due-day')?.addEventListener('input', (e) => {
    e.target.dataset.touched = '1';
  });
  ['eplan-rec-cadence', 'eplan-rec-start', 'eplan-rec-term', 'eplan-rec-amount-mode', 'eplan-rec-amount']
    .forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        if (id === 'eplan-rec-start') {
          const startVal = el.value;
          if (startVal) {
            const dayNum = Math.min(28, Math.max(1, parseInt(startVal.slice(8, 10), 10) || 1));
            const dayEl = document.getElementById('eplan-rec-day');
            const dueEl = document.getElementById('eplan-rec-due-day');
            if (dayEl) dayEl.value = String(dayNum);
            if (dueEl && !dueEl.dataset.touched) dueEl.value = String(dayNum);
          }
        }
        if (id === 'eplan-rec-term') window.__eplanEditingPeriodAmounts = [];
        refreshRecurringAmountUi();
      });
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

    const pivotRow = e.target.closest('tr.eplan-pivot-row');
    if (pivotRow && !e.target.closest('button')) {
      const pivotKey = pivotRow.dataset.eplanPivotKey || '';
      if (pivotKey.startsWith('rec:')) {
        const id = pivotKey.slice(4);
        const t = getRecurring().find((x) => x.id === id);
        if (t) {
          showTemplateDetail(t);
          return;
        }
      }
      const hit = lastTimeline.find((r) => r.key === pivotRow.dataset.eplanKey);
      if (hit) showDetail(hit);
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
