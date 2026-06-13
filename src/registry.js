/**
 * Sentry Registry Engine (Relational)
 */
import { portalState, persist, supabase, pullState, upsertSocietyConfig } from './store.js';
import { getSelectedBlock, unitMatchesBlock } from './blockFilter.js';
import {
  RECONCILE_EXPORT_HEADERS,
  buildReconcileExportRows,
  getSlotPoolKind,
  nextCommunityPoolSlotName,
  slotsForPoolKind,
} from './parkingImport.js';
import { effectiveAllocationType, resolveAllocationTargetLabel } from './allocation.js';
export { effectiveAllocationType } from './allocation.js';
import { logVehicleAudit, vehicleAuditSnapshot, refreshAuditBadge } from './vehicleAudit.js';

let activePoolKind = 'car';

const findVehicleContext = (vid) => {
    for (const u of portalState.units) {
        const v = u.vehicles.find((veh) => veh.id === vid);
        if (v) return { unit: u, vehicle: v };
    }
    return null;
};

const auditVehicleChange = async (opts) => {
    await logVehicleAudit(opts);
    void refreshAuditBadge();
};

/** Active vehicles consuming this unit's base car/bike quota (excludes pool + neighbor). */
export const countBaseSlotUsage = (unit) => {
    let baseCars = 0;
    let baseBikes = 0;
    (unit.vehicles || []).forEach((v) => {
        if (!v.is_parking_active) return;
        if (effectiveAllocationType(v) !== 'BASE') return;
        if ((v.type || 'CAR').toUpperCase() === 'CAR') baseCars++;
        else baseBikes++;
    });
    const carLimit = unit.car_limit || 0;
    const bikeLimit = unit.bike_limit || 0;
    const freeCars = Math.max(0, carLimit - baseCars);
    const freeBikes = Math.max(0, bikeLimit - baseBikes);
    return {
        baseCars,
        baseBikes,
        freeCars,
        freeBikes,
        hasFreeCarSlots: freeCars > 0,
        hasFreeBikeSlots: freeBikes > 0,
        hasFreeSlots: freeCars > 0 || freeBikes > 0,
    };
};

export const processAnalytics = () => {
    let overlimitCars = 0, overlimitBikes = 0, tc = 0, tb = 0;
    let baseCapacity = 0;
    portalState.units.forEach(u => {
        baseCapacity += (u.car_limit || 0) + (u.bike_limit || 0);
        let baseCars = 0, baseBikes = 0;
        u.vehicles.forEach(v => {
            if (!v.is_parking_active) {
                v.status = 'INACTIVE';
                return;
            }

            const allocType = effectiveAllocationType(v);
            if (v.type === 'CAR') tc++;
            else tb++;

            // EH pool + flat-to-flat rentals do not consume base slot quota.
            if (allocType === 'COMMON' || allocType === 'NEIGHBOR') {
                v.status = 'REALLOCATED';
                return;
            }

            if (v.type === 'CAR') {
                baseCars++;
                v.status = baseCars <= u.car_limit ? 'ALLOWED' : 'OVERLIMIT';
                if (v.status === 'OVERLIMIT') overlimitCars++;
            } else {
                baseBikes++;
                v.status = baseBikes <= u.bike_limit ? 'ALLOWED' : 'OVERLIMIT';
                if (v.status === 'OVERLIMIT') overlimitBikes++;
            }
        });
    });

    const activeTotal = tc + tb;
    const occupancyPct = baseCapacity > 0
        ? Math.round((activeTotal / baseCapacity) * 100)
        : null;
    const occupancyLabel = occupancyPct == null ? '—' : `${occupancyPct}%`;

    const k = (id) => document.getElementById(id);
    if (k('kpi-overlimit-cars')) {
        k('kpi-overlimit-cars').textContent = overlimitCars;
        k('kpi-overlimit-bikes').textContent = overlimitBikes;
        k('kpi-cars').textContent = tc;
        k('kpi-bikes').textContent = tb;
        k('kpi-occupancy').textContent = occupancyLabel;
    }

    if (k('ms-over-cars')) k('ms-over-cars').textContent = overlimitCars;
    if (k('ms-over-bikes')) k('ms-over-bikes').textContent = overlimitBikes;
    if (k('ms-occ')) k('ms-occ').textContent = occupancyLabel;
};

