/**
 * Residents MPA boot — cookie session + cached workspace chrome.
 */
import { clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';
import { hydrateWorkspaceSession } from '../appShell/workspaceBoot.js';

export async function bootResidentsApp(opts = {}) {
    try {
        const res = await fetch('/api/auth-session', { credentials: 'include' });
        if (!res.ok) throw new Error('auth');
    } catch {
        goToLogin('Sign in required.', {
            next: `${window.location.pathname}${window.location.search || ''}`,
        });
        return null;
    }

    const { ctx } = await hydrateWorkspaceSession();

    document.documentElement.dataset.mpaApp = '1';
    document.documentElement.dataset.residentsApp = '1';
    document.documentElement.dataset.residentsPage = opts.page || '';

    return ctx;
}

export async function switchResidentsApartment(apartmentId) {
    if (!apartmentId) return;
    await hydrateWorkspaceSession({ apartmentHint: apartmentId, force: true });
    window.location.reload();
}

export { clearMpaCtx };
