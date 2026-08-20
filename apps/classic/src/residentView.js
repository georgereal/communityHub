/** Resident directory rendering and modal helpers (lazy-loaded with apartment view). */

import { portalState, supabase } from './store.js';
import { withButtonBusy } from './buttonBusy.js';
import { deleteFlatWithResidents, flatDeleteConfirmMessage } from './unitDirectory.js';
import {
    loadResidents,
    saveResident as persistResident,
    deleteResident,
    getResidents,
    dedupeResidents,
    groupResidentsByUnit,
    splitResidentsByKind,
    classifyUnitOccupancy,
    computeResidentPageSummary,
    occupancySummaryLabel,
    occupancySummaryBadge,
    occupancySummaryHint,
    unitMissingOwners,
    normUnit,
    filterResidentsByOptions,
    unitPassesOccupancyFilter,
} from './residents.js';
import {
    getBlockOptions,
    getSelectedBlock,
    setSelectedBlock,
    unitNumberMatchesBlock,
} from './blockFilter.js';

let residentSummaryFilter = '';

const getResidentFilterOptions = () => ({
  filterQ: (document.getElementById('resident-filter')?.value || '').trim().toLowerCase(),
  kind: document.getElementById('resident-kind-filter')?.value || '',
  residency: document.getElementById('resident-residency-filter')?.value || '',
  primaryOnly: document.getElementById('resident-primary-filter')?.checked || false,
});

const hasResidentPersonFilters = (opts) =>
  Boolean(opts.filterQ || opts.kind || opts.residency || opts.primaryOnly);

const hasAnyResidentFilters = (opts) =>
  Boolean(hasResidentPersonFilters(opts) || residentSummaryFilter);

const buildScopedUnitNumbers = (block, allResidents) => {
  const fromUnits = (portalState.units || [])
    .filter((u) => u.is_community !== true)
    .filter((u) => !block || unitNumberMatchesBlock(u.number, block))
    .map((u) => u.number);
  const fromResidents = [...new Set((allResidents || []).map((r) => r.unit_number))];
  const merged = [...fromUnits];
  fromResidents.forEach((n) => {
    if (!block || unitNumberMatchesBlock(n, block)) {
      if (!merged.some((x) => normUnit(x) === normUnit(n))) merged.push(n);
    }
  });
  return merged;
};

const renderResidentRow = (r, esc) => {
  const residingBadge = (r.kind || '').toUpperCase() !== 'TENANT' && r.is_residing === false
    ? ' <span class="resident-residing-badge resident-residing-badge--away">Non-residing</span>'
    : '';
  return `
    <div class="apt-row resident-group-row" data-resident-id="${r.id}">
      <div class="resident-name">${esc(r.full_name)}${r.is_primary ? ' <span class="resident-primary-badge">Primary</span>' : ''}${residingBadge}</div>
      <div class="resident-phone" data-label="Phone">${esc(r.phone || '—')}</div>
      <div class="resident-email" data-label="Email">${esc(r.email || '—')}</div>
      <div class="resident-actions">
        <button class="btn btn-outline btn--icon" data-action="portal" title="Portal access"><i class="fa-solid fa-link"></i></button>
        <button class="btn btn-outline btn--icon" data-action="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-outline btn--icon btn--danger" data-action="del" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
      </div>
    </div>`;
};

const formatResidentNameList = (list, esc) => {
  if (!list.length) return '';
  return list.map((r) => {
    const primary = r.is_primary ? ' ★' : '';
    const away = (r.kind || '').toUpperCase() !== 'TENANT' && r.is_residing === false ? ' (away)' : '';
    return `${esc(r.full_name)}${primary}${away}`;
  }).join(' · ');
};

const previewNamesForUnit = (occ, owners, tenants) => {
  if (occ === 'TENANT_OCCUPIED') return tenants;
  if (occ === 'OWNER_OCCUPIED') return owners.filter((r) => r.is_residing !== false);
  if (occ === 'VACANT') return owners.filter((r) => r.is_residing === false);
  return [];
};

