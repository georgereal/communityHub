/**
 * Sentry Cloud Store (Relational)
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

export let portalState = {
    units: [],
    slots: [], // Shared Community Slots
    finances: { txns: [] },
    community: { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 } },
    access: {
        apartments: [{ id: 'apt-default', name: 'CommunityHub' }],
        users: [{ id: 'usr-default', name: 'Property Lead', email: '', apartment_ids: ['apt-default'] }],
        activeApartmentId: 'apt-default',
        activeUserId: 'usr-default'
    },
    activeUnitId: null,
    editingTxnId: null
};

/**
 * Platinum Cloud Pull: Deep-fetch all relational partitions
 */
export const pullState = async () => {
    if (!supabase) return false;
    try {
        const activeApartmentId = portalState.access?.activeApartmentId;
        if (!activeApartmentId) throw new Error('No active apartment selected');

        const [u, v, t, s, p] = await Promise.all([
            supabase.from('units').select('*').eq('apartment_id', activeApartmentId).order('number'),
            supabase.from('vehicles').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('transactions').select('*').eq('apartment_id', activeApartmentId).order('date', { ascending: false }),
            supabase.from('society_config').select('*').eq('apartment_id', activeApartmentId).maybeSingle(),
            supabase.from('parking_slots').select('*').eq('apartment_id', activeApartmentId).order('name')
        ]);

        if (s.data) portalState.community = { name: s.data.name, defaults: { cars: s.data.car_default, bikes: s.data.bike_default } };

        const units = u.data || [];
        const vehicles = v.data || [];
        portalState.units = units.map(unit => ({ ...unit, vehicles: vehicles.filter(veh => veh.unit_id === unit.id) }));
        portalState.finances.txns = t.data || [];

        // Hydrate slots with vehicle plate numbers
        portalState.slots = (p.data || []).map(slot => {
            const vMatch = vehicles.find(veh => veh.id === slot.assigned_vehicle_id);
            return { ...slot, occupant: vMatch ? vMatch.plate : null, unit_num: vMatch ? units.find(ux => ux.id === vMatch.unit_id)?.number : null };
        });

        return true;
    } catch (err) { console.error('Cloud-Link Broken:', err); return false; }
};

export const persist = () => { localStorage.setItem('sentry_portal_v5_platinum', JSON.stringify(portalState)); };

export const migrateAndRecover = async () => {
    // 1. Try to restore active apartment from local storage first
    const local = localStorage.getItem('sentry_portal_v5_platinum');
    if (local) {
        try {
            const savedState = JSON.parse(local);
            if (savedState.access?.activeApartmentId) {
                portalState.access.activeApartmentId = savedState.access.activeApartmentId;
            }
        } catch (e) { console.error('Local state recovery failed', e); }
    }

    // 2. Now pull data for that specific apartment
    const cloudLink = await pullState();
    
    // 3. Fallback to local data if offline
    if (!cloudLink && local) {
        portalState = JSON.parse(local);
        return true;
    }

    if (!portalState.access) {
        portalState.access = {
            apartments: [{ id: 'apt-default', name: portalState.community?.name || 'CommunityHub' }],
            users: [{ id: 'usr-default', name: 'Property Lead', email: '', apartment_ids: ['apt-default'] }],
            activeApartmentId: 'apt-default',
            activeUserId: 'usr-default'
        };
    }
    return cloudLink;
};
