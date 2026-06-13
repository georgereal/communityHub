/**
 * Parking registry Excel reconcile import (Flat / Vehicle_Number format).
 */
import { portalState, supabase, pullState } from './store.js';

const COL_ALIASES = {
  flat: ['flat', 'unit', 'unit_no', 'unit number'],
  block: ['block'],
  parkingNo: ['parking_no', 'parking no', 'parking slot', 'parking_slot', 'slot'],
  parkingArea: ['parking_area', 'parking area'],
  twoWheelerCount: ['two_wheeler_count', 'two wheeler count', 'bike_limit', 'bike limit', 'two_wheeler'],
  fourWheelerCount: ['four_wheeler_count', 'four wheeler count', 'car_limit', 'car limit', 'four_wheeler'],
  vehicleType: ['vehicle_type', 'vehicle type', 'type'],
  vehicleNumber: ['vehicle_number', 'vehicle number', 'plate', 'registration'],
  parkingSticker: ['parking_sticker', 'parking sticker', 'sticker'],
  updatedOn: ['updated_on', 'updated on'],
  rfidTag: ['rfid_tag', 'rfid tag'],
  rfidNumber: ['rfid_number', 'rfid number', 'rfid'],
  updatedBy: ['updated_by', 'updated by'],
};

const normHeader = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ');

const normPlate = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');

const isPlaceholderPlate = (plate) => {
  if (!plate) return true;
  const p = plate.toLowerCase();
  return p.includes('not assigned') || p === '—' || p === '-' || p === 'n/a' || p === 'na';
};

/** Normalize RFID/sticker cells; "RFID Not Assigned" → null unless keepEmpty. */
export const normalizeRegistryMetaField = (raw, { treatNotAssignedAsNull = true } = {}) => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (treatNotAssignedAsNull && s.toLowerCase().includes('not assigned')) return null;
  return s;
};

export function vehicleRegistryFieldsFromMeta(meta) {
  const fields = {};
  const sticker = normalizeRegistryMetaField(meta?.parkingSticker);
  const rfidTag = normalizeRegistryMetaField(meta?.rfidTag);
  const rfidNumber = normalizeRegistryMetaField(meta?.rfidNumber);
  const updatedOn = normalizeRegistryMetaField(meta?.updatedOn, { treatNotAssignedAsNull: false });
  const updatedBy = normalizeRegistryMetaField(meta?.updatedBy, { treatNotAssignedAsNull: false });
  if (sticker != null) fields.parking_sticker = sticker;
  if (rfidTag != null) fields.rfid_tag = rfidTag;
  if (rfidNumber != null) fields.rfid_number = rfidNumber;
  if (updatedOn != null) fields.registry_updated_on = updatedOn;
  if (updatedBy != null) fields.registry_updated_by = updatedBy;
  return fields;
}

export const RECONCILE_EXPORT_HEADERS = [
  'Flat',
  'Block',
  'Parking_No',
  'Parking_Area',
  'two_wheeler_count',
  'four_wheeler_count',
  'Vehicle_Type',
  'Vehicle_Number',
  'Parking_Sticker',
  'Updated_On',
  'RFID_Tag',
  'RFID_Number',
  'Updated_By',
];

export function deriveBlockFromFlat(flat) {
  const m = String(flat ?? '').match(/^([A-Za-z]+)-/);
  return m ? m[1].toUpperCase() : '';
}

export function parkingNoForVehicle(unit, vehicle, slots, allUnits = portalState.units) {
  const alloc = (vehicle.allocation_type || 'BASE').toUpperCase();
  if (alloc === 'COMMON' && vehicle.allocation_target_id) {
    const slot = slots.find((s) => s.id === vehicle.allocation_target_id);
    if (slot?.name) return normParkingNo(slot.name);
  }
  if (alloc === 'NEIGHBOR' && vehicle.allocation_target_id) {
    const neighbor = (allUnits || []).find((u) => u.id === vehicle.allocation_target_id);
    if (neighbor?.number) return normParkingNo(neighbor.number);
  }
  return normParkingNo(unit.number);
}

export function displayRfidExportValue(value) {
  const s = String(value ?? '').trim();
  return s || 'RFID Not Assigned';
}

