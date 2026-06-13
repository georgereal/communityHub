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
    finances: { txns: [], vendors: [], subCategories: [], maintenanceInvoices: [], maintenanceAllocations: [], maintenanceChargeHeads: [], maintenanceInvoiceLines: [], maintenancePenaltyRules: [], maintenanceBillingGroups: [], maintenanceBillingGroupUnits: [], maintenanceBillingBatches: [], maintenanceBillingBatchSkips: [], maintenanceReminderLog: [] },
    community: { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null },
    access: {
        apartments: [{ id: 'apt-default', name: 'CommunityHub' }],
        users: [{ id: 'usr-default', name: 'Property Lead', email: '', apartment_ids: ['apt-default'] }],
        activeApartmentId: 'apt-default',
        activeUserId: 'usr-default'
    },
    admin: { bankAccount: null, staff: [] },
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

        const [u, v, t, s, p, ev, esc, bank, staff, mi, ma, mch, mil, mpr, mbg, mbgu, mbb, mbbs, mrl] = await Promise.all([
            supabase.from('units').select('*').eq('apartment_id', activeApartmentId).order('number'),
            supabase.from('vehicles').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('transactions').select('*').eq('apartment_id', activeApartmentId).order('date', { ascending: false }),
            supabase.from('society_config').select('*').eq('apartment_id', activeApartmentId).maybeSingle(),
            supabase.from('parking_slots').select('*').eq('apartment_id', activeApartmentId).order('name'),
            supabase.from('expense_vendors').select('*').eq('apartment_id', activeApartmentId).order('last_used_at', { ascending: false }),
            supabase.from('expense_sub_categories').select('*').eq('apartment_id', activeApartmentId).order('last_used_at', { ascending: false }),
            supabase.from('apartment_bank_accounts').select('*').eq('apartment_id', activeApartmentId).maybeSingle(),
            supabase.from('staff_members').select('*').eq('apartment_id', activeApartmentId).order('full_name'),
            supabase.from('maintenance_invoices').select('*').eq('apartment_id', activeApartmentId).order('due_date'),
            supabase.from('maintenance_payment_allocations').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_charge_heads').select('*').eq('apartment_id', activeApartmentId).order('sort_order'),
            supabase.from('maintenance_invoice_lines').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_penalty_rules').select('*').eq('apartment_id', activeApartmentId).order('sort_order'),
            supabase.from('maintenance_billing_groups').select('*').eq('apartment_id', activeApartmentId).order('sort_order'),
            supabase.from('maintenance_billing_group_units').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_billing_batches').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
            supabase.from('maintenance_billing_batch_skips').select('*').eq('apartment_id', activeApartmentId),
            supabase.from('maintenance_reminder_log').select('*').eq('apartment_id', activeApartmentId).order('created_at', { ascending: false }),
        ]);

        if (s.data) {
            portalState.community = {
                name: s.data.name,
                defaults: { cars: s.data.car_default, bikes: s.data.bike_default },
                configId: s.data.id,
            };
        } else {
            portalState.community.configId = null;
        }

        const units = u.data || [];
        const vehicles = v.data || [];
        portalState.units = units.map(unit => ({ ...unit, vehicles: vehicles.filter(veh => veh.unit_id === unit.id) }));
        portalState.finances.txns = t.data || [];
        portalState.finances.vendors = ev.error ? [] : (ev.data || []);
        portalState.finances.subCategories = esc.error ? [] : (esc.data || []);
        portalState.finances.maintenanceInvoices = mi.error ? [] : (mi.data || []);
        portalState.finances.maintenanceAllocations = ma.error ? [] : (ma.data || []);
        portalState.finances.maintenanceChargeHeads = mch.error ? [] : (mch.data || []);
        portalState.finances.maintenanceInvoiceLines = mil.error ? [] : (mil.data || []);
        portalState.finances.maintenancePenaltyRules = mpr.error ? [] : (mpr.data || []);
        portalState.finances.maintenanceBillingGroups = mbg.error ? [] : (mbg.data || []);
        portalState.finances.maintenanceBillingGroupUnits = mbgu.error ? [] : (mbgu.data || []);
        portalState.finances.maintenanceBillingBatches = mbb.error ? [] : (mbb.data || []);
        portalState.finances.maintenanceBillingBatchSkips = mbbs.error ? [] : (mbbs.data || []);
        portalState.finances.maintenanceReminderLog = mrl.error ? [] : (mrl.data || []);
        portalState.admin.bankAccount = bank.error ? null : (bank.data || null);
        portalState.admin.staff = staff.error ? [] : (staff.data || []);

        // Hydrate slots with vehicle plate numbers
        portalState.slots = (p.data || []).map(slot => {
            const vMatch = vehicles.find(veh => veh.id === slot.assigned_vehicle_id);
            return { ...slot, occupant: vMatch ? vMatch.plate : null, unit_num: vMatch ? units.find(ux => ux.id === vMatch.unit_id)?.number : null };
        });

        return true;
    } catch (err) { console.error('Cloud-Link Broken:', err); return false; }
};

export const persist = () => { localStorage.setItem('sentry_portal_v5_platinum', JSON.stringify(portalState)); };

/** Insert or update society_config (id is required on first insert). */
export const upsertSocietyConfig = async (apartment_id, { name, car_default, bike_default }) => {
    if (!supabase) return { error: new Error('Supabase is required.') };

    const row = {
        id: portalState.community.configId || crypto.randomUUID(),
        apartment_id,
        name,
        car_default,
        bike_default,
    };

    const { data, error } = await supabase
        .from('society_config')
        .upsert(row, { onConflict: 'apartment_id' })
        .select('id');

    const savedId = data?.[0]?.id;
    if (!error && savedId) portalState.community.configId = savedId;
    return { data, error };
};

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