export const renderRegistry = () => {
    processAnalytics();
    const list = document.getElementById('registry-items'); if (!list) return; list.innerHTML = '';
    const search = document.getElementById('apt-search').value.toLowerCase();
    const sort = document.getElementById('registry-sort').value;
    const filter = document.body.dataset.registryFilter || 'ALL';
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 520px)').matches;

    const block = getSelectedBlock();

    let filtered = portalState.units.filter(u => {
        if (block && !unitMatchesBlock(u.id, block)) return false;
        const unitMatch = (u.number || '').toString().toLowerCase().includes(search);
        const plateMatch = u.vehicles.some(v => (v.plate || '').toString().toLowerCase().includes(search));
        return unitMatch || plateMatch;
    });

    filtered = filtered.filter(u => {
        const activeFleet = u.vehicles.filter(v => v.is_parking_active);
        const hasOverlimit = activeFleet.some(v => v.status === 'OVERLIMIT');
        const hasCompliant = activeFleet.some(v => v.status === 'ALLOWED' || v.status === 'REALLOCATED');
        const activeCars = activeFleet.filter(v => (v.type || 'CAR').toUpperCase() === 'CAR');
        const activeBikes = activeFleet.filter(v => (v.type || 'BIKE').toUpperCase() !== 'CAR');

        if (filter === 'OVERLIMIT') return hasOverlimit;
        if (filter === 'OVERLIMIT_CARS') return activeCars.some(v => v.status === 'OVERLIMIT');
        if (filter === 'OVERLIMIT_BIKES') return activeBikes.some(v => v.status === 'OVERLIMIT');
        if (filter === 'COMPLIANT') return hasCompliant && !hasOverlimit;
        if (filter === 'CARS') return activeCars.length > 0;
        if (filter === 'BIKES') return activeBikes.length > 0;
        if (filter === 'UNFILLED') return activeFleet.length === 0;
        if (filter === 'FREE_SLOTS_CARS') return countBaseSlotUsage(u).hasFreeCarSlots;
        if (filter === 'FREE_SLOTS_BIKES') return countBaseSlotUsage(u).hasFreeBikeSlots;
        return true; // ALL
    });

    if (sort === 'OVERLIMIT') {
        filtered.sort((a, b) => b.vehicles.some(v => v.status === 'OVERLIMIT') - a.vehicles.some(v => v.status === 'OVERLIMIT') || a.number.localeCompare(b.number));
    } else filtered.sort((a, b) => a.number.localeCompare(b.number));

    filtered.forEach(u => {
        const activeFleet = u.vehicles.filter(v => v.is_parking_active);
        const dormantFleet = u.vehicles.filter(v => !v.is_parking_active);
        const hasViolation = activeFleet.some(v => v.status === 'OVERLIMIT');
        const activeCars = activeFleet.filter(v => (v.type || 'CAR').toUpperCase() === 'CAR');
        const activeBikes = activeFleet.filter(v => (v.type || 'BIKE').toUpperCase() !== 'CAR');
        const overlimitVehicles = activeFleet.filter(v => v.status === 'OVERLIMIT');
        const carUsage = `${activeCars.length}/${u.car_limit}`;
        const bikeUsage = `${activeBikes.length}/${u.bike_limit}`;

        const mobilePlateChip = (v) => {
            const icon = (v.type || 'CAR') === 'CAR' ? 'fa-car' : 'fa-motorcycle';
            const iconTypeClass = (v.type || 'CAR') === 'CAR' ? 'car' : 'bike';
            const t = (v.type || 'CAR').toLowerCase();
            const s = !v.is_parking_active ? 'inactive' : (v.status || 'ALLOWED').toLowerCase();
            return `<span class="unit-chip unit-chip--compact ${t} ${s}"><i class="fa-solid ${icon} vehicle-type-icon ${iconTypeClass}"></i>${v.plate}</span>`;
        };
        const summaryPlates = [...activeFleet, ...dormantFleet];
        const summaryPlatesHtml = summaryPlates.length
            ? summaryPlates.map(mobilePlateChip).join('')
            : `<span class="unit-card__empty">No vehicles</span>`;

        if (isMobile) {
            const card = document.createElement('details');
            card.className = `unit-card ${hasViolation ? 'unit-card--violation' : ''}`;
            card.innerHTML = `
              <summary class="unit-card__summary">
                <div class="unit-card__head">
                  <div class="unit-card__unit">Unit ${u.number}</div>
                  <div class="unit-card__right">
                    <div class="status-pill ${hasViolation ? 'danger' : (activeFleet.length > 0 ? 'success' : 'warning')}"><span>${hasViolation ? 'Violation' : (activeFleet.length > 0 ? 'Pass' : 'Empty')}</span></div>
                    <button class="btn btn-outline unit-card__manage" type="button" aria-label="Manage unit"><i class="fa-solid fa-gear"></i></button>
                  </div>
                </div>
                <div class="unit-card__meta">
                  <span class="unit-card__usage"><i class="fa-solid fa-car"></i> ${carUsage}</span>
                  <span class="unit-card__usage"><i class="fa-solid fa-motorcycle"></i> ${bikeUsage}</span>
                  <span class="unit-card__dot">•</span>
                  <span>${activeFleet.length} active</span>
                  ${dormantFleet.length ? `<span class="unit-card__dot">•</span><span>${dormantFleet.length} dormant</span>` : ''}
                </div>
                <div class="unit-card__plates">${summaryPlatesHtml}</div>
              </summary>
              <div class="unit-card__body">
                ${hasViolation ? `
                <div class="unit-card__section unit-card__section--danger">
                  <div class="unit-card__label">Violation details</div>
                  <div class="unit-card__hint">
                    Overlimit happens when active vehicles exceed base slots (Cars: ${carUsage}, Bikes: ${bikeUsage}).
                    Fix: move extra vehicles to <b>Community Pool</b> or <b>Neighbor Unit</b>.
                  </div>
                  <div class="unit-card__chips">
                    ${overlimitVehicles.map(v => {
                        const icon = (v.type || 'CAR') === 'CAR' ? 'fa-car' : 'fa-motorcycle';
                        const iconTypeClass = (v.type || 'CAR') === 'CAR' ? 'car' : 'bike';
                        const t = (v.type || 'CAR').toLowerCase();
                        const alloc = effectiveAllocationType(v);
                        const allocLabel = alloc === 'BASE' ? 'Base slot exceeded' : `Allocated: ${alloc}`;
                        return `<span class="unit-chip ${t} overlimit"><i class="fa-solid ${icon} vehicle-type-icon ${iconTypeClass}"></i>${v.plate}<span class="unit-chip__sub">${allocLabel}</span></span>`;
                    }).join('')}
                  </div>
                </div>` : ''}
                <div class="unit-card__section">
                  <div class="unit-card__label">Active fleet</div>
                  <div class="unit-card__chips">
                    ${activeFleet.length ? activeFleet.map(v => {
                        const icon = (v.type || 'CAR') === 'CAR' ? 'fa-car' : 'fa-motorcycle';
                        const iconTypeClass = (v.type || 'CAR') === 'CAR' ? 'car' : 'bike';
                        const s = (v.status || 'ALLOWED').toLowerCase();
                        const t = (v.type || 'CAR').toLowerCase();
                        return `<span class="unit-chip ${t} ${s}"><i class="fa-solid ${icon} vehicle-type-icon ${iconTypeClass}"></i>${v.plate}</span>`;
                    }).join('') : `<span class="unit-card__empty">No active vehicles</span>`}
                  </div>
                </div>

                <div class="unit-card__grid">
                  <div class="unit-card__kv">
                    <div class="unit-card__label">Base slots</div>
                    <div class="unit-card__value"><i class="fa-solid fa-car"></i> ${u.car_limit} <i class="fa-solid fa-motorcycle"></i> ${u.bike_limit}</div>
                  </div>
                  <div class="unit-card__kv">
                    <div class="unit-card__label">Pool allocated</div>
                    <div class="unit-card__value">
                      ${activeFleet
                        .filter(v => effectiveAllocationType(v) === 'COMMON')
                        .map(v => portalState.slots.find(s => s.id === v.allocation_target_id)?.name ? `${v.plate} → ${portalState.slots.find(s => s.id === v.allocation_target_id)?.name}` : null)
                        .filter(Boolean)
                        .join('<br/>') || `<span class="unit-card__empty">None</span>`}
                    </div>
                  </div>
                </div>

                <div class="unit-card__section">
                  <div class="unit-card__label">Dormant registry</div>
                  <div class="unit-card__chips">
                    ${dormantFleet.length ? dormantFleet.map(v => {
                        const icon = (v.type || 'CAR') === 'CAR' ? 'fa-car' : 'fa-motorcycle';
                        const iconTypeClass = (v.type || 'CAR') === 'CAR' ? 'car' : 'bike';
                        const t = (v.type || 'CAR').toLowerCase();
                        return `<span class="unit-chip ${t} inactive"><i class="fa-solid ${icon} vehicle-type-icon ${iconTypeClass}"></i>${v.plate}</span>`;
                    }).join('') : `<span class="unit-card__empty">None</span>`}
                  </div>
                </div>
              </div>
            `;
            card.querySelector('.unit-card__manage').onclick = (e) => { e.preventDefault(); e.stopPropagation(); window.openMdl(u.id); };
            list.appendChild(card);
            return;
        }

        const item = document.createElement('div'); item.className = 'apt-row'; item.onclick = () => window.openMdl(u.id);
        const dormantDetails = dormantFleet
            .map(v => {
                const icon = (v.type || 'CAR') === 'CAR' ? 'fa-car' : 'fa-motorcycle';
                const iconTypeClass = (v.type || 'CAR') === 'CAR' ? 'car' : 'bike';
                return `<span class="dormant-chip"><i class="fa-solid ${icon} vehicle-type-icon ${iconTypeClass}"></i><b>${v.plate}</b></span>`;
            })
            .join('');
        const allocationDetails = activeFleet
            .filter(v => effectiveAllocationType(v) === 'COMMON')
            .map(v => {
                const target = portalState.slots.find(s => s.id === v.allocation_target_id)?.name;
                if (!target) return '';
                return `<span class="pool-alloc-chip common"><b>${v.plate}</b> <i class="fa-solid fa-arrow-right"></i> ${target}</span>`;
            })
            .filter(Boolean)
            .join('');

        const tags = activeFleet.map(v => {
            const icon = (v.type || 'CAR') === 'CAR' ? 'fa-car' : 'fa-motorcycle';
            const iconTypeClass = (v.type || 'CAR') === 'CAR' ? 'car' : 'bike';
            const rent = parkingAllocationLabel(v);
            const rentSuffix = rent ? ` <span class="v-tag-rent">${rent.replace('Rented slot ', '').replace('Rented from ', '@')}</span>` : '';
            return `<div class="v-tag ${(v.type || 'CAR').toLowerCase()} ${(v.status || 'ALLOWED').toLowerCase()}">
                <i class="fa-solid ${icon} vehicle-type-icon ${iconTypeClass}" style="font-size: 0.70rem; margin-right: 0.35rem; opacity: 0.95;"></i>
                <span>${v.plate}${rentSuffix}</span>
            </div>`;
        }).join('');

        item.innerHTML = `
        <div class="apt-number">${u.number}</div>
        <div class="vehicle-stack">${tags}</div>
        <div class="dormant-cell">${dormantDetails || '<span class="dormant-none">-</span>'}</div>
        <div class="pool-alloc-cell">${allocationDetails || '<span class="pool-alloc-none">-</span>'}</div>
        <div style="font-weight:700;"><i class="fa-solid fa-car" style="color:var(--text-dim); font-size:0.8rem;"></i> ${u.car_limit} <i class="fa-solid fa-motorcycle" style="color:var(--text-dim); font-size:0.8rem; margin-left:0.5rem;"></i> ${u.bike_limit}</div>
        <div><div class="status-pill ${hasViolation ? 'danger' : (activeFleet.length > 0 ? 'success' : 'warning')}"><span>${hasViolation ? 'Violation' : (activeFleet.length > 0 ? 'Pass' : 'Empty')}</span></div></div>
        <div style="text-align:right;"><button class="btn btn-outline" style="padding:0.25rem 0.5rem;"><i class="fa-solid fa-gear"></i></button></div>`;
        list.appendChild(item);
    });
    renderPoolGrid();
    renderBikePoolGrid();
    renderFlatRentalGrid();
};

