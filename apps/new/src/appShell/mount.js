/**
 * Mount the reusable multi-page app shell (sidebar + topbar + main + footer).
 */
import layoutHtml from './html/layout.html?raw';
import { paintAppShellChrome } from './chrome.js';
import { hideNavProgress, installNavProgressBoot } from './navProgress.js';
import '@classic/style.css';
import './shell.css';

installNavProgressBoot();

/**
 * Ensure shell DOM exists, paint chrome, return the page content host.
 * @param {{
 *   activeRoute: string,
 *   moduleLabel?: string,
 *   pageLabel?: string,
 *   onApartmentChange?: (id: string) => Promise<void>|void,
 * }} opts
 */
export function mountAppShell(opts) {
    document.documentElement.dataset.appShell = '1';
    document.body.classList.remove('finance-mpa-body');

    let root = document.getElementById('app-shell-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'app-shell-root';
        document.body.prepend(root);
    }

    if (!document.getElementById('app-shell-layout')) {
        root.innerHTML = layoutHtml;
    } else {
        // Hard nav may leave a boot splash inside the root — remove it once shell exists.
        document.getElementById('ch-boot-splash')?.remove();
    }

    // Remove legacy finance-only chrome container if present
    document.getElementById('finance-app-root')?.remove();

    paintAppShellChrome(opts);
    hideNavProgress();

    return document.getElementById('app-shell-page');
}

/** Replace page body inside the shell. */
export function setAppShellPageContent(html) {
    const host = document.getElementById('app-shell-page');
    if (!host) return null;
    host.innerHTML = html;
    host.classList.add('active', 'content-view');
    void import('../capUi.js').then(({ applyCapabilityGates }) => applyCapabilityGates(host));
    return host;
}
