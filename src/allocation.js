import { portalState } from './store.js';
import { getSlotPoolKind } from './parkingImport.js';

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
