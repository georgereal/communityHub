/**
 * Dashboard KPIs from Mongo (dues_invoices, ledger_entries, finance_config, property_units).
 * New UI: society membership from Mongo. Classic: user_apartments. Auth JWT is Supabase.
 */
import { requireSession } from '../../../packages/server/serverAuth.js';
import { createServiceClient, createUserClient } from '../../../packages/server/serverSupabase.js';
import { assertUuid } from '../../../packages/server/supabaseRest.js';
import { getQueryParam } from '../../../packages/server/vercelRequest.js';
import { getMongoDb } from '../../../packages/server/mongoClient.js';
import {
    LEDGER_SUMMARY_ENTRY_PROJECTION,
    LEDGER_SUMMARY_VOUCHER_PROJECTION,
    ledgerSummaryVoucherFilter,
    summarizeLoadedLedger,
} from './financeMongo/services/ledgerReads.js';
import { logMongoApi } from '../../../packages/server/mongoLog.js';
import { isNewUiRequest } from '../../../packages/server/uiMode.js';
import { mongoRbacReady, userHasMongoSocietyAccess } from './rbacMongo/service.js';

function logSummary(userId, apartmentId, ms, error) {
    logMongoApi({
        method: 'GET',
        path: '/api/dashboard-summary',
        op: 'summary',
        collection: 'dues_invoices',
        userId,
        apartmentId,
        ms,
        error: error || null,
    });
}

