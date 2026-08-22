/**
 * Excel-style column filter / sort popover for Finance-New ledger headers.
 * Icon on the header opens a menu (not always-visible filter inputs).
 * Amount → comparison ops; Passbook/calc → dual number filters + discrepancy.
 */
import {
    clearLedgerColumnFilter,
    getLedgerColumnFilters,
    getLedgerSort,
    isLedgerColumnFilterActive,
    setLedgerColumnFilter,
    setLedgerSort,
} from './ledgerFilter.js';

const MENU_ID = 'ledger-excel-col-menu';

const SORTABLE = new Set(['date', 'amount', 'cat', 'wallet', 'passbook', 'description', 'type', 'bills']);
const NUMBER_KEYS = new Set(['amount']);
const PASSBOOK_KEYS = new Set(['passbook']);

const NUMBER_OPS = [
    { value: 'eq', label: 'Equals' },
    { value: 'gt', label: 'Greater than (>)' },
    { value: 'gte', label: 'Greater or equal (≥)' },
    { value: 'lt', label: 'Less than (<)' },
    { value: 'lte', label: 'Less or equal (≤)' },
    { value: 'between', label: 'Between' },
];

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

let outsideWired = false;

const closeMenu = () => {
    document.getElementById(MENU_ID)?.remove();
};

const ensureOutsideClose = () => {
    if (outsideWired) return;
    outsideWired = true;
    document.addEventListener('mousedown', (e) => {
        const menu = document.getElementById(MENU_ID);
        if (!menu) return;
        if (menu.contains(e.target)) return;
        if (e.target.closest?.('.ledger-excel-col-btn')) return;
        closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });
};

const defaultNumberSpec = (partial = {}) => ({
    op: partial.op || 'eq',
    value: partial.value ?? '',
    value2: partial.value2 ?? '',
});

const opOptionsHtml = (selected) => NUMBER_OPS.map((op) =>
    `<option value="${op.value}"${op.value === selected ? ' selected' : ''}>${esc(op.label)}</option>`,
).join('');

const numberRowHtml = (prefix, label, spec, { autofocus = false } = {}) => {
    const s = defaultNumberSpec(spec || {});
    const between = s.op === 'between';
    return `
    <div class="ledger-excel-col-menu__num-row" data-num-prefix="${esc(prefix)}">
      <label class="ledger-excel-col-menu__label">${esc(label)}</label>
      <select class="ledger-excel-col-menu__select" data-field="${esc(prefix)}-op" aria-label="${esc(label)} operator">
        ${opOptionsHtml(s.op)}
      </select>
      <div class="ledger-excel-col-menu__num-values">
        <input type="text" inputmode="decimal" class="ledger-excel-col-menu__input" data-field="${esc(prefix)}-value"
          placeholder="Value…" value="${esc(s.value)}" autocomplete="off"${autofocus ? ' id="ledger-excel-col-filter-input"' : ''} />
        <input type="text" inputmode="decimal" class="ledger-excel-col-menu__input ledger-excel-col-menu__input--to${between ? '' : ' is-hidden'}"
          data-field="${esc(prefix)}-value2" placeholder="And…" value="${esc(s.value2)}" autocomplete="off" />
      </div>
    </div>`;
};

const readNumberSpec = (menu, prefix) => {
    const op = menu.querySelector(`[data-field="${prefix}-op"]`)?.value || 'eq';
    const value = menu.querySelector(`[data-field="${prefix}-value"]`)?.value ?? '';
    const value2 = menu.querySelector(`[data-field="${prefix}-value2"]`)?.value ?? '';
    return { op, value, value2 };
};

const wireNumberOpToggles = (menu) => {
    menu.querySelectorAll('[data-field$="-op"]').forEach((sel) => {
        sel.addEventListener('change', () => {
            const prefix = sel.dataset.field.replace(/-op$/, '');
            const to = menu.querySelector(`[data-field="${prefix}-value2"]`);
            to?.classList.toggle('is-hidden', sel.value !== 'between');
        });
    });
};

/**
 * Header cell: label + filter icon (Excel-style). Click icon → sort + filter.
 * @param {string} label
 * @param {{ filterKey: string, sortField?: string|null, align?: 'left'|'right' }} opts
 */