const collectFlatRentalCards = () => {
    const cards = [];
    const seenPlates = new Set();

    portalState.units.forEach((tenant) => {
        tenant.vehicles.forEach((v) => {
            if (!v.is_parking_active) return;
            if ((v.allocation_type || '').toUpperCase() !== 'NEIGHBOR') return;
            if (!v.allocation_target_id) return;
            const source = portalState.units.find((u) => u.id === v.allocation_target_id);
            if (seenPlates.has(v.plate)) return;
            seenPlates.add(v.plate);
            cards.push({
                sourceLabel: source?.number || '?',
                plate: v.plate,
                tenantLabel: tenant.number,
            });
        });
    });

    portalState.slots.forEach((s) => {
        if (getSlotPoolKind(s)) return;
        if (!s.occupant) return;
        if (seenPlates.has(s.occupant)) return;
        seenPlates.add(s.occupant);
        cards.push({
            sourceLabel: s.name,
            plate: s.occupant,
            tenantLabel: s.unit_num || '--',
            legacySlot: true,
            slotId: s.id,
        });
    });

    return cards.sort((a, b) => String(a.sourceLabel).localeCompare(String(b.sourceLabel)));
};

export const renderFlatRentalGrid = () => {
    const grid = document.getElementById('flat-rental-grid');
    const empty = document.getElementById('flat-rental-empty');
    if (!grid) return;
    grid.innerHTML = '';

    const cards = collectFlatRentalCards();
    if (empty) empty.hidden = cards.length > 0;

    cards.forEach((c) => {
        const d = document.createElement('div');
        d.className = 'pool-slot flat-rental-slot occupied';
        if (c.legacySlot && c.slotId) {
            d.onclick = () => window.openPool(c.slotId);
            d.title = 'Legacy pool row — click to manage';
        }
        d.innerHTML = `
            <div class="slot-name">${c.sourceLabel}</div>
            <div class="slot-occupant">${c.plate}</div>
            <div class="slot-unit">→ ${c.tenantLabel}</div>
        `;
        grid.appendChild(d);
    });

    const countEl = document.getElementById('ms-flat-rent-count');
    if (countEl) countEl.textContent = cards.length;
};