async function getService(req) {
    const { authHeader } = await requireSession(req);
    try {
        return createServiceClient();
    } catch {
        return createUserClient(authHeader);
    }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function monthStartIso() {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
}

function computeBilling(invoices = []) {
    let outstanding = 0;
    let openCount = 0;
    const flats = new Set();
    for (const inv of invoices) {
        const amount = parseFloat(inv.amount) || 0;
        const paid = parseFloat(inv.amount_paid) || 0;
        const bal = Math.max(0, amount - paid);
        if (bal > 0.001) {
            outstanding += bal;
            openCount += 1;
            if (inv.unit_id) flats.add(inv.unit_id);
        }
    }
    return {
        outstanding: round2(outstanding),
        openCount,
        flatsWithDues: flats.size,
    };
}

function computeMonthFlows(txns = []) {
    const monthStr = monthStartIso();
    let monthIn = 0;
    let monthOut = 0;
    for (const t of txns) {
        if (t.excluded_from_ledger) continue;
        const amt = parseFloat(t.amount) || 0;
        const day = String(t.date || '').slice(0, 10);
        if (day < monthStr) continue;
        if (t.type === 'IN') monthIn += amt;
        else monthOut += amt;
    }
    return { monthIn: round2(monthIn), monthOut: round2(monthOut) };
}

function computeParking(units = [], slots = []) {
    let overlimitCars = 0;
    let overlimitBikes = 0;
    let cars = 0;
    let bikes = 0;
    let baseCars = 0;
    let baseBikes = 0;
    let baseCapacity = 0;
    let carCapacity = 0;
    let bikeCapacity = 0;

    for (const u of units) {
        if (u.is_community) continue;
        baseCapacity += (u.car_limit || 0) + (u.bike_limit || 0);
        carCapacity += (u.car_limit || 0);
        bikeCapacity += (u.bike_limit || 0);
        let unitBaseCars = 0;
        let unitBaseBikes = 0;
        for (const v of u.vehicles || []) {
            if (!v.is_parking_active) continue;
            const allocType = String(v.allocation_type || 'BASE').toUpperCase();
            const type = String(v.type || 'CAR').toUpperCase();
            if (type === 'CAR') cars += 1;
            else bikes += 1;

            // EH (COMMON) + flat-to-flat (NEIGHBOR) do not consume the flat’s base slots.
            if (allocType === 'COMMON' || allocType === 'NEIGHBOR') continue;

            if (type === 'CAR') {
                unitBaseCars += 1;
                baseCars += 1;
                if (unitBaseCars > (u.car_limit || 0)) overlimitCars += 1;
            } else {
                unitBaseBikes += 1;
                baseBikes += 1;
                if (unitBaseBikes > (u.bike_limit || 0)) overlimitBikes += 1;
            }
        }
    }

    const ehSlots = (slots || []).filter((s) => {
        const kind = String(s.pool_kind || '').toLowerCase();
        if (kind === 'car') return true;
        if (kind === 'bike') return false;
        return /^EH/i.test(String(s.name || ''));
    });
    const bhSlots = (slots || []).filter((s) => {
        const kind = String(s.pool_kind || '').toLowerCase();
        if (kind === 'bike') return true;
        if (kind === 'car') return false;
        return /^BH/i.test(String(s.name || ''));
    });
    const ehOcc = ehSlots.filter((s) => s.assigned_vehicle_id || s.occupant).length;
    const bhOcc = bhSlots.filter((s) => s.assigned_vehicle_id || s.occupant).length;

    // Occupancy % = vehicles using base flat slots ÷ flat base capacity (not EH/BH pool cars).
    const activeBase = baseCars + baseBikes;
    return {
        units: units.filter((u) => !u.is_community).length,
        cars,
        bikes,
        baseCars,
        baseBikes,
        overlimitCars,
        overlimitBikes,
        occupancyPct: baseCapacity > 0 ? Math.round((activeBase / baseCapacity) * 100) : null,
        carOccupancyPct: carCapacity > 0 ? Math.round((baseCars / carCapacity) * 100) : null,
        bikeOccupancyPct: bikeCapacity > 0 ? Math.round((baseBikes / bikeCapacity) * 100) : null,
        baseCapacity,
        carCapacity,
        bikeCapacity,
        ehOcc,
        ehTotal: ehSlots.length,
        bhOcc,
        bhTotal: bhSlots.length,
    };
}

function computeSync(config) {
    const settings = config?.ledgerSync || config?.ledger_sync_settings || null;
    if (!settings?.spreadsheet_url) return null;
    return {
        status: settings.last_sync_status || '—',
        at: settings.last_synced_at || null,
        message: settings.last_sync_message || '',
    };
}

export async function buildDashboardSummary(db, apartmentId) {
    const apt = { apartment_id: apartmentId };
    const [invoices, entries, units, slots, vouchers, config] = await Promise.all([
        db.collection('dues_invoices')
            .find(apt)
            .project({ amount: 1, amount_paid: 1, unit_id: 1 })
            .toArray(),
        db.collection('ledger_entries')
            .find(apt)
            .project(LEDGER_SUMMARY_ENTRY_PROJECTION)
            .toArray(),
        db.collection('property_units')
            .find(apt)
            .project({
                car_limit: 1,
                bike_limit: 1,
                vehicles: 1,
                is_community: 1,
            })
            .toArray(),
        db.collection('property_slots')
            .find(apt)
            .project({
                name: 1,
                pool_kind: 1,
                assigned_vehicle_id: 1,
                occupant: 1,
            })
            .toArray(),
        db.collection('vouchers')
            .find(ledgerSummaryVoucherFilter(apartmentId))
            .project(LEDGER_SUMMARY_VOUCHER_PROJECTION)
            .toArray(),
        db.collection('finance_config').findOne(apt),
    ]);

    const ledgerPack = summarizeLoadedLedger(entries, vouchers, config || {});
    const flows = computeMonthFlows(entries);
    return {
        parking: computeParking(units, slots),
        billing: computeBilling(invoices),
        finance: {
            monthIn: flows.monthIn,
            monthOut: flows.monthOut,
            cashBalance: ledgerPack.totals?.cash ?? 0,
            bankBalance: ledgerPack.totals?.bank ?? null,
            bankAsOf: ledgerPack.asOf || null,
            bankNeedsOpening: !!ledgerPack.needsOpening,
        },
        sync: computeSync(config),
        meta: {
            apartmentId,
            at: new Date().toISOString(),
            source: 'mongo',
            errors: [],
        },
    };
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const started = Date.now();
    let userId = null;
    let apartmentId = null;

    try {
        apartmentId = assertUuid(getQueryParam(req, 'apartment_id'), 'apartment_id');
        const { user } = await requireSession(req);
        userId = user.id;

        if (isNewUiRequest(req) && await mongoRbacReady()) {
            const ok = await userHasMongoSocietyAccess(user.id, apartmentId);
            if (!ok) throw Object.assign(new Error('No access to this society.'), { status: 403 });
        } else {
            const service = await getService(req);
            const { data: mapping, error: mapErr } = await service
                .from('user_apartments')
                .select('apartment_id')
                .eq('user_id', user.id)
                .eq('apartment_id', apartmentId)
                .maybeSingle();
            if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
            if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });
        }

        const db = await getMongoDb();
        const summary = await buildDashboardSummary(db, apartmentId);
        logSummary(userId, apartmentId, Date.now() - started);
        return res.status(200).json({ ok: true, summary });
    } catch (err) {
        logSummary(userId, apartmentId, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'Dashboard summary failed.' });
    }
}
