import { clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';
import { MPA_ROUTE_PATHS } from '../appShell/routes.js';
import { ensureMpaCookieSession } from '../appShell/mpaAuth.js';
import { hydrateWorkspaceSession } from '../appShell/workspaceBoot.js';

export async function bootAdminApp({ route = 'an-society' } = {}) {
    const ok = await ensureMpaCookieSession();
    if (!ok) {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    const { ctx } = await hydrateWorkspaceSession();

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
    await hydrateWorkspaceSession({ apartmentHint: apartmentId, force: true });
    window.location.reload();
}

export { clearMpaCtx };
