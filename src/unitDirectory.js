/**
 * Unit Directory: flat master data + Excel bulk update
 */
import { portalState, supabase, pullState } from './store.js';
import { deriveBlockFromFlat } from './parkingImport.js';
import { mergeLegacyResidentsFromWorkbook } from './residentImport.js';
import {
    importResidentsFromSheet,
    deleteResident,
    loadResidents,
    fetchResidentsForApartment,
    clearResidentsCache,
    normUnit,
    getResidents,
    classifyUnitOccupancy,
    occupancySummaryLabel,
    occupancySummaryBadge,
    unitMissingOwners,
    splitResidentsByKind,
} from './residents.js';
import { logActivity } from './activityAudit.js';
import { renderBlockFilterSelect, unitMatchesBlock, initBlockFilterListener } from './blockFilter.js';
import {
    getOpenInvoicesForUnit,
    invoiceBalance,
    invoiceStatus,
    openMaintenanceCollectionForFlat,
    openRaiseInvoiceModal,
    viewInvoiceDetail,
} from './maintenanceBilling.js';
import { effectiveAllocationType, resolveAllocationTargetLabel } from './allocation.js';
import { getDocumentsForUnit, saveUnitDocument, deleteUnitDocument } from './operations.js';
import { withButtonBusy } from './buttonBusy.js';

export const OCCUPANCY_STATUSES = {
    OWNER_OCCUPIED: { label: 'Owner residing', short: 'Owner' },
    TENANT_OCCUPIED: { label: 'Tenant occupied', short: 'Tenant' },
    VACANT: { label: 'Vacant', short: 'Vacant' },
    NON_ALLOTABLE: { label: 'Non-allotable', short: 'N/A' },
    UNDER_RENOVATION: { label: 'Under renovation', short: 'Renovation' },
    LOCKED: { label: 'Locked / dispute', short: 'Locked' },
    DEVELOPER_HOLD: { label: 'Developer hold', short: 'Dev hold' },
};

export const OCCUPANCY_STATUS_VALUES = Object.keys(OCCUPANCY_STATUSES);

export const UNIT_DIRECTORY_HEADERS = [
    'Unit_Number',
    'Block',
    'Area_SqFt',
    'BHK',
    'Car_Slots',
    'Bike_Slots',
    'Occupancy_Status',
    'Notes',
];

export const RESIDENTS_SHEET_HEADERS = [
    'Unit_Number',
    'Role',
    'Full_Name',
    'Phone',
    'Email',
    'Notes',
];

const UNIT_COL_ALIASES = {
    unitNumber: ['unit_number', 'unit number', 'unit', 'flat', 'flat_no', 'flat no'],
    block: ['block', 'tower'],
    areaSqft: ['area_sqft', 'area sqft', 'sqft', 'sq ft', 'carpet_area', 'carpet area'],
    bhk: ['bhk', 'unit_type', 'unit type', 'type'],
    carSlots: ['car_slots', 'car slots', 'car_limit', 'car limit', 'four_wheeler_count'],
    bikeSlots: ['bike_slots', 'bike slots', 'bike_limit', 'bike limit', 'two_wheeler_count'],
    occupancyStatus: ['occupancy_status', 'occupancy status', 'occupancy', 'status'],
    notes: ['notes', 'unit_notes', 'unit notes', 'remarks'],
};

const RESIDENT_COL_ALIASES = {
    unitNumber: ['unit_number', 'unit number', 'unit', 'flat'],
    role: ['role', 'kind', 'type'],
    fullName: ['full_name', 'full name', 'name'],
    phone: ['phone', 'mobile'],
    email: ['email', 'e-mail'],
    notes: ['notes', 'remarks'],
};

const normHeader = (v) =>
    String(v ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');

const parseNum = (v) => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
};

const parseIntSlot = (v) => {
    const n = parseNum(v);
    if (n == null) return null;
    return Math.max(0, Math.round(n));
};

/** Blank Excel cell → null (skip). Explicit 0 is kept. */
const cellStr = (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    return s || null;
};

const parseOccupancy = (raw) => {
    const s = cellStr(raw);
    if (!s) return null;
    const key = s.toUpperCase().replace(/[\s-]+/g, '_');
    const aliases = {
        OWNER: 'OWNER_OCCUPIED',
        OWNER_OCCUPIED: 'OWNER_OCCUPIED',
        TENANT: 'TENANT_OCCUPIED',
        TENANT_OCCUPIED: 'TENANT_OCCUPIED',
        VACANT: 'VACANT',
        NOT_OCCUPIED: 'VACANT',
        EMPTY: 'VACANT',
        NON_ALLOTABLE: 'NON_ALLOTABLE',
        NON_ALLOTABLE_FLAT: 'NON_ALLOTABLE',
        UNDER_RENOVATION: 'UNDER_RENOVATION',
        RENOVATION: 'UNDER_RENOVATION',
        LOCKED: 'LOCKED',
        DEVELOPER_HOLD: 'DEVELOPER_HOLD',
        DEV_HOLD: 'DEVELOPER_HOLD',
    };
    const resolved = aliases[key] || (OCCUPANCY_STATUS_VALUES.includes(key) ? key : null);
    if (!resolved) throw new Error(`Invalid occupancy status "${s}"`);
    return resolved;
};

const parseRole = (raw) => {
    const s = cellStr(raw)?.toUpperCase();
    if (!s) return null;
    if (s === 'TENANT' || s === 'RENTER') return 'TENANT';
    if (s === 'OWNER' || s === 'OWNERS') return 'OWNER';
    throw new Error(`Invalid role "${raw}" — use OWNER or TENANT`);
};

export const directoryUnits = () =>
    portalState.units
        .filter((u) => u.is_community !== true)
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

const findUnit = (unitNumber) => {
    const needle = normUnit(unitNumber);
    return portalState.units.find((u) => normUnit(u.number) === needle);
};

export const flatDeleteConfirmMessage = (unitNumber, residents = []) => {
    const unit = findUnit(unitNumber);
    const people = residents.length;
    const vehicles = unit ? (unit.vehicles || []).length : 0;
    const parts = [`Delete ${unitNumber} and all ${people} owner/tenant record(s)?`];
    if (unit) {
        parts.push(`Removes the flat from the unit directory${vehicles ? ` and ${vehicles} registered vehicle(s)` : ''}.`);
    } else {
        parts.push('No unit directory record exists for this flat number — only resident records will be removed.');
    }
    parts.push('Linked billing or history may block deletion if invoices exist for this flat.');
    parts.push('This cannot be undone.');
    return parts.join('\n\n');
};

/** Delete a flat (if in units table), its vehicles, and all owner/tenant records. */
export async function deleteFlatWithResidents(unitNumber) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const needle = normUnit(unitNumber);
    const unit = findUnit(unitNumber);

    await loadResidents(true);
    const residentRows = getResidents().filter((r) => normUnit(r.unit_number) === needle);
    const residentIds = [...new Set(residentRows.map((r) => r.id))];

    if (unit) {
        const { error: vehErr } = await supabase.from('vehicles').delete().eq('unit_id', unit.id);
        if (vehErr) throw new Error(vehErr.message);

        const { error: unitErr } = await supabase.from('units').delete().eq('id', unit.id);
        if (unitErr) throw new Error(unitErr.message);
    }

    if (residentIds.length) {
        const { error: resErr } = await supabase.from('residents').delete().in('id', residentIds);
        if (resErr) throw new Error(resErr.message);
    }

    if (!unit && !residentIds.length) {
        throw new Error(`Nothing to delete for ${unitNumber}.`);
    }

    clearResidentsCache();
    await pullState();

    await logActivity({
        entityType: 'UNIT',
        entityId: unit?.id || unitNumber,
        action: 'DELETE',
        summary: `Deleted flat ${unitNumber} (${residentIds.length} resident(s)${unit ? ', unit record' : ''})`,
        newData: { unitNumber, residentCount: residentIds.length, unitDeleted: !!unit },
    });

    return { unitDeleted: !!unit, residentsDeleted: residentIds.length, vehiclesRemoved: unit ? (unit.vehicles || []).length : 0 };
};

