/** Domain-scoped apartment state loaders for /api/state */

export const STATE_DOMAINS = ['core', 'property', 'finance', 'operations', 'security', 'portal', 'admin'];

function emptyArr(result) {
    return result?.error ? [] : (result?.data || []);
}

function maybeNull(result) {
    return result?.error ? null : (result?.data ?? null);
}

function collectErrors(results) {
    return results.filter((r) => r?.error).map((r) => r.error.message);
}

function hydrateUnitsWithVehicles(units, vehicles) {
    return (units || []).map((unit) => ({
        ...unit,
        vehicles: (vehicles || []).filter((veh) => veh.unit_id == unit.id),
    }));
}

function hydrateSlots(slots, vehicles, units) {
    return (slots || []).map((slot) => {
        const vMatch = (vehicles || []).find((veh) => veh.id === slot.assigned_vehicle_id);
        return {
            ...slot,
            occupant: vMatch ? vMatch.plate : null,
            unit_num: vMatch ? units.find((ux) => ux.id === vMatch.unit_id)?.number : null,
        };
    });
}

/**
 * Boot / shell state — units, vehicles, and society config only.
 * Finance, operations, portal, etc. load via ensureRouteState when a view needs them.
 */
export async function fetchCoreState(service, apartmentId) {
    const queries = [
        service.from('units').select('*').eq('apartment_id', apartmentId).order('number'),
        service.from('vehicles').select('*').eq('apartment_id', apartmentId),
        service.from('society_config').select('*').eq('apartment_id', apartmentId).maybeSingle(),
    ];

    const results = await Promise.all(queries);
    const [u, v, s] = results;
    const units = emptyArr(u);
    const vehicles = emptyArr(v);

    return {
        errors: collectErrors(results),
        domain: 'core',
        community: s.data ? {
            name: s.data.name,
            defaults: { cars: s.data.car_default, bikes: s.data.bike_default },
            configId: s.data.id,
        } : { name: 'CommunityHub', defaults: { cars: 1, bikes: 1 }, configId: null },
        units: hydrateUnitsWithVehicles(units, vehicles),
        meta: {
            apartmentId,
            unitCount: units.length,
            vehicleCount: vehicles.length,
            at: new Date().toISOString(),
        },
    };
}

export async function fetchPropertyState(service, apartmentId) {
    const queries = [
        service.from('units').select('*').eq('apartment_id', apartmentId).order('number'),
        service.from('vehicles').select('*').eq('apartment_id', apartmentId),
        service.from('parking_slots').select('*').eq('apartment_id', apartmentId).order('name'),
        service.from('residents').select('*').eq('apartment_id', apartmentId).order('unit_number'),
    ];
    const results = await Promise.all(queries);
    const [u, v, p, res] = results;
    const units = emptyArr(u);
    const vehicles = emptyArr(v);

    return {
        errors: collectErrors(results),
        domain: 'property',
        units: hydrateUnitsWithVehicles(units, vehicles),
        slots: hydrateSlots(emptyArr(p), vehicles, units),
        residents: emptyArr(res),
    };
}

async function fetchFinanceIntegrations(service, apartmentId, userId) {
    const uid = userId || '00000000-0000-0000-0000-000000000000';
    const queries = [
        service.from('ledger_sync_settings').select('*').eq('apartment_id', apartmentId).maybeSingle(),
        service.from('ledger_sync_oauth_apps').select('id, apartment_id, provider, client_id, tenant_id, redirect_uri, enabled, client_secret_set, updated_at').eq('apartment_id', apartmentId),
        service.from('user_oauth_connections').select('id, provider, account_email, token_expires_at, connected_at, provider_account_id, account_meta').eq('apartment_id', apartmentId).eq('user_id', uid),
        service.rpc('get_ledger_sync_service_status', { p_apartment_id: apartmentId }),
        service.from('apartment_external_connections').select('id, apartment_id, provider, connection_key, display_name, base_url, client_id, workflow_id, enabled, api_key_set, updated_at').eq('apartment_id', apartmentId),
    ];
    const results = await Promise.all(queries);
    const [lss, loa, uoc, ssa, aec] = results;
    return {
        errors: collectErrors(results),
        finances: {
            ledgerSyncSettings: maybeNull(lss),
            ledgerOAuthApps: emptyArr(loa),
            myOAuthConnections: emptyArr(uoc),
            syncServiceAccounts: emptyArr(ssa),
        },
        admin: {
            externalConnections: emptyArr(aec),
        },
    };
}

