import { portalState } from '../../store.js';
import { can, assertCan } from '../../capabilities.js';
import { loadPropertyState } from '../loadState.js';
import { propertyFetch } from '../client.js';
import { downloadVehicleRegistryXlsx } from '../../registry.js';
import { effectiveAllocationType, getCommunityPoolSlotForVehicle } from '../../allocation.js';
import { getSlotPoolKind, slotsForPoolKind } from '../../parkingImport.js';

export async function fetchParkingBundle() {
    return loadPropertyState();
}

export function canEditParking() {
    return can('parking.update');
}

export function canEditBaseSlots() {
    return can('parking.base_slots');
}

export function countBaseSlotUsage(unit) {
    let baseCars = 0;
    let baseBikes = 0;
    (unit.vehicles || []).forEach((v) => {
        if (!v.is_parking_active) return;
        if (effectiveAllocationType(v) !== 'BASE') return;
        if ((v.type || 'CAR').toUpperCase() === 'CAR') baseCars += 1;
        else baseBikes += 1;
    });
    const carLimit = unit.car_limit || 0;
    const bikeLimit = unit.bike_limit || 0;
    return {
        baseCars,
        baseBikes,
        freeCars: Math.max(0, carLimit - baseCars),
        freeBikes: Math.max(0, bikeLimit - baseBikes),
        hasFreeCarSlots: carLimit - baseCars > 0,
        hasFreeBikeSlots: bikeLimit - baseBikes > 0,
    };
}

/** Stamp ALLOWED / OVERLIMIT / REALLOCATED / INACTIVE on a copy of unit vehicles. */
export function annotateUnitVehicles(unit) {
    let baseCars = 0;
    let baseBikes = 0;
    const vehicles = (unit.vehicles || []).map((v) => {
        if (!v.is_parking_active) return { ...v, status: 'INACTIVE' };
        const alloc = effectiveAllocationType(v);
        if (alloc === 'COMMON' || alloc === 'NEIGHBOR') return { ...v, status: 'REALLOCATED', allocation: alloc };
        const type = (v.type || 'CAR').toUpperCase();
        if (type === 'CAR') {
            baseCars += 1;
            return { ...v, status: baseCars <= (unit.car_limit || 0) ? 'ALLOWED' : 'OVERLIMIT', allocation: 'BASE' };
        }
        baseBikes += 1;
        return { ...v, status: baseBikes <= (unit.bike_limit || 0) ? 'ALLOWED' : 'OVERLIMIT', allocation: 'BASE' };
    });
    const hasViolation = vehicles.some((v) => v.status === 'OVERLIMIT');
    const overlimit = vehicles.filter((v) => v.status === 'OVERLIMIT');
    const allowed = vehicles.filter((v) => v.status === 'ALLOWED');
    const active = vehicles.filter((v) => v.is_parking_active);
    const dormant = vehicles.filter((v) => !v.is_parking_active);
    let status = 'Empty';
    if (hasViolation) status = 'Violation';
    else if (active.length) status = 'Pass';
    return { ...unit, vehicles, active, allowed, overlimit, dormant, hasViolation, parkingStatus: status };
}