export const renderExcelColHeader = (label, opts = {}) => {
    const filterKey = opts.filterKey;
    const sortField = opts.sortField ?? (SORTABLE.has(filterKey) ? filterKey : null);
    const align = opts.align === 'right' ? 'right' : 'left';
    const filters = getLedgerColumnFilters();
    const sort = getLedgerSort();
    const hasFilter = isLedgerColumnFilterActive(filters[filterKey]);
    const sorted = sortField && sort.field === sortField;
    const active = hasFilter || sorted;
    const numeric = NUMBER_KEYS.has(filterKey) || PASSBOOK_KEYS.has(filterKey);

    let iconClass = 'fa-solid fa-filter';
    if (sorted && sort.dir === 'asc') iconClass = 'fa-solid fa-arrow-up-short-wide';
    else if (sorted && sort.dir === 'desc') iconClass = 'fa-solid fa-arrow-down-wide-short';

    return `
    <span class="ledger-excel-col${align === 'right' ? ' ledger-excel-col--num' : ''}">
      <span class="ledger-excel-col__label">${esc(label)}</span>
      <button
        type="button"
        class="ledger-excel-col-btn${active ? ' ledger-excel-col-btn--active' : ''}"
        data-ledger-filter-key="${esc(filterKey)}"
        data-ledger-sort-field="${sortField ? esc(sortField) : ''}"
        data-can-sort="${sortField ? '1' : '0'}"
        data-filter-kind="${numeric ? (PASSBOOK_KEYS.has(filterKey) ? 'passbook' : 'number') : 'text'}"
        aria-label="Filter ${esc(label)}"
        title="Filter / sort"
      >
        <i class="${iconClass}" aria-hidden="true"></i>
      </button>
    </span>`;
};

const positionMenu = (menu, anchor) => {
    const r = anchor.getBoundingClientRect();
    const pad = 8;
    let left = r.left;
    let top = r.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.hidden = false;
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - mr.width - pad);
        menu.style.left = `${left}px`;
    }
    if (mr.bottom > window.innerHeight - pad) {
        top = Math.max(pad, r.top - mr.height - 4);
        menu.style.top = `${top}px`;
    }
};

const sortLabels = (kind) => {
    if (kind === 'number' || kind === 'passbook') {
        return { asc: 'Sort smallest → largest', desc: 'Sort largest → smallest' };
    }
    return { asc: 'Sort A → Z', desc: 'Sort Z → A' };
};

const renderFilterBody = (kind, draft) => {
    if (kind === 'number') {
        const spec = (draft && draft.kind === 'number')
            ? draft
            : { op: 'eq', value: typeof draft === 'string' ? draft : '', value2: '' };
        return `
      <div class="ledger-excel-col-menu__filter">
        <p class="ledger-excel-col-menu__hint">Signed amount (income +, expense −)</p>
        ${numberRowHtml('amount', 'Amount', spec, { autofocus: true })}
        <button type="button" class="btn btn-primary btn--small ledger-excel-col-menu__apply" data-action="apply">Filter</button>
      </div>`;
    }
    if (kind === 'passbook') {
        const spec = (draft && draft.kind === 'passbook')
            ? draft
            : { discrepancy: '', passbook: null, calc: null };
        const disc = spec.discrepancy || '';
        return `
      <div class="ledger-excel-col-menu__filter">
        <label class="ledger-excel-col-menu__label">Discrepancy</label>
        <select class="ledger-excel-col-menu__select" data-field="discrepancy" aria-label="Discrepancy">
          <option value=""${disc === '' ? ' selected' : ''}>Any</option>
          <option value="mismatch"${disc === 'mismatch' ? ' selected' : ''}>Has discrepancy</option>
          <option value="match"${disc === 'match' ? ' selected' : ''}>No discrepancy</option>
        </select>
        <p class="ledger-excel-col-menu__hint">Optional: filter Passbook and/or Calc (leave blank to skip)</p>
        ${numberRowHtml('passbook', 'Passbook', spec.passbook, { autofocus: true })}
        ${numberRowHtml('calc', 'Calc', spec.calc)}
        <button type="button" class="btn btn-primary btn--small ledger-excel-col-menu__apply" data-action="apply">Filter</button>
      </div>`;
    }
    const text = typeof draft === 'string' ? draft : '';
    return `
      <div class="ledger-excel-col-menu__filter">
        <label class="ledger-excel-col-menu__label" for="ledger-excel-col-filter-input">Contains</label>
        <input type="text" id="ledger-excel-col-filter-input" class="ledger-excel-col-menu__input" placeholder="Filter…" value="${esc(text)}" autocomplete="off" />
        <button type="button" class="btn btn-primary btn--small ledger-excel-col-menu__apply" data-action="apply">Filter</button>
      </div>`;
};

