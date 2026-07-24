/**
 * Lightweight dashboard KPIs — bulk aggregate queries (not full finance state).
 */
import { requireSession } from './serverAuth.js';
import { createServiceClient, createUserClient } from './serverSupabase.js';
import { assertUuid } from './supabaseRest.js';
import { getQueryParam } from './vercelRequest.js';

function logSummary(userId, apartmentId, ms, error) {
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        layer: 'api/dashboard-summary',
        userId,
        apartmentId,
        ms,
        ok: !error,
        error: error || null,
    }));
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
            if (inv.unit_id) flats.add(inv.unit_id);
        }
        if (bal > 0.001) openCount += 1;
    }
    return {
        outstanding: round2(outstanding),
        openCount,
        flatsWithDues: flats.size,
    };
}

function computeFinance(txns = [], bankAccount = null) {
    const monthStr = monthStartIso();
    const active = (txns || []).filter((t) => !t.excluded_from_ledger);

    let monthIn = 0;
    let monthOut = 0;
    let cashBalance = 0;

    for (const t of active) {
        const amt = parseFloat(t.amount) || 0;
        const day = String(t.date || '').slice(0, 10);
        if (day >= monthStr) {
            if (t.type === 'IN') monthIn += amt;
            else monthOut += amt;
        }
        if (String(t.wallet || 'CASH').toUpperCase() !== 'BANK') {
            cashBalance += t.type === 'IN' ? amt : -amt;
        }
    }

    const openingRaw = bankAccount?.opening_balance;
    const openingAmount = openingRaw == null || openingRaw === ''
        ? null
        : parseFloat(openingRaw);
    const openingDate = bankAccount?.opening_balance_date
        ? String(bankAccount.opening_balance_date).slice(0, 10)
        : null;

    if (openingAmount == null || Number.isNaN(openingAmount)) {
        return {
            monthIn: round2(monthIn),
            monthOut: round2(monthOut),
            cashBalance: round2(cashBalance),
            bankBalance: null,
            bankAsOf: null,
            bankNeedsOpening: true,
        };
    }

    const bankTxns = active
        .filter((t) => String(t.wallet || '').toUpperCase() === 'BANK')
        .filter((t) => {
            const day = String(t.date || '').slice(0, 10);
            if (openingDate && day && day < openingDate) return false;
            return true;
        })
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    let bankBalance = openingAmount;
    for (const t of bankTxns) {
        const amt = parseFloat(t.amount) || 0;
        bankBalance += t.type === 'IN' ? amt : -amt;
    }

    return {
        monthIn: round2(monthIn),
        monthOut: round2(monthOut),
        cashBalance: round2(cashBalance),
        bankBalance: round2(bankBalance),
        bankAsOf: bankTxns.length
            ? String(bankTxns[bankTxns.length - 1].date || '').slice(0, 10)
            : openingDate,
        bankNeedsOpening: false,
    };
}

function computeSync(settings) {
    if (!settings?.spreadsheet_url) return null;
    return {
        status: settings.last_sync_status || '—',
        at: settings.last_synced_at || null,
        message: settings.last_sync_message || '',
    };
}

export async function buildDashboardSummary(service, apartmentId) {
    const [invRes, txnRes, bankRes, syncRes] = await Promise.all([
        service
            .from('maintenance_invoices')
            .select('amount, amount_paid, unit_id')
            .eq('apartment_id', apartmentId),
        service
            .from('transactions')
            .select('amount, type, date, wallet, excluded_from_ledger')
            .eq('apartment_id', apartmentId),
        service
            .from('apartment_bank_accounts')
            .select('opening_balance, opening_balance_date')
            .eq('apartment_id', apartmentId)
            .maybeSingle(),
        service
            .from('ledger_sync_settings')
            .select('spreadsheet_url, last_sync_status, last_synced_at, last_sync_message')
            .eq('apartment_id', apartmentId)
            .maybeSingle(),
    ]);

    const errors = [invRes, txnRes, bankRes, syncRes]
        .filter((r) => r?.error)
        .map((r) => r.error.message);

    return {
        billing: computeBilling(invRes.error ? [] : (invRes.data || [])),
        finance: computeFinance(
            txnRes.error ? [] : (txnRes.data || []),
            bankRes.error ? null : bankRes.data,
        ),
        sync: computeSync(syncRes.error ? null : syncRes.data),
        meta: {
            apartmentId,
            at: new Date().toISOString(),
            errors,
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

        const summary = await buildDashboardSummary(service, apartmentId);
        logSummary(userId, apartmentId, Date.now() - started);
        return res.status(200).json({ ok: true, summary });
    } catch (err) {
        logSummary(userId, apartmentId, Date.now() - started, err.message);
        return res.status(err.status || 500).json({ error: err.message || 'Dashboard summary failed.' });
    }
}
