/**
 * Searchable flat picker with optional block filter
 */
import { portalState } from './store.js';
import { getUnitBlock, getBlockOptions } from './blockFilter.js';

const norm = (s) => String(s || '').trim().toUpperCase();

export function initFlatPicker({
    blockContainerId,
    inputId,
    hiddenId,
    listId,
    onChange,
    tagMode = false,
    onUnitPicked = null,
    getExcludeUnitIds = null,
}) {
    const blockContainer = document.getElementById(blockContainerId);
    const input = document.getElementById(inputId);
    const hidden = document.getElementById(hiddenId);
    const list = document.getElementById(listId);
    if (!input || !hidden || !list) return;

    let blockFilter = '';
    let highlightIdx = -1;

    const getFilteredUnits = () => {
        const q = norm(input.value);
        const excluded = new Set((getExcludeUnitIds?.() || []).map(String));
        return portalState.units
            .filter((u) => {
                if (excluded.has(String(u.id))) return false;
                if (blockFilter && norm(getUnitBlock(u)) !== norm(blockFilter)) return false;
                if (q && !norm(u.number).includes(q)) return false;
                return true;
            })
            .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
    };

    const renderBlockSelect = () => {
        if (!blockContainer) return;
        const blocks = getBlockOptions();
        blockContainer.innerHTML = `
          <label class="block-filter-label occ-block-filter">
            <span class="block-filter-label__text">Block</span>
            <select id="${blockContainerId}-select" class="expense-combobox block-filter-select">
              <option value="">All blocks</option>
              ${blocks.map((b) => `<option value="${b}" ${b === blockFilter ? 'selected' : ''}>${b}</option>`).join('')}
            </select>
          </label>`;
        document.getElementById(`${blockContainerId}-select`)?.addEventListener('change', (e) => {
            blockFilter = e.target.value;
            highlightIdx = -1;
            const current = portalState.units.find((u) => u.id === hidden.value);
            if (current && blockFilter && norm(getUnitBlock(current)) !== norm(blockFilter)) {
                clearSelection(false);
            }
            renderList();
            onChange?.(hidden.value || null);
        });
    };

    const clearSelection = (clearInput = true) => {
        hidden.value = '';
        if (clearInput) input.value = '';
        list.hidden = true;
        highlightIdx = -1;
    };

    const selectUnit = (unit) => {
        if (!unit) return;
        if (tagMode && onUnitPicked) {
            onUnitPicked(unit);
            clearSelection(true);
            input.focus();
            return;
        }
        hidden.value = unit.id;
        input.value = unit.number;
        list.hidden = true;
        highlightIdx = -1;
        onChange?.(unit.id);
    };

    const renderList = () => {
        const units = getFilteredUnits();
        if (!units.length) {
            list.innerHTML = '<li class="flat-picker__empty">No flats match</li>';
            list.hidden = false;
            return;
        }
        list.innerHTML = units.map((u, i) => {
            const block = getUnitBlock(u);
            return `<li class="flat-picker__item ${i === highlightIdx ? 'flat-picker__item--active' : ''}"
              role="option"
              data-unit-id="${u.id}"
              data-idx="${i}">
              <span class="flat-picker__number">${u.number}</span>
              ${block ? `<span class="flat-picker__block">${block}</span>` : ''}
            </li>`;
        }).join('');
        list.hidden = false;

        list.querySelectorAll('.flat-picker__item[data-unit-id]').forEach((el) => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const unit = portalState.units.find((u) => u.id === el.dataset.unitId);
                selectUnit(unit);
            });
        });
    };

    const tryResolveExact = () => {
        const q = norm(input.value);
        if (!q) return null;
        const units = getFilteredUnits();
        return units.find((u) => norm(u.number) === q) || null;
    };

    input.addEventListener('focus', () => {
        renderList();
    });

    input.addEventListener('input', () => {
        hidden.value = '';
        highlightIdx = -1;
        renderList();
        if (!tagMode) {
            const exact = tryResolveExact();
            if (exact) {
                hidden.value = exact.id;
                onChange?.(exact.id);
            } else {
                onChange?.(null);
            }
        }
    });

    input.addEventListener('keydown', (e) => {
        const units = getFilteredUnits();
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (list.hidden) renderList();
            highlightIdx = Math.min(highlightIdx + 1, units.length - 1);
            renderList();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlightIdx = Math.max(highlightIdx - 1, 0);
            renderList();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightIdx >= 0 && units[highlightIdx]) {
                selectUnit(units[highlightIdx]);
            } else {
                const exact = tryResolveExact();
                if (exact) selectUnit(exact);
            }
        } else if (e.key === 'Escape') {
            list.hidden = true;
            highlightIdx = -1;
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest(`#${listId}`) && e.target !== input) {
            list.hidden = true;
            highlightIdx = -1;
            const exact = tryResolveExact();
            if (exact && tagMode && onUnitPicked) {
                selectUnit(exact);
            } else if (exact && !hidden.value && !tagMode) {
                selectUnit(exact);
            } else if (!tagMode && hidden.value && norm(input.value) !== norm(unitById(hidden.value)?.number)) {
                const unit = unitById(hidden.value);
                if (unit) input.value = unit.number;
            }
        }
    });

    const refresh = () => {
        renderBlockSelect();
        const unit = unitById(hidden.value);
        if (unit) {
            if (blockFilter && norm(getUnitBlock(unit)) !== norm(blockFilter)) {
                clearSelection();
            } else {
                input.value = unit.number;
            }
        }
    };

    refresh();
    document.addEventListener('apartment-data-loaded', refresh);

    return {
        getUnitId: () => hidden.value || null,
        setUnitId: (unitId) => {
            if (tagMode) return;
            const unit = unitById(unitId);
            if (unit) selectUnit(unit);
            else clearSelection();
        },
        refresh,
        renderList,
        clearSelection,
    };
}

function unitById(id) {
    return portalState.units.find((u) => u.id === id);
}

export const getFlatPickerUnitId = (hiddenId = 'ops-transition-unit') =>
    document.getElementById(hiddenId)?.value || '';
