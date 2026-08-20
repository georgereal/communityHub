import React from 'react';
import { mountPropertyReactPage } from '../mount.jsx';
import VehicleList from './VehicleList.jsx';

async function main() {
    const status = document.querySelector('.property-mpa-status');
    try {
        if (status) status.textContent = 'Loading parking…';
        await mountPropertyReactPage({
            page: 'parking',
            route: 'pn-vehicles',
            pageLabel: 'Parking & Vehicles',
            rootId: 'property-parking-root',
            renderApp: () => <VehicleList />,
        });
    } catch (err) {
        console.error(err);
        if (status) {
            status.textContent = err?.message || 'Failed to start Parking.';
            status.style.color = '#b91c1c';
        }
    }
}

main();
