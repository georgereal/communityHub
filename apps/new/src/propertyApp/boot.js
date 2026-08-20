/**
 * Property-New MPA boot — cookie session + Mongo identity/RBAC.
 */
import { readMpaCtx, writeMpaCtx, clearMpaCtx } from '../appShell/mpaSession.js';
import { goToLogin } from '../authRedirect.js';
import {
    applyMongoBoot,
    fetchWorkspaceBoot,
    apartmentsFromBoot,
    sessionFieldsFromBoot,
} from '../appShell/workspaceBoot.js';

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

    const hint = readMpaCtx();
    const boot = await fetchWorkspaceBoot(hint?.apartmentId);
    const apartments = apartmentsFromBoot(boot, hint?.apartmentId);
    const apartmentId = boot.activeApartmentId || apartments[0]?.id || hint?.apartmentId;
    if (!apartmentId) throw new Error('No society assigned to this account.');
    const ctx = writeMpaCtx(sessionFieldsFromBoot(boot, apartmentId, apartments));
    applyMongoBoot(boot, ctx);

    document.documentElement.dataset.mpaApp = '1';
    document.documentElement.dataset.propertyApp = '1';
    document.documentElement.dataset.propertyPage = page;
    return { ctx, route };
}

export async function switchPropertyApartment(apartmentId) {
    if (!apartmentId) return;
    const boot = await fetchWorkspaceBoot(apartmentId);
    const apartments = apartmentsFromBoot(boot, apartmentId);
    writeMpaCtx(sessionFieldsFromBoot(boot, apartmentId, apartments));
    window.location.reload();
}

export { clearMpaCtx };
