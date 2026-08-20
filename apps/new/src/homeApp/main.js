import { bootHomeApp, switchHomeApartment } from './boot.js';
import { mountAppShell, setAppShellPageContent } from '../appShell/mount.js';
import { homePageHtml, renderHomeDashboard } from './page.js';
import './home-app.css';

async function main() {
    const status = document.querySelector('#app-shell-root .home-mpa-status');
    if (status) status.textContent = 'Signing in…';

    try {
        const ctx = await bootHomeApp();
        if (!ctx) return;

        mountAppShell({
            activeRoute: 'dashboard',
            moduleLabel: 'Home',
            pageLabel: 'Dashboard',
            onApartmentChange: (id) => switchHomeApartment(id),
        });
        try {
            const { MPA_ROUTE_PATHS } = await import('../appShell/routes.js');
            window.__mpaRoutePaths = MPA_ROUTE_PATHS;
        } catch { /* ignore */ }
        setAppShellPageContent(homePageHtml());
        await renderHomeDashboard();
    } catch (err) {
        const host = document.getElementById('app-shell-page') || document.getElementById('app-shell-root');
        if (host) {
            host.innerHTML = `<p class="home-mpa-status" role="alert">${String(err.message || err)}</p>`;
        }
    }
}

void main();
