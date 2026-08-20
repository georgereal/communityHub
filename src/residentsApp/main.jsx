import { mountResidentsReactApp } from './mount.jsx';

async function main() {
    const status = document.querySelector('.residents-mpa-status');
    try {
        if (status) status.textContent = 'Loading residents…';
        await mountResidentsReactApp();
    } catch (err) {
        console.error(err);
        if (status) {
            status.textContent = err?.message || 'Failed to start Residents.';
            status.style.color = '#b91c1c';
        } else {
            document.body.innerHTML = `<p style="padding:1.5rem;color:#b91c1c">${err?.message || 'Failed to start Residents.'}</p>`;
        }
    }
}

main();