export function computeParkingSummary(units = portalState.units || [], slots = portalState.slots || []) {
    let overlimitCars = 0;
    let overlimitBikes = 0;
    let cars = 0;
    let bikes = 0;
    let baseCapacity = 0;
    let rentals = 0;
    (units || []).forEach((u) => {
        if (u.is_community) return;
        baseCapacity += (u.car_limit || 0) + (u.bike_limit || 0);
        const annotated = annotateUnitVehicles(u);
        annotated.vehicles.forEach((v) => {
            if (!v.is_parking_active) return;
            const type = (v.type || 'CAR').toUpperCase();
            if (type === 'CAR') cars += 1;
            else bikes += 1;
            if (v.status === 'OVERLIMIT') {
                if (type === 'CAR') overlimitCars += 1;
                else overlimitBikes += 1;
            }
            if (effectiveAllocationType(v) === 'NEIGHBOR') rentals += 1;
        });
    });
    const eh = slotsForPoolKind(slots, 'car');
    const bh = slotsForPoolKind(slots, 'bike');
    const ehOcc = eh.filter((s) => s.assigned_vehicle_id || s.occupant).length;
    const bhOcc = bh.filter((s) => s.assigned_vehicle_id || s.occupant).length;
    const active = cars + bikes;
    const occupancyPct = baseCapacity > 0 ? Math.round((active / baseCapacity) * 100) : null;
    return {
        overlimitCars,
        overlimitBikes,
        cars,
        bikes,
        active,
        occupancyPct,
        occupancyLabel: occupancyPct == null ? '—' : `${occupancyPct}%`,
        ehOcc,
        ehTotal: eh.length,
        bhOcc,
        bhTotal: bh.length,
        rentals,
        flats: (units || []).filter((u) => !u.is_community).length,
    };
}

export function parkingSummaryCards(summary) {
    if (!summary) return [];
    return [
        { key: 'all', label: 'Flats', value: summary.flats, tone: 'default', hint: 'All flats with parking allocation' },
        { key: 'OVERLIMIT', label: 'Overlimit cars', value: summary.overlimitCars, tone: 'non-allotable', hint: 'Active cars beyond the flat’s base car slots' },
        { key: 'OVERLIMIT_BIKES', label: 'Overlimit bikes', value: summary.overlimitBikes, tone: 'warn', hint: 'Active bikes beyond the flat’s base bike slots' },
        { key: 'CARS', label: 'Active cars', value: summary.cars, tone: 'owner' },
        { key: 'BIKES', label: 'Active bikes', value: summary.bikes, tone: 'tenant' },
        { key: 'OCC', label: 'Occupancy', value: summary.occupancyLabel, tone: 'default', hint: 'Active vehicles vs total base slots' },
        { key: 'EH', label: 'EH pool', value: `${summary.ehOcc}/${summary.ehTotal}`, tone: 'owner', hint: 'Association-owned car parking rented to flats' },
        { key: 'BH', label: 'BH pool', value: `${summary.bhOcc}/${summary.bhTotal}`, tone: 'tenant', hint: 'Association-owned bike parking rented to flats' },
        { key: 'RENTALS', label: 'Flat rentals', value: summary.rentals, tone: 'vacant', hint: 'Vehicles using another flat’s slot' },
    ];
}

export function listPoolSlots(kind) {
    const rows = slotsForPoolKind(portalState.slots || [], kind);
    return rows.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }));
}

export function firstOpenPoolSlot(kind) {
    return listPoolSlots(kind).find((s) => !s.assigned_vehicle_id && !s.occupant) || null;
}

export function searchPoolCandidates({ kind, q = '', overlimitOnly = true } = {}) {
    const wantBike = kind === 'bike';
    const query = String(q || '').trim().toLowerCase();
    const rows = [];
    (portalState.units || []).forEach((u) => {
        if (u.is_community) return;
        const ann = annotateUnitVehicles(u);
        (ann.vehicles || []).forEach((v) => {
            const isBike = (v.type || 'CAR').toUpperCase() === 'BIKE';
            if (isBike !== wantBike) return;
            if (!v.is_parking_active) return;
            if (effectiveAllocationType(v) === 'COMMON') return;
            const hay = `${v.plate || ''} ${u.number || ''}`.toLowerCase();
            if (query && !hay.includes(query)) return;
            if (!query && overlimitOnly && v.status !== 'OVERLIMIT') return;
            rows.push({
                ...v,
                unit_id: u.id,
                unit_number: u.number,
            });
        });
    });
    rows.sort((a, b) => {
        if (overlimitOnly || !query) {
            const ao = a.status === 'OVERLIMIT' ? 0 : 1;
            const bo = b.status === 'OVERLIMIT' ? 0 : 1;
            if (ao !== bo) return ao - bo;
        }
        return String(a.unit_number).localeCompare(String(b.unit_number), undefined, { numeric: true })
            || String(a.plate).localeCompare(String(b.plate));
    });
    return rows;
}

