/**
 * Sentry Registry Engine (Relational)
 */
import { portalState, persist, supabase, pullState } from './store.js';

export const processAnalytics = () => {
    let total = 0, allowed = 0, overlimit = 0, tc = 0, tb = 0;
    portalState.units.forEach(u => {
        let lc = 0, lb = 0;
        u.vehicles.forEach(v => {
            total++;
            if (!v.is_parking_active) {
                v.status = 'INACTIVE';
                return;
            }

            // Count every active vehicle against unit entitlement.
            // If excess vehicles are moved to COMMUNITY/NEIGHBOR allocations,
            // mark them as reallocated (compliant but visibly differentiated).
            const allocType = (v.allocation_type || 'BASE').toUpperCase();
            if (v.type === 'CAR') {
                tc++;
                lc++;
                if (lc <= u.car_limit) v.status = 'ALLOWED';
                else v.status = allocType === 'BASE' ? 'OVERLIMIT' : 'REALLOCATED';
            } else {
                tb++;
                lb++;
                if (lb <= u.bike_limit) v.status = 'ALLOWED';
                else v.status = allocType === 'BASE' ? 'OVERLIMIT' : 'REALLOCATED';
            }

            if (v.status === 'ALLOWED' || v.status === 'REALLOCATED') allowed++;
            else overlimit++;
        });
    });
    const k = (id) => document.getElementById(id);
    if (k('kpi-total')) {
        k('kpi-total').textContent = total; k('kpi-allowed').textContent = allowed;
        k('kpi-dormant').textContent = overlimit; k('kpi-cars').textContent = tc;
        k('kpi-bikes').textContent = tb; k('complex-title').textContent = portalState.community.name;
    }

    // Mobile summary badges (optional)
    if (k('ms-total')) k('ms-total').textContent = total;
    if (k('ms-ok')) k('ms-ok').textContent = allowed;
    if (k('ms-bad')) k('ms-bad').textContent = overlimit;
};

export const renderRegistry = () => {
    processAnalytics();
    const list = document.getElementById('registry-items'); if (!list) return; list.innerHTML = '';
    const search = document.getElementById('apt-search').value.toLowerCase();
    const sort = document.getElementById('registry-sort').value;
    const filter = document.body.dataset.registryFilter || 'ALL';
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 520px)').matches;

    let filtered = portalState.units.filter(u => {
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
        if (filter === 'COMPLIANT') return hasCompliant && !hasOverlimit;
        if (filter === 'CARS') return activeCars.length > 0;
        if (filter === 'BIKES') return activeBikes.length > 0;
        if (filter === 'UNFILLED') return activeFleet.length === 0;
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

        if (isMobile) {
            const card = document.createElement('details');
            card.className = `unit-card ${hasViolation ? 'unit-card--violation' : ''}`;
            card.innerHTML = `
              <summary class="unit-card__summary">
                <div class="unit-card__title">
                  <div class="unit-card__unit">Unit ${u.number}</div>
                  <div class="unit-card__meta">
                    <span class="unit-card__usage"><i class="fa-solid fa-car"></i> ${carUsage}</span>
                    <span class="unit-card__usage"><i class="fa-solid fa-motorcycle"></i> ${bikeUsage}</span>
                    <span class="unit-card__dot">•</span>
                    <span>${activeFleet.length} active</span>
                    <span class="unit-card__dot">•</span>
                    <span>${dormantFleet.length} dormant</span>
                  </div>
                </div>
                <div class="unit-card__right">
                  <div class="status-pill ${hasViolation ? 'danger' : (activeFleet.length > 0 ? 'success' : 'warning')}"><span>${hasViolation ? 'Violation' : (activeFleet.length > 0 ? 'Pass' : 'Empty')}</span></div>
                  <button class="btn btn-outline unit-card__manage" type="button" aria-label="Manage unit"><i class="fa-solid fa-gear"></i></button>
                </div>
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
                        const alloc = ((v.allocation_type || 'BASE').toUpperCase());
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
                        .filter(v => (v.allocation_type || 'BASE').toUpperCase() === 'COMMON')
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
            .filter(v => (v.allocation_type || 'BASE').toUpperCase() === 'COMMON')
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
            return `<div class="v-tag ${(v.type || 'CAR').toLowerCase()} ${(v.status || 'ALLOWED').toLowerCase()}">
                <i class="fa-solid ${icon} vehicle-type-icon ${iconTypeClass}" style="font-size: 0.70rem; margin-right: 0.35rem; opacity: 0.95;"></i>
                <span>${v.plate}</span>
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
};

export const renderPoolGrid = () => {
    const grid = document.getElementById('pool-grid'); if (!grid) return; grid.innerHTML = '';
    let occupied = 0;
    portalState.slots.forEach(s => {
        if (s.occupant) occupied++;
        const d = document.createElement('div');
        d.className = `pool-slot ${s.occupant ? 'occupied' : 'empty'}`;
        d.onclick = () => window.openPool(s.id);
        d.innerHTML = `
            <div class="slot-name">${s.name}</div>
            <div class="slot-occupant">${s.occupant || 'VACANT'}</div>
            <div class="slot-unit">${s.unit_num || '--'}</div>
        `;
        grid.appendChild(d);
    });

    const k = (id) => document.getElementById(id);
    if (k('ms-pool-total')) k('ms-pool-total').textContent = portalState.slots.length;
    if (k('ms-pool-occ')) k('ms-pool-occ').textContent = occupied;
};

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
            await supabase.from('parking_slots').update({ assigned_vehicle_id: vehicle.id }).eq('id', slotId);
            document.getElementById('pool-modal').classList.remove('active');
            await pullState();
            renderRegistry();
        };
        list.appendChild(row);
    });
};

