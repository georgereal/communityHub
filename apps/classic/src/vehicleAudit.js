/**
 * Vehicle change audit — delta tracking for external system sync.
 */
import { portalState, supabase } from './store.js';
import { effectiveAllocationType, resolveAllocationTargetLabel } from './allocation.js';

const FIELD_LABELS = {
  plate: 'Plate',
  type: 'Type',
  unit_number: 'Unit',
  is_parking_active: 'Parking active',
  allocation_type: 'Allocation',
  allocation_target: 'Allocation target',
  parking_sticker: 'Parking sticker',
  rfid_tag: 'RFID tag',
  rfid_number: 'RFID number',
  registry_updated_on: 'Registry updated on',
  registry_updated_by: 'Registry updated by',
};

const AUDITED_FIELDS = Object.keys(FIELD_LABELS);

export const vehicleAuditSnapshot = (v, unitNumber) => ({
  plate: v.plate ?? null,
  type: (v.type || 'CAR').toUpperCase(),
  unit_number: unitNumber ?? null,
  is_parking_active: !!v.is_parking_active,
  allocation_type: effectiveAllocationType(v),
  allocation_target: resolveAllocationTargetLabel(v),
  parking_sticker: v.parking_sticker ?? null,
  rfid_tag: v.rfid_tag ?? null,
  rfid_number: v.rfid_number ?? null,
  registry_updated_on: v.registry_updated_on ?? null,
  registry_updated_by: v.registry_updated_by ?? null,
});

/** Flat snapshot for Excel/CSV import rows (no portalState allocation inference). */
export const vehicleAuditSnapshotFromImport = (row, unitNumber, alloc = null) => {
  const allocation_type = alloc?.allocation_type || (row.allocation_type || 'BASE').toUpperCase();
  let allocation_target = null;
  if (alloc && allocation_type !== 'BASE') allocation_target = alloc.parkingLabel || null;
  return {
    plate: row.plate ?? null,
    type: (row.type || 'CAR').toUpperCase(),
    unit_number: unitNumber ?? null,
    is_parking_active: row.is_parking_active !== false,
    allocation_type,
    allocation_target,
    parking_sticker: row.parking_sticker ?? null,
    rfid_tag: row.rfid_tag ?? null,
    rfid_number: row.rfid_number ?? null,
    registry_updated_on: row.registry_updated_on ?? null,
    registry_updated_by: row.registry_updated_by ?? null,
  };
};

const normVal = (val) => {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'boolean') return val;
  return String(val);
};

export const computeVehicleDelta = (before, after) => {
  const changes = [];
  AUDITED_FIELDS.forEach((field) => {
    const oldVal = normVal(before?.[field]);
    const newVal = normVal(after?.[field]);
    if (oldVal === newVal) return;
    changes.push({
      field,
      label: FIELD_LABELS[field] || field,
      old: oldVal,
      new: newVal,
    });
  });
  return changes;
};

const auditActor = () =>
  portalState.auth?.email || portalState.auth?.name || portalState.access?.activeUserId || null;

export const logVehicleAudit = async ({
  action,
  source = 'ui',
  vehicleId = null,
  unitNumber = null,
  plate = null,
  before = null,
  after = null,
  changes: explicitChanges = null,
}) => {
  if (!supabase) return { skipped: true };

  const apartment_id = portalState.access?.activeApartmentId;
  if (!apartment_id) return { skipped: true };

  let changes = explicitChanges;
  if (changes == null) {
    if (action === 'insert' && after) {
      changes = computeVehicleDelta({}, after);
    } else if (action === 'delete' && before) {
      changes = computeVehicleDelta(before, {});
    } else if (action === 'update' && before && after) {
      changes = computeVehicleDelta(before, after);
    } else {
      changes = [];
    }
  }

  if (action === 'update' && changes.length === 0) return { skipped: true };

  const row = {
    apartment_id,
    vehicle_id: vehicleId,
    unit_number: unitNumber ?? after?.unit_number ?? before?.unit_number ?? null,
    plate: plate ?? after?.plate ?? before?.plate ?? '—',
    action,
    source,
    changed_by: auditActor(),
    changes,
  };

  const { data, error } = await supabase.from('vehicle_audit_log').insert(row).select('id').single();
  if (error) {
    if (/vehicle_audit_log/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      console.warn('[audit] vehicle_audit_log table missing — run supabase_vehicle_audit_log.sql');
      return { skipped: true, error };
    }
    console.warn('[audit] could not log vehicle change:', error.message);
    return { error };
  }
  return { id: data?.id };
};