const indexResidents = (residents) => {
    const byUnit = new Map();
    (residents || []).forEach((r) => {
        const key = normUnit(r.unit_number);
        if (!byUnit.has(key)) byUnit.set(key, { owners: [], tenants: [] });
        const bucket = byUnit.get(key);
        if ((r.kind || '').toUpperCase() === 'TENANT') bucket.tenants.push(r);
        else bucket.owners.push(r);
    });
    return byUnit;
};

export const occupancyLabel = (status) =>
    occupancySummaryLabel(status) || OCCUPANCY_STATUSES[status]?.label || status || '—';

export const occupancyBadgeClass = (status) => occupancySummaryBadge(status);

export const deriveUnitOccupancy = (unit, residents = []) =>
    classifyUnitOccupancy(residents, unit);

export const buildUnitDirectoryRows = (units, residents = []) => {
    const resIndex = indexResidents(residents);
    return units.map((u) => {
        const unitResidents = [...(resIndex.get(normUnit(u.number))?.owners || []), ...(resIndex.get(normUnit(u.number))?.tenants || [])];
        const occ = deriveUnitOccupancy(u, unitResidents);
        return [
            u.number,
            u.block || deriveBlockFromFlat(u.number) || '',
            u.area_sqft != null && u.area_sqft !== '' ? u.area_sqft : '',
            u.bhk || '',
            u.car_limit ?? 0,
            u.bike_limit ?? 0,
            occ,
            u.notes || '',
        ];
    });
};

export const buildResidentsSheetRows = (units, residents = []) => {
    const unitSet = new Set(units.map((u) => normUnit(u.number)));
    return residents
        .filter((r) => unitSet.has(normUnit(r.unit_number)))
        .sort((a, b) => {
            const ua = normUnit(a.unit_number).localeCompare(normUnit(b.unit_number), undefined, { numeric: true });
            if (ua !== 0) return ua;
            const ka = (a.kind || 'OWNER').localeCompare(b.kind || 'OWNER');
            if (ka !== 0) return ka;
            return (a.full_name || '').localeCompare(b.full_name || '');
        })
        .map((r) => [
            r.unit_number,
            (r.kind || 'OWNER').toUpperCase(),
            r.full_name || '',
            r.phone || '',
            r.email || '',
            r.notes || '',
        ]);
};

export async function downloadUnitDirectoryTemplate() {
    await pullState();
    const ExcelJS = (await import('exceljs')).default;
    const apartmentId = portalState.access?.activeApartmentId;
    const units = directoryUnits();
    const residents = apartmentId ? await fetchResidentsForApartment(apartmentId) : [];
    const unitRows = buildUnitDirectoryRows(units, residents);
    const residentRows = buildResidentsSheetRows(units, residents);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CommunityHub';
    wb.created = new Date();

    const ws = wb.addWorksheet('Units', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(UNIT_DIRECTORY_HEADERS);
    unitRows.forEach((r) => ws.addRow(r));
    ws.columns = [
        { width: 12 }, { width: 8 }, { width: 10 }, { width: 8 },
        { width: 10 }, { width: 10 }, { width: 18 }, { width: 28 },
    ];
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };

    const rs = wb.addWorksheet('Residents', { views: [{ state: 'frozen', ySplit: 1 }] });
    rs.addRow(RESIDENTS_SHEET_HEADERS);
    residentRows.forEach((r) => rs.addRow(r));
    rs.columns = [
        { width: 12 }, { width: 10 }, { width: 24 }, { width: 14 }, { width: 26 }, { width: 20 },
    ];
    const rHeader = rs.getRow(1);
    rHeader.font = { bold: true };
    rHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };

    const help = wb.addWorksheet('Instructions');
    [
        ['Unit Directory — bulk update'],
        [''],
        ['Sheet "Units": one row per flat. Unit_Number is required.'],
        ['Blank cell = keep existing value. Use 0 for zero car/bike slots.'],
        [`Occupancy_Status: ${OCCUPANCY_STATUS_VALUES.join(', ')}`],
        [''],
        ['Sheet "Residents": one row per person (multiple owners/tenants per flat).'],
        ['Role = OWNER or TENANT. Import replaces all residents for flats listed on this sheet.'],
        ['Flats with no rows on Residents sheet keep their current people records.'],
        [''],
        ['All flats in the society are included on download — fill missing rows (e.g. D-005) before import.'],
    ].forEach((line) => help.addRow(line));
    help.getColumn(1).width = 78;

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const base = (portalState.community?.name || 'unit_directory').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'unit_directory';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}_units_template.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function mapHeaders(headerRow, aliasMap) {
    const map = {};
    headerRow.eachCell((cell, col) => {
        const h = normHeader(cell.value);
        Object.entries(aliasMap).forEach(([key, aliases]) => {
            if (aliases.some((a) => h === normHeader(a))) map[key] = col;
        });
    });
    return map;
}

function rowToUnitRecord(row, colMap) {
    const get = (key) => {
        const col = colMap[key];
        if (!col) return undefined;
        return row.getCell(col).value;
    };
    const unitNumber = cellStr(get('unitNumber'));
    if (!unitNumber) return null;

    const has = (key) => colMap[key] != null;
    let occupancyStatus = null;
    if (has('occupancyStatus')) {
        const raw = get('occupancyStatus');
        if (raw != null && raw !== '') occupancyStatus = parseOccupancy(raw);
    }

    return {
        unitNumber,
        block: has('block') ? cellStr(get('block')) : undefined,
        areaSqft: has('areaSqft') ? parseNum(get('areaSqft')) : undefined,
        bhk: has('bhk') ? cellStr(get('bhk')) : undefined,
        carSlots: has('carSlots') ? parseIntSlot(get('carSlots')) : undefined,
        bikeSlots: has('bikeSlots') ? parseIntSlot(get('bikeSlots')) : undefined,
        occupancyStatus,
        notes: has('notes') ? cellStr(get('notes')) : undefined,
    };
}

function rowToResidentRecord(row, colMap) {
    const get = (key) => {
        const col = colMap[key];
        if (!col) return null;
        return row.getCell(col).value;
    };
    const unitNumber = cellStr(get('unitNumber'));
    const fullName = cellStr(get('fullName'));
    if (!unitNumber || !fullName) return null;
    return {
        unitNumber,
        kind: parseRole(get('role')) || 'OWNER',
        fullName,
        phone: cellStr(get('phone')),
        email: cellStr(get('email')),
        notes: cellStr(get('notes')),
    };
}

export async function parseUnitDirectoryExcel(file) {
    const ExcelJS = (await import('exceljs')).default;
    const buf = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const ws = wb.getWorksheet('Units') || wb.worksheets[0];
    if (!ws) throw new Error('Workbook has no sheets.');

    const unitColMap = mapHeaders(ws.getRow(1), UNIT_COL_ALIASES);
    if (!unitColMap.unitNumber) throw new Error('Units sheet: missing Unit_Number column.');

    const rows = [];
    ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const rec = rowToUnitRecord(row, unitColMap);
        if (rec) rows.push(rec);
    });
    if (!rows.length) throw new Error('No data rows on Units sheet.');

    let residents = [];
    const rs = wb.getWorksheet('Residents');
    if (rs) {
        const resColMap = mapHeaders(rs.getRow(1), RESIDENT_COL_ALIASES);
        if (resColMap.unitNumber && resColMap.fullName) {
            rs.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return;
                try {
                    const rec = rowToResidentRecord(row, resColMap);
                    if (rec) residents.push(rec);
                } catch (err) {
                    throw new Error(`Residents row ${rowNumber}: ${err.message}`);
                }
            });
        }
    }
    if (!residents.length) {
        residents = mergeLegacyResidentsFromWorkbook(wb, residents);
    }

    return { unitRows: rows, residents, sheetName: ws.name };
}

function buildUnitPatch(row) {
    const patch = {};
    if (row.block !== undefined && row.block !== null) patch.block = row.block;
    if (row.areaSqft !== undefined && row.areaSqft !== null) patch.area_sqft = row.areaSqft;
    if (row.bhk !== undefined && row.bhk !== null) patch.bhk = row.bhk;
    if (row.carSlots !== undefined && row.carSlots !== null) patch.car_limit = row.carSlots;
    if (row.bikeSlots !== undefined && row.bikeSlots !== null) patch.bike_limit = row.bikeSlots;
    if (row.occupancyStatus !== undefined && row.occupancyStatus !== null) patch.occupancy_status = row.occupancyStatus;
    if (row.notes !== undefined && row.notes !== null) patch.notes = row.notes;
    return patch;
}

