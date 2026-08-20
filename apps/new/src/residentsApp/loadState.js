/**
 * Load property domain (units + residents) from Mongo for the Residents MPA.
 */
import { loadPropertyState } from '../propertyApp/loadState.js';

export async function loadResidentsPropertyState() {
    const { units, residents } = await loadPropertyState();
    return { units, residents };
}
