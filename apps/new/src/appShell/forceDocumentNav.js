/**
 * Full document navigations between MPA shells.
 * Soft history changes (React Router / pushState) can leave the wrong HTML
 * entry mounted on another app's URL — same-URL assign must still reload.
 */

const WRONG_SHELL_KEY = 'ch_wrong_shell_nav';

/** @param {string} href */
export function forceDocumentNavigation(href) {
    const url = new URL(href, window.location.origin);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const here = window.location.pathname.replace(/\/$/, '') || '/';

    // Already on this URL but wrong document may still be mounted — bust cache once.
    if (here === path) {
        let alreadyTried = false;
        try {
            alreadyTried = sessionStorage.getItem(WRONG_SHELL_KEY) === path;
        } catch { /* ignore */ }
        if (alreadyTried) {
            console.error('[mpa] Wrong app shell for', path, '— stopped reload loop.');
            return false;
        }
        try {
            sessionStorage.setItem(WRONG_SHELL_KEY, path);
        } catch { /* ignore */ }
        url.searchParams.set('_chshell', String(Date.now()));
    } else {
        try {
            sessionStorage.removeItem(WRONG_SHELL_KEY);
        } catch { /* ignore */ }
    }

    window.location.assign(`${url.pathname}${url.search}${url.hash}`);
    return true;
}

/** Clear the one-shot latch after a correct shell boots. */
export function clearWrongShellLatch() {
    try {
        sessionStorage.removeItem(WRONG_SHELL_KEY);
    } catch { /* ignore */ }
}

/** Drop `_chshell` from the address bar after a successful document load. */
export function stripShellRecoveryParam() {
    try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has('_chshell')) return;
        url.searchParams.delete('_chshell');
        const next = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState(window.history.state, '', next);
    } catch { /* ignore */ }
}