export async function applyUnitDirectoryImport(parsed, { createMissing = true, residentImportMode = 'update_listed' } = {}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const stats = { updated: 0, created: 0, residents: 0, skipped: 0, errors: [] };

    for (const row of parsed.unitRows) {
        try {
            let unit = findUnit(row.unitNumber);
            const patch = buildUnitPatch(row);

            if (!unit) {
                if (!createMissing) {
                    stats.skipped += 1;
                    stats.errors.push(`${row.unitNumber}: flat not found`);
                    continue;
                }
                const insertRow = {
                    id: crypto.randomUUID(),
                    apartment_id,
                    number: row.unitNumber,
                    car_limit: row.carSlots ?? portalState.community?.defaults?.cars ?? 1,
                    bike_limit: row.bikeSlots ?? portalState.community?.defaults?.bikes ?? 1,
                    is_community: false,
                    ...patch,
                };
                const { data: inserted, error } = await supabase
                    .from('units')
                    .insert(insertRow)
                    .select('*')
                    .single();
                if (error) throw formatDbError(error, row.unitNumber);
                unit = inserted;
                portalState.units.push({ ...unit, vehicles: [] });
                stats.created += 1;
            } else if (Object.keys(patch).length) {
                const { error } = await supabase.from('units').update(patch).eq('id', unit.id);
                if (error) throw formatDbError(error, row.unitNumber);
                Object.assign(unit, patch);
                stats.updated += 1;
            } else {
                stats.updated += 1;
            }
        } catch (err) {
            stats.errors.push(`${row.unitNumber}: ${err?.message || 'failed'}`);
        }
    }

    if (parsed.residents?.length) {
        try {
            const { count } = await importResidentsFromSheet(parsed.residents, residentImportMode);
            stats.residents = count;
        } catch (err) {
            stats.errors.push(`Residents: ${err?.message || 'import failed'}`);
        }
    }

    await pullState();
    return stats;
}