const previewFallbackLabel = (occ) => {
  if (occ === 'NON_ALLOTABLE') return 'Non-allotable';
  if (occ === 'VACANT') return 'Nobody residing';
  if (occ === 'UNDER_RENOVATION') return 'Under renovation';
  if (occ === 'LOCKED') return 'Locked';
  if (occ === 'DEVELOPER_HOLD') return 'Developer hold';
  return 'No residents';
};

const renderResidentKindSection = (label, list, esc) => {
  if (!list.length) {
    return `
      <div class="resident-kind-section">
        <h4 class="resident-kind-section__title">${label} <span class="resident-kind-section__count">0</span></h4>
        <p class="resident-kind-section__empty">None recorded</p>
      </div>`;
  }
  return `
    <div class="resident-kind-section">
      <h4 class="resident-kind-section__title">${label} <span class="resident-kind-section__count">${list.length}</span></h4>
      <div class="resident-kind-section__rows">
        <div class="registry-header resident-group-header resident-group-header--kind">
          <span>Name</span><span>Phone</span><span>Email</span><span style="text-align:right;">Action</span>
        </div>
        ${list.map((r) => renderResidentRow(r, esc)).join('')}
      </div>
    </div>`;
};

export const renderResidents = async () => {
  const list = document.getElementById('resident-items');
  if (!list) return;
  list.innerHTML = '';
  const apartmentId = portalState.access?.activeApartmentId;
  if (!apartmentId || !supabase) {
    list.innerHTML = `<div style="padding:0.9rem; color:var(--text-dim);">Supabase required.</div>`;
    return;
  }

  let data;
  try {
    data = await loadResidents(true);
  } catch (err) {
    list.innerHTML = `<div style="padding:0.9rem; color:var(--danger); font-weight:800;">${err?.message || 'Could not load residents.'}</div>`;
    return;
  }

  const block = getSelectedBlock();
  const filterOpts = getResidentFilterOptions();
  const blockFiltered = (data || []).filter((r) => !block || unitNumberMatchesBlock(r.unit_number, block));
  const { residents: allUnique } = dedupeResidents(blockFiltered);

  const personFiltered = filterResidentsByOptions(allUnique, filterOpts);
  const { residents: uniqueResidents, hiddenCount } = dedupeResidents(personFiltered);

  const scopedUnits = buildScopedUnitNumbers(block, allUnique);
  const summary = computeResidentPageSummary(allUnique, scopedUnits);

  const residentsByUnit = new Map();
  allUnique.forEach((r) => {
    const key = normUnit(r.unit_number);
    if (!residentsByUnit.has(key)) residentsByUnit.set(key, []);
    residentsByUnit.get(key).push(r);
  });

  const personFilteredIds = new Set(uniqueResidents.map((r) => r.id));
  const showKindOnly = residentSummaryFilter === 'owners' ? 'OWNER'
    : residentSummaryFilter === 'tenants' ? 'TENANT' : filterOpts.kind;

  const visibleGroups = [];
  scopedUnits.forEach((unitNum) => {
    const unitRecord = portalState.units.find((u) => normUnit(u.number) === normUnit(unitNum));
    const allForUnit = residentsByUnit.get(normUnit(unitNum)) || [];
    const occ = classifyUnitOccupancy(allForUnit, unitRecord);
    const missingOwners = unitMissingOwners(allForUnit);

    if (!unitPassesOccupancyFilter(occ, residentSummaryFilter, { missingOwners })) return;

    const hasPersonFilter = hasResidentPersonFilters(filterOpts);
    if (hasPersonFilter) {
      const matching = allForUnit.filter((r) => personFilteredIds.has(r.id));
      const showEmptyFlat = !matching.length && (
        (occ === 'VACANT' && residentSummaryFilter === 'VACANT')
        || (occ === 'NON_ALLOTABLE' && residentSummaryFilter === 'NON_ALLOTABLE')
        || (missingOwners && residentSummaryFilter === 'no_owner')
      );
      if (showEmptyFlat) {
        visibleGroups.push({ block: unitRecord?.block || '—', unit: unitNum, residents: [], occ, missingOwners });
        return;
      }
      if (!matching.length) return;
      visibleGroups.push({
        block: groupResidentsByUnit(matching)[0]?.block || '—',
        unit: unitNum,
        residents: matching,
        occ,
        missingOwners,
      });
      return;
    }

    if ((occ === 'VACANT' || occ === 'NON_ALLOTABLE') && residentSummaryFilter
      && residentSummaryFilter !== occ && residentSummaryFilter !== 'all' && residentSummaryFilter !== 'no_owner') {
      return;
    }
    if (residentSummaryFilter === 'no_owner' && !missingOwners) return;

    visibleGroups.push({
      block: allForUnit.length ? (groupResidentsByUnit(allForUnit)[0]?.block || '—') : (unitRecord?.block || '—'),
      unit: unitNum,
      residents: allForUnit,
      occ,
      missingOwners,
    });
  });

  visibleGroups.sort((a, b) => {
    const blockCmp = String(a.block).localeCompare(String(b.block), undefined, { numeric: true });
    if (blockCmp) return blockCmp;
    return String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true });
  });

  if (!visibleGroups.length) {
    list.innerHTML = `<p class="maintenance-dues-empty">${hasAnyResidentFilters(filterOpts) ? 'No residents match your filters.' : 'No residents recorded yet. Use Import file or Add to get started.'}</p>`;
    return;
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const summaryCards = [
    { key: 'all', label: 'Flats', value: summary.totalFlats, tone: '', hint: 'All flats in scope. Status cards count flats once each.' },
    {
      key: 'OWNER_OCCUPIED',
      label: 'Owner residing',
      value: summary.ownerOccupied,
      tone: 'owner',
      sub: `${summary.totalOwners} owners · ${summary.nonResidingOwners} non-residing`,
      hint: occupancySummaryHint('OWNER_OCCUPIED'),
    },
    {
      key: 'TENANT_OCCUPIED',
      label: 'Tenant occupied',
      value: summary.tenantOccupied,
      tone: 'tenant',
      sub: `${summary.totalTenants} tenants`,
      hint: occupancySummaryHint('TENANT_OCCUPIED'),
    },
    { key: 'VACANT', label: 'Vacant', value: summary.vacant, tone: 'vacant', hint: occupancySummaryHint('VACANT') },
    { key: 'NON_ALLOTABLE', label: 'Non-allotable', value: summary.nonAllotable, tone: 'non-allotable', hint: occupancySummaryHint('NON_ALLOTABLE') },
    { key: 'no_owner', label: 'No owner', value: summary.noOwnerFlats, tone: 'warn', hint: occupancySummaryHint('NO_OWNER') },
  ].filter((c) => c.value > 0 || ['all', 'VACANT', 'NON_ALLOTABLE', 'OWNER_OCCUPIED', 'TENANT_OCCUPIED', 'no_owner'].includes(c.key));

  if (summary.underRenovation) summaryCards.push({ key: 'UNDER_RENOVATION', label: 'Renovation', value: summary.underRenovation, tone: 'reno' });
  if (summary.locked) summaryCards.push({ key: 'LOCKED', label: 'Locked', value: summary.locked, tone: 'locked' });
  if (summary.developerHold) summaryCards.push({ key: 'DEVELOPER_HOLD', label: 'Dev hold', value: summary.developerHold, tone: 'dev' });

  const activeFilterLabel = summaryCards.find((c) => c.key === residentSummaryFilter)?.label;

  list.innerHTML = `
    <section class="resident-summary" aria-label="Occupancy summary">
      ${summaryCards.map((c) => `
        <button type="button" class="resident-summary-card resident-summary-card--${c.tone || 'default'}${residentSummaryFilter === c.key ? ' resident-summary-card--active' : ''}" data-summary-filter="${c.key}" title="${esc(c.hint || `Filter by ${c.label}`)}">
          <span class="resident-summary-card__label">${esc(c.label)}</span>
          <strong class="resident-summary-card__value">${c.value}</strong>
          ${c.sub ? `<span class="resident-summary-card__sub">${esc(c.sub)}</span>` : ''}
        </button>`).join('')}
      <p class="resident-summary-legend"><strong>Vacant</strong> = nobody residing. <strong>Non-allotable</strong> = no owner and no tenant on record. Click a flat row to expand details.</p>
    </section>
    ${(hasAnyResidentFilters(filterOpts)) ? `
      <div class="resident-active-filters">
        <span><i class="fa-solid fa-filter"></i> Filtered${activeFilterLabel ? `: ${esc(activeFilterLabel)}` : ''}${filterOpts.filterQ ? ` · “${esc(filterOpts.filterQ)}”` : ''}</span>
        <button type="button" class="btn btn-outline btn--small" id="resident-clear-filters">Clear filters</button>
      </div>` : ''}
    ${hiddenCount ? `<p class="resident-dupe-hint"><i class="fa-solid fa-circle-info"></i> ${hiddenCount} duplicate record(s) hidden. Delete extras via the trash icon if they appear after refresh.</p>` : ''}
    <div class="resident-unit-groups">
      ${visibleGroups.map((g) => {
        const occ = g.occ || classifyUnitOccupancy(g.residents, portalState.units.find((u) => normUnit(u.number) === normUnit(g.unit)));
        let { owners, tenants } = splitResidentsByKind(g.residents);
        if (showKindOnly === 'OWNER') tenants = [];
        else if (showKindOnly === 'TENANT') owners = [];
        const blockLabel = g.block && g.block !== '—' ? g.block : '';
        const noOwnerFlag = g.missingOwners ?? unitMissingOwners(g.residents);
        const previewList = previewNamesForUnit(occ, owners, tenants);
        const previewNamesHtml = previewList.length
          ? formatResidentNameList(previewList, esc)
          : `<span class="resident-unit-group__names-muted">${esc(previewFallbackLabel(occ))}</span>`;
        return `
        <details class="resident-unit-group${noOwnerFlag ? ' resident-unit-group--no-owner' : ''}">
          <summary class="resident-unit-group__summary">
            <div class="resident-unit-group__title">
              ${blockLabel ? `<span class="resident-unit-group__block">Block ${esc(blockLabel)}</span>` : ''}
              <strong class="resident-unit-group__unit">${esc(g.unit)}</strong>
              <span class="occupancy-badge ${occupancySummaryBadge(occ)}">${esc(occupancySummaryLabel(occ))}</span>
              ${noOwnerFlag ? '<span class="occupancy-badge occ-no-owner" title="No owner on record">No owner</span>' : ''}
            </div>
            <span class="resident-unit-group__names">${previewNamesHtml}</span>
            <span class="resident-unit-group__summary-actions">
              <i class="fa-solid fa-chevron-down resident-unit-group__chevron" aria-hidden="true"></i>
              <button type="button" class="btn btn-outline btn--small btn--danger resident-unit-delete" data-unit="${esc(g.unit)}" title="Delete flat and all residents">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </span>
          </summary>
          <div class="resident-unit-group__body">
            ${renderResidentKindSection('Owners', owners, esc)}
            ${renderResidentKindSection('Tenants', tenants, esc)}
          </div>
        </details>`;
      }).join('')}
    </div>`;

  list.querySelectorAll('[data-summary-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.summaryFilter;
      residentSummaryFilter = residentSummaryFilter === key ? '' : key;
      renderResidents();
    });
  });

  document.getElementById('resident-clear-filters')?.addEventListener('click', () => {
    residentSummaryFilter = '';
    const search = document.getElementById('resident-filter');
    const kind = document.getElementById('resident-kind-filter');
    const residency = document.getElementById('resident-residency-filter');
    const primary = document.getElementById('resident-primary-filter');
    if (search) search.value = '';
    if (kind) kind.value = '';
    if (residency) residency.value = '';
    if (primary) primary.checked = false;
    renderResidents();
  });

  list.querySelectorAll('.resident-group-row').forEach((row) => {
    const id = row.dataset.residentId;
    const r = uniqueResidents.find((x) => x.id === id);
    if (!r) return;
    row.querySelector('[data-action="portal"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.openResidentLinkModal(null, r.email || '', r.id, r.email ? 'invite' : 'manual');
    });
    row.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openResidentModal(r);
    });
    row.querySelector('[data-action="del"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete resident record?')) return;
      try {
        await deleteResident(r.id);
        renderResidents();
        window.refreshUnitDetailIfOpen?.();
      } catch (err) {
        alert(err?.message || 'Could not delete resident.');
      }
    });
  });

  list.querySelectorAll('.resident-unit-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const unitNumber = btn.dataset.unit;
      const unitResidents = allUnique.filter((r) => normUnit(r.unit_number) === normUnit(unitNumber));
      if (!confirm(flatDeleteConfirmMessage(unitNumber, unitResidents))) return;
      await withButtonBusy(btn, 'Deleting…', async () => {
        await deleteFlatWithResidents(unitNumber);
        await renderResidents();
        window.refreshUnitDetailIfOpen?.();
      }).catch((err) => alert(err?.message || 'Could not delete flat.'));
    });
  });
};

