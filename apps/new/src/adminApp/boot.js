import { readMpaCtx, writeMpaCtx, clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';
import { MPA_ROUTE_PATHS } from '../appShell/routes.js';
import { ensureMpaCookieSession } from '../appShell/mpaAuth.js';
import {
    applyMongoBoot,
    fetchWorkspaceBoot,
    apartmentsFromBoot,
    sessionFieldsFromBoot,
} from '../appShell/workspaceBoot.js';

export async function bootAdminApp({ route = 'an-society' } = {}) {
    const ok = await ensureMpaCookieSession();
    if (!ok) {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    const hint = readMpaCtx();
    const boot = await fetchWorkspaceBoot(hint?.apartmentId);
    const apartments = apartmentsFromBoot(boot, hint?.apartmentId);
    const apartmentId = boot.activeApartmentId || apartments[0]?.id || hint?.apartmentId;
    if (!apartmentId) throw new Error('No society assigned to this account.');
    const ctx = writeMpaCtx(sessionFieldsFromBoot(boot, apartmentId, apartments));
    applyMongoBoot(boot, ctx);

    try {
        const { refreshFinanceCategoryCatalog } = await import('./api.js');
        await refreshFinanceCategoryCatalog();
    } catch (err) {
        console.warn('[adminApp] domain load:', err);
    }

    document.documentElement.dataset.mpaApp = '1';
    document.documentElement.dataset.adminApp = '1';
    try {
        window.__mpaRoutePaths = MPA_ROUTE_PATHS;
    } catch { /* ignore */ }

    return { ctx, route };
}

export async function switchAdminApartment(apartmentId) {
    if (!apartmentId) return;
    const boot = await fetchWorkspaceBoot(apartmentId);
    const apartments = apartmentsFromBoot(boot, apartmentId);
    writeMpaCtx(sessionFieldsFromBoot(boot, apartmentId, apartments));
    window.location.reload();
}

export { clearMpaCtx };
