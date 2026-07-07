import { portalState, persist, supabase, pullState, upsertSocietyConfig } from '../../store.js';
import { initSetupAdmin } from '../../admin.js';
import { initResidentLinks } from '../../residentLinks.js';
import { renderAccessMappings, ensureAccessState } from '../../mainBoot.js';
import { processAnalytics, renderRegistry } from '../../registry.js';

let wired = false;

export default async function initSetupView() {
    if (wired) return;
    wired = true;

    initSetupAdmin();
    initResidentLinks();

    document.getElementById('save-setup-btn')?.addEventListener('click', async () => {
        const name = document.getElementById('setup-name').value;
        const car_default = parseInt(document.getElementById('setup-car').value, 10);
        const bike_default = parseInt(document.getElementById('setup-bike').value, 10);

        const activeApartment = portalState.access.apartments.find((a) => a.id === portalState.access.activeApartmentId);
        if (activeApartment && name) activeApartment.name = name;
        portalState.community.name = name;

        const apartment_id = portalState.access?.activeApartmentId;
        if (!apartment_id) return alert('No active apartment selected.');

        if (supabase) {
            const { error: cfgError } = await upsertSocietyConfig(apartment_id, { name, car_default, bike_default });
            if (cfgError) return alert(`Could not save policy: ${cfgError.message}`);

            const { error } = await supabase.from('units').update({ car_limit: car_default, bike_limit: bike_default }).eq('apartment_id', apartment_id).neq('number', '');

            if (!error) {
                await pullState();
                ensureAccessState();
                if (activeApartment && name) {
                    const refreshed = portalState.access.apartments.find((a) => a.id === activeApartment.id);
                    if (refreshed) refreshed.name = name;
                }
                portalState.community.name = name;
                renderAccessMappings();
                processAnalytics();
                renderRegistry();
                alert('Cloud Policy Synchronized: All units updated to new defaults!');
            }
        }
        persist();
    });

    document.getElementById('clear-all-btn')?.addEventListener('click', () => {
        if (confirm('DANGER: This will permanently wipe all community data (Vehicles, Accounts AND Units). Proceed?')) {
            localStorage.clear();
            portalState.units = [];
            portalState.finances.txns = [];
            persist();
            window.location.reload();
        }
    });

    document.getElementById('deep-repair-btn')?.addEventListener('click', () => {
        portalState.units.forEach((u) => { if (!u.vehicles) u.vehicles = []; u.vehicles.forEach((v) => { if (v.isParkingActive === undefined) v.isParkingActive = true; }); });
        portalState.finances.txns.forEach((t) => { if (!t.wallet) t.wallet = 'CASH'; if (!t.type) t.type = 'OUT'; });
        persist();
        alert('Deep repair complete. State sanitized.');
        window.location.reload();
    });

    document.getElementById('access-users-show-unassigned')?.addEventListener('change', () => renderAccessMappings());
}