export function vehiclesOfType(unit, type) {
    const wantBike = type === 'BIKE';
    return sortParkingVehicles(
        (unit?.vehicles || []).filter((v) => ((v.type || 'CAR').toUpperCase() === 'BIKE') === wantBike),
    ).map((row) => row.vehicle);
}

/** Self (base) first, then EH/BH, then neighbor rent. Same plate order within a group. */
export function parkingDisplayRank(vehicle, { incoming = false } = {}) {
    if (incoming) return 2;
    const alloc = effectiveAllocationType(vehicle);
    if (alloc === 'COMMON') return 1;
    if (alloc === 'NEIGHBOR') return 2;
    return 0;
}

export function sortParkingVehicles(vehicles, extras = []) {
    const rows = [
        ...(vehicles || []).map((v) => ({ vehicle: v, incoming: false })),
        ...extras,
    ];
    rows.sort((a, b) => {
        const ra = parkingDisplayRank(a.vehicle, { incoming: a.incoming });
        const rb = parkingDisplayRank(b.vehicle, { incoming: b.incoming });
        if (ra !== rb) return ra - rb;
        return String(a.vehicle.plate || '').localeCompare(String(b.vehicle.plate || ''));
    });
    return rows;
}

export function listFlatRentals() {
    const cards = [];
    (portalState.units || []).forEach((tenant) => {
        (tenant.vehicles || []).forEach((v) => {
            if (!v.is_parking_active) return;
            if (effectiveAllocationType(v) !== 'NEIGHBOR' || !v.allocation_target_id) return;
            const source = (portalState.units || []).find((u) => u.id === v.allocation_target_id);
            cards.push({
                plate: v.plate,
                tenantLabel: tenant.number,
                sourceLabel: source?.number || '?',
                vehicleId: v.id,
                unitId: tenant.id,
            });
        });
    });
    return cards;
}