export const populateResidentBlockFilter = () => {
    const sel = document.getElementById('resident-block-filter');
    if (!sel) return;
    const blocks = getBlockOptions();
    const selected = getSelectedBlock();
    sel.innerHTML = `<option value="">All blocks</option>${blocks.map((b) =>
        `<option value="${b}" ${b === selected ? 'selected' : ''}>${b}</option>`,
    ).join('')}`;
    sel.onchange = (e) => {
        setSelectedBlock(e.target.value);
        renderResidents();
    };
};

export const exportResidentsExcel = async () => {
    const ExcelJS = (await import('exceljs')).default;
    await loadResidents(true);
    const block = getSelectedBlock();
    const filterOpts = getResidentFilterOptions();
    const rows = filterResidentsByOptions(getResidents(), filterOpts)
        .filter((r) => !block || unitNumberMatchesBlock(r.unit_number, block));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Residents');
    ws.addRow(['Flat', 'Type', 'Name', 'Phone', 'Email', 'Notes']);
    rows.forEach((r) => ws.addRow([
        r.unit_number, r.kind, r.full_name, r.phone || '', r.email || '', r.notes || '',
    ]));
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Residents_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
};

let editingResidentId = null;

export const syncResidentModalFields = () => {
    const kind = document.getElementById('resident-kind')?.value || 'OWNER';
    const isOwner = kind === 'OWNER';
    const residingWrap = document.getElementById('resident-residing-wrap');
    const primaryWrap = document.getElementById('resident-primary-wrap');
    const hint = document.getElementById('resident-residing-hint');
    if (residingWrap) residingWrap.style.display = isOwner ? '' : 'none';
    if (primaryWrap) primaryWrap.style.display = isOwner ? '' : 'none';
    if (hint) hint.style.display = isOwner ? '' : 'none';
};

