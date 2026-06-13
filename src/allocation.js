import { portalState } from './store.js';
import { getSlotPoolKind } from './parkingImport.js';

/** Parking slot linked to a vehicle on EH/BH community pool (if any). */
export const getCommunityPoolSlotForVehicle = (v) => {
  if (v.allocation_target_id) {
    const slot = portalState.slots.find((s) => s.id === v.allocation_target_id);
    if (slot && getSlotPoolKind(slot)) return slot;
  }
  return portalState.slots.find((s) => s.assigned_vehicle_id === v.id && getSlotPoolKind(s)) || null;
};

const isCarVehicle = (v) => (v.type || 'CAR').toUpperCase() === 'CAR';

/** Active vehicles on community pool for this unit, filtered by EH (car) or BH (bike) pool. */
export const getExtraPoolVehicles = (unit, poolKind) => {
  return (unit.vehicles || []).filter((v) => {
    if (!v.is_parking_active) return false;
    if (effectiveAllocationType(v) !== 'COMMON') return false;
    const slot = getCommunityPoolSlotForVehicle(v);
    if (!slot || getSlotPoolKind(slot) !== poolKind) return false;
    if (poolKind === 'car') return isCarVehicle(v);
    return !isCarVehicle(v);
  });
};

export const countExtraPoolVehicles = (unit, poolKind) =>
  getExtraPoolVehicles(unit, poolKind).length;

/** Resolve allocation including EH/BH pool rows linked via parking_slots. */
export const effectiveAllocationType = (v) => {
  const declared = (v.allocation_type || 'BASE').toUpperCase();
  if (declared === 'COMMON' || declared === 'NEIGHBOR') return declared;

  const poolSlot = portalState.slots.find(
    (s) => s.assigned_vehicle_id === v.id && getSlotPoolKind(s),
  );
  if (poolSlot) return 'COMMON';

  if (v.allocation_target_id) {
    const slot = portalState.slots.find((s) => s.id === v.allocation_target_id);
    if (slot && getSlotPoolKind(slot)) return 'COMMON';
    if (portalState.units.some((u) => u.id === v.allocation_target_id)) return 'NEIGHBOR';
  }
  return 'BASE';
};

export const resolveAllocationTargetLabel = (v) => {
  const alloc = effectiveAllocationType(v);
  if (alloc === 'COMMON') {
    const slot = portalState.slots.find((s) => s.id === v.allocation_target_id);
    return slot?.name || null;
  }
  if (alloc === 'NEIGHBOR') {
    const unit = portalState.units.find((u) => u.id === v.allocation_target_id);
    return unit?.number ? `Unit ${unit.number}` : null;
  }
  return null;
};
