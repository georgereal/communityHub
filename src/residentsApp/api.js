/**
 * Thin React-facing API over existing residents helpers + /api/db.
 */
import {
    getResidents,
    getResidentsForUnit,
    getResidentBlock,
    filterResidentsByOptions,
    OCCUPANCY_SUMMARY,
    occupancySummaryHint,
    occupancySummaryLabel,
    occupancySummaryBadge,
    classifyUnitOccupancy,
    unitPassesOccupancyFilter,
    unitMissingOwners,
    dedupeResidents,
    clearResidentsCache,
    computeResidentPageSummary,
    splitResidentsByKind,
    groupResidentsByUnit,
    normUnit,
} from '../residents.js';
import { getBlockOptions, unitNumberMatchesBlock } from '../blockFilter.js';
import { flatDeleteConfirmMessage } from '../unitDirectory.js';
import { propertyFetch } from '../propertyApp/client.js';
import { parseLegacyResidentFile } from '../residentImport.js';
import { portalState } from '../store.js';
import { loadResidentsPropertyState } from './loadState.js';

export {
    OCCUPANCY_SUMMARY,
    getResidentBlock,
    occupancySummaryHint,
    occupancySummaryLabel,
    occupancySummaryBadge,
    flatDeleteConfirmMessage,
    parseLegacyResidentFile,
    splitResidentsByKind,
    normUnit,
};

function unitRecordFor(unitNumber) {
    return (portalState.units || []).find(
        (u) => normUnit(u.number) === normUnit(unitNumber) && u.is_community !== true,
    ) || null;
}

function buildScopedUnitNumbers(block, allResidents) {
    const fromUnits = (portalState.units || [])
        .filter((u) => u.is_community !== true)
        .map((u) => u.number)
        .filter((n) => !block || unitNumberMatchesBlock(n, block));
    const fromResidents = [...new Set((allResidents || []).map((r) => r.unit_number))];
    const merged = [...fromUnits];
    fromResidents.forEach((n) => {
        if (!block || unitNumberMatchesBlock(n, block)) {
            if (!merged.some((x) => normUnit(x) === normUnit(n))) merged.push(n);
        }
    });
    return merged;
}

export function canEditResidents(permissions = portalState.authPermissions || []) {
    return (permissions || []).includes('apartment_mgmt.edit');
}

export async function fetchResidentsBundle() {
    const { residents, units } = await loadResidentsPropertyState();
    return { residents, units };
}

export async function refreshResidents() {
    clearResidentsCache();
    await loadResidentsPropertyState();
    return getResidents();
}

export function listResidentsFiltered({
    search = '',
    kind = '',
    residency = '',
    primaryOnly = false,
    block = '',
    occupancy = '',
} = {}) {
    const { residents: deduped, hiddenCount } = dedupeResidents(getResidents());
    let rows = filterResidentsByOptions(deduped, {
        filterQ: search,
        kind,
        residency,
        primaryOnly,
    });
    if (block) {
        rows = rows.filter((r) => unitNumberMatchesBlock(r.unit_number, block));
    }
    if (occupancy && occupancy !== 'all') {
        rows = rows.filter((r) => {
            const mates = getResidentsForUnit(r.unit_number);
            const occ = classifyUnitOccupancy(mates, unitRecordFor(r.unit_number));
            return unitPassesOccupancyFilter(occ, occupancy, {
                missingOwners: unitMissingOwners(mates),
            });
        });
    }
    const sorted = rows.slice().sort((a, b) => {
        const u = String(a.unit_number || '').localeCompare(String(b.unit_number || ''), undefined, { numeric: true });
        if (u) return u;
        if (!!b.is_primary !== !!a.is_primary) return a.is_primary ? -1 : 1;
        return String(a.full_name || '').localeCompare(String(b.full_name || ''), undefined, { sensitivity: 'base' });
    });
    return { rows: sorted, hiddenCount };
}

/**
 * Unit-centric directory groups (classic Residents page behaviour).
 */