export const fetchVehicleAuditLog = async ({ pendingOnly = true, limit = 5000 } = {}) => {
  if (!supabase) return [];
  const apartment_id = portalState.access?.activeApartmentId;
  if (!apartment_id) return [];

  // Custom API client supports limit(), not PostgREST range().
  let q = supabase
    .from('vehicle_audit_log')
    .select('*')
    .eq('apartment_id', apartment_id)
    .order('changed_at', { ascending: false })
    .limit(limit);

  if (pendingOnly) q = q.is('synced_at', null);

  const { data, error } = await q;
  if (error) {
    if (/vehicle_audit_log/i.test(error.message)) return [];
    throw error;
  }
  return data || [];
};

export const countPendingVehicleAudit = async () => {
  if (!supabase) return 0;
  const apartment_id = portalState.access?.activeApartmentId;
  if (!apartment_id) return 0;

  const { count, error } = await supabase
    .from('vehicle_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('apartment_id', apartment_id)
    .is('synced_at', null);

  if (error) return 0;
  return count ?? 0;
};

export const markVehicleAuditSynced = async (ids) => {
  if (!supabase || !ids?.length) return { error: null };
  const synced_at = new Date().toISOString();
  const { error } = await supabase.from('vehicle_audit_log').update({ synced_at }).in('id', ids);
  return { error };
};

export const markAllPendingVehicleAuditSynced = async () => {
  if (!supabase) return { error: new Error('Supabase required') };
  const apartment_id = portalState.access?.activeApartmentId;
  if (!apartment_id) return { error: new Error('No apartment') };

  const synced_at = new Date().toISOString();
  const { error } = await supabase
    .from('vehicle_audit_log')
    .update({ synced_at })
    .eq('apartment_id', apartment_id)
    .is('synced_at', null);

  return { error };
};

const escapeHtml = (val) => {
  if (val == null) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

const normalizeChanges = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const formatChangeSummary = (entry) => {
  const changes = normalizeChanges(entry.changes);
  if (!changes.length) {
    if (entry.action === 'insert') return 'Added from Excel / registry';
    if (entry.action === 'delete') return 'Removed from system';
    return '—';
  }
  return changes
    .map((c) => `${c.label || c.field || 'Field'}: ${c.old ?? '—'} → ${c.new ?? '—'}`)
    .join('; ');
};

const escapeCsv = (val) => {
  const s = val == null ? '' : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

export const exportAuditLogCsv = (entries) => {
  const header = ['changed_at', 'action', 'unit', 'plate', 'field', 'old_value', 'new_value', 'source', 'changed_by'];
  const rows = [header.join(',')];

  entries.forEach((entry) => {
    const changes = entry.changes?.length ? entry.changes : [{ field: '', label: formatChangeSummary(entry), old: '', new: '' }];
    changes.forEach((c, idx) => {
      rows.push(
        [
          idx === 0 ? entry.changed_at : '',
          idx === 0 ? entry.action : '',
          idx === 0 ? entry.unit_number : '',
          idx === 0 ? entry.plate : '',
          c.label || c.field,
          c.old,
          c.new,
          idx === 0 ? entry.source : '',
          idx === 0 ? entry.changed_by : '',
        ]
          .map(escapeCsv)
          .join(','),
      );
    });
  });

  return rows.join('\n');
};

export const downloadPendingAuditCsv = async () => {
  const entries = await fetchVehicleAuditLog({ pendingOnly: true, limit: 5000 });
  if (!entries.length) return alert('No pending changes to export.');
  const csv = exportAuditLogCsv(entries);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vehicle-changes-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

const formatWhen = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
};

const actionBadge = (action) => {
  const cls = action === 'insert' ? 'insert' : action === 'delete' ? 'delete' : 'update';
  const label = action === 'insert' ? 'added' : action === 'delete' ? 'removed' : 'updated';
  return `<span class="audit-badge audit-badge--${cls}">${label}</span>`;
};

const actionOrder = { delete: 0, insert: 1, update: 2 };

const groupAuditByFlat = (entries) => {
  const map = new Map();
  entries.forEach((e) => {
    const flat = String(e.unit_number || '—').toUpperCase();
    if (!map.has(flat)) map.set(flat, []);
    map.get(flat).push(e);
  });
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([flat, items]) => {
      const sorted = [...items].sort((a, b) =>
        (actionOrder[a.action] ?? 9) - (actionOrder[b.action] ?? 9)
        || String(a.plate || '').localeCompare(String(b.plate || ''))
        || String(b.changed_at || '').localeCompare(String(a.changed_at || '')),
      );
      const counts = {
        insert: sorted.filter((x) => x.action === 'insert').length,
        delete: sorted.filter((x) => x.action === 'delete').length,
        update: sorted.filter((x) => x.action === 'update').length,
      };
      return { flat, items: sorted, counts };
    });
};

const renderAuditEntry = (e) => `
    <div class="audit-row" data-id="${escapeHtml(e.id)}">
      <div class="audit-row__head">
        ${actionBadge(e.action)}
        <strong class="audit-row__plate">${escapeHtml(e.plate || '—')}</strong>
        <span class="audit-row__when">${escapeHtml(formatWhen(e.changed_at))}</span>
      </div>
      <div class="audit-row__delta">${escapeHtml(formatChangeSummary(e))}</div>
      <div class="audit-row__meta">${escapeHtml(e.source || 'ui')} · ${escapeHtml(e.changed_by || 'unknown')}${e.synced_at ? ` · synced ${escapeHtml(formatWhen(e.synced_at))}` : ''}</div>
    </div>`;

export const renderVehicleAuditModal = async () => {
  const list = document.getElementById('audit-log-list');
  const empty = document.getElementById('audit-log-empty');
  const footer = document.getElementById('audit-log-footer');
  const pendingOnly = document.getElementById('audit-pending-only')?.checked ?? true;
  if (!list) return;

  list.innerHTML = '<div class="audit-loading">Loading…</div>';
  if (footer) footer.textContent = '';
  let entries;
  let totalPending = 0;
  try {
    if (pendingOnly) totalPending = await countPendingVehicleAudit();
    entries = await fetchVehicleAuditLog({ pendingOnly, limit: 5000 });
  } catch (err) {
    list.innerHTML = `<div class="audit-error">${escapeHtml(err.message || 'Could not load audit log.')}</div>`;
    return;
  }

  const countEl = document.getElementById('audit-pending-count');
  if (countEl) {
    if (pendingOnly) {
      const n = totalPending || entries.length;
      countEl.textContent = n ? `${n} pending` : 'None pending';
    } else {
      countEl.textContent = entries.length ? `${entries.length} shown` : 'None';
    }
  }

  if (!entries.length) {
    list.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  let groups;
  try {
    groups = groupAuditByFlat(entries);
    list.innerHTML = groups.map(({ flat, items, counts }) => {
      const chips = [
        counts.insert ? `<span class="audit-flat__chip audit-flat__chip--insert">${counts.insert} added</span>` : '',
        counts.delete ? `<span class="audit-flat__chip audit-flat__chip--delete">${counts.delete} removed</span>` : '',
        counts.update ? `<span class="audit-flat__chip audit-flat__chip--update">${counts.update} updated</span>` : '',
      ].filter(Boolean).join('');
      // Use divs only — global `header` / page styles were collapsing these rows to empty lines.
      return `
    <div class="audit-flat-group">
      <div class="audit-flat-group__head">
        <div class="audit-flat-group__title">Flat ${escapeHtml(flat)}</div>
        <div class="audit-flat-group__chips">${chips}</div>
      </div>
      <div class="audit-flat-group__body">
        ${items.map(renderAuditEntry).join('')}
      </div>
    </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="audit-error">${escapeHtml(err.message || 'Could not render audit log.')}</div>`;
    return;
  }

  if (footer) {
    footer.textContent = pendingOnly && totalPending > entries.length
      ? `Showing ${entries.length} of ${totalPending} pending across ${groups.length} flats`
      : `Showing ${entries.length} ${pendingOnly ? 'pending ' : ''}entr${entries.length === 1 ? 'y' : 'ies'} across ${groups.length} flat${groups.length === 1 ? '' : 's'}`;
  }
};

export const openVehicleAuditModal = async () => {
  document.getElementById('audit-log-modal')?.classList.add('active');
  await renderVehicleAuditModal();
  await refreshAuditBadge();
};

export const closeVehicleAuditModal = () => {
  document.getElementById('audit-log-modal')?.classList.remove('active');
};

export const refreshAuditBadge = async () => {
  const badge = document.getElementById('audit-pending-badge');
  if (!badge) return;
  const n = await countPendingVehicleAudit();
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
};
