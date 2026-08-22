/**
 * Unified residents — single source for CRUD, import, and billing contact resolution
 */
import { portalState, supabase, pullState } from './store.js';
import { getGroupById, getUnitIdsForGroup } from './billingGroups.js';
import { logActivity, auditSubmitHint } from './activityAudit.js';
import { getUnitBlock } from './blockFilter.js';
import { deriveBlockFromFlat } from './parkingImport.js';

let residentsCache = null;

export const normUnit = (n) => String(n || '').trim().toUpperCase();

export const clearResidentsCache = () => { residentsCache = null; };

export const isValidEmail = (email) => {
    if (!email?.trim()) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

export function setResidentsFromState(rows) {
    residentsCache = rows || [];
}

export async function fetchResidentsForApartment(apartmentId) {
    if (!apartmentId || !supabase) return [];
    const { data, error } = await supabase
        .from('residents')
        .select('id, apartment_id, unit_number, kind, full_name, phone, email, notes, is_primary, is_residing')
        .eq('apartment_id', apartmentId)
        .order('unit_number');
    if (error) return [];
    residentsCache = data || [];
    return residentsCache;
}

export const getResidents = () => residentsCache || [];

export async function loadResidents(force = false) {
    if (residentsCache && !force) return residentsCache;
    const apartmentId = portalState.access?.activeApartmentId;
    return fetchResidentsForApartment(apartmentId);
}

export const getResidentsForUnit = (unitNumber, residents = residentsCache || []) =>
    residents.filter((r) => normUnit(r.unit_number) === normUnit(unitNumber));

export const residentFingerprint = (r) => [
    normUnit(r.unit_number),
    (r.kind || '').toUpperCase(),
    (r.full_name || '').trim().toLowerCase(),
    (r.phone || '').trim(),
    (r.email || '').trim().toLowerCase(),
].join('|');

/** Collapse identical resident rows (e.g. from double import) for display */
export const dedupeResidents = (residents) => {
    const seen = new Map();
    let hiddenCount = 0;
    for (const r of residents) {
        const key = residentFingerprint(r);
        const existing = seen.get(key);
        if (!existing) {
            seen.set(key, r);
            continue;
        }
        hiddenCount += 1;
        if (r.is_primary && !existing.is_primary) seen.set(key, r);
    }
    return { residents: [...seen.values()], hiddenCount };
};

export const getResidentBlock = (unitNumber) => {
    const unit = portalState.units.find((u) => normUnit(u.number) === normUnit(unitNumber));
    if (unit) return getUnitBlock(unit) || deriveBlockFromFlat(unit.number) || '';
    return deriveBlockFromFlat(unitNumber) || '';
};

export const groupResidentsByUnit = (residents) => {
    const groups = new Map();
    residents.forEach((r) => {
        const unit = normUnit(r.unit_number);
        const block = getResidentBlock(r.unit_number) || '—';
        const key = `${block}|${unit}`;
        if (!groups.has(key)) groups.set(key, { block, unit, residents: [] });
        groups.get(key).residents.push(r);
    });
    return [...groups.values()].sort((a, b) => {
        const blockCmp = a.block.localeCompare(b.block, undefined, { numeric: true });
        if (blockCmp) return blockCmp;
        return a.unit.localeCompare(b.unit, undefined, { numeric: true });
    });
};

export const OCCUPANCY_SUMMARY = {
    OWNER_OCCUPIED: {
        label: 'Owner residing',
        shortLabel: 'Owner residing',
        hint: 'Flat where at least one owner lives there (no tenant).',
        badge: 'occ-owner',
    },
    TENANT_OCCUPIED: {
        label: 'Tenant occupied',
        shortLabel: 'Tenant occupied',
        hint: 'Flat with a tenant — includes rented units even if owner is non-residing.',
        badge: 'occ-tenant',
    },
    VACANT: {
        label: 'Vacant',
        shortLabel: 'Vacant',
        hint: 'Nobody is residing — no tenant and no owner living there (owner may be on record but non-residing).',
        badge: 'occ-vacant',
    },
    NON_ALLOTABLE: {
        label: 'Non-allotable',
        shortLabel: 'Non-allotable',
        hint: 'No owner and no tenant on record — not assigned / not allotable yet.',
        badge: 'occ-non-allotable',
    },
    NO_OWNER: {
        label: 'No owner',
        shortLabel: 'No owner',
        hint: 'Flat has no owner on record (may still have a tenant).',
        badge: 'occ-no-owner',
    },
    UNDER_RENOVATION: { label: 'Under renovation', shortLabel: 'Renovation', hint: '', badge: 'occ-reno' },
    LOCKED: { label: 'Locked', shortLabel: 'Locked', hint: '', badge: 'occ-locked' },
    DEVELOPER_HOLD: { label: 'Developer hold', shortLabel: 'Dev hold', hint: '', badge: 'occ-dev' },
};

export const occupancySummaryLabel = (key) => OCCUPANCY_SUMMARY[key]?.label || key || '—';
export const occupancySummaryHint = (key) => OCCUPANCY_SUMMARY[key]?.hint || '';
export const occupancySummaryBadge = (key) => OCCUPANCY_SUMMARY[key]?.badge || 'occ-unknown';

export function unitMissingOwners(residents) {
    return !residents.some((r) => (r.kind || '').toUpperCase() === 'OWNER');
}

export function classifyUnitOccupancy(residents, unitRecord = null) {
    const owners = residents.filter((r) => (r.kind || '').toUpperCase() === 'OWNER');
    const tenants = residents.filter((r) => (r.kind || '').toUpperCase() === 'TENANT');
    const residingOwners = owners.filter((r) => r.is_residing !== false);
    const explicit = unitRecord?.occupancy_status;

    if (explicit && ['UNDER_RENOVATION', 'LOCKED', 'DEVELOPER_HOLD'].includes(explicit)) {
        return explicit;
    }
    if (!owners.length && !tenants.length) return 'NON_ALLOTABLE';
    if (tenants.length) return 'TENANT_OCCUPIED';
    if (residingOwners.length) return 'OWNER_OCCUPIED';
    return 'VACANT';
}

export function splitResidentsByKind(residents) {
    const owners = residents.filter((r) => (r.kind || '').toUpperCase() !== 'TENANT');
    const tenants = residents.filter((r) => (r.kind || '').toUpperCase() === 'TENANT');
    return { owners, tenants };
}

export function computeResidentPageSummary(residents, unitNumbersInScope = []) {
    const byUnit = new Map();
    residents.forEach((r) => {
        const u = normUnit(r.unit_number);
        if (!byUnit.has(u)) byUnit.set(u, []);
        byUnit.get(u).push(r);
    });

    const counts = {
        totalFlats: 0,
        ownerOccupied: 0,
        tenantOccupied: 0,
        vacant: 0,
        nonAllotable: 0,
        noOwnerFlats: 0,
        underRenovation: 0,
        locked: 0,
        developerHold: 0,
        totalOwners: 0,
        totalTenants: 0,
        residingOwners: 0,
        nonResidingOwners: 0,
    };

    unitNumbersInScope.forEach((unitNum) => {
        const key = normUnit(unitNum);
        const unitRecord = portalState.units.find((u) => normUnit(u.number) === key && u.is_community !== true);
        const unitResidents = byUnit.get(key) || [];
        const occ = classifyUnitOccupancy(unitResidents, unitRecord);

        counts.totalFlats += 1;
        if (occ === 'OWNER_OCCUPIED') counts.ownerOccupied += 1;
        else if (occ === 'TENANT_OCCUPIED') counts.tenantOccupied += 1;
        else if (occ === 'VACANT') counts.vacant += 1;
        else if (occ === 'NON_ALLOTABLE') counts.nonAllotable += 1;
        if (unitMissingOwners(unitResidents)) counts.noOwnerFlats += 1;
        else if (occ === 'UNDER_RENOVATION') counts.underRenovation += 1;
        else if (occ === 'LOCKED') counts.locked += 1;
        else if (occ === 'DEVELOPER_HOLD') counts.developerHold += 1;

        unitResidents.forEach((r) => {
            if ((r.kind || '').toUpperCase() === 'TENANT') counts.totalTenants += 1;
            else {
                counts.totalOwners += 1;
                if (r.is_residing !== false) counts.residingOwners += 1;
                else counts.nonResidingOwners += 1;
            }
        });
    });

    return counts;
}

export function residentMatchesSearch(r, filterQ) {
    if (!filterQ) return true;
    const hay = [
        r.unit_number,
        r.kind,
        r.full_name,
        r.phone,
        r.email,
        r.notes,
        r.is_primary ? 'primary' : '',
        r.is_residing === false ? 'non-residing non residing' : 'residing',
    ]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
    return hay.includes(filterQ.toLowerCase());
}

export function filterResidentsByOptions(residents, { filterQ = '', kind = '', residency = '', primaryOnly = false } = {}) {
    return residents.filter((r) => {
        if (!residentMatchesSearch(r, filterQ)) return false;
        if (kind && (r.kind || '').toUpperCase() !== kind.toUpperCase()) return false;
        if (residency === 'residing' && r.is_residing === false) return false;
        if (residency === 'non-residing' && r.is_residing !== false) return false;
        if (primaryOnly && !r.is_primary) return false;
        return true;
    });
}

export function unitPassesOccupancyFilter(occ, filterKey, { missingOwners = false } = {}) {
    if (!filterKey || filterKey === 'all') return true;
    if (filterKey === 'owners') return occ === 'OWNER_OCCUPIED' || occ === 'VACANT';
    if (filterKey === 'tenants') return occ === 'TENANT_OCCUPIED';
    if (filterKey === 'no_owner') return missingOwners;
    return occ === filterKey;
}

const getUnitLabel = (unitId) =>
    portalState.units.find((u) => u.id === unitId)?.number || '—';

const unitNumbersForInvoice = (inv) => {
    const nums = new Set();
    if (inv.billing_group_id) {
        getUnitIdsForGroup(inv.billing_group_id).forEach((id) => {
            const n = getUnitLabel(id);
            if (n !== '—') nums.add(normUnit(n));
        });
    } else if (inv.unit_id) {
        nums.add(normUnit(getUnitLabel(inv.unit_id)));
    }
    return nums;
};

export const getBillToForInvoice = (inv, residents = []) => {
    const unitNums = unitNumbersForInvoice(inv);
    const group = inv.billing_group_id ? getGroupById(inv.billing_group_id) : null;

    const matches = residents.filter((r) => unitNums.has(normUnit(r.unit_number)));
    const owners = matches.filter((r) => (r.kind || '').toUpperCase() === 'OWNER');
    const tenants = matches.filter((r) => (r.kind || '').toUpperCase() === 'TENANT');
    const primary = matches.find((r) => r.is_primary)
        || owners[0] || tenants[0] || matches[0];

    const emails = [...new Set(matches.map((r) => r.email?.trim()).filter(Boolean))];
    const name = group?.contact_name || group?.name || primary?.full_name || 'Resident';
    const flats = [...unitNums]
        .map((n) => portalState.units.find((x) => normUnit(x.number) === n)?.number || n)
        .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
        .join(', ');

    return {
        name,
        phone: primary?.phone || '',
        email: emails[0] || '',
        allEmails: emails,
        flats,
        groupName: group?.name || null,
    };
};

export async function saveResident(payload, residentId = null) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');

    const unit_number = String(payload.unit_number || '').trim();
    const full_name = String(payload.full_name || '').trim();
    if (!unit_number || !full_name) throw new Error('Flat and name are required.');
    if (!isValidEmail(payload.email)) throw new Error('Invalid email address.');

    const row = {
        apartment_id,
        unit_number,
        kind: payload.kind || 'OWNER',
        full_name,
        phone: payload.phone?.trim() || null,
        email: payload.email?.trim() || null,
        notes: payload.notes?.trim() || null,
        is_primary: !!payload.is_primary,
        is_residing: (payload.kind || 'OWNER').toUpperCase() === 'TENANT'
            ? true
            : payload.is_residing !== false,
    };

    const { error } = residentId
        ? await supabase.from('residents').update(row).eq('id', residentId)
        : await supabase.from('residents').insert({ ...row, id: crypto.randomUUID() });
    if (error) throw new Error(error.message);

    clearResidentsCache();
    await loadResidents(true);
    const auditResult = await logActivity({
        entityType: 'RESIDENT',
        entityId: residentId || unit_number,
        action: residentId ? 'UPDATE' : 'CREATE',
        summary: `${residentId ? 'Updated' : 'Added'} resident ${full_name} (${unit_number})`,
        newData: row,
    });
    return auditSubmitHint(auditResult);
}

