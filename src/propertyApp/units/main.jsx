import React from 'react';
import { mountPropertyReactPage } from '../mount.jsx';
import UnitList from './UnitList.jsx';

async function main() {
    const status = document.querySelector('.property-mpa-status');
    try {
        if (status) status.textContent = 'Loading units…';
        await mountPropertyReactPage({
            page: 'units',
            route: 'pn-units',
            pageLabel: 'Unit Directory',
            rootId: 'property-units-root',
            renderApp: () => <UnitList />,
        });
    } catch (err) {
        console.error(err);
        if (status) {
            status.textContent = err?.message || 'Failed to start Unit Directory.';
            status.style.color = '#b91c1c';
        }
    }
}

main();
