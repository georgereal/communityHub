import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { bootAdminApp, switchAdminApartment } from './boot.js';
import { mountAppShell, setAppShellPageContent } from '../appShell/mount.js';
import { residentsTheme } from '../residentsApp/theme.js';
import { adminPageFromPathname } from './pages.js';
import AdminApp from './App.jsx';
import '../residentsApp/residents-app.css';
import './admin-app.css';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false },
    },
});

export async function mountAdminReactApp() {
    const status = document.querySelector('#app-shell-root .property-mpa-status');
    if (status) status.textContent = 'Loading…';

    const page = adminPageFromPathname();
    const boot = await bootAdminApp({ route: page.route });
    if (!boot) return null;

    mountAppShell({
        activeRoute: page.route,
        moduleLabel: ['an-vendors', 'an-categories'].includes(page.route) ? 'Operations' : 'Administration',
        pageLabel: page.label,
        onApartmentChange: (id) => switchAdminApartment(id),
    });

    setAppShellPageContent(`
      <div class="app-shell-page-body app-shell-page-body--react">
        <div id="admin-react-root"></div>
      </div>
    `);

    const host = document.getElementById('admin-react-root');
    if (!host) throw new Error('Missing #admin-react-root');

    const root = createRoot(host);
    root.render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={residentsTheme}>
                <CssBaseline />
                <AdminApp />
            </ThemeProvider>
        </QueryClientProvider>,
    );
    return { ctx: boot.ctx, root };
}
