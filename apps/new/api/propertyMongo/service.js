/**
 * Property-New domain — Mongoose models (property_units, property_slots).
 */
import { randomUUID } from 'node:crypto';
import { badRequest, notFound } from './errors.js';
import { PropertySlot, PropertyUnit } from './models.js';

const SCHEMA = 1;

function normUnit(n) {
    return String(n || '').trim().toUpperCase();
}

function aptFilter(apartmentId) {
    return { apartment_id: apartmentId };
}

function publicUnit(doc) {
    if (!doc) return null;
    const id = String(doc._id);
    return {
        id,
        apartment_id: doc.apartment_id,
        number: doc.number,
        block: doc.block || null,
        bhk: doc.bhk || null,
        area_sqft: doc.area_sqft ?? null,
        car_limit: doc.car_limit ?? 0,
        bike_limit: doc.bike_limit ?? 0,
        occupancy_status: doc.occupancy_status || null,
        notes: doc.notes || null,
        is_community: !!doc.is_community,
        vehicles: (doc.vehicles || []).map((v) => ({
            ...v,
            id: v.id,
            unit_id: id,
            allocation_type: v.allocation_type || 'BASE',
            allocation_target_id: v.allocation_target_id || null,
        })),
        residents: doc.residents || [],
    };
}

function flattenResidents(units = []) {
    const rows = [];
    for (const u of units) {
        for (const r of u.residents || []) {
            rows.push({
                ...r,
                unit_number: r.unit_number || u.number,
            });
        }
    }
    return rows;
}

export async function ensurePropertyIndexes() {
    await PropertyUnit.syncIndexes().catch(() => {});
    await PropertySlot.syncIndexes().catch(() => {});
}

export async function loadPropertyState(apartmentId) {
    const [unitDocs, slotDocs] = await Promise.all([
        PropertyUnit.find(aptFilter(apartmentId)).lean(),
        PropertySlot.find(aptFilter(apartmentId)).lean(),
    ]);
    const units = unitDocs.map(publicUnit);
    const residents = flattenResidents(units);
    const slots = slotDocs.map((s) => {
        const { _id, ...rest } = s;
        const id = rest.id || String(_id);
        let occupant = null;
        let unit_num = null;
        if (rest.assigned_vehicle_id) {
            for (const u of units) {
                const v = (u.vehicles || []).find((veh) => veh.id === rest.assigned_vehicle_id);
                if (v) {
                    occupant = v.plate;
                    unit_num = u.number;
                    break;
                }
            }
        }
        return { ...rest, id, occupant, unit_num };
    });
    return { units, residents, slots };
}

async function getUnitDoc(apartmentId, unitId) {
    return PropertyUnit.findOne({
        apartment_id: apartmentId,
        $or: [{ _id: unitId }, { id: unitId }, { number: normUnit(unitId) }],
    }).lean();
}

export async function saveResident(apartmentId, payload, residentId = null) {
    const unit_number = normUnit(payload.unit_number);
    const full_name = String(payload.full_name || '').trim();
    if (!unit_number || !full_name) throw badRequest('Flat and name are required.');

    if (residentId) {
        await PropertyUnit.updateOne(
            {
                apartment_id: apartmentId,
                'residents.id': residentId,
                number: { $ne: unit_number },
            },
            { $pull: { residents: { id: residentId } }, $set: { updated_at: new Date().toISOString() } },
        );
    }

    const unit = await PropertyUnit.findOne({ apartment_id: apartmentId, number: unit_number }).lean();
    if (!unit) throw notFound(`Flat ${unit_number} not found.`);

    const residents = [...(unit.residents || [])];
    const row = {
        id: residentId || randomUUID(),
        apartment_id: apartmentId,
        unit_number,
        kind: (payload.kind || 'OWNER').toUpperCase(),
        full_name,
        phone: payload.phone?.trim() || null,
        email: payload.email?.trim() || null,
        notes: payload.notes?.trim() || null,
        is_primary: !!payload.is_primary,
        is_residing: (payload.kind || 'OWNER').toUpperCase() === 'TENANT'
            ? true
            : payload.is_residing !== false,
    };

    const idx = residentId ? residents.findIndex((r) => String(r.id) === String(residentId)) : -1;
    if (idx >= 0) residents[idx] = { ...residents[idx], ...row, id: residents[idx].id };
    else residents.push(row);

    await PropertyUnit.updateOne(
        { _id: unit._id },
        { $set: { residents, updated_at: new Date().toISOString() } },
    );
    return { resident: row };
}

