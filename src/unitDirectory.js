/**
 * Unit Directory: flat master data + Excel bulk update
 */
import { portalState, supabase, pullState } from './store.js';
import { deriveBlockFromFlat } from './parkingImport.js';
import {
    importResidentsFromSheet,
    deleteResident,
    loadResidents,
    fetchResidentsForApartment,
} from './residents.js';
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

export const OCCUPANCY_STATUSES = {
    OWNER_OCCUPIED: { label: 'Owner occupied', short: 'Owner' },
    TENANT_OCCUPIED: { label: 'Tenant occupied', short: 'Tenant' },
    VACANT: { label: 'Vacant', short: 'Vacant' },
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

const normUnit = (v) => String(v ?? '').trim().toUpperCase();

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
    OCCUPANCY_STATUSES[status]?.label || status || '—';

export const occupancyBadgeClass = (status) => {
    const map = {
        OWNER_OCCUPIED: 'occ-owner',
        TENANT_OCCUPIED: 'occ-tenant',
        VACANT: 'occ-vacant',
        UNDER_RENOVATION: 'occ-reno',
        LOCKED: 'occ-locked',
        DEVELOPER_HOLD: 'occ-dev',
    };
    return map[status] || 'occ-unknown';
};

export const buildUnitDirectoryRows = (units, residents = []) => {
    const resIndex = indexResidents(residents);
    return units.map((u) => {
        const res = resIndex.get(normUnit(u.number)) || { owners: [], tenants: [] };
        let occ = u.occupancy_status || null;
        if (!occ) {
            if (res.tenants.length) occ = 'TENANT_OCCUPIED';
            else if (res.owners.length) occ = 'OWNER_OCCUPIED';
            else occ = 'VACANT';
        }
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

    const residents = [];
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

const formatResidentList = (list) => {
    if (!list?.length) return '<span class="unit-card__empty">—</span>';
    if (list.length === 1) return `<strong>${list[0].full_name}</strong>`;
    return `<strong>${list[0].full_name}</strong> <span class="unit-directory-more">+${list.length - 1}</span>`;
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
        return `
      <div class="unit-detail-person">
        <div class="unit-detail-person__main">
          <strong>${r.full_name}</strong>
          <span class="unit-detail-person__role ${isTenant ? 'unit-detail-person__role--tenant' : ''}">${(r.kind || 'OWNER').toUpperCase()}</span>
        </div>
        <div class="unit-detail-person__meta">
          ${r.phone ? `<span><i class="fa-solid fa-phone"></i> ${r.phone}</span>` : ''}
          ${r.email ? `<span><i class="fa-solid fa-envelope"></i> ${r.email}</span>` : ''}
          ${r.notes ? `<span class="unit-detail-person__notes">${r.notes}</span>` : ''}
        </div>
        <div class="unit-detail-person__actions">
          <button type="button" class="btn btn-outline btn--small unit-detail-edit-resident" data-id="${r.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn btn-outline btn--small unit-detail-del-resident" data-id="${r.id}" title="Delete" style="color:var(--danger);"><i class="fa-solid fa-trash-can"></i></button>
        </div>
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
        try {
            await saveUnitDocument(u.id, {
                title: document.getElementById('unit-doc-title')?.value?.trim(),
                doc_type: document.getElementById('unit-doc-type')?.value,
                file_path: document.getElementById('unit-doc-path')?.value?.trim(),
                expires_at: document.getElementById('unit-doc-expires')?.value || null,
            });
            renderUnitDetailDocuments(u);
        } catch (err) {
            alert(err?.message || 'Could not save document.');
        }
    });
    el.querySelectorAll('.unit-detail-del-doc').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this document record?')) return;
            try {
                await deleteUnitDocument(btn.dataset.id);
                renderUnitDetailDocuments(u);
            } catch (err) {
                alert(err?.message || 'Could not delete.');
            }
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

    document.getElementById('unit-detail-title').textContent = u.number;
    document.getElementById('unit-detail-subtitle').textContent = unitSubtitle(u);
    document.getElementById('unit-edit-block').value = u.block || deriveBlockFromFlat(u.number) || '';
    document.getElementById('unit-edit-bhk').value = u.bhk || '';
    document.getElementById('unit-edit-area').value = u.area_sqft ?? '';
    document.getElementById('unit-edit-car').value = u.car_limit ?? 0;
    document.getElementById('unit-edit-bike').value = u.bike_limit ?? 0;
    document.getElementById('unit-edit-occupancy').value = u.occupancy_status || '';
    document.getElementById('unit-edit-notes').value = u.notes || '';

    renderUnitDetailKpis(u);
    switchUnitDetailTab(tab);
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
        .filter((u) => !filterQ || String(u.number).toUpperCase().includes(filterQ));

    list.innerHTML = '';
    if (!units.length) {
        list.innerHTML = '<p class="maintenance-dues-empty">No units match your search.</p>';
        return;
    }

    units.forEach((u) => {
        const res = resIndex.get(normUnit(u.number)) || { owners: [], tenants: [] };
        let occ = u.occupancy_status;
        if (!occ) {
            if (res.tenants.length) occ = 'TENANT_OCCUPIED';
            else if (res.owners.length) occ = 'OWNER_OCCUPIED';
            else occ = 'VACANT';
        }
        const row = document.createElement('div');
        row.className = 'apt-row unit-directory-row unit-directory-row--clickable';
        row.innerHTML = `
          <div class="maintenance-dues-flat">${u.number}</div>
          <div>${u.block || deriveBlockFromFlat(u.number) || '—'}</div>
          <div>${formatUnitTypeLabel(u.bhk) || '—'}</div>
          <div style="text-align:right;">${u.area_sqft != null && u.area_sqft !== '' ? u.area_sqft : '—'}</div>
          <div style="text-align:center;">${u.car_limit ?? 0} / ${u.bike_limit ?? 0}</div>
          <div><span class="occupancy-badge ${occupancyBadgeClass(occ)}">${occupancyLabel(occ)}</span></div>
          <div class="unit-directory-resident">${formatResidentList(res.owners)}</div>
          <div class="unit-directory-resident">${formatResidentList(res.tenants)}</div>
          <div style="text-align:right;">
            <button type="button" class="btn btn-outline btn--small unit-directory-view" title="View flat details">
              <i class="fa-solid fa-arrow-right"></i>
            </button>
          </div>`;
        row.addEventListener('click', () => void openUnitDetailModal(u.id));
        row.querySelector('.unit-directory-view')?.addEventListener('click', (e) => {
            e.stopPropagation();
            void openUnitDetailModal(u.id);
        });
        list.appendChild(row);
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
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
            await saveUnitEdit();
        } catch (err) {
            alert(err?.message || 'Could not save flat.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save changes'; }
        }
    });
    document.getElementById('unit-detail-close')?.addEventListener('click', closeUnitDetailModal);
    document.getElementById('unit-edit-cancel')?.addEventListener('click', closeUnitDetailModal);
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
        if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
        try {
            const stats = await applyUnitDirectoryImport(pendingImport, { residentImportMode: mode });
            closeImportModal();
            await renderUnitDirectory();
            const errNote = stats.errors.length
                ? `\n\nIssues (${stats.errors.length}):\n${stats.errors.slice(0, 8).join('\n')}`
                : '';
            alert(`Updated ${stats.updated} flat(s), created ${stats.created}, residents ${stats.residents}.${errNote}`);
        } catch (err) {
            showError(err?.message || 'Import failed.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Apply import'; }
        }
    });

    modal?.addEventListener('click', (e) => {
        if (e.target.id === 'unit-directory-import-modal') closeImportModal();
    });
};

window.downloadUnitDirectoryTemplate = downloadUnitDirectoryTemplate;
