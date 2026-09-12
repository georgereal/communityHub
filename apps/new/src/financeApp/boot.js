/**
 * Finance MPA boot — cookie session + cached workspace chrome.
 */
import { readFinanceCtx, clearFinanceCtx } from './session.js';
import { goToLogin } from '../authRedirect.js';
import { restoreMpaNavPref } from '../appShell/navPref.js';
import { hydrateWorkspaceSession } from '../appShell/workspaceBoot.js';

export async function bootFinanceApp(opts = {}) {
    document.documentElement.dataset.financeApp = '1';
    document.documentElement.dataset.financePage = opts.page || '';
    restoreMpaNavPref();

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
    const { ctx } = await hydrateWorkspaceSession({ apartmentHint: hint?.apartmentId || null });
    document.documentElement.dataset.financePage = opts.page || '';

    try {
        const { clearWrongShellLatch } = await import('../appShell/forceDocumentNav.js');
        clearWrongShellLatch();
    } catch { /* ignore */ }

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
    await hydrateWorkspaceSession({ apartmentHint: apartmentId, force: true });
    window.location.reload();
}

export { clearFinanceCtx, readFinanceCtx };
