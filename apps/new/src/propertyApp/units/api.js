import { can, assertCan } from '../../capabilities.js';
import { propertyFetch } from '../client.js';
import {
    computeResidentPageSummary,
    getResidentBlock,
    getResidents,
    normUnit,
    splitResidentsByKind,
    unitMissingOwners,
} from '../../residents.js';
import {
    OCCUPANCY_STATUSES,
    OCCUPANCY_STATUS_VALUES,
    buildResidentsSheetRows,
    buildUnitDirectoryRows,
    deriveUnitOccupancy,
    directoryUnits,
    occupancyLabel,
    parseUnitDirectoryExcel,
    RESIDENTS_SHEET_HEADERS,
    UNIT_DIRECTORY_HEADERS,
    flatDeleteConfirmMessage,
} from '../../unitDirectory.js';
import { loadPropertyState } from '../loadState.js';
import { buildSummaryCards } from '../../residentsApp/api.js';
import { financeNewFetch } from '../../financeNew/api.js';

export async function fetchUnitsBundle() {
    return loadPropertyState();
}

export function canEditUnits() {
    return can('units.update');
}

export function listDirectoryUnits({ search = '', occupancy = '' } = {}) {
    const q = String(search || '').trim().toUpperCase();
    const residents = getResidents();
    const byUnit = new Map();
    residents.forEach((r) => {
        const key = normUnit(r.unit_number);
        if (!byUnit.has(key)) byUnit.set(key, []);
        byUnit.get(key).push(r);
    });

    return directoryUnits()
        .map((u) => {
            const mates = byUnit.get(normUnit(u.number)) || [];
            const occ = deriveUnitOccupancy(u, mates);
            const { owners, tenants } = splitResidentsByKind(mates);
            return {
                ...u,
                occupancy: occ,
                owners,
                tenants,
                missingOwners: unitMissingOwners(mates),
                blockLabel: u.block || getResidentBlock(u.number) || '',
            };
        })
        .filter((u) => {
            if (occupancy === 'no_owner' && !u.missingOwners) return false;
            if (occupancy && occupancy !== 'all' && occupancy !== 'no_owner' && u.occupancy !== occupancy) return false;
            if (!q) return true;
            const hay = [
                u.number, u.blockLabel, u.bhk, u.notes,
                ...u.owners.map((r) => r.full_name),
                ...u.tenants.map((r) => r.full_name),
            ].join(' ').toUpperCase();
            return hay.includes(q);
        })
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

export function unitSummaryCards() {
    const units = directoryUnits();
    const residents = getResidents();
    const summary = computeResidentPageSummary(residents, units.map((u) => u.number));
    return buildSummaryCards(summary);
}

export async function saveUnitFields(unitId, patch) {
    assertCan('units.update');
    const json = await propertyFetch(`/api/property/units/${encodeURIComponent(unitId)}`, {
        method: 'PATCH',
        body: patch,
    });
    await loadPropertyState();
    return json.unit;
}

export async function loadUnitFinance(unit) {
    const unitId = unit?.id;
    const number = normUnit(unit?.number);
    const empty = { invoices: [], payments: [], nobroker: [], unavailable: false };
    if (!unitId && !number) return empty;
    try {
        const billing = await financeNewFetch('/api/finance/billing');
        const invoices = (billing.duesInvoices || []).filter((inv) => inv.unit_id === unitId);
        const payments = invoices.flatMap((inv) => (inv.payments || []).map((p) => ({
            ...p,
            invoice_id: inv.id || inv._id,
            period_label: inv.period_label,
        })));
        let nobroker = [];
        try {
            const json = await financeNewFetch('/api/finance/nobroker', {
                query: { limit: 2000, offset: 0, unit_number: unit.number },
            });
            nobroker = (json.rows || []).filter((r) => normUnit(r.unit_number) === number);
        } catch {
            nobroker = [];
        }
        return { invoices, payments, nobroker, unavailable: false };
    } catch {
        return { ...empty, unavailable: true };
    }
}

export async function createUnit(payload) {
    assertCan('units.create');
    const json = await propertyFetch('/api/property/units', { method: 'POST', body: payload });
    await loadPropertyState();
    return json.unit;
}

export async function deleteFlatWithResidents(unitNumber) {
    assertCan('units.delete');
    const json = await propertyFetch(`/api/property/units/${encodeURIComponent(unitNumber)}`, {
        method: 'DELETE',
    });
    await loadPropertyState();
    return json;
}

export async function downloadUnitsTemplate() {
    const ExcelJS = (await import('exceljs')).default;
    const units = directoryUnits();
    const residents = getResidents();
    const unitRows = buildUnitDirectoryRows(units, residents);
    const residentRows = buildResidentsSheetRows(units, residents);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Units', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(UNIT_DIRECTORY_HEADERS);
    unitRows.forEach((r) => ws.addRow(r));
    const rs = wb.addWorksheet('Residents', { views: [{ state: 'frozen', ySplit: 1 }] });
    rs.addRow(RESIDENTS_SHEET_HEADERS);
    residentRows.forEach((r) => rs.addRow(r));
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'unit_directory.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
}

export async function importUnitsExcel(file) {
    assertCan('units.create');
    const parsed = await parseUnitDirectoryExcel(file);
    const result = await propertyFetch('/api/property/units/import', {
        method: 'POST',
        body: {
            unitRows: parsed.unitRows || [],
            residents: parsed.residents || [],
            createMissing: true,
            residentImportMode: 'update_listed',
        },
    });
    await loadPropertyState();
    return { parsed, result };
}

export {
    occupancyLabel,
    OCCUPANCY_STATUSES,
    OCCUPANCY_STATUS_VALUES,
    parseUnitDirectoryExcel,
    flatDeleteConfirmMessage,
};