export async function deleteResident(apartmentId, residentId) {
    const result = await PropertyUnit.updateOne(
        { apartment_id: apartmentId, 'residents.id': residentId },
        { $pull: { residents: { id: residentId } }, $set: { updated_at: new Date().toISOString() } },
    );
    if (!result.matchedCount) throw notFound('Resident not found.');
    return {};
}

export async function importResidents(apartmentId, rows = [], mode = 'update_listed') {
    if (!Array.isArray(rows) || !rows.length) return { count: 0 };
    const units = await PropertyUnit.find(aptFilter(apartmentId)).lean();
    const byNumber = new Map(units.map((u) => [normUnit(u.number), u]));

    if (mode === 'full_replace') {
        await PropertyUnit.updateMany(
            aptFilter(apartmentId),
            { $set: { residents: [], updated_at: new Date().toISOString() } },
        );
        units.forEach((u) => { u.residents = []; });
    }

    let count = 0;
    const byUnit = new Map();
    rows.forEach((r) => {
        const key = normUnit(r.unitNumber || r.unit_number);
        if (!byUnit.has(key)) byUnit.set(key, []);
        byUnit.get(key).push(r);
    });

    for (const [unitKey, people] of byUnit) {
        const unit = byNumber.get(unitKey);
        if (!unit) continue;
        let residents = [...(unit.residents || [])];
        const unitLabel = unit.number;

        if (mode === 'replace_listed' || mode === 'full_replace') {
            residents = [];
        }

        for (const p of people) {
            const full_name = p.fullName || p.full_name;
            const kind = (p.kind || 'OWNER').toUpperCase();
            const row = {
                id: randomUUID(),
                apartment_id: apartmentId,
                unit_number: unitLabel,
                kind,
                full_name,
                phone: p.phone || null,
                email: p.email || null,
                notes: p.notes || null,
                is_primary: !!(p.is_primary ?? p.isPrimary),
                is_residing: p.is_residing ?? p.isResiding ?? true,
            };
            if (mode === 'update_listed') {
                const existing = residents.find((r) =>
                    String(r.full_name || '').trim().toLowerCase() === String(full_name || '').trim().toLowerCase()
                    && (r.kind || '').toUpperCase() === kind,
                );
                if (existing) {
                    Object.assign(existing, { ...row, id: existing.id });
                } else {
                    residents.push(row);
                }
            } else {
                residents.push(row);
            }
            count += 1;
        }

        await PropertyUnit.updateOne(
            { _id: unit._id },
            { $set: { residents, updated_at: new Date().toISOString() } },
        );
        unit.residents = residents;
    }

    return { count };
}

export async function saveUnit(apartmentId, payload, unitId = null) {
    const number = normUnit(payload.number);
    if (!number && !unitId) throw badRequest('Flat number is required.');

    const patch = {};
    const fields = ['block', 'bhk', 'notes', 'occupancy_status'];
    for (const f of fields) {
        if (payload[f] !== undefined) patch[f] = payload[f] || null;
    }
    if (payload.area_sqft !== undefined) {
        patch.area_sqft = payload.area_sqft === '' || payload.area_sqft == null
            ? null
            : Number(payload.area_sqft);
    }
    if (payload.car_limit !== undefined) patch.car_limit = Number(payload.car_limit) || 0;
    if (payload.bike_limit !== undefined) patch.bike_limit = Number(payload.bike_limit) || 0;
    if (payload.is_community !== undefined) patch.is_community = !!payload.is_community;
    patch.updated_at = new Date().toISOString();

    if (unitId) {
        let doc = await PropertyUnit.findOneAndUpdate(
            { apartment_id: apartmentId, _id: unitId },
            { $set: patch },
            { new: true },
        ).lean();
        if (!doc) {
            doc = await getUnitDoc(apartmentId, unitId);
            if (!doc) throw notFound('Flat not found.');
            await PropertyUnit.updateOne({ _id: doc._id }, { $set: patch });
        }
        return { unit: publicUnit({ ...doc, ...patch }) };
    }

    const existing = await PropertyUnit.findOne({ apartment_id: apartmentId, number }).lean();
    if (existing) throw badRequest(`Flat ${number} already exists.`);

    const created = await PropertyUnit.create({
        _id: randomUUID(),
        apartment_id: apartmentId,
        number,
        block: payload.block || null,
        bhk: payload.bhk || null,
        area_sqft: payload.area_sqft === '' || payload.area_sqft == null ? null : Number(payload.area_sqft),
        car_limit: Number(payload.car_limit) || 0,
        bike_limit: Number(payload.bike_limit) || 0,
        occupancy_status: payload.occupancy_status || null,
        notes: payload.notes || null,
        is_community: false,
        vehicles: [],
        residents: [],
        _schema: SCHEMA,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    });
    return { unit: publicUnit(created.toObject()) };
}

