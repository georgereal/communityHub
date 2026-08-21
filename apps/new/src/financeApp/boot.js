/**
 * Finance MPA boot — cookie session + Mongo identity/RBAC.
 */
import { readFinanceCtx, writeFinanceCtx, clearFinanceCtx } from './session.js';
import { goToLogin } from '../authRedirect.js';
import { restoreMpaNavPref } from '../appShell/navPref.js';
import {
    applyMongoBoot,
    fetchWorkspaceBoot,
    apartmentsFromBoot,
    sessionFieldsFromBoot,
} from '../appShell/workspaceBoot.js';

export async function bootFinanceApp(opts = {}) {
    document.documentElement.dataset.financeApp = '1';
    document.documentElement.dataset.financePage = opts.page || '';
    restoreMpaNavPref();

    try {
        const { clearWrongShellLatch, stripShellRecoveryParam } = await import('../appShell/forceDocumentNav.js');
        clearWrongShellLatch();
        stripShellRecoveryParam();
    } catch { /* ignore */ }

    try {
        const res = await fetch('/api/auth-session', { credentials: 'include' });
        if (!res.ok) throw new Error('auth');
    } catch {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    const hint = readFinanceCtx();
    const boot = await fetchWorkspaceBoot(hint?.apartmentId);
    const apartments = apartmentsFromBoot(boot, hint?.apartmentId);
    const apartmentId = boot.activeApartmentId || apartments[0]?.id || hint?.apartmentId;
    if (!apartmentId) throw new Error('No society assigned to this account.');
    const ctx = writeFinanceCtx(sessionFieldsFromBoot(boot, apartmentId, apartments));
    applyMongoBoot(boot, ctx);
    document.documentElement.dataset.financePage = opts.page || '';

    const { initFinancePackCache } = await import('../financeNew/packCache.js');
    initFinancePackCache(ctx.apartmentId);

    return ctx;
}

export async function switchFinanceApartment(apartmentId) {
    if (!apartmentId) return;
    const prev = readFinanceCtx();
    try {
        const { clearFinancePackCache } = await import('../financeNew/packCache.js');
        clearFinancePackCache(prev?.apartmentId);
        clearFinancePackCache(apartmentId);
    } catch { /* ignore */ }
    const boot = await fetchWorkspaceBoot(apartmentId);
    const apartments = apartmentsFromBoot(boot, apartmentId);
    writeFinanceCtx(sessionFieldsFromBoot(boot, apartmentId, apartments));
    window.location.reload();
}

export { clearFinanceCtx, readFinanceCtx };
