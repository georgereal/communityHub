/**
 * Home MPA boot — cookie session + cached workspace chrome.
 */
import { clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';
import { ensureMpaCookieSession } from '../appShell/mpaAuth.js';
import { hydrateWorkspaceSession } from '../appShell/workspaceBoot.js';

export async function bootHomeApp() {
    const ok = await ensureMpaCookieSession();
    if (!ok) {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    const { ctx } = await hydrateWorkspaceSession();

    document.documentElement.dataset.mpaApp = '1';
    document.documentElement.dataset.homeApp = '1';
    return ctx;
}

export async function switchHomeApartment(apartmentId) {
    if (!apartmentId) return;
    await hydrateWorkspaceSession({ apartmentHint: apartmentId, force: true });
    window.location.reload();
}

export { clearMpaCtx };