const collectFilterValue = (menu, kind) => {
    if (kind === 'number') {
        const n = readNumberSpec(menu, 'amount');
        return { kind: 'number', ...n };
    }
    if (kind === 'passbook') {
        return {
            kind: 'passbook',
            discrepancy: menu.querySelector('[data-field="discrepancy"]')?.value || '',
            passbook: readNumberSpec(menu, 'passbook'),
            calc: readNumberSpec(menu, 'calc'),
        };
    }
    return menu.querySelector('#ledger-excel-col-filter-input')?.value || '';
};

const openMenu = (btn) => {
    ensureOutsideClose();
    closeMenu();

    const filterKey = btn.dataset.ledgerFilterKey;
    if (!filterKey) return;
    const sortField = btn.dataset.ledgerSortField || '';
    const canSort = btn.dataset.canSort === '1' && sortField;
    const kind = btn.dataset.filterKind || 'text';
    const filters = getLedgerColumnFilters();
    const sort = getLedgerSort();
    const draft = filters[filterKey];
    const sortedAsc = canSort && sort.field === sortField && sort.dir === 'asc';
    const sortedDesc = canSort && sort.field === sortField && sort.dir === 'desc';
    const hasFilter = isLedgerColumnFilterActive(draft);
    const showClear = hasFilter || sortedAsc || sortedDesc;
    const labels = sortLabels(kind);

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = `ledger-excel-col-menu ledger-excel-col-menu--${kind}`;
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.innerHTML = `
      ${canSort ? `
        <button type="button" class="ledger-excel-col-menu__item${sortedAsc ? ' is-selected' : ''}" data-action="sort-asc" role="menuitem">
          ${esc(labels.asc)}
        </button>
        <button type="button" class="ledger-excel-col-menu__item${sortedDesc ? ' is-selected' : ''}" data-action="sort-desc" role="menuitem">
          ${esc(labels.desc)}
        </button>
        <div class="ledger-excel-col-menu__divider" role="separator"></div>
      ` : ''}
      ${renderFilterBody(kind, draft)}
      ${showClear ? `
        <div class="ledger-excel-col-menu__divider" role="separator"></div>
        <button type="button" class="ledger-excel-col-menu__item" data-action="clear" role="menuitem">Clear</button>
      ` : ''}
    `;
    document.body.appendChild(menu);
    positionMenu(menu, btn);
    wireNumberOpToggles(menu);

    const refresh = () => {
        closeMenu();
        window.renderCashLedger?.();
    };

    const apply = () => {
        setLedgerColumnFilter(filterKey, collectFilterValue(menu, kind));
        refresh();
    };

    menu.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        e.preventDefault();
        if (action === 'sort-asc' && canSort) {
            setLedgerSort(sortField, 'asc');
            refresh();
            return;
        }
        if (action === 'sort-desc' && canSort) {
            setLedgerSort(sortField, 'desc');
            refresh();
            return;
        }
        if (action === 'apply') {
            apply();
            return;
        }
        if (action === 'clear') {
            clearLedgerColumnFilter(filterKey);
            if (canSort && sort.field === sortField) {
                setLedgerSort('date', 'desc');
            }
            refresh();
        }
    });

    menu.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input, select')) {
            e.preventDefault();
            apply();
        }
    });

    requestAnimationFrame(() => {
        menu.querySelector('#ledger-excel-col-filter-input')?.focus();
    });
};

/** Wire once on the ledger table host (click filter buttons). */
export const wireLedgerExcelColFilters = (host) => {
    if (!host || host.dataset.excelColWired === '1') return;
    host.dataset.excelColWired = '1';
    host.addEventListener('click', (e) => {
        const btn = e.target.closest('.ledger-excel-col-btn');
        if (!btn || !host.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        const open = document.getElementById(MENU_ID);
        if (open && open.dataset.anchorKey === btn.dataset.ledgerFilterKey) {
            closeMenu();
            return;
        }
        openMenu(btn);
        const menu = document.getElementById(MENU_ID);
        if (menu) menu.dataset.anchorKey = btn.dataset.ledgerFilterKey || '';
    });
};
