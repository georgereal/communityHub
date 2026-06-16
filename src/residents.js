/**
 * Unified residents — single source for CRUD, import, and billing contact resolution
 */
import { portalState, supabase, pullState } from './store.js';
import { getGroupById, getUnitIdsForGroup } from './billingGroups.js';
import { logActivity } from './activityAudit.js';
import { getUnitBlock } from './blockFilter.js';
import { deriveBlockFromFlat } from './parkingImport.js';

let residentsCache = null;

export const normUnit = (n) => String(n || '').trim().toUpperCase();

export const clearResidentsCache = () => { residentsCache = null; };

export const isValidEmail = (email) => {
    if (!email?.trim()) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
};

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
    };

    const { error } = residentId
        ? await supabase.from('residents').update(row).eq('id', residentId)
        : await supabase.from('residents').insert({ ...row, id: crypto.randomUUID() });
    if (error) throw new Error(error.message);

    clearResidentsCache();
    await loadResidents(true);
    await logActivity({
        entityType: 'RESIDENT',
        entityId: residentId || unit_number,
        action: residentId ? 'UPDATE' : 'CREATE',
        summary: `${residentId ? 'Updated' : 'Added'} resident ${full_name} (${unit_number})`,
        newData: row,
    });
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
