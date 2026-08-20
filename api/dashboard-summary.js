/**
 * Dashboard KPIs from Mongo (dues_invoices, ledger_entries, finance_config, property_units).
 * Auth/membership still uses Supabase session + user_apartments.
 */
import { requireSession } from './serverAuth.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';
import { assertUuid } from './supabaseRest.js';
import { getQueryParam } from './vercelRequest.js';
import { getMongoDb } from './mongoClient.js';
import { buildLedgerSummary } from './financeMongo/services/ledgerReads.js';
import { logMongoApi } from './mongoLog.js';

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

function computeParking(units = []) {
    let overlimitCars = 0;
    let overlimitBikes = 0;
    let cars = 0;
    let bikes = 0;
    let baseCapacity = 0;

    for (const u of units) {
        baseCapacity += (u.car_limit || 0) + (u.bike_limit || 0);
        let baseCars = 0;
        let baseBikes = 0;
        for (const v of u.vehicles || []) {
            if (!v.is_parking_active) continue;
            const allocType = String(v.allocation_type || 'BASE').toUpperCase();
            const type = String(v.type || 'CAR').toUpperCase();
            if (type === 'CAR') cars += 1;
            else bikes += 1;
            if (allocType === 'COMMON' || allocType === 'NEIGHBOR') continue;
            if (type === 'CAR') {
                baseCars += 1;
                if (baseCars > (u.car_limit || 0)) overlimitCars += 1;
            } else {
                baseBikes += 1;
                if (baseBikes > (u.bike_limit || 0)) overlimitBikes += 1;
            }
        }
    }

    const activeTotal = cars + bikes;
    return {
        units: units.length,
        cars,
        bikes,
        overlimitCars,
        overlimitBikes,
        occupancyPct: baseCapacity > 0 ? Math.round((activeTotal / baseCapacity) * 100) : null,
        baseCapacity,
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
    const [invoices, entries, units, ledgerPack, config] = await Promise.all([
        db.collection('dues_invoices')
            .find(apt)
            .project({ amount: 1, amount_paid: 1, unit_id: 1 })
            .toArray(),
        db.collection('ledger_entries')
            .find(apt)
            .project({ amount: 1, type: 1, date: 1, excluded_from_ledger: 1 })
            .toArray(),
        db.collection('property_units')
            .find(apt)
            .project({
                car_limit: 1,
                bike_limit: 1,
                vehicles: 1,
            })
            .toArray(),
        buildLedgerSummary(db, apartmentId),
        db.collection('finance_config').findOne(apt),
    ]);

    const flows = computeMonthFlows(entries);
    return {
        parking: computeParking(units),
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

        const service = await getService(req);
        const { data: mapping, error: mapErr } = await service
            .from('user_apartments')
            .select('apartment_id')
            .eq('user_id', user.id)
            .eq('apartment_id', apartmentId)
            .maybeSingle();
        if (mapErr) throw Object.assign(new Error(mapErr.message), { status: 500 });
        if (!mapping) throw Object.assign(new Error('No access to this society.'), { status: 403 });

        const db = await getMongoDb();
        const summary = await buildDashboardSummary(db, apartmentId);
        logSummary(userId, apartmentId, Date.now() - started);
        return res.status(200).json({ ok: true, summary });
    } catch (err) {
        logSummary(userId, apartmentId, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'Dashboard summary failed.' });
    }
}