const renderCommunityPoolGrid = (kind, gridId, occId, totalId, emptyId) => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = '';

    const poolSlots = slotsForPoolKind(portalState.slots, kind);
    let occupied = 0;

    poolSlots.forEach((s) => {
        if (s.occupant) occupied++;
        const d = document.createElement('div');
        d.className = `pool-slot pool-slot--managed ${s.occupant ? 'occupied' : 'empty'}`;
        d.onclick = () => window.openPool(s.id);

        const delBtn = !s.occupant
            ? `<button type="button" class="pool-slot__del" title="Delete slot" aria-label="Delete ${s.name}"><i class="fa-solid fa-xmark"></i></button>`
            : '';

        d.innerHTML = `
            ${delBtn}
            <div class="slot-name">${s.name}</div>
            <div class="slot-occupant">${s.occupant || 'VACANT'}</div>
            <div class="slot-unit">${s.unit_num || '--'}</div>
        `;

        const del = d.querySelector('.pool-slot__del');
        if (del) {
            del.onclick = (e) => {
                e.stopPropagation();
                void window.deleteCommunityPoolSlot(s.id, kind);
            };
        }
        grid.appendChild(d);
    });

    const emptyEl = emptyId ? document.getElementById(emptyId) : null;
    if (emptyEl) emptyEl.hidden = poolSlots.length > 0;

    const k = (id) => document.getElementById(id);
    if (totalId && k(totalId)) k(totalId).textContent = poolSlots.length;
    if (occId && k(occId)) k(occId).textContent = occupied;
};

export const renderPoolGrid = () => {
    renderCommunityPoolGrid('car', 'pool-grid', 'ms-pool-occ', 'ms-pool-total', null);
};

export const renderBikePoolGrid = () => {
    renderCommunityPoolGrid('bike', 'bike-pool-grid', 'ms-bike-pool-occ', 'ms-bike-pool-total', 'bike-pool-empty');
};

export const addCommunityPoolSlot = async (kind) => {
    if (!supabase) return alert('Supabase is required.');
    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) return alert('No active apartment selected.');

    const name = nextCommunityPoolSlotName(kind, portalState.slots);
    const payload = { apartment_id: apartmentId, name, pool_kind: kind };
    let { error } = await supabase.from('parking_slots').insert(payload);
    if (error && /pool_kind/i.test(error.message)) {
        ({ error } = await supabase.from('parking_slots').insert({ apartment_id: apartmentId, name }));
    }
    if (error) return alert(`Could not add slot: ${error.message}`);

    await pullState();
    processAnalytics();
    renderRegistry();
};
window.addCommunityPoolSlot = addCommunityPoolSlot;

export const deleteCommunityPoolSlot = async (slotId, kind) => {
    if (!supabase) return;
    const slot = portalState.slots.find((s) => s.id === slotId);
    if (!slot) return;
    if (slot.occupant || slot.assigned_vehicle_id) {
        return alert('Release the vehicle from this slot before deleting it.');
    }
    if (!confirm(`Delete pool slot ${slot.name}?`)) return;

    const { error } = await supabase.from('parking_slots').delete().eq('id', slotId);
    if (error) return alert(`Could not delete slot: ${error.message}`);

    await pullState();
    processAnalytics();
    renderRegistry();
};
window.deleteCommunityPoolSlot = deleteCommunityPoolSlot;

const renderPoolSearchResults = (slotId, query = '') => {
    const list = document.getElementById('pool-search-results');
    if (!list) return;
    list.innerHTML = '';

    const q = query.trim().toLowerCase();
    const candidates = [];

    portalState.units.forEach(u => {
        u.vehicles.forEach(v => {
            const alreadyAssignedElsewhere = portalState.slots.some(sx => sx.assigned_vehicle_id === v.id && sx.id !== slotId);
            if (alreadyAssignedElsewhere) return;

            const plate = (v.plate || '').toUpperCase();
            const type = (v.type || 'CAR').toUpperCase();
            const isBike = type !== 'CAR';
            if (activePoolKind === 'bike' && !isBike) return;
            if (activePoolKind === 'car' && isBike) return;
            const haystack = `${u.number} ${plate} ${type}`.toLowerCase();
            if (q && !haystack.includes(q)) return;
            candidates.push({ unit: u, vehicle: v });
        });
    });

    if (candidates.length === 0) {
        list.innerHTML = `<div style="padding:0.75rem; font-size:0.8rem; color:var(--text-dim); border:1px dashed var(--border); border-radius:8px;">No matching unassigned vehicles found.</div>`;
        return;
    }

    candidates.forEach(({ unit, vehicle }) => {
        const row = document.createElement('button');
        const icon = (vehicle.type || 'CAR') === 'CAR' ? 'fa-car' : 'fa-motorcycle';
        row.className = 'pool-search-row';
        row.innerHTML = `
            <span><i class="fa-solid ${icon}" style="font-size:0.75rem; color:var(--text-dim); margin-right:0.4rem;"></i>${vehicle.plate}</span>
            <span style="color:var(--text-dim); font-size:0.75rem;">${unit.number}</span>
        `;
        row.onclick = async () => {
            if (!supabase) return;
            const slot = portalState.slots.find((s) => s.id === slotId);
            const before = vehicleAuditSnapshot(vehicle, unit.number);
            await supabase.from('parking_slots').update({ assigned_vehicle_id: vehicle.id }).eq('id', slotId);
            await supabase.from('vehicles').update({
                allocation_type: 'COMMON',
                allocation_target_id: slotId,
            }).eq('id', vehicle.id);
            const after = {
                ...before,
                allocation_type: 'COMMON',
                allocation_target: slot?.name || null,
            };
            await auditVehicleChange({
                action: 'update',
                source: 'ui',
                vehicleId: vehicle.id,
                unitNumber: unit.number,
                plate: vehicle.plate,
                before,
                after,
            });
            document.getElementById('pool-modal').classList.remove('active');
            await pullState();
            renderRegistry();
        };
        list.appendChild(row);
    });
};