export function listUnitGroups({
    search = '',
    kind = '',
    residency = '',
    primaryOnly = false,
    block = '',
    occupancy = '',
} = {}) {
    const blockFiltered = getResidents().filter((r) => !block || unitNumberMatchesBlock(r.unit_number, block));
    const { residents: allUnique, hiddenCount } = dedupeResidents(blockFiltered);

    const filterOpts = { filterQ: search, kind, residency, primaryOnly };
    const personFiltered = filterResidentsByOptions(allUnique, filterOpts);
    const { residents: uniqueResidents } = dedupeResidents(personFiltered);
    const personFilteredIds = new Set(uniqueResidents.map((r) => r.id));
    const hasPersonFilter = Boolean(search || kind || residency || primaryOnly);

    const scopedUnits = buildScopedUnitNumbers(block, allUnique);
    const summary = computeResidentPageSummary(allUnique, scopedUnits);

    const residentsByUnit = new Map();
    allUnique.forEach((r) => {
        const key = normUnit(r.unit_number);
        if (!residentsByUnit.has(key)) residentsByUnit.set(key, []);
        residentsByUnit.get(key).push(r);
    });

    const showKindOnly = occupancy === 'owners' ? 'OWNER'
        : occupancy === 'tenants' ? 'TENANT'
            : kind;

    const visibleGroups = [];
    scopedUnits.forEach((unitNum) => {
        const unitRecord = unitRecordFor(unitNum);
        const allForUnit = residentsByUnit.get(normUnit(unitNum)) || [];
        const occ = classifyUnitOccupancy(allForUnit, unitRecord);
        const missingOwners = unitMissingOwners(allForUnit);

        if (!unitPassesOccupancyFilter(occ, occupancy, { missingOwners })) return;

        if (hasPersonFilter) {
            const matching = allForUnit.filter((r) => personFilteredIds.has(r.id));
            const showEmptyFlat = !matching.length && (
                (occ === 'VACANT' && occupancy === 'VACANT')
                || (occ === 'NON_ALLOTABLE' && occupancy === 'NON_ALLOTABLE')
                || (missingOwners && occupancy === 'no_owner')
            );
            if (showEmptyFlat) {
                visibleGroups.push({
                    block: unitRecord?.block || getResidentBlock(unitNum) || '—',
                    unit: unitNum,
                    residents: [],
                    occ,
                    missingOwners,
                });
                return;
            }
            if (!matching.length) return;
            visibleGroups.push({
                block: groupResidentsByUnit(matching)[0]?.block || getResidentBlock(unitNum) || '—',
                unit: unitNum,
                residents: matching,
                occ,
                missingOwners,
            });
            return;
        }

        if ((occ === 'VACANT' || occ === 'NON_ALLOTABLE') && occupancy
            && occupancy !== occ && occupancy !== 'all' && occupancy !== 'no_owner') {
            return;
        }
        if (occupancy === 'no_owner' && !missingOwners) return;

        visibleGroups.push({
            block: allForUnit.length
                ? (groupResidentsByUnit(allForUnit)[0]?.block || '—')
                : (unitRecord?.block || getResidentBlock(unitNum) || '—'),
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

    const groups = visibleGroups.map((g) => {
        let { owners, tenants } = splitResidentsByKind(g.residents);
        if (showKindOnly === 'OWNER') tenants = [];
        else if (showKindOnly === 'TENANT') owners = [];
        return { ...g, owners, tenants };
    });

    return { groups, summary, hiddenCount, scopedUnitCount: scopedUnits.length };
}

export function buildSummaryCards(summary) {
    if (!summary) return [];
    const cards = [
        {
            key: 'all',
            label: 'Flats',
            value: summary.totalFlats,
            tone: 'default',
            hint: 'All flats in scope. Status cards count flats once each.',
        },
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
        {
            key: 'VACANT',
            label: 'Vacant',
            value: summary.vacant,
            tone: 'vacant',
            hint: occupancySummaryHint('VACANT'),
        },
        {
            key: 'NON_ALLOTABLE',
            label: 'Non-allotable',
            value: summary.nonAllotable,
            tone: 'non-allotable',
            hint: occupancySummaryHint('NON_ALLOTABLE'),
        },
        {
            key: 'no_owner',
            label: 'No owner',
            value: summary.noOwnerFlats,
            tone: 'warn',
            hint: occupancySummaryHint('NO_OWNER'),
        },
    ].filter((c) => c.value > 0 || ['all', 'VACANT', 'NON_ALLOTABLE', 'OWNER_OCCUPIED', 'TENANT_OCCUPIED', 'no_owner'].includes(c.key));

    if (summary.underRenovation) {
        cards.push({ key: 'UNDER_RENOVATION', label: 'Renovation', value: summary.underRenovation, tone: 'reno' });
    }
    if (summary.locked) {
        cards.push({ key: 'LOCKED', label: 'Locked', value: summary.locked, tone: 'locked' });
    }
    if (summary.developerHold) {
        cards.push({ key: 'DEVELOPER_HOLD', label: 'Dev hold', value: summary.developerHold, tone: 'dev' });
    }
    return cards;
}

export function getResidentById(id) {
    return getResidents().find((r) => r.id === id) || null;
}

export function getUnitMates(unitNumber, excludeId = null) {
    return getResidentsForUnit(unitNumber).filter((r) => r.id !== excludeId);
}

export function getUnitOptions() {
    return (portalState.units || [])
        .map((u) => ({ id: u.id, number: u.number, block: u.block || getResidentBlock(u.number) }))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

export function getBlocks() {
    return getBlockOptions();
}

export function occupancyForUnit(unitNumber) {
    const mates = getResidentsForUnit(unitNumber);
    const key = classifyUnitOccupancy(mates, unitRecordFor(unitNumber));
    return { key, meta: OCCUPANCY_SUMMARY[key] || null, mates };
}

export async function saveResident(payload, residentId = null) {
    const json = await propertyFetch('/api/property/residents', {
        method: 'POST',
        body: { ...payload, id: residentId || payload.id || undefined },
    });
    await loadResidentsPropertyState();
    return json;
}

export async function deleteResident(id) {
    await propertyFetch(`/api/property/residents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadResidentsPropertyState();
}

export async function deleteFlat(unitNumber) {
    await propertyFetch(`/api/property/units/${encodeURIComponent(unitNumber)}`, { method: 'DELETE' });
    await loadResidentsPropertyState();
}

export async function importResidentsFromSheet(residents, mode = 'update_listed') {
    const json = await propertyFetch('/api/property/residents/import', {
        method: 'POST',
        body: { rows: residents, mode },
    });
    await loadResidentsPropertyState();
    return { count: json.count || 0 };
}

export async function exportResidentsExcel({
    search = '',
    kind = '',
    residency = '',
    primaryOnly = false,
    block = '',
} = {}) {
    const ExcelJS = (await import('exceljs')).default;
    await loadResidentsPropertyState();
    const { rows } = listResidentsFiltered({
        search, kind, residency, primaryOnly, block,
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Residents');
    ws.addRow(['Flat', 'Type', 'Name', 'Phone', 'Email', 'Primary', 'Residing', 'Notes']);
    rows.forEach((r) => ws.addRow([
        r.unit_number,
        r.kind,
        r.full_name,
        r.phone || '',
        r.email || '',
        r.is_primary ? 'Yes' : '',
        r.is_residing === false ? 'No' : 'Yes',
        r.notes || '',
    ]));
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Residents_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    return { count: rows.length };
}

export function previewNamesForUnit(occ, owners, tenants) {
    if (occ === 'TENANT_OCCUPIED') return tenants;
    if (occ === 'OWNER_OCCUPIED') return owners.filter((r) => r.is_residing !== false);
    if (occ === 'VACANT') return owners.filter((r) => r.is_residing === false);
    return [];
}

export function previewFallbackLabel(occ) {
    if (occ === 'NON_ALLOTABLE') return 'Non-allotable';
    if (occ === 'VACANT') return 'Nobody residing';
    if (occ === 'UNDER_RENOVATION') return 'Under renovation';
    if (occ === 'LOCKED') return 'Locked';
    if (occ === 'DEVELOPER_HOLD') return 'Developer hold';
    return 'No residents';
}
