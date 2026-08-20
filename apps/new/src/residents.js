/**
 * New residents helpers — module cache is shared via classic re-exports;
 * override anything that reads portalState so New uses Mongo-backed state.
 */
export * from '@classic/residents.js';

import { portalState } from './store.js';
import { getUnitBlock } from './blockFilter.js';
import { deriveBlockFromFlat } from './parkingImport.js';

const normUnit = (n) => String(n || '').trim().toUpperCase();

export function getResidentBlock(unitNumber) {
    const unit = (portalState.units || []).find((u) => normUnit(u.number) === normUnit(unitNumber));
    if (unit) return getUnitBlock(unit) || deriveBlockFromFlat(unit.number) || '';
    return deriveBlockFromFlat(unitNumber) || '';
}