function formatDbError(error, unitNumber) {
    const msg = error?.message || 'database error';
    if (/column.*does not exist/i.test(msg)) {
        return new Error(`${msg} — run supabase_units_directory.sql in Supabase SQL Editor`);
    }
    if (/occupancy_status/i.test(msg)) {
        return new Error(`${msg} — run supabase_units_directory.sql for occupancy_status column`);
    }
    return new Error(msg);
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Owner names for list column — primary owner first. */
const ownersForDisplay = (owners) => {
    if (!owners.length) return [];
    const primary = owners.find((r) => r.is_primary);
    if (primary) return [primary, ...owners.filter((r) => r.id !== primary.id)];
    return owners;
};
const tenantsForDisplay = (tenants) => {
    if (!tenants.length) return [];
    const primary = tenants.find((r) => r.is_primary);
    if (primary) return [primary, ...tenants.filter((r) => r.id !== primary.id)];
    return tenants;
};

const formatResidentCell = (list, emptyLabel = '—', { showAway = false } = {}) => {
    if (!list.length) return `<span class="unit-directory-cell--empty">${emptyLabel}</span>`;
    const rows = list.map((r) => {
        const primary = r.is_primary ? '<span class="unit-dir-name__tag">★</span>' : '';
        const away = showAway && (r.kind || '').toUpperCase() !== 'TENANT' && r.is_residing === false
            ? '<span class="unit-dir-name__tag">away</span>'
            : '';
        return `<span class="unit-dir-name">${esc(r.full_name)}${primary}${away}</span>`;
    });
    return `<span class="unit-directory-names">${rows.join('')}</span>`;
};

const computeUnitVehicleStats = (unit) => {
    let slotCars = 0;
    let slotBikes = 0;
    let activeCars = 0;
    let activeBikes = 0;
    (unit.vehicles || []).forEach((v) => {
        if (v.is_parking_active === false) return;
        const isCar = (v.type || 'CAR').toUpperCase() === 'CAR';
        if (isCar) activeCars += 1;
        else activeBikes += 1;
        const allocType = effectiveAllocationType(v);
        if (allocType === 'COMMON' || allocType === 'NEIGHBOR') return;
        if (isCar) slotCars += 1;
        else slotBikes += 1;
    });
    const carLimit = unit.car_limit || 0;
    const bikeLimit = unit.bike_limit || 0;
    const violations = (portalState.parking?.violations || [])
        .filter((v) => v.unit_id === unit.id && (v.status || 'PENDING') === 'PENDING');
    return {
        activeCars,
        activeBikes,
        slotCars,
        slotBikes,
        carLimit,
        bikeLimit,
        carsOver: slotCars > carLimit,
        bikesOver: slotBikes > bikeLimit,
        violations,
    };
};

const formatSlotUsage = (icon, used, limit, label, over, activeTotal) => {
    const fraction = limit > 0 ? `${used}/${limit}` : String(used || 0);
    const poolExtra = activeTotal > used ? ` · ${activeTotal} total` : '';
    const title = limit > 0
        ? `${used} of ${limit} ${label} slot${limit === 1 ? '' : 's'} in use${poolExtra}${over ? ' — over limit' : ''}`
        : `${activeTotal || used} active ${label}${used !== activeTotal ? ` (${used} on base slots)` : ''}`;
    return `<span class="unit-directory-slot${over ? ' unit-directory-slot--over' : ''}" title="${esc(title)}">
      <i class="fa-solid ${icon}" aria-hidden="true"></i>
      <strong>${fraction}</strong>
      <span class="unit-directory-slot__label">${label}</span>
    </span>`;
};

const formatVehicleSummary = (unit) => {
    const {
        activeCars, activeBikes, slotCars, slotBikes,
        carLimit, bikeLimit, carsOver, bikesOver, violations,
    } = computeUnitVehicleStats(unit);
    const hasParking = carLimit || bikeLimit || slotCars || slotBikes || activeCars || activeBikes;
    if (!hasParking && !violations.length) {
        return '<span class="unit-directory-cell--empty">—</span>';
    }
    const parts = [];
    if (carLimit || slotCars || activeCars) {
        parts.push(formatSlotUsage('fa-car', slotCars, carLimit, 'car', carsOver, activeCars));
    }
    if (bikeLimit || slotBikes || activeBikes) {
        parts.push(formatSlotUsage('fa-motorcycle', slotBikes, bikeLimit, 'bike', bikesOver, activeBikes));
    }
    const flags = violations.length
        ? [`<span class="unit-directory-vehicle-flag unit-directory-vehicle-flag--violation" title="Pending parking violations">${violations.length} violation${violations.length === 1 ? '' : 's'}</span>`]
        : [];
    return `<span class="unit-directory-vehicle-summary">${parts.join('')}${flags.length ? `<span class="unit-directory-vehicle-flags">${flags.join('')}</span>` : ''}</span>`;
};

const formatResidentList = (list) => {
    if (!list?.length) return '<span class="unit-card__empty">—</span>';
    if (list.length === 1) return `<strong>${list[0].full_name}</strong>`;
    return `<strong>${list[0].full_name}</strong> <span class="unit-directory-more">+${list.length - 1}</span>`;
};

const renderUnitDirectoryPerson = (r) => {
    const isTenant = (r.kind || '').toUpperCase() === 'TENANT';
    const residingBadge = !isTenant && r.is_residing === false
        ? '<span class="occupancy-badge occ-no-owner">Non-residing</span>'
        : '';
    const primaryBadge = r.is_primary ? '<span class="resident-primary-badge">Primary</span>' : '';
    const phone = (r.phone || '').trim();
    const email = (r.email || '').trim();
    const contactParts = [
        phone ? `<span class="unit-dir-person__contact"><i class="fa-solid fa-phone" aria-hidden="true"></i>${esc(phone)}</span>` : '',
        email ? `<span class="unit-dir-person__contact"><i class="fa-solid fa-envelope" aria-hidden="true"></i>${esc(email)}</span>` : '',
    ].filter(Boolean);
    const metaHtml = contactParts.length
        ? `<div class="unit-dir-person__meta">${contactParts.join('')}</div>`
        : '';
    return `
      <div class="unit-dir-person">
        <div class="unit-dir-person__main">
          <strong class="unit-dir-person__name">${esc(r.full_name)}</strong>${primaryBadge}${residingBadge}
          <button type="button" class="unit-dir-person__edit unit-dir-edit-resident" data-id="${r.id}" title="Edit name, phone, and email">
            <i class="fa-solid fa-pen" aria-hidden="true"></i>
          </button>
        </div>
        ${metaHtml}
      </div>`;
};

const renderUnitDirectoryVehicle = (v, unit) => {
    const active = v.is_parking_active !== false;
    const icon = v.type === 'BIKE' ? 'fa-motorcycle' : 'fa-car';
    const alloc = effectiveAllocationType(v);
    let statusNote = '';
    if (!active) statusNote = 'Dormant';
    else if (alloc === 'COMMON' || alloc === 'NEIGHBOR') statusNote = 'Pool / reallocated';
    else if (v.slotStatus === 'OVERLIMIT') statusNote = 'Over limit';
    return `
      <div class="unit-dir-vehicle${active ? '' : ' unit-dir-vehicle--dormant'}">
        <span><i class="fa-solid ${icon}"></i> <strong>${esc(v.plate || '—')}</strong></span>
        <span class="unit-dir-vehicle__meta">${esc(v.type || '—')}${statusNote ? ` · ${statusNote}` : ''}</span>
      </div>`;
};

const vehiclesWithSlotStatus = (unit) => {
    let baseCars = 0;
    let baseBikes = 0;
    return [...(unit.vehicles || [])].map((v) => {
        if (v.is_parking_active === false) return { ...v, slotStatus: 'INACTIVE' };
        const allocType = effectiveAllocationType(v);
        if (allocType === 'COMMON' || allocType === 'NEIGHBOR') return { ...v, slotStatus: 'POOL' };
        if ((v.type || 'CAR').toUpperCase() === 'CAR') {
            baseCars += 1;
            return { ...v, slotStatus: baseCars <= (unit.car_limit || 0) ? 'OK' : 'OVERLIMIT' };
        }
        baseBikes += 1;
        return { ...v, slotStatus: baseBikes <= (unit.bike_limit || 0) ? 'OK' : 'OVERLIMIT' };
    }).sort((a, b) => (a.plate || '').localeCompare(b.plate || ''));
};

const renderUnitDirectoryInvoice = (inv) => {
    const bal = invoiceBalance(inv);
    const due = inv.due_date
        ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
        : '—';
    return `
      <div class="unit-dir-invoice">
        <div class="unit-dir-invoice__main">
          <strong>${esc(inv.period_label || 'Invoice')}</strong>
          ${invoiceStatusBadge(inv)}
        </div>
        <div class="unit-dir-invoice__meta">
          <span>Due ${due}</span>
          <span class="${bal > 0 ? 'unit-detail-kpi--warn' : ''}">${formatMoney(bal)} due</span>
        </div>
        <button type="button" class="btn btn-outline btn--small unit-dir-view-invoice" data-id="${inv.id}">View</button>
      </div>`;
};

const renderUnitDirectoryExpanded = (u, unitResidents, occ) => {
    const { owners, tenants } = splitResidentsByKind(unitResidents);
    const vehicles = vehiclesWithSlotStatus(u);
    const invoices = getUnitInvoices(u.id);
    const open = getOpenInvoicesForUnit(u.id);
    const outstanding = open.reduce((s, inv) => s + invoiceBalance(inv), 0);
    const vStats = computeUnitVehicleStats(u);

    const sectionCard = (title, count, body, empty) => `
      <section class="unit-directory-panel">
        <header class="unit-directory-panel__head">
          <h4 class="unit-directory-panel__title">${title}</h4>
          <span class="unit-directory-panel__count">${count}</span>
        </header>
        <div class="unit-directory-panel__body">
          ${body || `<p class="unit-directory-panel__empty">${empty}</p>`}
        </div>
      </section>`;

    return `
      <div class="unit-directory-expanded">
        <div class="unit-directory-expanded__toolbar">
          <div class="unit-directory-expanded__stats">
            <span class="unit-directory-stat${outstanding > 0 ? ' unit-directory-stat--warn' : ''}">
              <i class="fa-solid fa-indian-rupee-sign"></i> ${outstanding > 0 ? formatMoney(outstanding) : 'Clear'}
            </span>
            <span class="unit-directory-stat">
              <i class="fa-solid fa-user-group"></i> ${owners.length} owner${owners.length === 1 ? '' : 's'} · ${tenants.length} tenant${tenants.length === 1 ? '' : 's'}
            </span>
            <span class="unit-directory-stat">
              <i class="fa-solid fa-car"></i> ${vStats.activeCars}/${vStats.carLimit || 0} car · ${vStats.activeBikes}/${vStats.bikeLimit || 0} bike
            </span>
            <span class="occupancy-badge ${occupancyBadgeClass(occ)}">${esc(occupancyLabel(occ))}</span>
          </div>
          <button type="button" class="btn btn-primary btn--small unit-directory-open-modal" data-unit-id="${u.id}" data-tab="overview">
            <i class="fa-solid fa-up-right-from-square"></i> Open full details
          </button>
        </div>
        <div class="unit-directory-expanded__grid">
          ${sectionCard('Owners', owners.length, owners.map(renderUnitDirectoryPerson).join(''), 'No owners recorded')}
          ${sectionCard('Tenants', tenants.length, tenants.map(renderUnitDirectoryPerson).join(''), 'No tenants recorded')}
          ${sectionCard('Parking', vehicles.length, vehicles.map((v) => renderUnitDirectoryVehicle(v, u)).join(''), 'No vehicles registered')}
          ${sectionCard('Invoices', invoices.length, invoices.length
        ? `<div class="unit-directory-panel__summary">
              <span>Outstanding <strong class="${outstanding > 0 ? 'unit-detail-kpi--warn' : ''}">${formatMoney(outstanding)}</strong></span>
              <span>${open.length} open</span>
            </div>${invoices.slice(0, 5).map(renderUnitDirectoryInvoice).join('')}`
        : '', 'No invoices yet')}
        </div>
        <nav class="unit-directory-expanded__nav" aria-label="Flat detail shortcuts">
          <button type="button" class="unit-directory-full-detail" data-unit-id="${u.id}" data-tab="overview">Edit flat</button>
          <button type="button" class="unit-directory-full-detail" data-unit-id="${u.id}" data-tab="residents">Residents</button>
          <button type="button" class="unit-directory-full-detail" data-unit-id="${u.id}" data-tab="billing">Billing</button>
          <button type="button" class="unit-directory-full-detail" data-unit-id="${u.id}" data-tab="vehicles">Vehicles</button>
          <button type="button" class="unit-directory-full-detail" data-unit-id="${u.id}" data-tab="documents">Documents</button>
        </nav>
      </div>`;
};

const wireUnitDirectoryRowActions = (root, residents) => {
    root.querySelectorAll('.unit-directory-open-modal').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            void openUnitDetailModal(btn.dataset.unitId, btn.dataset.tab || 'overview');
        });
    });
    wireUnitDirectoryExpanded(root, residents);
};

const wireUnitDirectoryExpanded = (root, residents) => {
    root.querySelectorAll('.unit-dir-edit-resident').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const r = residents.find((x) => x.id === btn.dataset.id);
            if (r && typeof window.openResidentModal === 'function') window.openResidentModal(r);
        });
    });
    root.querySelectorAll('.unit-dir-view-invoice').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            viewInvoiceDetail(btn.dataset.id);
        });
    });
    root.querySelectorAll('.unit-directory-full-detail').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            void openUnitDetailModal(btn.dataset.unitId, btn.dataset.tab || 'overview');
        });
    });
};

let editingUnitId = null;
let editingUnitResidents = [];
let activeUnitDetailTab = 'overview';

const formatMoney = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN')}`;

const invoiceStatusBadge = (inv) => {
    const status = invoiceStatus(inv);
    const statusClass = { OPEN: 'dues-open', PARTIAL: 'dues-partial', PAID: 'dues-paid' }[status];
    return `<span class="maintenance-dues-badge ${statusClass}">${status}</span>`;
};

