/**
 * Property-New MPA boot — cookie session + cached workspace chrome.
 */
import { clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';
import { hydrateWorkspaceSession } from '../appShell/workspaceBoot.js';

export async function bootPropertyApp({ page = '', route = 'pn-residents' } = {}) {
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
    document.documentElement.dataset.propertyApp = '1';
    document.documentElement.dataset.propertyPage = page;
    return { ctx, route };
}

export async function switchPropertyApartment(apartmentId) {
    if (!apartmentId) return;
    await hydrateWorkspaceSession({ apartmentHint: apartmentId, force: true });
    window.location.reload();
}

export { clearMpaCtx };
