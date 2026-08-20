/**
 * Block / tower filter — persisted in session, applied across billing and directory
 */
import { portalState } from './store.js';
import { deriveBlockFromFlat } from './parkingImport.js';
import { getUnitIdsForGroup } from './billingGroups.js';
import { normUnit } from './residents.js';

const STORAGE_KEY = 'communityhub_block_filter';

export const getUnitBlock = (unit) => {
    if (!unit) return '';
    return String(unit.block || deriveBlockFromFlat(unit.number) || '').trim();
};

export const getBlockOptions = () => {
    const blocks = new Set();
    portalState.units.forEach((u) => {
        const b = getUnitBlock(u);
        if (b) blocks.add(b);
    });
    return [...blocks].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
};

export const getSelectedBlock = () => {
    try {
        return sessionStorage.getItem(STORAGE_KEY) || '';
    } catch {
        return '';
    }
};

export const setSelectedBlock = (block) => {
    try {
        if (block) sessionStorage.setItem(STORAGE_KEY, block);
        else sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
    document.dispatchEvent(new CustomEvent('block-filter-change', { detail: block }));
};

export const unitMatchesBlock = (unitId, block = getSelectedBlock()) => {
    if (!block) return true;
    const unit = portalState.units.find((u) => u.id === unitId);
    if (!unit) return false;
    return getUnitBlock(unit).toUpperCase() === block.toUpperCase();
};

export const unitNumberMatchesBlock = (unitNumber, block = getSelectedBlock()) => {
    if (!block) return true;
    const unit = portalState.units.find((u) => normUnit(u.number) === normUnit(unitNumber));
    if (unit) return unitMatchesBlock(unit.id, block);
    const derived = deriveBlockFromFlat(unitNumber);
    return derived && derived.toUpperCase() === block.toUpperCase();
};

export const invoiceMatchesBlock = (inv, block = getSelectedBlock()) => {
    if (!block) return true;
    if (inv.billing_group_id) {
        const memberIds = getUnitIdsForGroup(inv.billing_group_id);
        return memberIds.some((uid) => unitMatchesBlock(uid, block));
    }
    return unitMatchesBlock(inv.unit_id, block);
};

export const renderBlockFilterSelect = (containerId, onChange) => {
    const el = document.getElementById(containerId);
    if (!el) return;

    const blocks = getBlockOptions();
    const selected = getSelectedBlock();
    el.innerHTML = `
      <label class="block-filter-label">
        <span class="block-filter-label__text">Block</span>
        <select id="${containerId}-select" class="expense-combobox block-filter-select">
          <option value="">All blocks</option>
          ${blocks.map((b) => `<option value="${b}" ${b === selected ? 'selected' : ''}>${b}</option>`).join('')}
        </select>
      </label>`;

    document.getElementById(`${containerId}-select`)?.addEventListener('change', (e) => {
        setSelectedBlock(e.target.value);
        onChange?.();
    });
};

export const renderBlockKpiStrip = (containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;

    const block = getSelectedBlock();
    if (!block) {
        el.hidden = true;
        return;
    }

    el.hidden = false;
    const units = portalState.units.filter((u) => unitMatchesBlock(u.id, block));
    const unitIds = new Set(units.map((u) => u.id));
    let outstanding = 0;
    let openInvoices = 0;
    let vehicles = 0;

    (portalState.finances.maintenanceInvoices || []).forEach((inv) => {
        if (!invoiceMatchesBlock(inv, block)) return;
        const bal = Math.max(0, parseFloat(inv.amount || 0) - parseFloat(inv.amount_paid || 0));
        if (bal > 0.001) outstanding += bal;
        if (bal > 0.001 || parseFloat(inv.amount_paid || 0) > 0) openInvoices += 1;
    });

    units.forEach((u) => { vehicles += (u.vehicles || []).length; });

    el.innerHTML = `
      <div class="block-kpi-strip">
        <span class="block-kpi-strip__title">${block}</span>
        <div class="block-kpi-strip__stats">
          <div><span>Flats</span><strong>${units.length}</strong></div>
          <div><span>Outstanding</span><strong>₹${outstanding.toLocaleString('en-IN')}</strong></div>
          <div><span>Invoices</span><strong>${openInvoices}</strong></div>
          <div><span>Vehicles</span><strong>${vehicles}</strong></div>
        </div>
      </div>`;
};

export const initBlockFilterListener = (callback) => {
    document.addEventListener('block-filter-change', () => callback?.());
};
