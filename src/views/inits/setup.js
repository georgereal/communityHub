import { portalState, persist, supabase, pullState, upsertSocietyConfig } from '../../store.js';
import { initSetupAdmin } from '../../admin.js';
import { initResidentLinks } from '../../residentLinks.js';
import { renderAccessRequestsAdmin } from '../../accessRequests.js';
import { renderAccessMappings, ensureAccessState } from '../../mainBoot.js';
import { processAnalytics, renderRegistry } from '../../registry.js';
import {
    initSetupSocietyAccordion,
    refreshSetupSocietyMeta,
    openSetupSection,
} from '../../setupSocietyUi.js';

let wired = false;

export default async function initSetupView() {
    if (wired) return;
    wired = true;

    initSetupAdmin();
    initResidentLinks();
    initSetupSocietyAccordion();

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
            if (cfgError) return alert(`Could not save profile: ${cfgError.message}`);

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
                refreshSetupSocietyMeta();
                alert('Society profile saved. Default parking limits applied to all units.');
            }
        }
        persist();
    });

    document.getElementById('access-users-show-unassigned')?.addEventListener('change', () => renderAccessMappings());
}

export async function refreshSetupAccessPanels() {
    initSetupSocietyAccordion();
    renderAccessMappings();
    await renderAccessRequestsAdmin();
    refreshSetupSocietyMeta();
}

export { openSetupSection };