export function buildReconcileExportRows(units, slots) {
  const rows = [];
  units.forEach((u) => {
    u.vehicles.forEach((v) => {
      rows.push([
        u.number,
        deriveBlockFromFlat(u.number),
        parkingNoForVehicle(u, v, slots, units),
        'PARKING',
        u.bike_limit ?? 0,
        u.car_limit ?? 0,
        (v.type || 'CAR').toUpperCase() === 'CAR' ? 'FOUR_WHEELER' : 'TWO_WHEELER',
        v.plate,
        v.parking_sticker ?? '',
        v.registry_updated_on ?? '',
        displayRfidExportValue(v.rfid_tag),
        displayRfidExportValue(v.rfid_number),
        v.registry_updated_by ?? '',
      ]);
    });
  });
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[7]).localeCompare(String(b[7])));
  return rows;
}

const mapVehicleType = (raw, parkingNo = '') => {
  const t = String(raw ?? '').trim().toUpperCase();
  if (t.includes('TWO') || t.includes('BIKE') || t.includes('2')) return 'BIKE';
  if (t.includes('FOUR') || t.includes('CAR') || t.includes('4')) return 'CAR';
  const p = String(parkingNo ?? '').trim().toUpperCase().replace(/-/g, '');
  if (/^BH\d/.test(p)) return 'BIKE';
  if (/^EH\d/.test(p)) return 'CAR';
  return 'CAR';
};

const parseIntSafe = (v, fallback = 0) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function resolveColumns(headerRow) {
  const idx = {};
  headerRow.eachCell((cell, colNumber) => {
    const h = normHeader(cell.value);
    if (!h) return;
    for (const [key, aliases] of Object.entries(COL_ALIASES)) {
      if (idx[key] != null) continue;
      if (aliases.some((a) => h === a || h.includes(a))) idx[key] = colNumber;
    }
  });
  if (idx.flat == null || idx.vehicleNumber == null) {
    throw new Error('Could not find required columns "Flat" and "Vehicle_Number" in the spreadsheet.');
  }
  return idx;
}

function cellText(row, col) {
  if (col == null) return '';
  const cell = row.getCell(col);
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object' && v.text != null) return String(v.text).trim();
  if (typeof v === 'object' && v.result != null) return String(v.result).trim();
  return String(v).trim();
}

/**
 * @returns {{ units: Map<string, { number: string, car_limit: number, bike_limit: number }>, vehicles: Array<{ unitNumber: string, plate: string, type: string, parkingNo: string, meta: Record<string,string> }>, rowCount: number }}
 */
export function parseParkingWorksheet(ws) {
  let headerRowNum = 0;
  let cols = null;
  for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
    const row = ws.getRow(r);
    const texts = [];
    row.eachCell({ includeEmpty: false }, (c) => texts.push(normHeader(c.value)));
    if (texts.some((t) => t.includes('flat')) && texts.some((t) => t.includes('vehicle'))) {
      headerRowNum = r;
      cols = resolveColumns(row);
      break;
    }
  }
  if (!cols) throw new Error('Header row not found. Expected columns like Flat, Vehicle_Number, Vehicle_Type.');

  const units = new Map();
  const vehicles = [];
  let rowCount = 0;

  for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const flat = cellText(row, cols.flat).toUpperCase();
    if (!flat) continue;

    rowCount++;
    const carLimit = parseIntSafe(cellText(row, cols.fourWheelerCount), 1);
    const bikeLimit = parseIntSafe(cellText(row, cols.twoWheelerCount), 1);
    const prev = units.get(flat);
    units.set(flat, {
      number: flat,
      car_limit: prev ? Math.max(prev.car_limit, carLimit) : carLimit,
      bike_limit: prev ? Math.max(prev.bike_limit, bikeLimit) : bikeLimit,
    });

    const plate = normPlate(cellText(row, cols.vehicleNumber));
    if (isPlaceholderPlate(plate)) continue;

    vehicles.push({
      unitNumber: flat,
      plate,
      type: mapVehicleType(cellText(row, cols.vehicleType), cellText(row, cols.parkingNo)),
      parkingNo: cellText(row, cols.parkingNo).toUpperCase() || flat,
      meta: {
        block: cellText(row, cols.block),
        parkingArea: cellText(row, cols.parkingArea),
        parkingSticker: cellText(row, cols.parkingSticker),
        updatedOn: cellText(row, cols.updatedOn),
        rfidTag: cellText(row, cols.rfidTag),
        rfidNumber: cellText(row, cols.rfidNumber),
        updatedBy: cellText(row, cols.updatedBy),
      },
    });
  }

  if (units.size === 0) throw new Error('No data rows found below the header.');
  return { units, vehicles, rowCount };
}