export const openPool = (id) => {
    const s = portalState.slots.find(x => x.id === id); if (!s) return;
    activePoolKind = getSlotPoolKind(s) || 'car';
    const isBike = activePoolKind === 'bike';
    document.getElementById('pool-mdl-title').textContent = `Slot ${s.name}`;
    document.getElementById('pool-mdl-status').textContent = s.occupant ? 'Active Assignment' : 'Available for Allocation';
    const iconEl = document.getElementById('pool-v-icon');
    if (iconEl) iconEl.textContent = isBike ? '🏍️' : '🚗';

    document.getElementById('pool-mdl-occupied').style.display = s.occupant ? 'block' : 'none';
    document.getElementById('pool-mdl-available').style.display = s.occupant ? 'none' : 'block';

    if (s.occupant) {
        document.getElementById('pool-v-plate').textContent = s.occupant;
        document.getElementById('pool-v-unit').textContent = `ASSIGNED TO ${s.unit_num}`;
        document.getElementById('pool-deallocate-btn').onclick = () => window.deallocateSlot(id);
    } else {
        const searchInput = document.getElementById('pool-search-input');
        if (searchInput) {
            searchInput.value = '';
            searchInput.oninput = (e) => renderPoolSearchResults(id, e.target.value);
        }
        renderPoolSearchResults(id, '');
    }
    document.getElementById('pool-modal').classList.add('active');
};
window.openPool = openPool;

export const deallocateSlot = async (id) => {
    if (confirm('Release this community slot?') && supabase) {
        const slot = portalState.slots.find((s) => s.id === id);
        const vid = slot?.assigned_vehicle_id;
        const ctx = vid ? findVehicleContext(vid) : null;
        const before = ctx ? vehicleAuditSnapshot(ctx.vehicle, ctx.unit.number) : null;
        await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('id', id);
        if (vid) {
            await supabase.from('vehicles').update({
                allocation_type: 'BASE',
                allocation_target_id: null,
            }).eq('id', vid);
            if (before && ctx) {
                await auditVehicleChange({
                    action: 'update',
                    source: 'ui',
                    vehicleId: vid,
                    unitNumber: ctx.unit.number,
                    plate: ctx.vehicle.plate,
                    before,
                    after: { ...before, allocation_type: 'BASE', allocation_target: null },
                });
            }
        }
        document.getElementById('pool-modal').classList.remove('active');
        await pullState(); renderRegistry();
    }
};
window.deallocateSlot = deallocateSlot;

export const openMdl = (id) => {
    portalState.activeUnitId = id; const u = portalState.units.find(x => x.id == id);
    document.getElementById('mdl-apt-name').textContent = u.number;
    document.getElementById('mdl-car-slots').value = u.car_limit;
    document.getElementById('mdl-bike-slots').value = u.bike_limit;
    const areaEl = document.getElementById('mdl-area-sqft');
    if (areaEl) areaEl.value = u.area_sqft ?? '';
    renderMdlList(u);
    document.getElementById('apt-modal').classList.add('active');
};
window.openMdl = openMdl;

export const closeMdl = () => document.getElementById('apt-modal').classList.remove('active');
window.closeMdl = closeMdl;

let capacityDraft = null;

const showCapacityError = (msg) => {
    const el = document.getElementById('capacity-error');
    if (!el) return;
    if (msg) {
        el.style.display = 'block';
        el.textContent = msg;
    } else {
        el.style.display = 'none';
        el.textContent = '';
    }
};

const initCapacityDraft = () => {
    capacityDraft = new Map();
    portalState.units.forEach((u) => {
        capacityDraft.set(u.id, {
            car: u.car_limit ?? 0,
            bike: u.bike_limit ?? 0,
        });
    });
};

const updateCapacityTotals = () => {
    const el = document.getElementById('capacity-totals');
    if (!el || !capacityDraft) return;
    let cars = 0;
    let bikes = 0;
    capacityDraft.forEach((d) => {
        cars += d.car;
        bikes += d.bike;
    });
    el.textContent = `${capacityDraft.size} flats · ${cars} car + ${bikes} bike base slots`;
};

export const refreshCapacityUnitList = () => {
    const list = document.getElementById('capacity-unit-list');
    if (!list || !capacityDraft) return;
    const q = (document.getElementById('capacity-search')?.value || '').toLowerCase();
    list.innerHTML = '';

    [...portalState.units]
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }))
        .forEach((u) => {
            if (q && !String(u.number).toLowerCase().includes(q)) return;
            const draft = capacityDraft.get(u.id);
            if (!draft) return;
            const usage = countBaseSlotUsage(u);
            const row = document.createElement('div');
            row.className = 'capacity-row';
            row.dataset.unitId = u.id;
            row.innerHTML = `
                <span class="capacity-row__unit">${u.number}</span>
                <span class="capacity-row__usage">
                    <i class="fa-solid fa-car"></i> ${usage.baseCars}/${draft.car}
                    <i class="fa-solid fa-motorcycle"></i> ${usage.baseBikes}/${draft.bike}
                </span>
                <input type="number" min="0" step="1" class="capacity-car" value="${draft.car}" />
                <input type="number" min="0" step="1" class="capacity-bike" value="${draft.bike}" />
            `;
            const carInput = row.querySelector('.capacity-car');
            const bikeInput = row.querySelector('.capacity-bike');
            carInput.oninput = () => {
                draft.car = Math.max(0, parseInt(carInput.value, 10) || 0);
                row.querySelector('.capacity-row__usage').innerHTML = `
                    <i class="fa-solid fa-car"></i> ${usage.baseCars}/${draft.car}
                    <i class="fa-solid fa-motorcycle"></i> ${usage.baseBikes}/${draft.bike}
                `;
                updateCapacityTotals();
            };
            bikeInput.oninput = () => {
                draft.bike = Math.max(0, parseInt(bikeInput.value, 10) || 0);
                row.querySelector('.capacity-row__usage').innerHTML = `
                    <i class="fa-solid fa-car"></i> ${usage.baseCars}/${draft.car}
                    <i class="fa-solid fa-motorcycle"></i> ${usage.baseBikes}/${draft.bike}
                `;
                updateCapacityTotals();
            };
            list.appendChild(row);
        });

    updateCapacityTotals();
};

