import { mountAdminReactApp } from './mount.jsx';

async function main() {
    const status = document.querySelector('.property-mpa-status');
    try {
        if (status) status.textContent = 'Loading administration…';
        await mountAdminReactApp();
    } catch (err) {
        console.error(err);
        if (status) {
            status.textContent = err?.message || 'Failed to start Administration.';
            status.style.color = '#b91c1c';
        }
    }
}

main();