const getUnitInvoices = (unitId) =>
    (portalState.finances.maintenanceInvoices || [])
        .filter((inv) => inv.unit_id === unitId)
        .sort((a, b) => {
            const da = a.due_date || a.created_at || '';
            const db = b.due_date || b.created_at || '';
            return db.localeCompare(da);
        });

const getUnitPayments = (unitId) => {
    const invoiceIds = new Set(getUnitInvoices(unitId).map((i) => i.id));
    const txns = portalState.finances.txns || [];
    return (portalState.finances.maintenanceAllocations || [])
        .filter((a) => invoiceIds.has(a.invoice_id))
        .map((a) => {
            const inv = portalState.finances.maintenanceInvoices.find((i) => i.id === a.invoice_id);
            const txn = txns.find((t) => t.id === a.transaction_id);
            return { ...a, invoice: inv, txn };
        })
        .sort((a, b) => String(b.txn?.date || '').localeCompare(String(a.txn?.date || '')));
};

const formatUnitTypeLabel = (bhk) => {
    const s = String(bhk ?? '').trim();
    if (!s) return null;
    if (/bhk/i.test(s)) return s.replace(/\s*bhk\s*/i, ' BHK').replace(/\s+/g, ' ').trim();
    if (/^\d+(\.\d+)?$/.test(s)) return `${s} BHK`;
    return s;
};

const unitSubtitle = (u) => {
    const parts = [];
    const block = u.block || deriveBlockFromFlat(u.number);
    if (block) parts.push(`Block ${block}`);
    const unitType = formatUnitTypeLabel(u.bhk);
    if (unitType) parts.push(unitType);
    if (u.area_sqft != null && u.area_sqft !== '') parts.push(`${u.area_sqft} sq ft`);
    return parts.join(' · ') || 'Flat details';
};

const renderUnitDetailKpis = (u) => {
    const el = document.getElementById('unit-detail-kpis');
    if (!el) return;
    const invoices = getUnitInvoices(u.id);
    const open = invoices.filter((inv) => invoiceBalance(inv) > 0.001);
    const outstanding = open.reduce((s, inv) => s + invoiceBalance(inv), 0);
    const vehicles = (u.vehicles || []).filter((v) => v.is_parking_active !== false);
    const residents = editingUnitResidents.filter((r) => normUnit(r.unit_number) === normUnit(u.number));
    el.innerHTML = `
      <div class="unit-detail-kpi-card ${outstanding > 0 ? 'unit-detail-kpi-card--warn' : ''}">
        <i class="fa-solid fa-indian-rupee-sign"></i>
        <div><span>Outstanding</span><strong>${formatMoney(outstanding)}</strong></div>
      </div>
      <div class="unit-detail-kpi-card">
        <i class="fa-solid fa-file-invoice"></i>
        <div><span>Open invoices</span><strong>${open.length}</strong></div>
      </div>
      <div class="unit-detail-kpi-card">
        <i class="fa-solid fa-user-group"></i>
        <div><span>Residents</span><strong>${residents.length}</strong></div>
      </div>
      <div class="unit-detail-kpi-card">
        <i class="fa-solid fa-car"></i>
        <div><span>Vehicles</span><strong>${vehicles.length}</strong></div>
      </div>`;
};

const switchUnitDetailTab = (tab) => {
    activeUnitDetailTab = tab;
    document.querySelectorAll('.unit-detail-tab').forEach((btn) => {
        const active = btn.dataset.unitTab === tab;
        btn.classList.toggle('unit-detail-tab--active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.unit-detail-panel').forEach((panel) => {
        panel.hidden = !panel.id.endsWith(tab);
    });
    const footer = document.getElementById('unit-detail-footer');
    if (footer) footer.hidden = tab !== 'overview';
    const u = portalState.units.find((x) => x.id === editingUnitId);
    if (!u) return;
    if (tab === 'residents') renderUnitDetailResidents(u);
    if (tab === 'vehicles') renderUnitDetailVehicles(u);
    if (tab === 'billing') {
        void pullState().then(() => {
            if (editingUnitId === u.id) {
                renderUnitDetailKpis(u);
                renderUnitDetailBilling(u);
            }
        });
    }
    if (tab === 'documents') renderUnitDetailDocuments(u);
};

const renderUnitDetailResidents = (u) => {
    const el = document.getElementById('unit-detail-panel-residents');
    if (!el) return;
    const residents = editingUnitResidents.filter((r) => normUnit(r.unit_number) === normUnit(u.number));
    const owners = residents.filter((r) => (r.kind || '').toUpperCase() !== 'TENANT');
    const tenants = residents.filter((r) => (r.kind || '').toUpperCase() === 'TENANT');

    const personRow = (r) => {
        const isTenant = (r.kind || '').toUpperCase() === 'TENANT';
        const residingBadge = !isTenant && r.is_residing === false
            ? ' <span class="occupancy-badge occ-no-owner">Non-residing</span>'
            : '';
        const phone = (r.phone || '').trim();
        const email = (r.email || '').trim();
        const notes = (r.notes || '').trim();
        const metaParts = [
            phone ? `<span><i class="fa-solid fa-phone" aria-hidden="true"></i> ${esc(phone)}</span>` : '',
            email ? `<span><i class="fa-solid fa-envelope" aria-hidden="true"></i> ${esc(email)}</span>` : '',
            notes ? `<span class="unit-detail-person__notes">${esc(notes)}</span>` : '',
        ].filter(Boolean);
        const metaHtml = metaParts.length
            ? `<div class="unit-detail-person__meta">${metaParts.join('')}</div>`
            : '';
        return `
      <div class="unit-detail-person">
        <div class="unit-detail-person__main">
          <strong>${esc(r.full_name)}</strong>
          <span class="unit-detail-person__role ${isTenant ? 'unit-detail-person__role--tenant' : ''}">${(r.kind || 'OWNER').toUpperCase()}</span>${residingBadge}
          <button type="button" class="unit-detail-person__edit unit-detail-edit-resident" data-id="${r.id}" title="Edit name, phone, and email">
            <i class="fa-solid fa-pen" aria-hidden="true"></i>
          </button>
          <button type="button" class="unit-detail-person__delete unit-detail-del-resident" data-id="${r.id}" title="Delete">
            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
          </button>
        </div>
        ${metaHtml}
      </div>`;
    };

    const section = (label, list, kind) => `
      <div class="unit-detail-residents-section">
        <div class="unit-detail-residents-section__head">
          <h3>${label}</h3>
          <button type="button" class="btn btn-outline btn--small unit-detail-add-resident" data-kind="${kind}">
            <i class="fa-solid fa-plus"></i> Add
          </button>
        </div>
        ${list.length ? list.map(personRow).join('') : '<p class="unit-detail-empty">None recorded</p>'}
      </div>`;

    el.innerHTML = `
      <div class="unit-detail-panel__toolbar">
        <button type="button" class="btn btn-outline btn--small" id="unit-detail-all-residents">
          <i class="fa-solid fa-user-group"></i> All residents page
        </button>
      </div>
      <div class="unit-detail-residents-grid">
        ${section('Owners', owners, 'OWNER')}
        ${section('Tenants', tenants, 'TENANT')}
      </div>`;

    el.querySelectorAll('.unit-detail-add-resident').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (typeof window.openResidentModal === 'function') {
                window.openResidentModal({ unit_number: u.number, kind: btn.dataset.kind });
            }
        });
    });
    el.querySelectorAll('.unit-detail-edit-resident').forEach((btn) => {
        btn.addEventListener('click', () => {
            const r = residents.find((x) => x.id === btn.dataset.id);
            if (r && typeof window.openResidentModal === 'function') window.openResidentModal(r);
        });
    });
    el.querySelectorAll('.unit-detail-del-resident').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this resident record?')) return;
            await deleteResident(btn.dataset.id);
            editingUnitResidents = await fetchResidentsForApartment(portalState.access?.activeApartmentId);
            renderUnitDetailResidents(u);
            renderUnitDetailKpis(u);
            void renderUnitDirectory();
        });
    });
    document.getElementById('unit-detail-all-residents')?.addEventListener('click', () => {
        closeUnitDetailModal();
        window.location.hash = 'property-residents';
    });
};

