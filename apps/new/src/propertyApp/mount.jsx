import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { bootPropertyApp, switchPropertyApartment } from './boot.js';
import { mountAppShell, setAppShellPageContent } from '../appShell/mount.js';
import { residentsTheme } from '../residentsApp/theme.js';
import '../residentsApp/residents-app.css';
import './property-app.css';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: 1, refetchOnWindowFocus: false },
    },
});

export async function mountPropertyReactPage({
    page,
    route,
    pageLabel,
    rootId,
    renderApp,
}) {
    const status = document.querySelector('#app-shell-root .property-mpa-status');
    if (status) status.textContent = 'Loading…';

    const boot = await bootPropertyApp({ page, route });
    if (!boot) return null;

    mountAppShell({
        activeRoute: route,
        moduleLabel: 'Property-New',
        pageLabel,
        onApartmentChange: (id) => switchPropertyApartment(id),
    });

    setAppShellPageContent(`
      <div class="app-shell-page-body app-shell-page-body--react">
        <div id="${rootId}"></div>
      </div>
    `);

    const host = document.getElementById(rootId);
    if (!host) throw new Error(`Missing #${rootId}`);

    const root = createRoot(host);
    root.render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={residentsTheme}>
                <CssBaseline />
                {renderApp()}
            </ThemeProvider>
        </QueryClientProvider>,
    );
    return { ctx: boot.ctx, root };
}