export const openCapacityModal = () => {
    if (!supabase) return alert('Supabase is required.');
    if (!portalState.units.length) return alert('No units loaded yet.');
    initCapacityDraft();
    const carDefault = document.getElementById('cap-default-cars');
    const bikeDefault = document.getElementById('cap-default-bikes');
    if (carDefault) carDefault.value = portalState.community.defaults?.cars ?? 1;
    if (bikeDefault) bikeDefault.value = portalState.community.defaults?.bikes ?? 1;
    const search = document.getElementById('capacity-search');
    if (search) search.value = '';
    showCapacityError('');
    refreshCapacityUnitList();
    document.getElementById('capacity-modal')?.classList.add('active');
};

export const closeCapacityModal = () => {
    document.getElementById('capacity-modal')?.classList.remove('active');
    capacityDraft = null;
    showCapacityError('');
};

export const applyCapacityDefaultsToAll = () => {
    if (!capacityDraft) return;
    const cars = Math.max(0, parseInt(document.getElementById('cap-default-cars')?.value, 10) || 0);
    const bikes = Math.max(0, parseInt(document.getElementById('cap-default-bikes')?.value, 10) || 0);
    capacityDraft.forEach((d) => {
        d.car = cars;
        d.bike = bikes;
    });
    refreshCapacityUnitList();
};

export const saveCapacityAllocation = async () => {
    if (!supabase || !capacityDraft) return;
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return alert('No active apartment selected.');

    const car_default = Math.max(0, parseInt(document.getElementById('cap-default-cars')?.value, 10) || 0);
    const bike_default = Math.max(0, parseInt(document.getElementById('cap-default-bikes')?.value, 10) || 0);
    const updates = [...capacityDraft.entries()].map(([id, d]) => ({
        id,
        car_limit: Math.max(0, d.car),
        bike_limit: Math.max(0, d.bike),
    }));

    showCapacityError('');
    const results = await Promise.all(
        updates.map((u) =>
            supabase.from('units').update({ car_limit: u.car_limit, bike_limit: u.bike_limit }).eq('id', u.id),
        ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) {
        showCapacityError(failed.error.message);
        return;
    }

    const { error: cfgError } = await upsertSocietyConfig(apartment_id, {
        name: portalState.community.name,
        car_default,
        bike_default,
    });
    if (cfgError) {
        showCapacityError(cfgError.message);
        return;
    }

    portalState.community.defaults = { cars: car_default, bikes: bike_default };
    await pullState();
    processAnalytics();
    renderRegistry();
    persist();
    closeCapacityModal();
};

const formatRegistryMetaLine = (v) => {
    const parts = [];
    if (v.parking_sticker) parts.push(`Sticker: ${v.parking_sticker}`);
    const rfid = v.rfid_number || v.rfid_tag;
    if (rfid && !String(rfid).toLowerCase().includes('not assigned')) {
        parts.push(`RFID: ${v.rfid_number || v.rfid_tag}`);
    } else if (v.rfid_tag) {
        parts.push(`RFID: ${v.rfid_tag}`);
    }
    if (v.registry_updated_on) parts.push(`Updated: ${v.registry_updated_on}`);
    return parts.length ? `<div class="vehicle-registry-meta">${parts.join(' · ')}</div>` : '';
};

const parkingAllocationLabel = (v) => {
    const alloc = effectiveAllocationType(v);
    const label = resolveAllocationTargetLabel(v);
    if (!label) return '';
    if (alloc === 'COMMON') return `Rented slot ${label}`;
    if (alloc === 'NEIGHBOR') return `Rented from ${label.replace(/^Unit /, '')}`;
    return label;
};

const formatParkingAllocLine = (v) => {
    const label = parkingAllocationLabel(v);
    return label ? `<div class="vehicle-parking-alloc">${label}</div>` : '';
};

const renderMdlList = (u) => {
    const c = document.getElementById('mdl-vehicle-list'); if (!c) return; c.innerHTML = '';
    // Stable Sort: Maintain arrival order to prevent jumpy UI
    const stableVehicles = [...u.vehicles].sort((a, b) => a.id.localeCompare(b.id));

    stableVehicles.forEach(v => {
        const d = document.createElement('div'); d.className = 'modal-list-item';
        d.classList.add('vehicle-row-card');
        const status = (v.status || 'ALLOWED').toUpperCase();

        const type = (v.type || 'CAR').toLowerCase();
        const icon = type === 'car' ? 'fa-car' : 'fa-motorcycle';
        const alloc = effectiveAllocationType(v);
        const statusChip = status === 'OVERLIMIT'
            ? `<span class="alloc-status-chip overlimit">Overlimit</span>`
            : (status === 'REALLOCATED'
                ? `<span class="alloc-status-chip reallocated">Reallocated</span>`
                : (status === 'INACTIVE' ? `<span class="alloc-status-chip inactive">Inactive</span>` : ''));
        if (status === 'OVERLIMIT') d.classList.add('is-overlimit');

        d.innerHTML = `
        <div class="apt-alloc-row">
          <div class="apt-alloc-vehicle">
            <i class="fa-solid ${icon} vehicle-type-icon ${type}"></i>
            <div class="apt-alloc-vehicle__text">
              <input type="text" class="vehicle-plate-input" aria-label="Plate number" spellcheck="false" autocomplete="off" />
              ${formatParkingAllocLine(v)}
              ${formatRegistryMetaLine(v)}
            </div>
            ${statusChip}
          </div>
          <div class="apt-alloc-controls ${alloc !== 'BASE' ? 'with-target' : ''}">
            <label class="vehicle-active-toggle">
              <input type="checkbox" ${v.is_parking_active ? 'checked' : ''} onchange="window.toggleVehicleActive('${u.id}', '${v.id}', this.checked)" />
              <span>${v.is_parking_active ? 'Active' : 'Dormant'}</span>
            </label>
            <select class="form-select apt-alloc-select" aria-label="Space Type" title="Space Type" onchange="window.updateAllocation('${v.id}', '${u.id}', this.value)">
              <option value="BASE" ${alloc === 'BASE' ? 'selected' : ''}>Base Area Slot</option>
              <option value="COMMON" ${alloc === 'COMMON' ? 'selected' : ''}>Community Pool</option>
              <option value="NEIGHBOR" ${alloc === 'NEIGHBOR' ? 'selected' : ''}>Neighbor Unit</option>
            </select>
            ${alloc !== 'BASE' ? `
            <select class="form-select apt-alloc-select" aria-label="Allocation Target" title="Allocation Target" onchange="window.updateAllocationTarget('${v.id}', '${u.id}', this.value)">
              <option value="">Choose Target...</option>
              ${alloc === 'COMMON'
                    ? portalState.slots
                        .filter(s => !s.occupant || s.assigned_vehicle_id === v.id)
                        .map(s => `<option value="${s.id}" ${v.allocation_target_id === s.id ? 'selected' : ''}>${s.name}</option>`).join('')
                    : portalState.units.filter(ux => ux.id !== u.id).map(ux => `<option value="${ux.id}" ${v.allocation_target_id === ux.id ? 'selected' : ''}>Unit ${ux.number}</option>`).join('')
                }
            </select>` : ''}
            <button class="btn btn-outline vehicle-del-btn" onclick="window.delVeh('${u.id}', '${v.id}')"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
        `;
        const plateInput = d.querySelector('.vehicle-plate-input');
        if (plateInput) {
            plateInput.value = v.plate || '';
            plateInput.dataset.original = v.plate || '';
            plateInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    plateInput.blur();
                }
                if (e.key === 'Escape') {
                    plateInput.value = plateInput.dataset.original || '';
                    plateInput.blur();
                }
            });
            plateInput.addEventListener('blur', () => {
                void window.updateVehiclePlate(u.id, v.id, plateInput);
            });
        }
        c.appendChild(d);
    });
};