const renderUnitDetailVehicles = (u) => {
    const el = document.getElementById('unit-detail-panel-vehicles');
    if (!el) return;
    const vehicles = [...(u.vehicles || [])].sort((a, b) => {
        const aa = a.is_parking_active === false ? 1 : 0;
        const bb = b.is_parking_active === false ? 1 : 0;
        if (aa !== bb) return aa - bb;
        return (a.plate || '').localeCompare(b.plate || '');
    });

    const row = (v) => {
        const active = v.is_parking_active !== false;
        const alloc = effectiveAllocationType(v);
        const target = resolveAllocationTargetLabel(v);
        const icon = v.type === 'BIKE' ? 'fa-motorcycle' : 'fa-car';
        return `<div class="unit-detail-vehicle ${active ? '' : 'unit-detail-vehicle--dormant'}">
          <div class="unit-detail-vehicle__plate"><i class="fa-solid ${icon}"></i> <strong>${v.plate || '—'}</strong></div>
          <div class="unit-detail-vehicle__meta">
            <span>${v.type || '—'}</span>
            <span>${alloc}${target && alloc !== 'BASE' ? ` · ${target}` : ''}</span>
            <span class="unit-detail-vehicle__status">${active ? 'Active' : 'Dormant'}</span>
            ${v.status === 'OVERLIMIT' ? '<span class="unit-detail-vehicle__over">Over limit</span>' : ''}
          </div>
          <button type="button" class="btn btn-outline btn--small unit-detail-edit-vehicle" data-id="${v.id}" title="Edit in parking registry"><i class="fa-solid fa-pen"></i></button>
        </div>`;
    };

    el.innerHTML = `
      <div class="unit-detail-panel__toolbar">
        <button type="button" class="btn btn-outline btn--small" id="unit-detail-parking-registry">
          <i class="fa-solid fa-car"></i> Full parking registry
        </button>
      </div>
      <div class="unit-detail-vehicle-list">
      ${vehicles.length
        ? vehicles.map(row).join('')
        : '<p class="unit-detail-empty">No vehicles registered for this flat.</p>'}
      </div>`;

    el.querySelectorAll('.unit-detail-edit-vehicle').forEach((btn) => {
        btn.addEventListener('click', () => {
            closeUnitDetailModal();
            window.location.hash = 'property-vehicles';
            setTimeout(() => window.openMdl?.(u.id), 150);
        });
    });
    document.getElementById('unit-detail-parking-registry')?.addEventListener('click', () => {
        closeUnitDetailModal();
        window.location.hash = 'property-vehicles';
        setTimeout(() => window.openMdl?.(u.id), 150);
    });
};

const renderUnitDetailBilling = (u) => {
    const el = document.getElementById('unit-detail-panel-billing');
    if (!el) return;
    const invoices = getUnitInvoices(u.id);
    const payments = getUnitPayments(u.id);
    const open = getOpenInvoicesForUnit(u.id);
    const outstanding = open.reduce((s, inv) => s + invoiceBalance(inv), 0);

    const invoiceRows = invoices.length
        ? invoices.map((inv) => {
            const bal = invoiceBalance(inv);
            const due = inv.due_date
                ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                : '—';
            return `<div class="unit-detail-invoice-row">
              <div class="unit-detail-invoice-row__main">
                <strong>${inv.period_label || 'Invoice'}</strong>
                ${invoiceStatusBadge(inv)}
              </div>
              <div class="unit-detail-invoice-row__meta">
                <span>Due ${due}</span>
                <span>Billed ${formatMoney(inv.amount)}</span>
                <span class="${bal > 0 ? 'unit-detail-kpi--warn' : ''}">Bal ${formatMoney(bal)}</span>
              </div>
              <button type="button" class="btn btn-outline btn--small unit-detail-view-invoice" data-id="${inv.id}">View</button>
            </div>`;
        }).join('')
        : '<p class="unit-detail-empty">No maintenance invoices for this flat yet.</p>';

    const paymentRows = payments.length
        ? payments.map((p) => {
            const date = p.txn?.date
                ? new Date(p.txn.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                : '—';
            return `<div class="unit-detail-payment-row">
              <div><strong>${formatMoney(p.amount)}</strong> <span class="unit-detail-payment-row__period">${p.invoice?.period_label || 'Invoice'}</span></div>
              <div class="unit-detail-payment-row__meta">
                <span>${date}</span>
                <span>${p.txn?.wallet || ''}</span>
              </div>
            </div>`;
        }).join('')
        : '<p class="unit-detail-empty">No payments applied to this flat\'s invoices yet.</p>';

    el.innerHTML = `
      <div class="unit-detail-billing-summary">
        <div><span>Outstanding</span><strong class="${outstanding > 0 ? 'unit-detail-kpi--warn' : ''}">${formatMoney(outstanding)}</strong></div>
        <div><span>Open invoices</span><strong>${open.length}</strong></div>
      </div>
      <div class="unit-detail-panel__toolbar">
        <button type="button" class="btn btn-primary btn--small" id="unit-detail-raise-invoice">
          <i class="fa-solid fa-file-invoice"></i> Raise invoice
        </button>
        <button type="button" class="btn btn-outline btn--small" id="unit-detail-record-payment" ${outstanding <= 0 ? 'disabled title="No outstanding balance"' : ''}>
          <i class="fa-solid fa-indian-rupee-sign"></i> Record payment
        </button>
        <button type="button" class="btn btn-outline btn--small" id="unit-detail-billing-page">
          <i class="fa-solid fa-arrow-up-right-from-square"></i> Maintenance billing
        </button>
      </div>
      <div class="unit-detail-billing-grid">
        <div class="unit-detail-billing-col">
          <h3 class="unit-detail-section-title">Invoices</h3>
          <div class="unit-detail-invoice-list">${invoiceRows}</div>
        </div>
        <div class="unit-detail-billing-col">
          <h3 class="unit-detail-section-title">Payments applied</h3>
          <div class="unit-detail-payment-list">${paymentRows}</div>
        </div>
      </div>`;

    document.getElementById('unit-detail-raise-invoice')?.addEventListener('click', () => {
        void openRaiseInvoiceModal(u.number);
    });
    document.getElementById('unit-detail-record-payment')?.addEventListener('click', () => {
        openMaintenanceCollectionForFlat(u.number);
    });
    document.getElementById('unit-detail-billing-page')?.addEventListener('click', () => {
        closeUnitDetailModal();
        window.location.hash = 'finance-maintenance';
        setTimeout(() => window.filterInvoicesByFlat?.(u.number), 150);
    });
    el.querySelectorAll('.unit-detail-view-invoice').forEach((btn) => {
        btn.addEventListener('click', () => viewInvoiceDetail(btn.dataset.id));
    });
};

const renderUnitDetailDocuments = (u) => {
    const el = document.getElementById('unit-detail-panel-documents');
    if (!el) return;
    const docs = getDocumentsForUnit(u.id);
    const rows = docs.length
        ? docs.map((d) => `<div class="unit-detail-doc-row">
          <div><strong>${d.title}</strong> <span class="unit-detail-doc-type">${d.doc_type}</span></div>
          <div class="unit-detail-doc-meta">
            ${d.expires_at ? `<span>Expires ${d.expires_at}</span>` : ''}
            <a href="${d.file_path}" target="_blank" rel="noopener" class="btn btn-outline btn--small">Open</a>
            <button type="button" class="btn btn-outline btn--small unit-detail-del-doc" data-id="${d.id}" style="color:var(--danger);"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>`).join('')
        : '<p class="unit-detail-empty">No documents uploaded for this flat.</p>';

    el.innerHTML = `
      <div class="unit-detail-panel__toolbar">
        <button type="button" class="btn btn-primary btn--small" id="unit-detail-add-doc"><i class="fa-solid fa-plus"></i> Add document</button>
      </div>
      <div class="unit-detail-doc-list">${rows}</div>
      <form id="unit-doc-form" class="unit-doc-form" hidden onsubmit="return false">
        <input type="text" id="unit-doc-title" class="expense-combobox" placeholder="Title" required />
        <select id="unit-doc-type" class="expense-combobox">
          <option value="SALE_DEED">Sale deed</option>
          <option value="RENTAL_AGREEMENT">Rental agreement</option>
          <option value="ID">ID</option>
          <option value="NOC">NOC</option>
          <option value="OTHER">Other</option>
        </select>
        <input type="text" id="unit-doc-path" class="expense-combobox" placeholder="File URL or storage path" required />
        <input type="date" id="unit-doc-expires" class="expense-combobox" title="Expiry (optional)" />
        <button type="button" class="btn btn-primary btn--small" id="unit-doc-save">Save</button>
        <button type="button" class="btn btn-outline btn--small" id="unit-doc-cancel">Cancel</button>
      </form>`;

    document.getElementById('unit-detail-add-doc')?.addEventListener('click', () => {
        document.getElementById('unit-doc-form')?.removeAttribute('hidden');
    });
    document.getElementById('unit-doc-cancel')?.addEventListener('click', () => {
        document.getElementById('unit-doc-form')?.setAttribute('hidden', '');
    });
    document.getElementById('unit-doc-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('unit-doc-save');
        await withButtonBusy(btn, 'Saving…', async () => {
            await saveUnitDocument(u.id, {
                title: document.getElementById('unit-doc-title')?.value?.trim(),
                doc_type: document.getElementById('unit-doc-type')?.value,
                file_path: document.getElementById('unit-doc-path')?.value?.trim(),
                expires_at: document.getElementById('unit-doc-expires')?.value || null,
            });
            renderUnitDetailDocuments(u);
        }).catch((err) => alert(err?.message || 'Could not save document.'));
    });
    el.querySelectorAll('.unit-detail-del-doc').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this document record?')) return;
            await withButtonBusy(btn, 'Deleting…', async () => {
                await deleteUnitDocument(btn.dataset.id);
                renderUnitDetailDocuments(u);
            }).catch((err) => alert(err?.message || 'Could not delete.'));
        });
    });
};