export async function bulkPatchParkingLimits(apartmentId, unitIds, { car_limit, bike_limit } = {}) {
    const ids = [...new Set((unitIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) throw badRequest('Pick at least one flat.');
    const patch = { updated_at: new Date().toISOString() };
    if (car_limit !== undefined) patch.car_limit = Number(car_limit) || 0;
    if (bike_limit !== undefined) patch.bike_limit = Number(bike_limit) || 0;
    if (Object.keys(patch).length === 1) {
        throw badRequest('Enter a car count, a bike count, or both. Leave a field off to keep the current value.');
    }
    const result = await PropertyUnit.updateMany(
        {
            apartment_id: apartmentId,
            $or: [{ _id: { $in: ids } }, { id: { $in: ids } }],
        },
        { $set: patch },
    );
    return { updated: result.modifiedCount, matched: result.matchedCount };
}

export async function deleteUnit(apartmentId, unitIdOrNumber) {
    const doc = await getUnitDoc(apartmentId, unitIdOrNumber);
    if (!doc) throw notFound('Flat not found.');
    await PropertyUnit.deleteOne({ _id: doc._id });
    return {
        unitDeleted: true,
        residentsDeleted: (doc.residents || []).length,
        vehiclesRemoved: (doc.vehicles || []).length,
    };
}

export async function importUnits(apartmentId, { unitRows = [], residents = [], createMissing = true, residentImportMode = 'update_listed' } = {}) {
    const stats = { updated: 0, created: 0, residents: 0, skipped: 0, errors: [] };
    for (const row of unitRows) {
        try {
            const number = normUnit(row.unitNumber || row.number);
            if (!number) continue;
            let unit = await PropertyUnit.findOne({ apartment_id: apartmentId, number }).lean();
            const patch = {};
            if (row.block != null) patch.block = row.block;
            if (row.areaSqft != null || row.area_sqft != null) patch.area_sqft = row.areaSqft ?? row.area_sqft;
            if (row.bhk != null) patch.bhk = row.bhk;
            if (row.carSlots != null || row.car_limit != null) patch.car_limit = row.carSlots ?? row.car_limit;
            if (row.bikeSlots != null || row.bike_limit != null) patch.bike_limit = row.bikeSlots ?? row.bike_limit;
            if (row.occupancyStatus != null || row.occupancy_status != null) {
                patch.occupancy_status = row.occupancyStatus ?? row.occupancy_status;
            }
            if (row.notes != null) patch.notes = row.notes;
            patch.updated_at = new Date().toISOString();

            if (!unit) {
                if (!createMissing) {
                    stats.skipped += 1;
                    stats.errors.push(`${number}: flat not found`);
                    continue;
                }
                await PropertyUnit.create({
                    _id: randomUUID(),
                    apartment_id: apartmentId,
                    number,
                    car_limit: patch.car_limit ?? 1,
                    bike_limit: patch.bike_limit ?? 1,
                    is_community: false,
                    vehicles: [],
                    residents: [],
                    _schema: SCHEMA,
                    created_at: new Date().toISOString(),
                    ...patch,
                });
                stats.created += 1;
            } else if (Object.keys(patch).length) {
                await PropertyUnit.updateOne({ _id: unit._id }, { $set: patch });
                stats.updated += 1;
            } else {
                stats.updated += 1;
            }
        } catch (err) {
            stats.errors.push(`${row.unitNumber || row.number}: ${err.message}`);
        }
    }
    if (residents?.length) {
        const out = await importResidents(apartmentId, residents, residentImportMode);
        stats.residents = out.count;
    }
    return stats;
}

export async function saveVehicle(apartmentId, { unitId, plate, type }, vehicleId = null) {
    const normalizedPlate = String(plate || '').trim().toUpperCase();
    if (!normalizedPlate) throw badRequest('Plate number is required.');
    const vehicleType = type === 'BIKE' ? 'BIKE' : 'CAR';

    const dup = await PropertyUnit.findOne({
        apartment_id: apartmentId,
        'vehicles.plate': normalizedPlate,
        ...(vehicleId ? { 'vehicles.id': { $ne: vehicleId } } : {}),
    }).lean();
    if (dup && !(vehicleId && (dup.vehicles || []).some((v) => v.id === vehicleId && v.plate === normalizedPlate))) {
        const other = (dup.vehicles || []).find((v) => v.plate === normalizedPlate && v.id !== vehicleId);
        if (other) throw badRequest(`Plate ${normalizedPlate} is already registered.`);
    }

    if (vehicleId) {
        const unit = await PropertyUnit.findOne({ apartment_id: apartmentId, 'vehicles.id': vehicleId }).lean();
        if (!unit) throw notFound('Vehicle not found.');
        const vehicles = (unit.vehicles || []).map((v) => (
            v.id === vehicleId ? { ...v, plate: normalizedPlate, type: vehicleType } : v
        ));
        await PropertyUnit.updateOne(
            { _id: unit._id },
            { $set: { vehicles, updated_at: new Date().toISOString() } },
        );
        return { vehicle: vehicles.find((v) => v.id === vehicleId) };
    }

    const unit = await getUnitDoc(apartmentId, unitId);
    if (!unit) throw notFound('Flat not found.');
    const vehicle = {
        id: randomUUID(),
        plate: normalizedPlate,
        type: vehicleType,
        is_parking_active: true,
        allocation_type: 'BASE',
        unit_id: String(unit._id),
    };
    await PropertyUnit.updateOne(
        { _id: unit._id },
        { $push: { vehicles: vehicle }, $set: { updated_at: new Date().toISOString() } },
    );
    return { vehicle };
}

async function clearVehicleSlots(apartmentId, vehicleId) {
    await PropertySlot.updateMany(
        { apartment_id: apartmentId, assigned_vehicle_id: vehicleId },
        { $set: { assigned_vehicle_id: null } },
    );
}

export async function patchVehicle(apartmentId, vehicleId, patch = {}) {
    const unit = await PropertyUnit.findOne({ apartment_id: apartmentId, 'vehicles.id': vehicleId }).lean();
    if (!unit) throw notFound('Vehicle not found.');
    const vehicles = (unit.vehicles || []).map((v) => {
        if (v.id !== vehicleId) return v;
        const next = { ...v };
        if (patch.plate != null) next.plate = String(patch.plate).trim().toUpperCase();
        if (patch.type != null) next.type = patch.type === 'BIKE' ? 'BIKE' : 'CAR';
        if (patch.is_parking_active != null) next.is_parking_active = !!patch.is_parking_active;
        if (patch.allocation_type != null) {
            const alloc = String(patch.allocation_type).toUpperCase();
            next.allocation_type = ['COMMON', 'NEIGHBOR', 'BASE'].includes(alloc) ? alloc : 'BASE';
        }
        if (patch.allocation_target_id !== undefined) {
            next.allocation_target_id = patch.allocation_target_id || null;
        }
        if (next.allocation_type === 'BASE') next.allocation_target_id = null;
        return next;
    });
    const vehicle = vehicles.find((v) => v.id === vehicleId);
    await PropertyUnit.updateOne(
        { _id: unit._id },
        { $set: { vehicles, updated_at: new Date().toISOString() } },
    );

    if (vehicle.allocation_type === 'COMMON' && vehicle.allocation_target_id) {
        await assignVehicleToSlot(apartmentId, vehicle.allocation_target_id, vehicleId);
    } else if (vehicle.allocation_type !== 'COMMON') {
        await clearVehicleSlots(apartmentId, vehicleId);
    }
    return { vehicle };
}

export async function deleteVehicle(apartmentId, vehicleId) {
    await clearVehicleSlots(apartmentId, vehicleId);
    const result = await PropertyUnit.updateOne(
        { apartment_id: apartmentId, 'vehicles.id': vehicleId },
        { $pull: { vehicles: { id: vehicleId } }, $set: { updated_at: new Date().toISOString() } },
    );
    if (!result.matchedCount) throw notFound('Vehicle not found.');
    return {};
}

export async function createPoolSlot(apartmentId, { pool_kind = 'car', name = null } = {}) {
    const kind = pool_kind === 'bike' ? 'bike' : 'car';
    const prefix = kind === 'bike' ? 'BH' : 'EH';
    const existing = await PropertySlot.find(aptFilter(apartmentId)).lean();
    let slotName = name;
    if (!slotName) {
        let n = 1;
        const taken = new Set(existing.map((s) => String(s.name || '').toUpperCase().replace(/-/g, '')));
        while (taken.has(`${prefix}${String(n).padStart(2, '0')}`) || taken.has(`${prefix}${n}`)) n += 1;
        slotName = `${prefix}-${String(n).padStart(2, '0')}`;
    }
    const id = randomUUID();
    const doc = await PropertySlot.create({
        _id: id,
        id,
        apartment_id: apartmentId,
        name: slotName,
        pool_kind: kind,
        assigned_vehicle_id: null,
        created_at: new Date().toISOString(),
    });
    return { slot: { ...doc.toObject(), occupant: null, unit_num: null } };
}

export async function deletePoolSlot(apartmentId, slotId) {
    const slot = await PropertySlot.findOne({
        apartment_id: apartmentId,
        $or: [{ _id: slotId }, { id: slotId }],
    }).lean();
    if (!slot) throw notFound('Slot not found.');
    if (slot.assigned_vehicle_id) throw badRequest('Release the vehicle from this slot before deleting it.');
    await PropertySlot.deleteOne({ _id: slot._id });
    return {};
}

export async function assignVehicleToSlot(apartmentId, slotId, vehicleId) {
    const slot = await PropertySlot.findOne({
        apartment_id: apartmentId,
        $or: [{ _id: slotId }, { id: slotId }],
    }).lean();
    if (!slot) throw notFound('Slot not found.');
    const unit = await PropertyUnit.findOne({ apartment_id: apartmentId, 'vehicles.id': vehicleId }).lean();
    if (!unit) throw notFound('Vehicle not found.');
    const vehicle = (unit.vehicles || []).find((v) => v.id === vehicleId);
    const kind = slot.pool_kind === 'bike' || /^BH/i.test(slot.name || '') ? 'bike' : 'car';
    const isBike = (vehicle.type || 'CAR').toUpperCase() === 'BIKE';
    if (kind === 'bike' && !isBike) throw badRequest('BH slots are for bikes only.');
    if (kind === 'car' && isBike) throw badRequest('EH slots are for cars only.');

    await clearVehicleSlots(apartmentId, vehicleId);
    await PropertySlot.updateOne({ _id: slot._id }, { $set: { assigned_vehicle_id: vehicleId } });
    const vehicles = (unit.vehicles || []).map((v) => (
        v.id === vehicleId
            ? { ...v, allocation_type: 'COMMON', allocation_target_id: String(slot.id || slot._id) }
            : v
    ));
    await PropertyUnit.updateOne(
        { _id: unit._id },
        { $set: { vehicles, updated_at: new Date().toISOString() } },
    );
    return { slotId: String(slot.id || slot._id), vehicleId };
}

export async function releaseSlot(apartmentId, slotId) {
    const slot = await PropertySlot.findOne({
        apartment_id: apartmentId,
        $or: [{ _id: slotId }, { id: slotId }],
    }).lean();
    if (!slot) throw notFound('Slot not found.');
    const vehicleId = slot.assigned_vehicle_id;
    await PropertySlot.updateOne({ _id: slot._id }, { $set: { assigned_vehicle_id: null } });
    if (vehicleId) {
        const unit = await PropertyUnit.findOne({ apartment_id: apartmentId, 'vehicles.id': vehicleId }).lean();
        if (unit) {
            const vehicles = (unit.vehicles || []).map((v) => (
                v.id === vehicleId ? { ...v, allocation_type: 'BASE', allocation_target_id: null } : v
            ));
            await PropertyUnit.updateOne(
                { _id: unit._id },
                { $set: { vehicles, updated_at: new Date().toISOString() } },
            );
        }
    }
    return {};
}

export async function importVehicles(apartmentId, rows = []) {
    let added = 0;
    const errors = [];
    for (const row of rows) {
        try {
            const unit = await PropertyUnit.findOne({
                apartment_id: apartmentId,
                number: normUnit(row.unit_number),
            }).lean();
            if (!unit) {
                errors.push(`${row.unit_number}: flat not found`);
                continue;
            }
            await saveVehicle(apartmentId, {
                unitId: String(unit._id),
                plate: row.plate,
                type: row.type,
            });
            added += 1;
        } catch (err) {
            errors.push(`${row.plate || row.unit_number}: ${err.message}`);
        }
    }
    return { added, errors, total: rows.length };
}