function financeStateFromRpc(data) {
    const d = data || {};
    return {
        finances: {
            txns: d.transactions || [],
            vendors: d.vendors || [],
            subCategories: d.subCategories || [],
            maintenanceInvoices: d.maintenanceInvoices || [],
            maintenanceAllocations: d.maintenanceAllocations || [],
            maintenanceChargeHeads: d.maintenanceChargeHeads || [],
            maintenanceInvoiceLines: d.maintenanceInvoiceLines || [],
            maintenancePenaltyRules: d.maintenancePenaltyRules || [],
            maintenanceBillingGroups: d.maintenanceBillingGroups || [],
            maintenanceBillingGroupUnits: d.maintenanceBillingGroupUnits || [],
            maintenanceBillingBatches: d.maintenanceBillingBatches || [],
            maintenanceBillingBatchSkips: d.maintenanceBillingBatchSkips || [],
            maintenanceReminderLog: d.maintenanceReminderLog || [],
            bankStatementImports: d.bankStatementImports || [],
            bankStatementLines: d.bankStatementLines || [],
            bankClassificationRules: d.bankClassificationRules || [],
            // Loaded separately — finance RPC may not include this table yet.
            nobrokerInvoicesRaised: Array.isArray(d.nobrokerInvoicesRaised)
                ? d.nobrokerInvoicesRaised
                : undefined,
        },
        ledger: {
            accounts: d.ledgerAccounts || [],
            entries: d.journalEntries || [],
            lines: d.journalLines || [],
        },
    };
}

async function fetchFinanceStateParallel(service, apartmentId) {
    const queries = [
        service.from('transactions').select('*').eq('apartment_id', apartmentId).order('date', { ascending: false }),
        service.from('expense_vendors').select('*').eq('apartment_id', apartmentId).order('last_used_at', { ascending: false }),
        service.from('expense_sub_categories').select('*').eq('apartment_id', apartmentId).order('last_used_at', { ascending: false }),
        service.from('maintenance_invoices').select('*').eq('apartment_id', apartmentId).order('due_date'),
        service.from('maintenance_payment_allocations').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_charge_heads').select('*').eq('apartment_id', apartmentId).order('sort_order'),
        service.from('maintenance_invoice_lines').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_penalty_rules').select('*').eq('apartment_id', apartmentId).order('sort_order'),
        service.from('maintenance_billing_groups').select('*').eq('apartment_id', apartmentId).order('sort_order'),
        service.from('maintenance_billing_group_units').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_billing_batches').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('maintenance_billing_batch_skips').select('*').eq('apartment_id', apartmentId),
        service.from('maintenance_reminder_log').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('bank_statement_imports').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('bank_statement_lines').select('*').eq('apartment_id', apartmentId).order('line_date', { ascending: true }).order('line_order', { ascending: true }).order('source_row_index', { ascending: true }),
        service.from('bank_classification_rules').select('*').eq('apartment_id', apartmentId).order('priority', { ascending: false }).order('created_at', { ascending: true }),
        service.from('nobroker_invoices_raised').select('*').eq('apartment_id', apartmentId).order('billing_month', { ascending: false }),
        service.from('finance_documents').select('*').eq('apartment_id', apartmentId).order('doc_date', { ascending: false }),
        service.from('chart_of_accounts').select('*').eq('apartment_id', apartmentId).order('code'),
        service.from('journal_entries').select('*').eq('apartment_id', apartmentId).order('entry_date', { ascending: false }),
        service.from('journal_lines').select('*').eq('apartment_id', apartmentId),
    ];
    const results = await Promise.all(queries);
    const [
        t, ev, esc, mi, ma, mch, mil, mpr, mbg, mbgu, mbb, mbbs, mrl, bsi, bsl, bcr, nbir, fdocs, coa, je, jl,
    ] = results;

    return {
        errors: collectErrors(results),
        source: 'parallel',
        finances: {
            txns: emptyArr(t),
            vendors: emptyArr(ev),
            subCategories: emptyArr(esc),
            maintenanceInvoices: emptyArr(mi),
            maintenanceAllocations: emptyArr(ma),
            maintenanceChargeHeads: emptyArr(mch),
            maintenanceInvoiceLines: emptyArr(mil),
            maintenancePenaltyRules: emptyArr(mpr),
            maintenanceBillingGroups: emptyArr(mbg),
            maintenanceBillingGroupUnits: emptyArr(mbgu),
            maintenanceBillingBatches: emptyArr(mbb),
            maintenanceBillingBatchSkips: emptyArr(mbbs),
            maintenanceReminderLog: emptyArr(mrl),
            bankStatementImports: emptyArr(bsi),
            bankStatementLines: emptyArr(bsl),
            bankClassificationRules: emptyArr(bcr),
            nobrokerInvoicesRaised: emptyArr(nbir),
            financeDocuments: emptyArr(fdocs),
        },
        ledger: {
            accounts: emptyArr(coa),
            entries: emptyArr(je),
            lines: emptyArr(jl),
        },
    };
}