export const openResidentModal = (r = null) => {
    editingResidentId = r?.id || null;
    document.getElementById('resident-unit').value = r?.unit_number || '';
    document.getElementById('resident-kind').value = r?.kind || 'OWNER';
    document.getElementById('resident-name').value = r?.full_name || '';
    document.getElementById('resident-phone').value = r?.phone || '';
    document.getElementById('resident-email').value = r?.email || '';
    document.getElementById('resident-notes').value = r?.notes || '';
    document.getElementById('resident-residing').value = r?.is_residing === false ? 'false' : 'true';
    document.getElementById('resident-primary').checked = !!r?.is_primary;
    syncResidentModalFields();
    document.getElementById('resident-modal').classList.add('active');
    requestAnimationFrame(() => document.getElementById('resident-name')?.focus());
};

export const closeResidentModal = () => {
    document.getElementById('resident-modal').classList.remove('active');
    editingResidentId = null;
};

export const saveResident = async () => {
    const kind = document.getElementById('resident-kind').value;
    const payload = {
        unit_number: document.getElementById('resident-unit').value.trim(),
        kind,
        full_name: document.getElementById('resident-name').value.trim(),
        phone: document.getElementById('resident-phone').value.trim(),
        email: document.getElementById('resident-email').value.trim(),
        notes: document.getElementById('resident-notes').value.trim(),
        is_primary: document.getElementById('resident-primary').checked,
        is_residing: document.getElementById('resident-residing').value !== 'false',
    };
    try {
        const reviewHint = await persistResident(payload, editingResidentId);
        closeResidentModal();
        renderResidents();
        window.refreshUnitDetailIfOpen?.();
        if (reviewHint) alert(reviewHint);
    } catch (err) {
        alert(err?.message || 'Could not save resident.');
    }
};

if (typeof window !== 'undefined') {
    window.renderResidents = renderResidents;
    window.openResidentModal = openResidentModal;
    window.closeResidentModal = closeResidentModal;
}