export function listParkingUnits({ search = '', filter = 'all' } = {}) {
    const q = String(search || '').trim().toLowerCase();
    const rows = (portalState.units || [])
        .filter((u) => !u.is_community)
        .map(annotateUnitVehicles)
        .filter((u) => {
            if (q) {
                const plates = (u.vehicles || []).map((v) => v.plate).join(' ');
                const hay = `${u.number} ${u.block || ''} ${plates}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            const usage = countBaseSlotUsage(u);
            if (filter === 'OVERLIMIT' || filter === 'OVERLIMIT_CARS') {
                return u.vehicles.some((v) => v.status === 'OVERLIMIT' && (filter === 'OVERLIMIT' || (v.type || 'CAR') === 'CAR'));
            }
            if (filter === 'OVERLIMIT_BIKES') return u.vehicles.some((v) => v.status === 'OVERLIMIT' && (v.type || '').toUpperCase() === 'BIKE');
            if (filter === 'UNFILLED') return (u.active || []).length === 0;
            if (filter === 'FREE_SLOTS_CARS') return usage.hasFreeCarSlots;
            if (filter === 'FREE_SLOTS_BIKES') return usage.hasFreeBikeSlots;
            if (filter === 'EH' || filter === 'BH') {
                const kind = filter === 'EH' ? 'car' : 'bike';
                return (u.active || []).some((v) => {
                    if (effectiveAllocationType(v) !== 'COMMON') return false;
                    const slot = (portalState.slots || []).find((s) => s.id === v.allocation_target_id);
                    return getSlotPoolKind(slot) === kind;
                });
            }
            if (filter === 'RENTALS') {
                return (u.active || []).some((v) => effectiveAllocationType(v) === 'NEIGHBOR');
            }
            if (filter === 'CARS') return (u.active || []).some((v) => (v.type || 'CAR') === 'CAR');
            if (filter === 'BIKES') return (u.active || []).some((v) => (v.type || '').toUpperCase() === 'BIKE');
            return true;
        })
        .sort((a, b) => {
            if (filter === 'OVERLIMIT' || filter === 'OVERLIMIT_CARS' || filter === 'OVERLIMIT_BIKES') {
                return (b.hasViolation ? 1 : 0) - (a.hasViolation ? 1 : 0)
                    || String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
            }
            return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
        });
    return rows;
}

export function listUnitOptions() {
    return (portalState.units || [])
        .filter((u) => !u.is_community)
        .map((u) => ({ id: u.id, number: u.number }))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

export function poolSlotLabel(vehicle, { incoming = false } = {}) {
    const alloc = effectiveAllocationType(vehicle);
    if (alloc === 'COMMON') {
        const slot = getCommunityPoolSlotForVehicle(vehicle);
        return slot?.name ? slot.name : 'EH/BH';
    }
    if (alloc === 'NEIGHBOR') {
        if (incoming) {
            const owner = (portalState.units || []).find((u) => u.id === vehicle.unit_id);
            return owner ? owner.number : 'slot';
        }
        const src = (portalState.units || []).find((u) => u.id === vehicle.allocation_target_id);
        return src ? `rented · ${src.number}` : 'rented';
    }
    return '';
}

/** Vehicles on other flats that rent a base slot from this flat. */
export function listIncomingRentals(unitId) {
    const rows = [];
    (portalState.units || []).forEach((u) => {
        if (u.id === unitId || u.is_community) return;
        (u.vehicles || []).forEach((v) => {
            if (!v.is_parking_active) return;
            if (effectiveAllocationType(v) !== 'NEIGHBOR') return;
            if (String(v.allocation_target_id) !== String(unitId)) return;
            rows.push({ ...v, unit_id: u.id, owner_number: u.number });
        });
    });
    return rows;
}

/** Flats that still have a free base car/bike slot after own base use and incoming rentals. */
export function vacantHostFlats(type) {
    const wantBike = type === 'BIKE';
    return (portalState.units || [])
        .filter((u) => !u.is_community)
        .map(annotateUnitVehicles)
        .map((u) => {
            const usage = countBaseSlotUsage(u);
            const incoming = listIncomingRentals(u.id).filter((v) => (
                ((v.type || 'CAR').toUpperCase() === 'BIKE') === wantBike
            )).length;
            const free = (wantBike ? usage.freeBikes : usage.freeCars) - incoming;
            return { id: u.id, number: u.number, free };
        })
        .filter((u) => u.free > 0)
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

export async function saveVehicle({ unitId, plate, type }, existing = null) {
    assertCan('parking.update');
    if (existing) {
        await propertyFetch(`/api/property/vehicles/${encodeURIComponent(existing.id)}`, {
            method: 'PATCH',
            body: { plate, type },
        });
    } else {
        await propertyFetch('/api/property/vehicles', {
            method: 'POST',
            body: { unitId, plate, type },
        });
    }
    await loadPropertyState();
}

export async function setVehicleActive(unitId, vehicleId, active) {
    assertCan('parking.update');
    await propertyFetch(`/api/property/vehicles/${encodeURIComponent(vehicleId)}`, {
        method: 'PATCH',
        body: { is_parking_active: active },
    });
    await loadPropertyState();
}

export async function removeVehicle(unitId, vehicleId) {
    assertCan('parking.delete');
    await propertyFetch(`/api/property/vehicles/${encodeURIComponent(vehicleId)}`, {
        method: 'DELETE',
    });
    await loadPropertyState();
}

export async function setVehicleAllocation(vehicleId, { allocation_type, allocation_target_id = null }) {
    assertCan('parking.update');
    await propertyFetch(`/api/property/vehicles/${encodeURIComponent(vehicleId)}`, {
        method: 'PATCH',
        body: { allocation_type, allocation_target_id },
    });
    await loadPropertyState();
}

export async function addPoolSlot(pool_kind) {
    assertCan('parking.update');
    await propertyFetch('/api/property/slots', { method: 'POST', body: { pool_kind } });
    await loadPropertyState();
}

export async function deletePoolSlot(slotId) {
    assertCan('parking.delete');
    await propertyFetch(`/api/property/slots/${encodeURIComponent(slotId)}`, { method: 'DELETE' });
    await loadPropertyState();
}

export async function assignPoolSlot(slotId, vehicleId) {
    assertCan('parking.update');
    await propertyFetch(`/api/property/slots/${encodeURIComponent(slotId)}/assign`, {
        method: 'POST',
        body: { vehicleId },
    });
    await loadPropertyState();
}

export async function releasePoolSlot(slotId) {
    assertCan('parking.update');
    await propertyFetch(`/api/property/slots/${encodeURIComponent(slotId)}/release`, { method: 'POST', body: {} });
    await loadPropertyState();
}

export async function saveUnitParkingLimits(unitId, { car_limit, bike_limit }, { reload = true } = {}) {
    assertCan('parking.base_slots');
    const body = {};
    if (car_limit !== undefined) body.car_limit = Number(car_limit) || 0;
    if (bike_limit !== undefined) body.bike_limit = Number(bike_limit) || 0;
    if (!Object.keys(body).length) throw new Error('Nothing to update.');
    await propertyFetch(`/api/property/units/${encodeURIComponent(unitId)}`, {
        method: 'PATCH',
        body,
    });
    if (reload) await loadPropertyState();
}

export async function saveUnitParkingLimitsBulk(unitIds, patch) {
    assertCan('parking.base_slots');
    const ids = [...new Set((unitIds || []).filter(Boolean))];
    if (!ids.length) throw new Error('Pick at least one flat.');
    const body = { unitIds: ids };
    if (patch.car_limit !== undefined) body.car_limit = patch.car_limit;
    if (patch.bike_limit !== undefined) body.bike_limit = patch.bike_limit;
    if (body.car_limit === undefined && body.bike_limit === undefined) {
        throw new Error('Enter a car count, a bike count, or both. Leave a field blank to keep the current value.');
    }
    const json = await propertyFetch('/api/property/units/parking-limits', {
        method: 'POST',
        body,
    });
    await loadPropertyState();
    return { updated: json.updated ?? ids.length, matched: json.matched };
}

export async function exportParkingExcel() {
    await downloadVehicleRegistryXlsx();
}

export async function importParkingCsv(file) {
    assertCan('parking.update');
    const text = await file.text();
    const lines = text.split('\n');
    const payloadVehicles = [];
    lines.forEach((line, idx) => {
        const parts = line.split(',');
        if (parts.length < 4 || idx === 0) return;
        const unit_num = parts[0].trim().toUpperCase();
        const plate = parts[3].trim().toUpperCase();
        const type = parts[2].trim().toUpperCase().includes('BIKE') ? 'BIKE' : 'CAR';
        if (!unit_num || !plate || plate.includes('VEHICLE')) return;
        payloadVehicles.push({ unit_number: unit_num, plate, type });
    });
    if (!payloadVehicles.length) throw new Error('No vehicle rows found. Expected CSV columns including flat and plate.');
    const json = await propertyFetch('/api/property/vehicles/import', {
        method: 'POST',
        body: { rows: payloadVehicles },
    });
    await loadPropertyState();
    return {
        added: json.added || 0,
        errors: json.errors || [],
        total: json.total || payloadVehicles.length,
    };
}

export function unassignedVehiclesForPool(kind) {
    const rows = [];
    (portalState.units || []).forEach((u) => {
        if (u.is_community) return;
        (u.vehicles || []).forEach((v) => {
            const isBike = (v.type || 'CAR').toUpperCase() === 'BIKE';
            if (kind === 'bike' && !isBike) return;
            if (kind === 'car' && isBike) return;
            const taken = (portalState.slots || []).some((s) => s.assigned_vehicle_id === v.id);
            if (taken) return;
            rows.push({ ...v, unit_id: u.id, unit_number: u.number });
        });
    });
    return rows;
}