export async function fetchFinanceState(service, apartmentId, userId) {
    let financeChunk;
    try {
        const { data, error } = await service.rpc('get_apartment_finance_state', { p_apartment_id: apartmentId });
        if (!error && data) {
            financeChunk = { ...financeStateFromRpc(data), errors: [], source: 'rpc' };
        }
    } catch {
        financeChunk = null;
    }

    if (!financeChunk) {
        financeChunk = await fetchFinanceStateParallel(service, apartmentId);
    }

    // Finance RPC does not return nobroker_invoices_raised (yet). An empty [] from
    // `d.field || []` used to skip this fetch — always load from the table when missing
    // or when state came from RPC without that key.
    const raisedFromChunk = financeChunk.finances?.nobrokerInvoicesRaised;
    if (!Array.isArray(raisedFromChunk)) {
        const nbir = await service
            .from('nobroker_invoices_raised')
            .select('*')
            .eq('apartment_id', apartmentId)
            .order('billing_month', { ascending: false });
        financeChunk = {
            ...financeChunk,
            finances: {
                ...(financeChunk.finances || {}),
                nobrokerInvoicesRaised: emptyArr(nbir),
            },
            errors: [...(financeChunk.errors || []), ...collectErrors([nbir])],
        };
    }

    const docsFromChunk = financeChunk.finances?.financeDocuments;
    if (!Array.isArray(docsFromChunk)) {
        const fdocs = await service
            .from('finance_documents')
            .select('*')
            .eq('apartment_id', apartmentId)
            .order('doc_date', { ascending: false });
        financeChunk = {
            ...financeChunk,
            finances: {
                ...(financeChunk.finances || {}),
                financeDocuments: emptyArr(fdocs),
            },
            errors: [...(financeChunk.errors || []), ...collectErrors([fdocs])],
        };
    }

    const integrations = await fetchFinanceIntegrations(service, apartmentId, userId);

    return {
        domain: 'finance',
        errors: [...(financeChunk.errors || []), ...(integrations.errors || [])],
        source: financeChunk.source,
        finances: {
            ...(financeChunk.finances || {}),
            ...(integrations.finances || {}),
        },
        ledger: financeChunk.ledger || { accounts: [], entries: [], lines: [] },
        admin: integrations.admin || {},
    };
}