window.updateVehiclePlate = async (uid, vid, inputEl) => {
    if (!supabase || !inputEl) return;
    const u = portalState.units.find((x) => x.id === uid);
    const v = u?.vehicles.find((veh) => veh.id === vid);
    if (!u || !v) return;

    const plate = inputEl.value.trim().toUpperCase();
    const original = (inputEl.dataset.original || v.plate || '').trim().toUpperCase();
    if (!plate) {
        inputEl.value = original;
        return alert('Plate number cannot be empty.');
    }
    if (plate === original) return;

    const duplicate = portalState.units.some((unit) =>
        unit.vehicles.some((veh) => veh.id !== vid && (veh.plate || '').trim().toUpperCase() === plate),
    );
    if (duplicate) {
        inputEl.value = original;
        return alert(`Plate ${plate} is already registered in this apartment.`);
    }

    const before = vehicleAuditSnapshot(v, u.number);
    const { error } = await supabase.from('vehicles').update({ plate }).eq('id', vid);
    if (error) {
        inputEl.value = original;
        return alert(`Could not update plate: ${error.message}`);
    }

    await auditVehicleChange({
        action: 'update',
        source: 'ui',
        vehicleId: vid,
        unitNumber: u.number,
        plate,
        before,
        after: { ...before, plate },
    });

    inputEl.dataset.original = plate;
    inputEl.value = plate;
    await pullState();
    processAnalytics();
    renderRegistry();
    openMdl(uid);
};

window.updateAllocation = async (vid, uid, type) => {
    if (!supabase) return;
    const u = portalState.units.find((x) => x.id === uid);
    const v = u?.vehicles.find((veh) => veh.id === vid);
    const before = v ? vehicleAuditSnapshot(v, u.number) : null;
    await supabase.from('vehicles').update({ allocation_type: type, allocation_target_id: null }).eq('id', vid);
    if (type !== 'COMMON') {
        await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('assigned_vehicle_id', vid);
    }
    if (before && v) {
        await auditVehicleChange({
            action: 'update',
            source: 'ui',
            vehicleId: vid,
            unitNumber: u.number,
            plate: v.plate,
            before,
            after: { ...before, allocation_type: type, allocation_target: null },
        });
    }
    await pullState(); processAnalytics(); renderRegistry(); openMdl(uid);
};

window.updateAllocationTarget = async (vid, uid, targetId) => {
    if (!supabase || !targetId) return;
    const u = portalState.units.find((x) => x.id === uid);
    const v = u?.vehicles.find((veh) => veh.id === vid);
    const before = v ? vehicleAuditSnapshot(v, u.number) : null;
    await supabase.from('vehicles').update({ allocation_target_id: targetId }).eq('id', vid);

    if (v?.allocation_type === 'COMMON') {
        await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('assigned_vehicle_id', vid);
        await supabase.from('parking_slots').update({ assigned_vehicle_id: vid }).eq('id', targetId);
    }
    if (before && v) {
        let targetLabel = null;
        const slot = portalState.slots.find((s) => s.id === targetId);
        if (slot) targetLabel = slot.name;
        else {
            const neighbor = portalState.units.find((ux) => ux.id === targetId);
            if (neighbor) targetLabel = `Unit ${neighbor.number}`;
        }
        await auditVehicleChange({
            action: 'update',
            source: 'ui',
            vehicleId: vid,
            unitNumber: u.number,
            plate: v.plate,
            before,
            after: { ...before, allocation_target: targetLabel },
        });
    }
    await pullState(); processAnalytics(); renderRegistry(); openMdl(uid);
};

window.delVeh = async (uid, vid) => {
    if (!supabase) return;
    const u = portalState.units.find((x) => x.id === uid);
    const v = u?.vehicles.find((veh) => veh.id === vid);
    const before = v ? vehicleAuditSnapshot(v, u.number) : null;
    const { error } = await supabase.from('vehicles').delete().eq('id', vid);
    if (!error) {
        if (before && v) {
            await auditVehicleChange({
                action: 'delete',
                source: 'ui',
                vehicleId: vid,
                unitNumber: u.number,
                plate: v.plate,
                before,
            });
        }
        await pullState(); processAnalytics(); renderRegistry(); openMdl(uid);
    }
};

window.toggleVehicleActive = async (uid, vid, isActive) => {
    if (!supabase) return;
    const u = portalState.units.find((x) => x.id === uid);
    const v = u?.vehicles.find((veh) => veh.id === vid);
    const before = v ? vehicleAuditSnapshot(v, u.number) : null;
    const { error } = await supabase.from('vehicles').update({ is_parking_active: isActive }).eq('id', vid);
    if (!error) {
        if (before && v) {
            await auditVehicleChange({
                action: 'update',
                source: 'ui',
                vehicleId: vid,
                unitNumber: u.number,
                plate: v.plate,
                before,
                after: { ...before, is_parking_active: isActive },
            });
        }
        await pullState();
        processAnalytics();
        renderRegistry();
        openMdl(uid);
    }
};

