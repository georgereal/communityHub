/**
 * Classic-shaped Finance state for Finance-New UI clones.
 * Mongo remodeled collections are mapped into the same fields classic screens expect.
 *
 * Prefer per-subview loaders in load.js — do not full-hydrate on every page.
 */
import { portalState } from '../store.js';
import { emptyFinanceNewState, getFinanceNew } from './state.js';

function emptyClassicFinances() {
    return {
        txns: [],
        vendors: [],
        subCategories: [],
        maintenanceInvoices: [],
        maintenanceAllocations: [],
        maintenanceChargeHeads: [],
        maintenanceInvoiceLines: [],
        maintenancePenaltyRules: [],
        maintenanceBillingGroups: [],
        maintenanceBillingGroupUnits: [],
        maintenanceBillingBatches: [],
        maintenanceBillingBatchSkips: [],
        maintenanceReminderLog: [],
        bankStatementImports: [],
        bankStatementLines: [],
        bankClassificationRules: [],
        nobrokerInvoicesRaised: [],
        financeDocuments: [],
        expensePlanItems: [],
        expensePlanRecurring: [],
        ledgerSyncSettings: null,
        ledgerOAuthApps: [],
        myOAuthConnections: [],
        syncServiceAccounts: [],
        bankAccount: null,
    };
}

export function ensureFnClassicShape() {
    const s = getFinanceNew();
    if (!s.finances) s.finances = emptyClassicFinances();
    if (!s.ledger) s.ledger = { accounts: [], entries: [], lines: [] };
    if (!s.admin) s.admin = { bankAccount: null };
    return s;
}

export function fnFinances() {
    return ensureFnClassicShape().finances;
}

export function fnLedger() {
    return ensureFnClassicShape().ledger;
}

function mapLedgerEntry(e) {
    const { voucherIds, bankLineRefs, maintenancePayments, _schema, _remodeledAt, _id, ...rest } = e || {};
    return { ...rest, id: rest.id || _id };
}

function mapVoucher(v) {
    const { ledgerEntryId, _schema, _remodeledAt, _id, ...rest } = v || {};
    return {
        ...rest,
        id: rest.id || _id,
        transaction_id: rest.transaction_id || ledgerEntryId || null,
    };
}

function flattenBankImports(imports = []) {
    const bankStatementImports = [];
    const bankStatementLines = [];
    for (const imp of imports) {
        const { lines, lineCount, _schema, _remodeledAt, _id, ...meta } = imp || {};
        bankStatementImports.push({ ...meta, id: meta.id || _id });
        for (const line of lines || []) {
            bankStatementLines.push({
                ...line,
                id: line.id || line._id,
                import_id: meta.id || _id,
                apartment_id: meta.apartment_id,
            });
        }
    }
    return { bankStatementImports, bankStatementLines };
}

function mapDuesInvoice(inv) {
    const { lines, payments, _schema, _remodeledAt, _id, ...rest } = inv || {};
    return {
        invoice: { ...rest, id: rest.id || _id },
        lines: (lines || []).map((l) => ({
            ...l,
            id: l.id || l._id,
            invoice_id: rest.id || _id,
            apartment_id: rest.apartment_id,
        })),
        allocations: (payments || []).map((p) => ({
            id: p.id,
            apartment_id: rest.apartment_id,
            invoice_id: rest.id || _id,
            transaction_id: p.transaction_id,
            amount: p.amount,
            created_at: p.created_at,
        })),
    };
}

function mapBillingGroup(g) {
    const { unitIds, _schema, _remodeledAt, _id, ...rest } = g || {};
    const group = { ...rest, id: rest.id || _id };
    const units = (unitIds || []).map((unit_id) => ({
        group_id: group.id,
        unit_id,
        apartment_id: group.apartment_id,
    }));
    return { group, units };
}

function mapBatch(b) {
    const { skips, _schema, _remodeledAt, _id, ...rest } = b || {};
    return {
        batch: { ...rest, id: rest.id || _id },
        skips: (skips || []).map((s) => ({
            ...s,
            id: s.id || s._id,
            batch_id: rest.id || _id,
            apartment_id: rest.apartment_id,
        })),
    };
}