export async function deleteResident(id) {
    if (!supabase) return;
    const { error } = await supabase.from('residents').delete().eq('id', id);
    if (error) throw error;
    clearResidentsCache();
    await loadResidents(true);
    await logActivity({
        entityType: 'RESIDENT',
        entityId: id,
        action: 'DELETE',
        summary: `Deleted resident record`,
    });
}

/** @typedef {'update_listed' | 'replace_listed' | 'full_replace'} ResidentImportMode */

export async function importResidentsFromSheet(residents, mode = 'update_listed') {
    if (!supabase) throw new Error('Supabase is not configured.');
    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) throw new Error('No active apartment selected.');
    if (!residents?.length) return { count: 0 };

    await loadResidents(true);
    const existingResidents = getResidents();

    if (mode === 'full_replace') {
        const { error } = await supabase.from('residents').delete().eq('apartment_id', apartment_id);
        if (error) throw new Error(error.message);
    }

    const byUnit = new Map();
    residents.forEach((r) => {
        const key = normUnit(r.unitNumber || r.unit_number);
        if (!byUnit.has(key)) byUnit.set(key, []);
        byUnit.get(key).push(r);
    });

    let count = 0;
    for (const [unitKey, people] of byUnit) {
        const unitLabel = people[0]?.unitNumber || people[0]?.unit_number || unitKey;

        if (mode === 'replace_listed' || mode === 'full_replace') {
            const { error: delErr } = await supabase
                .from('residents')
                .delete()
                .eq('apartment_id', apartment_id)
                .eq('unit_number', unitLabel);
            if (delErr) throw new Error(delErr.message);
        }

        if (mode === 'update_listed') {
            for (const p of people) {
                const existing = existingResidents.find((r) =>
                    normUnit(r.unit_number) === normUnit(unitLabel)
                    && normUnit(r.full_name) === normUnit(p.fullName || p.full_name)
                    && (r.kind || '').toUpperCase() === (p.kind || 'OWNER').toUpperCase(),
                );
                const row = {
                    apartment_id,
                    unit_number: unitLabel,
                    kind: (p.kind || 'OWNER').toUpperCase(),
                    full_name: p.fullName || p.full_name,
                    phone: p.phone || null,
                    email: p.email || null,
                    notes: p.notes || null,
                    is_primary: !!(p.is_primary ?? p.isPrimary),
                    is_residing: p.is_residing ?? p.isResiding ?? true,
                };
                if (existing) {
                    const { error } = await supabase.from('residents').update(row).eq('id', existing.id);
                    if (error) throw new Error(error.message);
                } else {
                    const { error } = await supabase.from('residents').insert({ ...row, id: crypto.randomUUID() });
                    if (error) throw new Error(error.message);
                }
                count += 1;
            }
        } else {
            const payload = people.map((p) => ({
                id: crypto.randomUUID(),
                apartment_id,
                unit_number: unitLabel,
                kind: (p.kind || 'OWNER').toUpperCase(),
                full_name: p.fullName || p.full_name,
                phone: p.phone || null,
                email: p.email || null,
                notes: p.notes || null,
                is_primary: !!(p.is_primary ?? p.isPrimary),
                is_residing: p.is_residing ?? p.isResiding ?? true,
            }));
            const { error: insErr } = await supabase.from('residents').insert(payload);
            if (insErr) throw new Error(insErr.message);
            count += payload.length;
        }
    }

    clearResidentsCache();
    await pullState();
    await loadResidents(true);
    await logActivity({
        entityType: 'RESIDENT',
        entityId: apartment_id,
        action: 'IMPORT',
        summary: `Imported ${count} resident row(s) (${mode})`,
        newData: { mode, count },
    });
    return { count };
}

export const warnMultipleOwners = (residents, unitNumber) => {
    const owners = getResidentsForUnit(unitNumber, residents)
        .filter((r) => (r.kind || '').toUpperCase() === 'OWNER');
    return owners.length > 1 ? `${owners.length} owners on ${unitNumber}` : null;
};