export async function parseParkingExcelFile(file) {
  const ExcelJS = (await import('exceljs')).default;
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws =
    wb.getWorksheet('Main') ||
    wb.worksheets.find((s) => s.rowCount > 1) ||
    wb.worksheets[0];
  if (!ws) throw new Error('Workbook has no worksheets.');
  return parseParkingWorksheet(ws);
}

/**
 * Build a human-readable preview summary before apply.
 */
export function buildImportPreview(parsed, mode) {
  const apartmentId = portalState.access?.activeApartmentId;
  const existingPlates = new Map();
  portalState.units.forEach((u) => {
    u.vehicles.forEach((v) => {
      if (v.plate) existingPlates.set(normPlate(v.plate), { unit: u.number, id: v.id });
    });
  });

  const unitNumbers = new Set(parsed.units.keys());
  const existingUnits = new Set(portalState.units.map((u) => String(u.number).toUpperCase()));

  let newUnits = 0;
  let updatedUnits = 0;
  unitNumbers.forEach((n) => {
    if (existingUnits.has(n)) updatedUnits++;
    else newUnits++;
  });

  let newVehicles = 0;
  let updatedVehicles = 0;
  let withSticker = 0;
  let withRfid = 0;
  let rentedParking = 0;
  let carCount = 0;
  let bikeCount = 0;
  const seenPlates = new Set();
  parsed.vehicles.forEach((v) => {
    if (seenPlates.has(v.plate)) return;
    seenPlates.add(v.plate);

    const ex = existingPlates.get(v.plate);
    if (!ex) newVehicles++;
    else updatedVehicles++;

    if ((v.type || 'CAR').toUpperCase() === 'CAR') carCount++;
    else bikeCount++;

    const fields = vehicleRegistryFieldsFromMeta(v.meta);
    if (fields.parking_sticker) withSticker++;
    if (fields.rfid_number || fields.rfid_tag) withRfid++;
    if (slotMatchKey(v.parkingNo) !== slotMatchKey(v.unitNumber)) rentedParking++;
  });

  const existingVehicleCount = portalState.units.reduce((n, u) => n + u.vehicles.length, 0);
  const removedVehicles =
    mode === 'overwrite' ? Math.max(0, existingVehicleCount - seenPlates.size) : 0;

  return {
    mode,
    rowCount: parsed.rowCount,
    unitCount: unitNumbers.size,
    vehicleCount: seenPlates.size,
    carCount,
    bikeCount,
    newUnits,
    updatedUnits,
    newVehicles,
    updatedVehicles,
    removedVehicles,
    withSticker,
    withRfid,
    rentedParking,
    apartmentId,
  };
}

async function upsertUnits(apartmentId, unitsMap) {
  const { data: existing, error: fetchErr } = await supabase
    .from('units')
    .select('id, number')
    .eq('apartment_id', apartmentId);
  if (fetchErr) throw new Error(`Unit lookup failed: ${fetchErr.message}`);

  for (const u of unitsMap.values()) {
    const exId = existing?.find((row) => slotMatchKey(row.number) === slotMatchKey(u.number))?.id;
    if (exId) {
      const { error } = await supabase
        .from('units')
        .update({ car_limit: u.car_limit, bike_limit: u.bike_limit })
        .eq('id', exId);
      if (error) throw new Error(`Unit update failed (${u.number}): ${error.message}`);
    } else {
      const { data, error } = await supabase
        .from('units')
        .insert({
          apartment_id: apartmentId,
          number: u.number,
          car_limit: u.car_limit,
          bike_limit: u.bike_limit,
          is_community: false,
        })
        .select('id, number')
        .single();
      if (error) throw new Error(`Unit insert failed (${u.number}): ${error.message}`);
    }
  }

  const { data: allUnits, error: allErr } = await supabase
    .from('units')
    .select('id, number')
    .eq('apartment_id', apartmentId);
  if (allErr) throw new Error(`Unit mapping failed: ${allErr.message}`);
  return buildUnitIdLookup(allUnits || []);
}