export async function fetchOperationsState(service, apartmentId) {
    const queries = [
        service.from('helpdesk_tickets').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('unit_transitions').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('unit_documents').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('society_assets').select('*').eq('apartment_id', apartmentId).order('name'),
        service.from('asset_service_log').select('*').eq('apartment_id', apartmentId).order('service_date', { ascending: false }),
        service.from('amenities').select('*').eq('apartment_id', apartmentId).order('name'),
        service.from('amenity_bookings').select('*').eq('apartment_id', apartmentId).order('starts_at', { ascending: false }),
        service.from('staff_attendance').select('*').eq('apartment_id', apartmentId).order('work_date', { ascending: false }),
        service.from('payroll_runs').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('society_notices').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('email_outbox').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
    ];
    const results = await Promise.all(queries);
    const [hd, ut, ud, sa, asl, am, ab, att, pr, sn, em] = results;

    return {
        domain: 'operations',
        errors: collectErrors(results),
        operations: {
            helpdeskTickets: emptyArr(hd),
            unitTransitions: emptyArr(ut),
            unitDocuments: emptyArr(ud),
            societyAssets: emptyArr(sa),
            assetServiceLog: emptyArr(asl),
            amenities: emptyArr(am),
            amenityBookings: emptyArr(ab),
            staffAttendance: emptyArr(att),
            payrollRuns: emptyArr(pr),
        },
        portal: {
            notices: emptyArr(sn),
        },
        email: {
            outbox: emptyArr(em),
        },
    };
}

export async function fetchSecurityState(service, apartmentId) {
    const queries = [
        service.from('visitor_log').select('*').eq('apartment_id', apartmentId).order('entry_at', { ascending: false }),
        service.from('visitor_log_units').select('*').eq('apartment_id', apartmentId),
        service.from('gate_parcels').select('*').eq('apartment_id', apartmentId).order('received_at', { ascending: false }),
        service.from('visitor_parking_passes').select('*').eq('apartment_id', apartmentId).order('valid_until', { ascending: false }),
    ];
    const results = await Promise.all(queries);
    const [vl, vlu, gp, vpp] = results;

    return {
        domain: 'security',
        errors: collectErrors(results),
        operations: {
            visitorLog: emptyArr(vl),
            visitorLogUnits: emptyArr(vlu),
            gateParcels: emptyArr(gp),
        },
        parking: {
            visitorPasses: emptyArr(vpp),
        },
    };
}

export async function fetchPortalState(service, apartmentId, userId) {
    const uid = userId || '00000000-0000-0000-0000-000000000000';
    const queries = [
        service.from('resident_user_links').select('*').eq('apartment_id', apartmentId),
        service.from('resident_portal_invites').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('payment_intents').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        service.from('apartment_payment_config').select('*').eq('apartment_id', apartmentId).maybeSingle(),
        service.from('society_notices').select('*').eq('apartment_id', apartmentId).order('created_at', { ascending: false }),
        userId
            ? service.from('notice_read_log').select('*').eq('user_id', uid)
            : Promise.resolve({ data: [], error: null }),
        service.from('maintenance_invoices').select('*').eq('apartment_id', apartmentId).order('due_date'),
        service.from('maintenance_payment_allocations').select('*').eq('apartment_id', apartmentId),
    ];
    const results = await Promise.all(queries);
    const [rul, rpi, pi, pc, sn, nrl, mi, ma] = results;

    return {
        domain: 'portal',
        errors: collectErrors(results),
        portal: {
            residentLinks: emptyArr(rul),
            portalInvites: emptyArr(rpi),
            paymentIntents: emptyArr(pi),
            paymentConfig: maybeNull(pc),
            notices: emptyArr(sn),
            noticeReadLog: emptyArr(nrl),
        },
        finances: {
            maintenanceInvoices: emptyArr(mi),
            maintenanceAllocations: emptyArr(ma),
        },
    };
}