export const refreshUnitDetailIfOpen = async () => {
    if (!editingUnitId) return;
    const u = portalState.units.find((x) => x.id === editingUnitId);
    if (!u) return;
    const apartmentId = portalState.access?.activeApartmentId;
    if (apartmentId) editingUnitResidents = await fetchResidentsForApartment(apartmentId);
    renderUnitDetailKpis(u);
    if (activeUnitDetailTab === 'residents') renderUnitDetailResidents(u);
    if (activeUnitDetailTab === 'vehicles') renderUnitDetailVehicles(u);
    if (activeUnitDetailTab === 'billing') renderUnitDetailBilling(u);
    if (activeUnitDetailTab === 'documents') renderUnitDetailDocuments(u);
    void renderUnitDirectory();
};

export const openUnitDetailModal = async (unitId, tab = 'overview') => {
    const u = portalState.units.find((x) => x.id === unitId);
    if (!u) return;

    editingUnitId = unitId;
    const apartmentId = portalState.access?.activeApartmentId;
    editingUnitResidents = apartmentId ? await fetchResidentsForApartment(apartmentId) : [];
    const unitResidents = editingUnitResidents.filter((r) => normUnit(r.unit_number) === normUnit(u.number));
    const derivedOcc = deriveUnitOccupancy(u, unitResidents);

    document.getElementById('unit-detail-title').textContent = u.number;
    document.getElementById('unit-detail-subtitle').textContent = [
        unitSubtitle(u),
        occupancyLabel(derivedOcc),
        u.occupancy_status && u.occupancy_status !== derivedOcc ? `(manual: ${occupancyLabel(u.occupancy_status)})` : '',
    ].filter(Boolean).join(' · ');
    document.getElementById('unit-edit-block').value = u.block || deriveBlockFromFlat(u.number) || '';
    document.getElementById('unit-edit-bhk').value = u.bhk || '';
    document.getElementById('unit-edit-area').value = u.area_sqft ?? '';
    document.getElementById('unit-edit-car').value = u.car_limit ?? 0;
    document.getElementById('unit-edit-bike').value = u.bike_limit ?? 0;
    document.getElementById('unit-edit-occupancy').value = u.occupancy_status || '';
    document.getElementById('unit-edit-notes').value = u.notes || '';

    renderUnitDetailKpis(u);
    switchUnitDetailTab(tab);
    const deleteBtn = document.getElementById('unit-detail-delete');
    if (deleteBtn) deleteBtn.hidden = false;
    document.getElementById('unit-detail-modal')?.classList.add('active');
};

export const openUnitEditModal = openUnitDetailModal;

export const closeUnitDetailModal = () => {
    document.getElementById('unit-detail-modal')?.classList.remove('active');
    editingUnitId = null;
};

export const closeUnitEditModal = closeUnitDetailModal;

async function saveUnitEdit() {
    if (!supabase || !editingUnitId) return;
    const u = portalState.units.find((x) => x.id === editingUnitId);
    if (!u) return;

    const areaRaw = document.getElementById('unit-edit-area')?.value;
    const occ = document.getElementById('unit-edit-occupancy')?.value || null;
    const patch = {
        block: document.getElementById('unit-edit-block')?.value.trim() || null,
        bhk: document.getElementById('unit-edit-bhk')?.value.trim() || null,
        area_sqft: areaRaw === '' ? null : parseFloat(areaRaw),
        car_limit: parseInt(document.getElementById('unit-edit-car')?.value, 10) || 0,
        bike_limit: parseInt(document.getElementById('unit-edit-bike')?.value, 10) || 0,
        occupancy_status: occ || null,
        notes: document.getElementById('unit-edit-notes')?.value.trim() || null,
    };

    const { error } = await supabase.from('units').update(patch).eq('id', u.id);
    if (error) throw formatDbError(error, u.number);

    await pullState();
    closeUnitDetailModal();
    await renderUnitDirectory();
}

window.openUnitDetailModal = openUnitDetailModal;
window.openUnitEditModal = openUnitEditModal;
window.closeUnitDetailModal = closeUnitDetailModal;
window.closeUnitEditModal = closeUnitEditModal;
window.refreshUnitDetailIfOpen = refreshUnitDetailIfOpen;