/** Uppercase, trim, collapse spaces — keeps hyphens (D-003, EH-01). */
export function normParkingNo(v) {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Loose key for pool slot matching: EH-01, EH01, eh-01 → EH01.
 * Hyphens are ignored so Excel and DB naming stay in sync.
 */
export function slotMatchKey(v) {
  return normParkingNo(v).replace(/-/g, '');
}

/** Name for a new pool slot — follow EH-01 style when the community pool already uses it. */
export function formatNewPoolSlotName(matchKey, existingSlots = []) {
  const m = matchKey.match(/^EH(\d+)$/i);
  if (!m) return matchKey;

  const usesHyphen = (existingSlots || []).some((s) => /^EH-/i.test(String(s.name)));
  const num = m[1].padStart(2, '0');
  return usesHyphen ? `EH-${num}` : `EH${num}`;
}

/** EH community car pool (EH-01, EH01, …). */
export function isEhCommunitySlotName(name) {
  return /^EH-?\d+$/i.test(String(name ?? '').trim().replace(/\s/g, ''));
}

/** BH community bike pool (BH-01, BH01, …). */
export function isBikeCommunitySlotName(name) {
  return /^BH-?\d+$/i.test(String(name ?? '').trim().replace(/\s/g, ''));
}

export function isCommunityPoolSlotName(name) {
  return isEhCommunitySlotName(name) || isBikeCommunitySlotName(name);
}

/** @param {{ name?: string, pool_kind?: string }} slot */
export function getSlotPoolKind(slot) {
  const k = String(slot?.pool_kind ?? '').toLowerCase();
  if (k === 'car' || k === 'bike') return k;
  if (isBikeCommunitySlotName(slot?.name)) return 'bike';
  if (isEhCommunitySlotName(slot?.name)) return 'car';
  return null;
}

export function slotsForPoolKind(slots, kind) {
  return (slots || []).filter((s) => getSlotPoolKind(s) === kind);
}

/** Next auto name EH-11 / BH-03 following existing hyphen style. */
export function nextCommunityPoolSlotName(kind, slots) {
  const prefix = kind === 'bike' ? 'BH' : 'EH';
  const kindSlots = slotsForPoolKind(slots, kind);
  const usesHyphen = kindSlots.some((s) => new RegExp(`^${prefix}-`, 'i').test(String(s.name)));
  let n = 1;
  const taken = new Set(kindSlots.map((s) => slotMatchKey(s.name)));
  while (taken.has(slotMatchKey(`${prefix}${n}`)) || taken.has(slotMatchKey(`${prefix}-${n}`))) n++;
  const num = String(n).padStart(2, '0');
  return usesHyphen || kindSlots.length > 0 ? `${prefix}-${num}` : `${prefix}-${num}`;
}

export function buildUnitIdLookup(rows) {
  const map = new Map();
  (rows || []).forEach((u) => {
    const n = String(u.number).toUpperCase();
    map.set(n, u.id);
    map.set(slotMatchKey(n), u.id);
  });
  return map;
}

/**
 * Parking_No drives physical slot assignment:
 * - same as Flat → BASE (unit's own slot)
 * - matches another unit number → NEIGHBOR (rented from that unit)
 * - otherwise → COMMON community slot (e.g. EH01), created on import if missing
 */
export function resolveParkingAllocation(parkingNo, flat, unitIdByNumber, slotByName) {
  const pNo = normParkingNo(parkingNo);
  const flatUp = normParkingNo(flat);

  if (!pNo || slotMatchKey(parkingNo) === slotMatchKey(flat)) {
    return { allocation_type: 'BASE', allocation_target_id: null, slotId: null, parkingLabel: flatUp };
  }

  const neighborUnitId =
    unitIdByNumber.get(slotMatchKey(parkingNo)) ||
    unitIdByNumber.get(pNo) ||
    unitIdByNumber.get(normParkingNo(parkingNo));
  if (neighborUnitId) {
    return {
      allocation_type: 'NEIGHBOR',
      allocation_target_id: neighborUnitId,
      slotId: null,
      parkingLabel: pNo,
    };
  }

  const slot = slotByName.get(slotMatchKey(parkingNo));
  return {
    allocation_type: 'COMMON',
    allocation_target_id: slot?.id ?? null,
    slotId: slot?.id ?? null,
    parkingLabel: pNo,
    needsSlot: !slot,
  };
}

export function buildSlotByName(slots) {
  const map = new Map();
  (slots || []).forEach((s) => {
    const key = slotMatchKey(s.name);
    if (key) map.set(key, s);
  });
  return map;
}

/** Collect EH pool slot keys that need a parking_slots row (never unit-to-unit rentals). */
export function collectExternalParkingSlotNames(vehicles, unitIdByNumber) {
  const names = new Set();
  for (const v of vehicles) {
    const pKey = slotMatchKey(v.parkingNo);
    const flatKey = slotMatchKey(v.unitNumber);
    if (!pKey || pKey === flatKey) continue;
    if (unitIdByNumber.has(pKey)) continue;
    if (!/^EH\d+$/i.test(pKey)) continue;
    names.add(pKey);
  }
  return names;
}

async function ensureParkingSlotsForImport(apartmentId, vehicles, unitIdByNumber) {
  const needed = collectExternalParkingSlotNames(vehicles, unitIdByNumber);
  if (!needed.size) return buildSlotByName(portalState.slots);

  const { data: existing, error } = await supabase
    .from('parking_slots')
    .select('id, name')
    .eq('apartment_id', apartmentId);
  if (error) throw new Error(`Parking slot lookup failed: ${error.message}`);

  const slotByName = buildSlotByName(existing);
  const toCreate = [...needed].filter((key) => !slotByName.has(key));

  if (toCreate.length) {
    const { data: created, error: insErr } = await supabase
      .from('parking_slots')
      .insert(
        toCreate.map((key) => ({
          apartment_id: apartmentId,
          name: formatNewPoolSlotName(key, existing),
          pool_kind: 'car',
        })),
      )
      .select('id, name');
    if (insErr) throw new Error(`Could not create parking slots (${toCreate.join(', ')}): ${insErr.message}`);
    (created || []).forEach((s) => slotByName.set(slotMatchKey(s.name), s));
  }

  await pullState();
  return buildSlotByName(portalState.slots);
}

const REGISTRY_DB_COLUMNS = [
  'parking_sticker',
  'rfid_tag',
  'rfid_number',
  'registry_updated_on',
  'registry_updated_by',
];

export const VEHICLE_REGISTRY_MIGRATION_SQL = `alter table public.vehicles add column if not exists parking_sticker text;
alter table public.vehicles add column if not exists rfid_tag text;
alter table public.vehicles add column if not exists rfid_number text;
alter table public.vehicles add column if not exists registry_updated_on text;
alter table public.vehicles add column if not exists registry_updated_by text;`;

function isMissingRegistryColumnsError(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return (
    (msg.includes('schema cache') || msg.includes('column') || msg.includes('does not exist')) &&
    REGISTRY_DB_COLUMNS.some((c) => msg.includes(c))
  );
}

function stripRegistryColumns(payload) {
  const next = { ...payload };
  REGISTRY_DB_COLUMNS.forEach((k) => delete next[k]);
  return next;
}

function importAuditSnapshot(row, unitNumber, alloc = null) {
  const allocation_type = alloc?.allocation_type || (row.allocation_type || 'BASE').toUpperCase();
  let allocation_target = null;
  if (alloc && allocation_type !== 'BASE') allocation_target = alloc.parkingLabel || null;
  return {
    plate: row.plate ?? null,
    type: (row.type || 'CAR').toUpperCase(),
    unit_number: unitNumber ?? null,
    is_parking_active: row.is_parking_active !== false,
    allocation_type,
    allocation_target,
    parking_sticker: row.parking_sticker ?? null,
    rfid_tag: row.rfid_tag ?? null,
    rfid_number: row.rfid_number ?? null,
    registry_updated_on: row.registry_updated_on ?? null,
    registry_updated_by: row.registry_updated_by ?? null,
  };
}

async function writeVehicleRecord({ existingId, payload, alloc, plateToId, v }) {
  const op = existingId ? 'update' : 'insert';
  let before = null;
  if (existingId) {
    const { data: prev } = await supabase.from('vehicles').select('*').eq('id', existingId).maybeSingle();
    if (prev) before = importAuditSnapshot(prev, v.unitNumber);
  }
  const after = importAuditSnapshot(payload, v.unitNumber, alloc);

  let result = existingId
    ? await supabase.from('vehicles').update(payload).eq('id', existingId)
    : await supabase.from('vehicles').insert(payload).select('id').single();

  let skippedRegistryMeta = false;
  if (result.error && isMissingRegistryColumnsError(result.error)) {
    const core = stripRegistryColumns(payload);
    result = existingId
      ? await supabase.from('vehicles').update(core).eq('id', existingId)
      : await supabase.from('vehicles').insert(core).select('id').single();
    skippedRegistryMeta = !result.error;
  }

  if (result.error) {
    throw new Error(
      `${op === 'update' ? 'Update' : 'Insert'} failed for ${v.plate}: ${formatDbError(result.error)}`,
    );
  }

  const vehicleId = existingId || result.data?.id;
  if (vehicleId && !existingId) plateToId.set(v.plate, vehicleId);

  if (alloc.allocation_type === 'COMMON' && alloc.slotId && vehicleId) {
    await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('assigned_vehicle_id', vehicleId);
    await supabase.from('parking_slots').update({ assigned_vehicle_id: vehicleId }).eq('id', alloc.slotId);
  } else if (alloc.allocation_type === 'NEIGHBOR' && vehicleId) {
    await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('assigned_vehicle_id', vehicleId);
  }

  const { logVehicleAudit } = await import('./vehicleAudit.js');
  await logVehicleAudit({
    action: op === 'update' ? 'update' : 'insert',
    source: 'excel_import',
    vehicleId,
    unitNumber: v.unitNumber,
    plate: v.plate,
    before,
    after,
  });

  return { vehicleId, skippedRegistryMeta };
}

function formatDbError(err, plate) {
  const msg = err?.message || String(err);
  if (/parking_sticker|rfid_|registry_updated/i.test(msg) && /column|schema/i.test(msg)) {
    return `${msg} — Run supabase_vehicle_rfid_sticker.sql in the Supabase SQL editor first.`;
  }
  return plate ? `${msg} (${plate})` : msg;
}

/**
 * @param {'merge'|'overwrite'} mode
 */
export async function applyParkingImport(parsed, mode) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const apartmentId = portalState.access?.activeApartmentId;
  if (!apartmentId) throw new Error('No active apartment selected.');

  if (mode === 'overwrite') {
    const { error: delErr } = await supabase.from('vehicles').delete().eq('apartment_id', apartmentId);
    if (delErr) throw new Error(`Could not clear existing vehicles: ${delErr.message}`);
    await supabase.from('parking_slots').update({ assigned_vehicle_id: null }).eq('apartment_id', apartmentId);
  }

  const unitIdByNumber = await upsertUnits(apartmentId, parsed.units);
  const slotByName = await ensureParkingSlotsForImport(apartmentId, parsed.vehicles, unitIdByNumber);

  const { data: existingVehicles } = await supabase
    .from('vehicles')
    .select('id, plate')
    .eq('apartment_id', apartmentId);
  const plateToId = new Map(
    (existingVehicles || []).map((v) => [normPlate(v.plate), v.id]),
  );

  const deduped = [];
  const seen = new Set();
  for (const v of parsed.vehicles) {
    if (seen.has(v.plate)) continue;
    seen.add(v.plate);
    deduped.push(v);
  }

  let skippedRegistryMeta = false;
  for (const v of deduped) {
    const unitId = unitIdByNumber.get(v.unitNumber);
    if (!unitId) continue;

    const alloc = resolveParkingAllocation(v.parkingNo, v.unitNumber, unitIdByNumber, slotByName);
    const payload = {
      apartment_id: apartmentId,
      unit_id: unitId,
      plate: v.plate,
      type: v.type,
      is_parking_active: true,
      allocation_type: alloc.allocation_type,
      allocation_target_id: alloc.allocation_target_id,
      ...vehicleRegistryFieldsFromMeta(v.meta),
    };

    const existingId = plateToId.get(v.plate);
    const { skippedRegistryMeta: skipped } = await writeVehicleRecord({
      existingId,
      payload,
      alloc,
      plateToId,
      v,
    });
    if (skipped) skippedRegistryMeta = true;
  }

  await pullState();
  const preview = buildImportPreview(parsed, mode);
  return {
    ...preview,
    skippedRegistryMeta,
    migrationSql: skippedRegistryMeta ? VEHICLE_REGISTRY_MIGRATION_SQL : undefined,
  };
}
