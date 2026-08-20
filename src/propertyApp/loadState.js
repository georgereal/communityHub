import { portalState } from '../store.js';
import { setResidentsFromState } from '../residents.js';
import { propertyFetch } from './client.js';

export async function loadPropertyState() {
    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) throw new Error('No active apartment.');
    const chunk = await propertyFetch('/api/property/state');
    if (chunk?.units) portalState.units = chunk.units;
    if (chunk?.slots) portalState.slots = chunk.slots;
    const residents = Array.isArray(chunk?.residents) ? chunk.residents : [];
    setResidentsFromState(residents);
    return {
        units: portalState.units || [],
        slots: portalState.slots || [],
        residents,
    };
}