export const openPool = (id) => {
    const s = portalState.slots.find(x => x.id === id); if (!s) return;
    document.getElementById('pool-mdl-title').textContent = `Slot ${s.name}`;
    document.getElementById('pool-mdl-status').textContent = s.occupant ? 'Active Assignment' : 'Available for Allocation';

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
        await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('id', id);
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
    renderMdlList(u);
    document.getElementById('apt-modal').classList.add('active');
};
window.openMdl = openMdl;

export const closeMdl = () => document.getElementById('apt-modal').classList.remove('active');
window.closeMdl = closeMdl;

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
        const alloc = v.allocation_type || 'BASE';
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
            <b>${v.plate}</b>
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
        c.appendChild(d);
    });
};

window.updateAllocation = async (vid, uid, type) => {
    if (!supabase) return;
    await supabase.from('vehicles').update({ allocation_type: type, allocation_target_id: null }).eq('id', vid);
    if (type !== 'COMMON') {
        // Clear slot association if moved away from COMMON
        await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('assigned_vehicle_id', vid);
    }
    await pullState(); processAnalytics(); renderRegistry(); openMdl(uid);
};

window.updateAllocationTarget = async (vid, uid, targetId) => {
    if (!supabase || !targetId) return;
    const v = portalState.units.flatMap(ux => ux.vehicles).find(veh => veh.id === vid);
    await supabase.from('vehicles').update({ allocation_target_id: targetId }).eq('id', vid);

    if (v.allocation_type === 'COMMON') {
        // Update parking_slots table as well for the grid visual
        await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('assigned_vehicle_id', vid);
        await supabase.from('parking_slots').update({ assigned_vehicle_id: vid }).eq('id', targetId);
    }
    await pullState(); processAnalytics(); renderRegistry(); openMdl(uid);
};

window.delVeh = async (uid, vid) => {
    if (supabase) { const { error } = await supabase.from('vehicles').delete().eq('id', vid); if (!error) { await pullState(); processAnalytics(); renderRegistry(); openMdl(uid); } }
};

window.toggleVehicleActive = async (uid, vid, isActive) => {
    if (!supabase) return;
    const { error } = await supabase.from('vehicles').update({ is_parking_active: isActive }).eq('id', vid);
    if (!error) {
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
    await supabase.from('units').update({ car_limit, bike_limit }).eq('id', u.id);

    // 2. Insert New Vehicle
    if (plate) await supabase.from('vehicles').insert({ apartment_id, unit_id: u.id, plate, type, is_parking_active: true });

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
const HEADER_YELLOW = 'FFFFFF00';

const vehicleWheelType = (v) => {
    const t = (v.type || 'CAR').toUpperCase();
    return t === 'CAR' ? 'FOUR_WHEELER' : 'TWO_WHEELER';
};

const vehicleBrandField = (v) => (v.brand ?? v.make ?? v.vehicle_brand ?? '').toString().trim();

const buildParkingRow = (u, v) => [
    'PARKING',
    u.number,
    vehicleWheelType(v),
    (v.plate || '').toString().trim(),
    vehicleBrandField(v)
];

/**
 * Active vehicles → Main (compliant) vs overlimit; dormant → separate sheet.
 */
const collectRegistryExportRows = () => {
    processAnalytics();
    const compliant = [];
    const overlimit = [];
    const dormant = [];
    portalState.units.forEach((u) => {
        u.vehicles.forEach((v) => {
            if (!v.is_parking_active) {
                dormant.push(buildParkingRow(u, v));
                return;
            }
            const row = buildParkingRow(u, v);
            if (v.status === 'OVERLIMIT') overlimit.push(row);
            else compliant.push(row);
        });
    });
    return { compliant, overlimit, dormant };
};

const applyRegistrySheetHeader = (ws) => {
    const headers = ['Parking Area', 'Parking Slot Name', 'Vehicle Type', 'Vehicle Number', 'Vehicle Brand'];
    ws.addRow(headers);
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FF000000' } };
    row.alignment = { vertical: 'middle', horizontal: 'center' };
    for (let c = 1; c <= 4; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_GREEN } };
    }
    row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_YELLOW } };
};

const thinOutline = { style: 'thin', color: { argb: 'FF000000' } };

const gridBorders = (ws, rowStart, rowEnd) => {
    for (let r = rowStart; r <= rowEnd; r++) {
        for (let c = 1; c <= 5; c++) {
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
    const { compliant, overlimit, dormant } = collectRegistryExportRows();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CommunityHub';
    wb.created = new Date();

    const mkSheet = (name, rows) => {
        const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
        applyRegistrySheetHeader(ws);
        rows.forEach((cells) => ws.addRow(cells));
        ws.columns = [
            { width: 14 },
            { width: 18 },
            { width: 16 },
            { width: 18 },
            { width: 16 }
        ];
        const lastRow = 1 + rows.length;
        gridBorders(ws, 1, Math.max(lastRow, 1));
    };

    mkSheet('Main', compliant);
    mkSheet('overlimit', overlimit);
    mkSheet('dormant', dormant);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const base = (portalState.community?.name || 'vehicle_registry').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'vehicle_registry';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_parking_export.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
};

window.downloadVehicleRegistryXlsx = downloadVehicleRegistryXlsx;