/** Apply Mongo packs into classic finances fields used by cloned UI. */
export function applyMongoPacksToClassic(packs = {}) {
    const s = ensureFnClassicShape();
    const f = s.finances;
    const cfg = packs.config || s.config || {};

    if (packs.config) s.config = packs.config;
    if (packs.counts) s.counts = packs.counts;

    f.vendors = cfg.vendors || f.vendors || [];
    f.subCategories = cfg.subCategories || f.subCategories || [];
    f.maintenanceChargeHeads = cfg.chargeHeads || f.maintenanceChargeHeads || [];
    f.maintenancePenaltyRules = cfg.penaltyRules || f.maintenancePenaltyRules || [];
    f.bankClassificationRules = cfg.classificationRules || f.bankClassificationRules || [];
    f.expensePlanItems = cfg.expensePlanItems || f.expensePlanItems || [];
    f.expensePlanRecurring = cfg.expensePlanRecurring || f.expensePlanRecurring || [];
    f.bankAccount = cfg.bankAccount || null;
    s.admin.bankAccount = f.bankAccount;
    s.ledger.accounts = cfg.chartOfAccounts || [];

    if (Array.isArray(packs.ledgerEntries)) {
        f.txns = packs.ledgerEntries.map(mapLedgerEntry);
        s.ledgerEntries = packs.ledgerEntries;
        s.ledgerLoaded = true;
    }
    if (Array.isArray(packs.vouchers)) {
        f.financeDocuments = packs.vouchers.map(mapVoucher);
        s.vouchers = packs.vouchers;
        s.vouchersLoaded = true;
        if (packs.vouchersTotal != null) s.vouchersTotal = packs.vouchersTotal;
    }
    if (Array.isArray(packs.bankImports)) {
        const flat = flattenBankImports(packs.bankImports);
        f.bankStatementImports = flat.bankStatementImports;
        f.bankStatementLines = flat.bankStatementLines;
        s.bankImports = packs.bankImports;
        s.bankLoaded = true;
    }
    if (Array.isArray(packs.duesInvoices) || Array.isArray(packs.billingGroups) || Array.isArray(packs.billingBatches)) {
        const invoices = [];
        const lines = [];
        const allocs = [];
        for (const inv of packs.duesInvoices || []) {
            const m = mapDuesInvoice(inv);
            invoices.push(m.invoice);
            lines.push(...m.lines);
            allocs.push(...m.allocations);
        }
        f.maintenanceInvoices = invoices;
        f.maintenanceInvoiceLines = lines;
        f.maintenanceAllocations = allocs;

        const groups = [];
        const groupUnits = [];
        for (const g of packs.billingGroups || []) {
            const m = mapBillingGroup(g);
            groups.push(m.group);
            groupUnits.push(...m.units);
        }
        f.maintenanceBillingGroups = groups;
        f.maintenanceBillingGroupUnits = groupUnits;

        const batches = [];
        const skips = [];
        for (const b of packs.billingBatches || []) {
            const m = mapBatch(b);
            batches.push(m.batch);
            skips.push(...m.skips);
        }
        f.maintenanceBillingBatches = batches;
        f.maintenanceBillingBatchSkips = skips;
        s.billingLoaded = true;
    }
    if (Array.isArray(packs.nobrokerInvoices)) {
        f.nobrokerInvoicesRaised = packs.nobrokerInvoices;
        s.nobrokerInvoices = packs.nobrokerInvoices;
        s.nobrokerLoaded = true;
    }
    return s;
}

/** @deprecated Use loadAccountsSubview / reloadFinancePacks from load.js */
export async function hydrateFinanceNewClassic({ force = false } = {}) {
    const { reloadFinancePacks } = await import('./load.js');
    return reloadFinancePacks(
        ['boot', 'ledger', 'bank', 'billing', 'nobroker', 'vouchers', 'voucherAggregates'],
        { force },
    );
}

export function resetFinanceNewClassic() {
    const s = emptyFinanceNewState();
    portalState.financeNew = s;
    ensureFnClassicShape();
    return s;
}
