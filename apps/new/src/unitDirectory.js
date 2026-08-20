/**
 * New Unit Directory helpers — reads apps/new portalState (Mongo property state).
 * Pure Excel/occupancy helpers still come from classic; do not use classic
 * directoryUnits() here (that reads classic SPA portalState).
 */
import { portalState } from './store.js';

const normUnit = (n) => String(n || '').trim().toUpperCase();

export {
    OCCUPANCY_STATUSES,
    OCCUPANCY_STATUS_VALUES,
    UNIT_DIRECTORY_HEADERS,
    RESIDENTS_SHEET_HEADERS,
    occupancyLabel,
    deriveUnitOccupancy,
    buildUnitDirectoryRows,
    buildResidentsSheetRows,
    parseUnitDirectoryExcel,
} from '@classic/unitDirectory.js';

export const directoryUnits = () =>
    (portalState.units || [])
        .filter((u) => u.is_community !== true)
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

export const flatDeleteConfirmMessage = (unitNumber, residents = []) => {
    const needle = normUnit(unitNumber);
    const unit = (portalState.units || []).find((u) => normUnit(u.number) === needle);
    const people = residents.length;
    const vehicles = unit ? (unit.vehicles || []).length : 0;
    const parts = [`Delete ${unitNumber} and all ${people} owner/tenant record(s)?`];
    if (unit) {
        parts.push(`Removes the flat from the unit directory${vehicles ? ` and ${vehicles} registered vehicle(s)` : ''}.`);
    } else {
        parts.push('No unit directory record exists for this flat number — only resident records will be removed.');
    }
    parts.push('Linked billing or history may block deletion if invoices exist for this flat.');
    parts.push('This cannot be undone.');
    return parts.join('\n\n');
};