export async function fetchAdminState(service, apartmentId) {
    const queries = [
        service.from('apartment_bank_accounts').select('*').eq('apartment_id', apartmentId).maybeSingle(),
        service.from('staff_members').select('*').eq('apartment_id', apartmentId).order('full_name'),
        service.from('expense_vendors').select('*').eq('apartment_id', apartmentId).order('last_used_at', { ascending: false }),
        service.from('expense_sub_categories').select('*').eq('apartment_id', apartmentId).order('last_used_at', { ascending: false }),
    ];
    const results = await Promise.all(queries);
    const [bank, staff, ev, esc] = results;

    return {
        domain: 'admin',
        errors: collectErrors(results),
        admin: {
            bankAccount: maybeNull(bank),
            staff: emptyArr(staff),
        },
        finances: {
            vendors: emptyArr(ev),
            subCategories: emptyArr(esc),
        },
    };
}

export async function fetchParkingState() {
    // Parking fines/violations removed — visitor passes live under security domain.
    return {
        domain: 'parking',
        errors: [],
        parking: {},
    };
}

export async function fetchAllLegacyState(service, apartmentId, userId) {
    const chunks = await Promise.all([
        fetchCoreState(service, apartmentId),
        fetchPropertyState(service, apartmentId),
        fetchFinanceState(service, apartmentId, userId),
        fetchOperationsState(service, apartmentId),
        fetchSecurityState(service, apartmentId),
        fetchPortalState(service, apartmentId, userId),
        fetchAdminState(service, apartmentId),
    ]);
    return mergeDomainStates(chunks, apartmentId);
}

export function mergeDomainStates(chunks, apartmentId) {
    const merged = {
        errors: [],
        meta: { apartmentId, at: new Date().toISOString() },
    };

    for (const chunk of chunks) {
        if (!chunk) continue;
        if (chunk.errors?.length) merged.errors.push(...chunk.errors);
        if (chunk.meta) merged.meta = { ...merged.meta, ...chunk.meta };
        if (chunk.community) merged.community = chunk.community;
        if (chunk.units) merged.units = chunk.units;
        if (chunk.slots) merged.slots = chunk.slots;
        if (chunk.residents) merged.residents = chunk.residents;
        if (chunk.finances) merged.finances = { ...(merged.finances || {}), ...chunk.finances };
        if (chunk.admin) merged.admin = { ...(merged.admin || {}), ...chunk.admin };
        if (chunk.portal) merged.portal = { ...(merged.portal || {}), ...chunk.portal };
        if (chunk.operations) merged.operations = { ...(merged.operations || {}), ...chunk.operations };
        if (chunk.parking) merged.parking = { ...(merged.parking || {}), ...chunk.parking };
        if (chunk.ledger) merged.ledger = { ...(merged.ledger || {}), ...chunk.ledger };
        if (chunk.email) merged.email = { ...(merged.email || {}), ...chunk.email };
    }

    return merged;
}

export async function fetchDomainState(service, domain, apartmentId, userId) {
    switch (domain) {
        case 'core': return fetchCoreState(service, apartmentId);
        case 'property': return fetchPropertyState(service, apartmentId);
        case 'finance': return fetchFinanceState(service, apartmentId, userId);
        case 'operations': return fetchOperationsState(service, apartmentId);
        case 'security': return fetchSecurityState(service, apartmentId);
        case 'portal': return fetchPortalState(service, apartmentId, userId);
        case 'admin': return fetchAdminState(service, apartmentId);
        case 'parking': return fetchParkingState(service, apartmentId);
        case 'all': return fetchAllLegacyState(service, apartmentId, userId);
        default:
            throw Object.assign(new Error(`Unknown state domain: ${domain}`), { status: 400 });
    }
}