export const saveMdlData = async () => {
    if (!supabase) return;
    const u = portalState.units.find(x => x.id == portalState.activeUnitId);
    const plate = document.getElementById('new-v-plate').value.trim();
    const type = document.getElementById('new-v-type').value;
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return alert('No active apartment selected.');

    // 1. Update Unit Policy
    const car_limit = parseInt(document.getElementById('mdl-car-slots').value);
    const bike_limit = parseInt(document.getElementById('mdl-bike-slots').value);
    const areaRaw = document.getElementById('mdl-area-sqft')?.value;
    const area_sqft = areaRaw === '' || areaRaw == null ? null : parseFloat(areaRaw);
    await supabase.from('units').update({ car_limit, bike_limit, area_sqft }).eq('id', u.id);

    // 2. Insert New Vehicle
    if (plate) {
        const { data: inserted, error } = await supabase
            .from('vehicles')
            .insert({ apartment_id, unit_id: u.id, plate, type, is_parking_active: true })
            .select('id')
            .single();
        if (!error && inserted?.id) {
            const after = vehicleAuditSnapshot(
                { plate, type, is_parking_active: true, allocation_type: 'BASE' },
                u.number,
            );
            await auditVehicleChange({
                action: 'insert',
                source: 'ui',
                vehicleId: inserted.id,
                unitNumber: u.number,
                plate,
                after,
            });
        }
    }

    document.getElementById('new-v-plate').value = '';
    await pullState(); processAnalytics(); renderRegistry(); persist(); window.closeMdl();
};
window.saveMdlData = saveMdlData;

export const handleCSVImport = async (file) => {
    console.log('🔄 [Ingestion] Starting Bulk CSV Ingestion Engine...');
    const reader = new FileReader();
    reader.onload = async (e) => {
        const lines = e.target.result.split('\n'); const rawUnits = [], payloadVehicles = [];
        lines.forEach((line, idx) => {
            const parts = line.split(','); if (parts.length < 4 || idx === 0) return;
            const unit_num = parts[0].trim().toUpperCase(), plate = parts[3].trim().toUpperCase();
            const type = parts[2].trim().toUpperCase().includes('BIKE') ? 'BIKE' : 'CAR';
            if (!unit_num || !plate || plate.includes('VEHICLE')) return;
            rawUnits.push({ number: unit_num, car_limit: 1, bike_limit: 1, is_community: false });
            payloadVehicles.push({ unit_number: unit_num, plate, type, is_parking_active: true });
        });

        // Strategic De-duplication of Units
        const payloadUnits = Array.from(new Map(rawUnits.map(item => [item.number, item])).values());

        console.log(`📡 [Ingestion] Parsed ${payloadUnits.length} UNIQUE Units and ${payloadVehicles.length} Vehicles.`);

        if (supabase) {
            console.log('🚀 [Cloud-Sync] Pushing Atomic Unit Batch...');
            const { error: uErr } = await supabase.from('units').upsert(payloadUnits, { onConflict: 'number' });
            if (uErr) return console.error('❌ [Cloud-Sync] Unit Upsert Failed:', uErr);

            console.log('🚀 [Cloud-Sync] Mapping Relational IDs...');
            const { data: allUnits, error: fetchErr } = await supabase.from('units').select('id, number');
            if (fetchErr) return console.error('❌ [Cloud-Sync] Unit Mapping Failed:', fetchErr);

            const finalVehicles = payloadVehicles.map(v => {
                const uMatch = allUnits.find(u => u.number === v.unit_number);
                return uMatch ? { unit_id: uMatch.id, plate: v.plate, type: v.type, is_parking_active: true } : null;
            }).filter(x => x !== null);

            console.log(`🚀 [Cloud-Sync] Pushing ${finalVehicles.length} Vehicles to Fleet Registry...`);
            const { error: vErr } = await supabase.from('vehicles').insert(finalVehicles);
            if (vErr) console.warn('⚠️ [Cloud-Sync] Some vehicles might have failed (possible duplicates):', vErr);

            console.log('✅ [Ingestion] Bulk Operation Successful. Performing Global State Refresh...');
            await pullState(); renderRegistry();
        } else {
            console.warn('⚠️ [Ingestion] Cloud Registry Offline. Ensure VITE_ keys are set in .env.local.');
        }
    };
    reader.readAsText(file);
};
window.handleCSVImport = handleCSVImport;

const HEADER_GREEN = 'FF00FF00';

const thinOutline = { style: 'thin', color: { argb: 'FF000000' } };

const applyReconcileSheetHeader = (ws) => {
    ws.addRow(RECONCILE_EXPORT_HEADERS);
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FF000000' } };
    row.alignment = { vertical: 'middle', horizontal: 'center' };
    for (let c = 1; c <= RECONCILE_EXPORT_HEADERS.length; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_GREEN } };
    }
};

const gridBordersWide = (ws, rowStart, rowEnd, colCount) => {
    for (let r = rowStart; r <= rowEnd; r++) {
        for (let c = 1; c <= colCount; c++) {
            ws.getCell(r, c).border = {
                top: thinOutline,
                left: thinOutline,
                bottom: thinOutline,
                right: thinOutline
            };
        }
    }
};

export const downloadVehicleRegistryXlsx = async () => {
    const ExcelJS = (await import('exceljs')).default;
    const rows = buildReconcileExportRows(portalState.units, portalState.slots);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CommunityHub';
    wb.created = new Date();

    const ws = wb.addWorksheet('Main', { views: [{ state: 'frozen', ySplit: 1 }] });
    applyReconcileSheetHeader(ws);
    rows.forEach((cells) => ws.addRow(cells));
    ws.columns = [
        { width: 10 },
        { width: 8 },
        { width: 12 },
        { width: 12 },
        { width: 16 },
        { width: 16 },
        { width: 14 },
        { width: 14 },
        { width: 14 },
        { width: 12 },
        { width: 18 },
        { width: 18 },
        { width: 12 },
    ];
    const lastRow = 1 + rows.length;
    gridBordersWide(ws, 1, Math.max(lastRow, 1), RECONCILE_EXPORT_HEADERS.length);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const base = (portalState.community?.name || 'vehicle_registry').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'vehicle_registry';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_parking_reconcile.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
};

window.downloadVehicleRegistryXlsx = downloadVehicleRegistryXlsx;
