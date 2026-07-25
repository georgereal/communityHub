/**
 * Mock portalState for finance reports / bank recon screenshots (offline demo).
 */

const monthOffsets = (count, end = new Date()) => {
    const months = [];
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
        months.push({ y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) });
    }
    return months;
};

const isoDate = (y, m, day = 15) => new Date(y, m, day).toISOString();

export function buildMockFinanceState() {
    const aptId = 'apt-green-valley-001';
    const months = monthOffsets(12);
    const txns = [];
    let id = 1;
    const nextId = () => `txn-mock-${String(id++).padStart(4, '0')}`;

    const expenseCats = [
        { cat: 'Security', base: 85000, sub: 'Guard salary' },
        { cat: 'Maintenance', base: 42000, sub: 'Lift / Elevator' },
        { cat: 'Plumbing', base: 18000, sub: 'Tank cleaning' },
        { cat: 'Electrical', base: 35000, sub: 'Diesel' },
        { cat: 'Stationery', base: 4500, sub: 'Printing' },
        { cat: 'Other', base: 12000, sub: 'Miscellaneous' },
    ];

    months.forEach(({ y, m }, mi) => {
        const season = 1 + Math.sin(mi / 2) * 0.15;
        expenseCats.forEach(({ cat, base, sub }, ci) => {
            const amount = Math.round(base * season * (0.92 + (ci * 0.03)));
            txns.push({
                id: nextId(),
                apartment_id: aptId,
                type: 'OUT',
                amount,
                date: isoDate(y, m, 5 + ci * 3),
                wallet: ci % 3 === 0 ? 'CASH' : 'BANK',
                cat,
                sub_category: sub,
                vendor_name: `${cat} Vendor ${ci + 1}`,
                description: `${sub} — ${months[mi].label}`,
                external_sync_key: `xls:row-${y}${m}-${cat}`,
                sync_hash: `hash-${y}-${m}-${cat}`,
            });
        });

        const collection = Math.round(195000 + mi * 2500 + (mi % 3) * 8000);
        txns.push({
            id: nextId(),
            apartment_id: aptId,
            type: 'IN',
            amount: collection,
            date: isoDate(y, m, 28),
            wallet: 'BANK',
            cat: 'Maintenance Collection',
            description: `Maintenance collections — ${months[mi].label}`,
            bank_payment_type: 'NEFT',
            bank_reference: `NEFT/GVA/${y}${String(m + 1).padStart(2, '0')}`,
        });

        if (m === 2 || m === 8) {
            txns.push({
                id: nextId(),
                apartment_id: aptId,
                type: 'IN',
                amount: 4200,
                date: isoDate(y, m, 10),
                wallet: 'BANK',
                cat: 'Interest',
                description: 'Savings account interest',
                bank_payment_type: 'NEFT',
            });
        }
    });

    const bankLines = [];
    let lineId = 1;
    const nextLineId = () => `bsl-mock-${String(lineId++).padStart(4, '0')}`;

    const matchedTxnIds = txns.filter((t) => t.wallet === 'BANK' && t.type === 'IN').slice(0, 6);
    matchedTxnIds.forEach((t, i) => {
        const d = new Date(t.date);
        bankLines.push({
            id: nextLineId(),
            apartment_id: aptId,
            import_id: 'imp-mock-001',
            line_date: d.toISOString().slice(0, 10),
            description: t.description,
            debit: 0,
            credit: t.amount,
            balance: 1200000 + i * 45000,
            match_status: 'MATCHED',
            transaction_id: t.id,
        });
    });

    const unmatchedCredits = [
        { date: '2026-05-08', desc: 'UPI NOBROKER A-101 MAY RENT', credit: 18500, balance: 1285600 },
        { date: '2026-05-12', desc: 'UPI NOBROKER B-204 MAY RENT', credit: 22000, balance: 1307600 },
        { date: '2026-05-18', desc: 'NEFT MAINTENANCE COLLECTION BATCH', credit: 45000, balance: 1352600 },
        { date: '2026-06-02', desc: 'UPI NOBROKER A-305 JUN RENT', credit: 19500, balance: 1372100 },
    ];
    unmatchedCredits.forEach((row) => {
        bankLines.push({
            id: nextLineId(),
            apartment_id: aptId,
            import_id: 'imp-mock-001',
            line_date: row.date,
            description: row.desc,
            debit: 0,
            credit: row.credit,
            balance: row.balance,
            match_status: 'UNMATCHED',
            transaction_id: null,
        });
    });

    const unmatchedDebits = [
        { date: '2026-05-22', desc: 'NEFT SHREE ELECTRICAL DG DIESEL', debit: 28500, balance: 1324100 },
        { date: '2026-06-05', desc: 'CHQ 004892 GUARD SERVICES JUN', debit: 85000, balance: 1287100 },
    ];
    unmatchedDebits.forEach((row) => {
        bankLines.push({
            id: nextLineId(),
            apartment_id: aptId,
            import_id: 'imp-mock-001',
            line_date: row.date,
            description: row.desc,
            debit: row.debit,
            credit: 0,
            balance: row.balance,
            match_status: 'UNMATCHED',
            transaction_id: null,
        });
    });

    bankLines.push({
        id: nextLineId(),
        apartment_id: aptId,
        import_id: 'imp-mock-001',
        line_date: '2026-06-08',
        description: 'BANK CHARGES SMS ALERTS',
        debit: 118,
        credit: 0,
        balance: 1286982,
        match_status: 'IGNORED',
        transaction_id: null,
    });

    return {
        units: [
            { id: 'u-101', apartment_id: aptId, number: 'A-101', car_limit: 1, bike_limit: 1, is_community: false, vehicles: [] },
            { id: 'u-204', apartment_id: aptId, number: 'B-204', car_limit: 1, bike_limit: 1, is_community: false, vehicles: [] },
            { id: 'u-305', apartment_id: aptId, number: 'A-305', car_limit: 1, bike_limit: 1, is_community: false, vehicles: [] },
        ],
        slots: [],
        finances: {
            txns,
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
            bankStatementImports: [{ id: 'imp-mock-001', apartment_id: aptId, file_name: 'HDFC_Apr-Jun_2026.xlsx' }],
            bankStatementLines: bankLines,
            ledgerSyncSettings: null,
            ledgerOAuthApps: [],
            myOAuthConnections: [],
            syncServiceAccounts: [],
        },
        community: { name: 'Green Valley Apartments', defaults: { cars: 1, bikes: 1 }, configId: null },
        access: {
            apartments: [{ id: aptId, name: 'Green Valley Apartments' }],
            users: [{ id: 'usr-demo', name: 'Treasurer Demo', email: 'treasurer@demo.local', apartment_ids: [aptId] }],
            activeApartmentId: aptId,
            activeUserId: 'usr-demo',
        },
        auth: { id: 'usr-demo', email: 'treasurer@demo.local', name: 'Treasurer Demo', role: 'admin', effectiveRoleKey: 'apartment_admin' },
        authPermissions: [
            'vehicle_registry.view', 'vehicle_registry.edit',
            'accounts.view', 'accounts.edit',
            'setup.view', 'setup.edit',
            'rbac.view', 'rbac.edit',
            'apartment_mgmt.view', 'apartment_mgmt.edit',
            'portal.view', 'security.view',
        ],
        admin: { bankAccount: { bank_name: 'HDFC Bank', account_number: '••••4821' }, staff: [] },
        portal: { residentLinks: [], portalInvites: [], paymentIntents: [], paymentConfig: null, notices: [], noticeReadLog: [] },
        operations: { helpdeskTickets: [], unitTransitions: [], unitDocuments: [], societyAssets: [], assetServiceLog: [], amenities: [], amenityBookings: [], visitorLog: [], visitorLogUnits: [], gateParcels: [], staffAttendance: [], payrollRuns: [] },
        parking: { visitorPasses: [] },
        ledger: { accounts: [], entries: [], lines: [] },
        email: { outbox: [] },
        moduleAccess: { apartment: {}, user: {} },
        activeUnitId: null,
        editingTxnId: null,
        notifications: { items: [], unreadCount: 0 },
    };
}

export function buildMockNoBrokerLines() {
    return [
        { date: '2026-05-08', amount: 18500, description: 'A-101 · Ravi Kumar · May rent', reference: 'NB-UPI-8801', flatHint: 'A-101', source: 'nobroker' },
        { date: '2026-05-12', amount: 22000, description: 'B-204 · Priya Nair · May rent', reference: 'NB-UPI-8812', flatHint: 'B-204', source: 'nobroker' },
        { date: '2026-06-02', amount: 19500, description: 'A-305 · Suresh Menon · Jun rent', reference: 'NB-UPI-9002', flatHint: 'A-305', source: 'nobroker' },
        { date: '2026-05-05', amount: 18500, description: 'A-101 · Ravi Kumar · Apr rent', reference: 'NB-UPI-7701', flatHint: 'A-101', source: 'nobroker' },
        { date: '2026-04-08', amount: 18500, description: 'A-101 · Ravi Kumar · Mar rent', reference: 'NB-UPI-6601', flatHint: 'A-101', source: 'nobroker' },
    ];
}
