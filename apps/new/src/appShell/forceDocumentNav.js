/**
 * Full document navigations between MPA shells (admin HTML vs finance HTML, etc.).
 * Soft history changes must never leave the wrong JS document on another app's URL.
 */
import { beginHardNavigation, showNavProgress, markHardNavPending } from './navProgress.js';

const LATCH_KEY = 'ch_wrong_shell_nav';

function pathOnly(href) {
    try {
        return new URL(href, window.location.origin).pathname.replace(/\/$/, '') || '/';
    } catch {
        return String(href || '').split('?')[0].replace(/\/$/, '') || '/';
    }
}

/**
 * Navigate with a real document load. Same-URL calls reload at most once per path
 * (latch) so soft-nav recovery cannot spin forever.
 * @param {string} href
 * @returns {boolean} false if a reload loop was blocked
 */
export function forceDocumentNavigation(href) {
    const targetPath = pathOnly(href);
    const herePath = pathOnly(window.location.pathname);

    // Already the correct finance document — never bounce.
    if (
        document.documentElement.dataset.financeApp === '1'
        && targetPath.startsWith('/finance')
        && herePath === targetPath
    ) {
        return false;
    }

    // Already the correct admin document.
    if (
        document.documentElement.dataset.adminApp === '1'
        && targetPath.startsWith('/admin')
        && herePath === targetPath
    ) {
        return false;
    }

    if (herePath === targetPath) {
        let alreadyTried = false;
        try {
            alreadyTried = sessionStorage.getItem(LATCH_KEY) === targetPath;
        } catch { /* ignore */ }
        if (alreadyTried) {
            console.error('[mpa] Wrong app shell for', targetPath, '— stopped reload loop.');
            return false;
        }
        try {
            sessionStorage.setItem(LATCH_KEY, targetPath);
        } catch { /* ignore */ }
        showNavProgress({ cover: true, label: 'Loading' });
        markHardNavPending();
        window.location.reload();
        return true;
    }

    try {
        sessionStorage.removeItem(LATCH_KEY);
    } catch { /* ignore */ }
    beginHardNavigation(href);
    return true;
}

export function clearWrongShellLatch() {
    try {
        sessionStorage.removeItem(LATCH_KEY);
    } catch { /* ignore */ }
}
