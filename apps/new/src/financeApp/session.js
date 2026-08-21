/**
 * Minimal Finance-New MPA session context (sessionStorage).
 * Not a full portalState snapshot — only what finance pages need to call /api/finance/*.
 */
const CTX_KEY = 'ch_finance_ctx';
const PERM_SCOPE = 'all';

export function readFinanceCtx() {
    try {
        const raw = sessionStorage.getItem(CTX_KEY);
        if (!raw) return null;
        const ctx = JSON.parse(raw);
        if (!ctx?.apartmentId) return null;
        return {
            apartmentId: String(ctx.apartmentId),
            apartmentName: ctx.apartmentName ? String(ctx.apartmentName) : '',
            userId: ctx.userId ? String(ctx.userId) : '',
            userName: ctx.userName ? String(ctx.userName) : '',
            userEmail: ctx.userEmail ? String(ctx.userEmail) : '',
            permissions: Array.isArray(ctx.permissions) ? ctx.permissions.map(String) : [],
            permScope: ctx.permScope || '',
            apartments: Array.isArray(ctx.apartments) ? ctx.apartments : [],
            updatedAt: ctx.updatedAt || null,
        };
    } catch {
        return null;
    }
}

export function writeFinanceCtx(partial = {}) {
    const prev = readFinanceCtx() || {};
    const next = {
        apartmentId: partial.apartmentId ?? prev.apartmentId ?? null,
        apartmentName: partial.apartmentName ?? prev.apartmentName ?? '',
        userId: partial.userId ?? prev.userId ?? '',
        userName: partial.userName ?? prev.userName ?? '',
        userEmail: partial.userEmail ?? prev.userEmail ?? '',
        permissions: [...new Set((partial.permissions ?? prev.permissions ?? []).map(String))],
        permScope: PERM_SCOPE,
        apartments: Array.isArray(partial.apartments)
            ? partial.apartments
            : (prev.apartments || []),
        updatedAt: new Date().toISOString(),
    };
    if (!next.apartmentId) {
        throw new Error('writeFinanceCtx requires apartmentId.');
    }
    sessionStorage.setItem(CTX_KEY, JSON.stringify(next));
    return next;
}

export function clearFinanceCtx() {
    try {
        sessionStorage.removeItem(CTX_KEY);
    } catch { /* ignore */ }
}

/** Map SPA portalState → finance ctx before navigating to /finance/*.html */
export function writeFinanceCtxFromPortal(portalState) {
    const aptId = portalState?.access?.activeApartmentId;
    if (!aptId) throw new Error('No active apartment to write finance context.');
    const apt = (portalState.access?.apartments || []).find((a) => a.id === aptId);
    const perms = Array.isArray(portalState.authPermissions) ? portalState.authPermissions : [];
    const auth = portalState.auth || {};
    return writeFinanceCtx({
        apartmentId: aptId,
        apartmentName: apt?.name || portalState.community?.name || '',
        userId: auth.id || portalState.access?.activeUserId || '',
        userName: auth.name || auth.full_name || auth.email || '',
        userEmail: auth.email || '',
        permissions: perms,
        apartments: (portalState.access?.apartments || []).map((a) => ({
            id: a.id,
            name: a.name || a.id,
        })),
    });
}

export const FINANCE_PAGES = {
    reports: { path: '/finance/reports.html', label: 'Financial reports', subview: 'reports', icon: 'fa-chart-line' },
    ledger: { path: '/finance/ledger.html', label: 'Ledger', subview: 'ledger', icon: 'fa-book' },
    docs: { path: '/finance/docs.html', label: 'Bills & receipts', subview: 'finance-docs', icon: 'fa-file-invoice' },
    'expense-plan': { path: '/finance/expense-plan.html', label: 'Expense plan', subview: 'expense-plan', icon: 'fa-calendar-check' },
    'invoices-raised': { path: '/finance/invoices-raised.html', label: 'Invoices Raised', subview: 'invoices-raised', icon: 'fa-file-invoice-dollar' },
    'bank-recon': { path: '/finance/bank-recon.html', label: 'Bank Reconciliation', subview: 'bank-recon', icon: 'fa-scale-balanced' },
};

export function financePathForRoute(route) {
    // Only Finance-New routes → MPA. Classic `finance-*` must stay in the SPA.
    const map = {
        'fn-reports': FINANCE_PAGES.reports.path,
        'fn-ledger': FINANCE_PAGES.ledger.path,
        'fn-docs': FINANCE_PAGES.docs.path,
        'fn-expense-plan': FINANCE_PAGES['expense-plan'].path,
        'fn-invoices-raised': FINANCE_PAGES['invoices-raised'].path,
        'fn-bank-recon': FINANCE_PAGES['bank-recon'].path,
    };
    return map[route] || null;
}

/** Internal Finance-New nav aliases → MPA (used only by navigateFinance, not SPA switchView). */
const FINANCE_NEW_NAV_ALIASES = {
    'finance-docs': FINANCE_PAGES.docs.path,
    'expense-plan': FINANCE_PAGES['expense-plan'].path,
    'finance-expense-plan': FINANCE_PAGES['expense-plan'].path,
    'finance-bank-recon': FINANCE_PAGES['bank-recon'].path,
    'finance-ledger': FINANCE_PAGES.ledger.path,
    'finance-reports': FINANCE_PAGES.reports.path,
    'finance-invoices-raised': FINANCE_PAGES['invoices-raised'].path,
};

/** Navigate within Finance-New MPA (or open MPA from Finance-New modules). */
export function navigateFinance(routeOrKey) {
    const path = FINANCE_PAGES[routeOrKey]?.path
        || financePathForRoute(routeOrKey)
        || FINANCE_NEW_NAV_ALIASES[routeOrKey];
    if (path) {
        void import('../appShell/forceDocumentNav.js').then((m) => {
            const here = window.location.pathname.replace(/\/$/, '') || '/';
            const there = String(path).replace(/\/$/, '') || '/';
            // Same finance page on the correct document — no-op.
            if (here === there && document.documentElement.dataset.adminApp !== '1') return;
            m.forceDocumentNavigation(path);
        });
        return;
    }
    window.switchView?.(routeOrKey);
}
