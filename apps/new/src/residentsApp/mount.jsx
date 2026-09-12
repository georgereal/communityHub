/**
 * Mount Residents React MPA into the shared app shell.
 */
import { createRoot } from 'react-dom/client';
import { bootResidentsApp, switchResidentsApartment } from './boot.js';
import { mountAppShell, setAppShellPageContent } from '../appShell/mount.js';
import ResidentsApp from './App.jsx';
import './residents-app.css';

export async function mountResidentsReactApp() {
    const status = document.querySelector('#app-shell-root .finance-mpa-status, #app-shell-root .residents-mpa-status');
    if (status) status.textContent = 'Loading…';

    const ctx = await bootResidentsApp({ page: 'list' });
    if (!ctx) return null;

    mountAppShell({
        activeRoute: 'pn-residents',
        moduleLabel: 'Property-New',
        pageLabel: 'Residents',
        onApartmentChange: (id) => switchResidentsApartment(id),
    });

    setAppShellPageContent(`
      <div class="app-shell-page-body app-shell-page-body--react">
        <div id="residents-react-root"></div>
      </div>
    `);

    const host = document.getElementById('residents-react-root');
    if (!host) throw new Error('Missing #residents-react-root');

    const root = createRoot(host);
    root.render(<ResidentsApp />);
    return { ctx, root };
}