export const renderUnitDirectory = async () => {
    const list = document.getElementById('unit-directory-items');
    if (!list) return;

    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId || !supabase) {
        list.innerHTML = '<p class="maintenance-dues-empty">Supabase required to load units.</p>';
        return;
    }

    let residents = [];
    try {
        residents = await fetchResidentsForApartment(apartmentId);
    } catch (err) {
        list.innerHTML = `<p class="maintenance-dues-empty" style="color:var(--danger);">${err.message}</p>`;
        return;
    }

    const filterQ = (document.getElementById('unit-directory-filter')?.value || '').trim().toUpperCase();
    const resIndex = indexResidents(residents);

    const units = directoryUnits()
        .filter((u) => unitMatchesBlock(u.id))
        .filter((u) => {
            if (!filterQ) return true;
            const res = resIndex.get(normUnit(u.number)) || { owners: [], tenants: [] };
            const hay = [
                u.number, u.block, u.bhk, u.notes,
                ...res.owners.map((r) => r.full_name),
                ...res.tenants.map((r) => r.full_name),
            ].join(' ').toUpperCase();
            return hay.includes(filterQ);
        });

    list.innerHTML = '';
    if (!units.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No units match your search.</p>';
        return;
    }

    const html = units.map((u) => {
        const res = resIndex.get(normUnit(u.number)) || { owners: [], tenants: [] };
        const unitResidents = res.owners.concat(res.tenants);
        const occ = deriveUnitOccupancy(u, unitResidents);
        const missingOwners = unitMissingOwners(unitResidents);
        const { owners, tenants } = splitResidentsByKind(unitResidents);
        const ownerList = ownersForDisplay(owners);
        const tenantList = tenantsForDisplay(tenants);
        const block = u.block || deriveBlockFromFlat(u.number) || '—';
        const bhk = formatUnitTypeLabel(u.bhk) || '—';
        const area = u.area_sqft != null && u.area_sqft !== '' ? `${u.area_sqft} sq ft` : '—';
        const outstanding = getOpenInvoicesForUnit(u.id).reduce((s, inv) => s + invoiceBalance(inv), 0);
        const duesHtml = outstanding > 0
            ? `<span class="unit-directory-group__dues unit-directory-group__dues--warn">${formatMoney(outstanding)}</span>`
            : `<span class="unit-directory-group__dues">—</span>`;

        return `
        <details class="unit-directory-group${missingOwners ? ' resident-unit-group--no-owner' : ''}">
          <summary class="unit-directory-group__summary">
            <strong class="unit-directory-group__flat">${esc(u.number)}</strong>
            <span class="unit-directory-group__block">${esc(block)}</span>
            <span class="unit-directory-group__meta">${esc(bhk)} · ${esc(area)}</span>
            <span class="unit-directory-group__status">
              <span class="occupancy-badge ${occupancyBadgeClass(occ)}">${esc(occupancyLabel(occ))}</span>
              ${missingOwners ? '<span class="occupancy-badge occ-no-owner">No owner</span>' : ''}
            </span>
            <span class="unit-directory-group__owners">${formatResidentCell(ownerList, '—', { showAway: true })}</span>
            <span class="unit-directory-group__tenants">${formatResidentCell(tenantList)}</span>
            <span class="unit-directory-group__vehicles">${formatVehicleSummary(u)}</span>
            <span class="unit-directory-group__dues-col">${duesHtml}</span>
            <span class="unit-directory-group__actions">
              <span class="unit-directory-group__actions-inner">
              <button type="button" class="btn btn-outline btn--small unit-directory-open-modal" data-unit-id="${u.id}" data-tab="overview" title="Open full flat details">
                <i class="fa-solid fa-up-right-from-square"></i>
              </button>
              <i class="fa-solid fa-chevron-down unit-directory-group__chevron" aria-hidden="true"></i>
              <button type="button" class="btn btn-outline btn--small btn--danger unit-directory-delete" data-unit-id="${u.id}" data-unit-number="${esc(u.number)}" title="Delete flat">
                <i class="fa-solid fa-trash-can"></i>
              </button>
              </span>
            </span>
          </summary>
          ${renderUnitDirectoryExpanded(u, unitResidents, occ)}
        </details>`;
    }).join('');

    list.innerHTML = html;
    wireUnitDirectoryRowActions(list, residents);

    list.querySelectorAll('.unit-directory-delete').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const unitNumber = btn.dataset.unitNumber;
            const unitResidents = residents.filter((r) => normUnit(r.unit_number) === normUnit(unitNumber));
            if (!confirm(flatDeleteConfirmMessage(unitNumber, unitResidents))) return;
            await withButtonBusy(btn, '…', async () => {
                await deleteFlatWithResidents(unitNumber);
                if (editingUnitId === btn.dataset.unitId) closeUnitDetailModal();
                await renderUnitDirectory();
                window.renderResidents?.();
            }).catch((err) => alert(err?.message || 'Could not delete flat.'));
        });
    });
};

export const initUnitDirectory = () => {
    renderBlockFilterSelect('unit-directory-block-filter', () => void renderUnitDirectory());
    initBlockFilterListener(() => void renderUnitDirectory());
    document.getElementById('unit-directory-filter')?.addEventListener('input', () => void renderUnitDirectory());

    document.querySelectorAll('.unit-detail-tab').forEach((btn) => {
        btn.addEventListener('click', () => switchUnitDetailTab(btn.dataset.unitTab));
    });

    document.getElementById('unit-edit-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('unit-edit-save');
        await withButtonBusy(btn, 'Saving…', saveUnitEdit)
            .catch((err) => alert(err?.message || 'Could not save flat.'));
    });
    document.getElementById('unit-detail-close')?.addEventListener('click', closeUnitDetailModal);
    document.getElementById('unit-edit-cancel')?.addEventListener('click', closeUnitDetailModal);
    document.getElementById('unit-detail-delete')?.addEventListener('click', async () => {
        const u = portalState.units.find((x) => x.id === editingUnitId);
        if (!u) return;
        const residents = editingUnitResidents.filter((r) => normUnit(r.unit_number) === normUnit(u.number));
        if (!confirm(flatDeleteConfirmMessage(u.number, residents))) return;
        const btn = document.getElementById('unit-detail-delete');
        await withButtonBusy(btn, 'Deleting…', async () => {
            await deleteFlatWithResidents(u.number);
            closeUnitDetailModal();
            await renderUnitDirectory();
            window.renderResidents?.();
        }).catch((err) => alert(err?.message || 'Could not delete flat.'));
    });
    document.getElementById('unit-edit-parking-link')?.addEventListener('click', () => {
        const id = editingUnitId;
        closeUnitDetailModal();
        window.location.hash = 'property-vehicles';
        if (id) setTimeout(() => window.openMdl?.(id), 150);
    });
    document.getElementById('unit-detail-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'unit-detail-modal') closeUnitDetailModal();
    });

    document.getElementById('unit-directory-download')?.addEventListener('click', () => {
        downloadUnitDirectoryTemplate().catch((err) => alert(err?.message || 'Download failed.'));
    });

    const fileInput = document.getElementById('unit-directory-xlsx');
    const modal = document.getElementById('unit-directory-import-modal');
    const stepPick = document.getElementById('unit-directory-import-pick');
    const stepPreview = document.getElementById('unit-directory-import-preview');
    const summaryEl = document.getElementById('unit-directory-import-summary');
    const errorEl = document.getElementById('unit-directory-import-error');
    let pendingImport = null;

    const showError = (msg) => {
        if (!errorEl) return;
        errorEl.textContent = msg || '';
        errorEl.hidden = !msg;
    };

    const openImportModal = () => {
        pendingImport = null;
        showError('');
        if (stepPick) stepPick.hidden = false;
        if (stepPreview) stepPreview.hidden = true;
        if (fileInput) fileInput.value = '';
        modal?.classList.add('active');
    };

    const closeImportModal = () => modal?.classList.remove('active');

    document.getElementById('unit-directory-import-btn')?.addEventListener('click', openImportModal);
    document.getElementById('unit-directory-import-close')?.addEventListener('click', closeImportModal);
    document.getElementById('unit-directory-import-cancel')?.addEventListener('click', closeImportModal);
    document.getElementById('unit-directory-import-choose')?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        showError('');
        try {
            pendingImport = await parseUnitDirectoryExcel(file);
            const newUnits = pendingImport.unitRows.filter((r) => !findUnit(r.unitNumber)).length;
            const resNote = pendingImport.residents.length
                ? ` · <strong>${pendingImport.residents.length}</strong> resident row(s)`
                : '';
            if (summaryEl) {
                summaryEl.innerHTML = `<strong>${pendingImport.unitRows.length}</strong> unit row(s)${resNote}
                  · <strong>${newUnits}</strong> new flat(s) · existing flats updated`;
            }
            document.getElementById('unit-directory-import-filename').textContent = file.name;
            if (stepPick) stepPick.hidden = true;
            if (stepPreview) stepPreview.hidden = false;
        } catch (err) {
            showError(err?.message || 'Could not read Excel file.');
        }
    });

    document.getElementById('unit-directory-import-back')?.addEventListener('click', () => {
        pendingImport = null;
        if (stepPick) stepPick.hidden = false;
        if (stepPreview) stepPreview.hidden = true;
        showError('');
    });

    document.getElementById('unit-directory-import-apply')?.addEventListener('click', async () => {
        if (!pendingImport) return;
        const mode = document.querySelector('input[name="resident-import-mode"]:checked')?.value || 'update_listed';
        if (mode === 'full_replace' && !confirm('This will delete ALL residents for this apartment before importing. Continue?')) return;
        const btn = document.getElementById('unit-directory-import-apply');
        await withButtonBusy(btn, 'Applying…', async () => {
            const stats = await applyUnitDirectoryImport(pendingImport, { residentImportMode: mode });
            closeImportModal();
            await renderUnitDirectory();
            const errNote = stats.errors.length
                ? `\n\nIssues (${stats.errors.length}):\n${stats.errors.slice(0, 8).join('\n')}`
                : '';
            alert(`Updated ${stats.updated} flat(s), created ${stats.created}, residents ${stats.residents}.${errNote}`);
        }).catch((err) => showError(err?.message || 'Import failed.'));
    });

    modal?.addEventListener('click', (e) => {
        if (e.target.id === 'unit-directory-import-modal') closeImportModal();
    });
};

window.downloadUnitDirectoryTemplate = downloadUnitDirectoryTemplate;
