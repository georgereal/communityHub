/**
 * Sentry Portal Modular Entry (Vercel Edition)
 * Primary Boot Sequence & View Coordination
 */
import { portalState, persist, migrateAndRecover, supabase, pullState, upsertSocietyConfig } from './store.js';
import {
  processAnalytics,
  renderRegistry,
  saveMdlData,
  handleCSVImport,
  downloadVehicleRegistryXlsx,
  addCommunityPoolSlot,
  openCapacityModal,
  closeCapacityModal,
  applyCapacityDefaultsToAll,
  saveCapacityAllocation,
  refreshCapacityUnitList,
} from './registry.js';
import { processFinances, renderCashLedger, saveCashData } from './finances.js';
import {
  parseParkingExcelFile,
  buildImportPreview,
  applyParkingImport,
} from './parkingImport.js';

const showAuth = (msg = '') => {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('active');
  const err = document.getElementById('auth-error');
  if (err) {
    if (msg) { err.style.display = 'block'; err.textContent = msg; }
    else { err.style.display = 'none'; err.textContent = ''; }
  }
};

const hideAuth = () => {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('active');
  const err = document.getElementById('auth-error');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
};

const getProfile = async (userId) => {
  if (!supabase || !userId) return null;
  try {
    const { data } = await supabase.from('profiles').select('id, full_name, role, email').eq('id', userId).single();
    return data || null;
  } catch {
    // Backward-compatible fallback if the `email` column isn't migrated yet.
    try {
      const { data } = await supabase.from('profiles').select('id, full_name, role').eq('id', userId).single();
      return data || null;
    } catch {
      return null;
    }
  }
};

const ROLE_OPTIONS = [
  { key: 'admin', label: 'Admin' },
  { key: 'property_manager', label: 'Property Manager' },
  { key: 'accounts_manager', label: 'Accounts Manager' },
  { key: 'security', label: 'Security' },
  { key: 'resident_viewer', label: 'Resident Viewer' }
];

const hasPermission = (role, perm) => {
  const r = role || 'resident_viewer';
  const matrix = {
    admin: new Set(['registry.view', 'registry.edit', 'accounts.view', 'accounts.edit', 'setup.view', 'setup.edit', 'users.manage']),
    property_manager: new Set(['registry.view', 'registry.edit', 'accounts.view', 'setup.view']),
    accounts_manager: new Set(['accounts.view', 'accounts.edit']),
    security: new Set(['registry.view', 'registry.edit']),
    resident_viewer: new Set(['registry.view', 'accounts.view'])
  };
  return (matrix[r] || matrix.resident_viewer).has(perm);
};

const can = (perm) => {
  const role = portalState.auth?.role || 'resident_viewer';
  // v1 fallback permissions mapping until v2 tables are enabled
  return hasPermission(role, perm);
};

const fetchEffectivePermissions = async (apartmentId) => {
  if (!supabase) return null;
  const { data: s } = await supabase.auth.getSession();
  const uid = s?.session?.user?.id;
  if (!uid) return null;

  // Pull scoped user roles for this apartment + system roles
  const { data: roles } = await supabase.from('user_role_assignments')
    .select('role_key, scope, apartment_id')
    .eq('user_id', uid);

  if (!roles) return [];

  const isSystemAdmin = roles.some(r => r.scope === 'system' && r.role_key === 'system_admin');
  if (isSystemAdmin) {
    const { data: perms } = await supabase.from('permissions').select('key');
    return (perms || []).map(p => p.key);
  }

  const aptRoleKeys = roles.filter(r => r.scope === 'apartment' && r.apartment_id === apartmentId).map(r => r.role_key);
  if (!aptRoleKeys.length) return [];

  const { data: rp } = await supabase.from('role_permissions').select('permission_key, role_key').in('role_key', aptRoleKeys);
  return Array.from(new Set((rp || []).map(x => x.permission_key)));
};

const applyPermissionsToNav = (perms) => {
  const arr = perms || [];
  // If we couldn't resolve permissions yet, don't hide navigation.
  if (!Array.isArray(arr) || arr.length === 0) return;
  const set = new Set(arr);
  const show = (route, ok) => document.querySelectorAll(`.nav-link-btn[data-route="${route}"]`).forEach(b => b.style.display = ok ? 'flex' : 'none');
  show('registry', set.has('vehicle_registry.view') || !supabase); // keep visible in offline
  show('accounts', set.has('accounts.view'));
  show('setup', set.has('setup.view') || set.has('rbac.view') || set.has('system.apartments.manage'));
  show('apartment', set.has('apartment_mgmt.view'));
};

const applyAuthToUI = async (session) => {
  const user = session?.user;
  if (!user) return;
  const profile = await getProfile(user.id);
  const name = profile?.full_name || profile?.email || user.email || 'User';
  const role = profile?.role || 'resident_viewer';
  portalState.auth = { id: user.id, email: user.email || '', name, role };

  const initials = (name || 'U').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
  const topbarInitialsNode = document.getElementById('topbar-user-initials');
  const topbarNameNode = document.getElementById('topbar-user-name');
  const topbarRoleNode = document.getElementById('topbar-user-role');
  const sidebarInitials = document.getElementById('sidebar-user-initials');
  const sidebarName = document.getElementById('sidebar-user-name');
  const sidebarRole = document.getElementById('sidebar-user-role');

  if (topbarInitialsNode) topbarInitialsNode.textContent = initials;
  if (sidebarInitials) sidebarInitials.textContent = initials;
  if (topbarNameNode) topbarNameNode.textContent = name;
  if (sidebarName) sidebarName.textContent = name;
  if (topbarRoleNode) topbarRoleNode.textContent = role;
  if (sidebarRole) sidebarRole.textContent = role;

  // RBAC gating (UI-level; server-side via RLS in SQL file)
  const manageBtn = document.getElementById('user-menu-manage');
  if (manageBtn) manageBtn.style.display = hasPermission(role, 'users.manage') ? 'flex' : 'none';
  document.querySelectorAll('.nav-link-btn[data-route="setup"]').forEach(btn => {
    btn.style.display = hasPermission(role, 'setup.view') ? 'flex' : 'none';
  });
  document.querySelectorAll('.nav-link-btn[data-route="accounts"]').forEach(btn => {
    btn.style.display = hasPermission(role, 'accounts.view') ? 'flex' : 'none';
  });

  // Show "Make me admin" only if no admin exists yet and user isn't admin.
  const makeAdminBtn = document.getElementById('user-menu-make-admin');
  if (makeAdminBtn && supabase && role !== 'admin') {
    try {
      const { data } = await supabase.rpc('no_admin_exists');
      makeAdminBtn.style.display = data ? 'flex' : 'none';
    } catch {
      makeAdminBtn.style.display = 'none';
    }
  }
};

const ensureAccessState = () => {
  if (!portalState.access) {
    portalState.access = {
      apartments: [{ id: 'apt-default', name: portalState.community?.name || 'CommunityHub' }],
      users: [{ id: 'usr-default', name: 'Property Lead', email: '', apartment_ids: ['apt-default'] }],
      activeApartmentId: 'apt-default',
      activeUserId: 'usr-default'
    };
  }
  if (!portalState.access.apartments.length) portalState.access.apartments.push({ id: 'apt-default', name: 'CommunityHub' });
  if (!portalState.access.activeApartmentId) portalState.access.activeApartmentId = portalState.access.apartments[0].id;
  if (!portalState.access.users.length) portalState.access.users.push({ id: 'usr-default', name: 'Property Lead', email: '', apartment_ids: [portalState.access.activeApartmentId] });
  if (!portalState.access.activeUserId) portalState.access.activeUserId = portalState.access.users[0].id;
};

const setActiveApartment = async (apartmentId) => {
  const apt = portalState.access.apartments.find(a => a.id === apartmentId);
  if (!apt) return;
  
  portalState.access.activeApartmentId = apartmentId;
  portalState.community.name = apt.name;
  
  // UI header updates
  const topApt = document.getElementById('topbar-apartment-name');
  if (topApt) topApt.textContent = apt.name;
  
  persist();
  
  // Save to DB for permanent history (cross-device)
  if (supabase) {
    const { data: s } = await supabase.auth.getSession();
    if (s?.session?.user?.id) {
      await supabase.from('profiles').update({ last_apartment_id: apartmentId }).eq('id', s.session.user.id);
    }
  }

  // 🔄 Pull new data partition from Supabase and refresh all views
  const success = await pullState();
  if (success) {
    renderAccessMappings();
    renderRegistry();
    // Refresh other view-specific components if they exist
    if (typeof window.renderCashLedger === 'function') window.renderCashLedger();
    if (typeof window.renderAuditReports === 'function') window.renderAuditReports();
  }
};

const setActiveUser = (userId) => {
  const user = portalState.access.users.find(u => u.id === userId);
  if (!user) return;
  portalState.access.activeUserId = userId;
  renderAccessMappings();
  persist();
};

const renderAccessMappings = () => {
  ensureAccessState();
  const apartments = portalState.access.apartments;
  const users = portalState.access.users;

  // 1. Sidebar/Header Selects
  const sidebarApartmentSelect = document.getElementById('sidebar-apartment-switch');
  const drawerApartmentSelect = document.getElementById('nav-apartment-switch');
  const headerApartmentSelect = document.getElementById('header-apartment-switch');

  const apartmentOptions = apartments.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  if (sidebarApartmentSelect) {
    sidebarApartmentSelect.innerHTML = apartmentOptions;
    sidebarApartmentSelect.value = portalState.access.activeApartmentId;
  }
  if (drawerApartmentSelect) {
    drawerApartmentSelect.innerHTML = apartmentOptions;
    drawerApartmentSelect.value = portalState.access.activeApartmentId;
  }
  if (headerApartmentSelect) {
    headerApartmentSelect.innerHTML = apartmentOptions;
    headerApartmentSelect.value = portalState.access.activeApartmentId;
  }

  // 2. New User Directory Table (v2)
  const usersListV2 = document.getElementById('access-users-list-v2');
  if (usersListV2) {
    usersListV2.innerHTML = users.map(u => {
      const mappedApts = apartments.filter(a => (u.apartment_ids || []).includes(a.id));
      const aptChips = mappedApts.map(a => `<span class="apt-chip">${a.name}</span>`).join('') || '<span style="color:var(--text-dim); font-style:italic;">No access</span>';
      const initials = (u.name || 'U').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
      const roleLabel = ROLE_OPTIONS.find(r => r.key === u.role)?.label || u.role || 'Viewer';

      return `
        <div class="user-row">
          <div class="user-info">
            <div class="user-avatar">${initials}</div>
            <div class="user-details">
              <span class="user-name">${u.name}</span>
              <span class="user-email">${u.email || '—'}</span>
            </div>
          </div>
          <div>
            <span class="role-badge ${u.role || 'resident_viewer'}">${roleLabel}</span>
          </div>
          <div class="apt-chips">${aptChips}</div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button class="btn-icon" onclick="window.openUserModal('${u.id}')" title="Edit Access"><i class="fa-solid fa-pen-to-square"></i></button>
            <button class="btn-icon danger" onclick="window.deleteUser('${u.id}')" title="Revoke All Access"><i class="fa-solid fa-user-slash"></i></button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 3. Apartment Portfolio Grid
  const portfolioGrid = document.getElementById('portfolio-grid');
  if (portfolioGrid) {
    portfolioGrid.innerHTML = apartments.map(a => {
      const userCount = users.filter(u => (u.apartment_ids || []).includes(a.id)).length;
      return `
        <div class="portfolio-card">
          <div class="portfolio-info">
            <span class="portfolio-name">${a.name}</span>
            <span class="portfolio-meta">${userCount} authorized users</span>
          </div>
          <div style="display:flex; gap:0.5rem;">
            <button class="btn-icon" onclick="window.openAptModal('${a.id}')" title="Rename"><i class="fa-solid fa-pen"></i></button>
            <button class="btn-icon danger" onclick="window.deleteApartment('${a.id}')" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
      `;
    }).join('');
  }

  // 4. Modal Dropdowns (Role & Apartments)
  const userRoleSelectV2 = document.getElementById('access-user-role-v2');
  if (userRoleSelectV2) {
    userRoleSelectV2.innerHTML = ROLE_OPTIONS.map(r => `<option value="${r.key}">${r.label}</option>`).join('');
  }
  const userAptsSelectV2 = document.getElementById('access-user-apartments-v2');
  if (userAptsSelectV2) {
    userAptsSelectV2.innerHTML = apartments.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  }
};

const syncAccessFromSupabase = async () => {
  if (!supabase) return false;
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) return false;

  // 1. Get profile (including last_viewed_apartment if column exists)
  const selfProfile = await getProfile(uid);
  if (selfProfile) {
    const selfUser = {
      id: selfProfile.id,
      name: selfProfile.full_name || selfProfile.email || 'User',
      email: selfProfile.email || '',
      role: selfProfile.role || 'resident_viewer',
      apartment_ids: []
    };
    portalState.access.users = [selfUser];
    portalState.access.activeUserId = uid;
    
    // If we have a saved ID in the DB and current state is default, use the DB one
    if (selfProfile.last_apartment_id && (!portalState.access.activeApartmentId || portalState.access.activeApartmentId === 'apt-default')) {
      portalState.access.activeApartmentId = selfProfile.last_apartment_id;
    }
  }

  // 2. Apartments the current user can see (RLS enforces)
  const { data: apartmentsRaw } = await supabase.from('apartments').select('id, name').order('name');
  const apartments = (apartmentsRaw || []).filter(a => a.name !== '__SYSTEM__');
  
  if (apartments && apartments.length) {
    portalState.access.apartments = apartments;
    const cur = portalState.access.activeApartmentId;
    
    // Verify if the current apartment is still valid/permitted
    const isValid = cur && cur !== 'apt-default' && apartments.some(a => a.id === cur);
    
    if (!isValid) {
      portalState.access.activeApartmentId = apartments[0].id;
    }
    
    // 🔥 Ensure the UI and Data Partition are fully synchronized
    await setActiveApartment(portalState.access.activeApartmentId);
  }

  // Apply scoped permissions if RBAC v2 tables exist
  try {
    const perms = await fetchEffectivePermissions(portalState.access.activeApartmentId);
    if (perms && perms.length > 0) {
      portalState.authPermissions = perms;
      applyPermissionsToNav(perms);
    }
  } catch {
    // ignore
  }

  // Current user's apartment mappings (always allowed under current RLS).
  const { data: selfMappings } = await supabase.from('user_apartments').select('apartment_id').eq('user_id', uid);
  if (portalState.access.users?.length) {
    portalState.access.users[0].apartment_ids = (selfMappings || []).map(m => m.apartment_id);
  }

  // Users list (admin only due to RLS). If allowed, hydrate full directory.
  const { data: profiles } = await supabase.from('profiles').select('id, full_name, email, role').order('full_name');
  if (profiles && profiles.length) {
    const { data: mappings } = await supabase.from('user_apartments').select('user_id, apartment_id');
    const map = new Map();
    (mappings || []).forEach(m => {
      if (!map.has(m.user_id)) map.set(m.user_id, []);
      map.get(m.user_id).push(m.apartment_id);
    });
    portalState.access.users = profiles.map(p => ({
      id: p.id,
      name: p.full_name || p.email || p.id,
      email: p.email || '',
      role: p.role || 'resident_viewer',
      apartment_ids: map.get(p.id) || []
    }));

    if (!portalState.access.activeUserId || !portalState.access.users.some(u => u.id === portalState.access.activeUserId)) {
      portalState.access.activeUserId = uid;
    }
  }

  persist();
  renderAccessMappings();
  return true;
};

/**
 * Global Boot Sequence: Partition Restoration & Initialization
 */
/**
 * Global Boot Sequence: Relational Retrieval & Modular Hydration
 */
const boot = async () => {
  document.body.prepend(Object.assign(document.createElement('div'), { id: 'sentry-boot-loader', innerHTML: '<div style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.9); display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:9999; color:#fff;"><i class="fa-solid fa-hotel fa-spin" style="font-size:2rem; margin-bottom:1rem; color:var(--accent);"></i><div style="font-weight:900; letter-spacing:1px; text-transform:uppercase; font-size:0.75rem;">Initializing CommunityHub</div></div>' }));

  let bootHasSupabaseSession = false;
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      document.getElementById('sentry-boot-loader')?.remove();
      showAuth();
      return;
    }
    bootHasSupabaseSession = true;
    await applyAuthToUI(data.session);
    // Resolve real apartment UUID before pullState — otherwise queries use apt-default and return empty rows.
    ensureAccessState();
    await syncAccessFromSupabase();
  }

  const connected = await migrateAndRecover();
  document.getElementById('sentry-boot-loader')?.remove();
  if (!connected) console.warn('Cloud Registry Offline - Falling back to local cache.');
  if (!supabase || !bootHasSupabaseSession) ensureAccessState();
  setActiveApartment(portalState.access.activeApartmentId);
  renderAccessMappings();

  processAnalytics();
  processFinances();
  renderRegistry();

  const route = window.location.hash.slice(1) || 'registry';
  window.switchView(route);
};

export const initializeSeedData = async () => {
  const blocks = ['A', 'B']; const pUnits = [];
  for (let b = 0; b < 2; b++) { for (let f = 1; f <= 5; f++) { for (let n = 1; n <= 2; n++) { pUnits.push({ number: `${blocks[b]}-${f}0${n}`, car_limit: 1, bike_limit: 1, is_community: false }); } } }
  if (supabase) { const { error } = await supabase.from('units').insert(pUnits); if (!error) { await pullState(); window.location.reload(); } }
};
window.initializeSeedData = initializeSeedData;

/**
 * View & SubView Navigation logic (Sentry Strategic Router)
 */
window.switchView = (v) => {
  // Validate route and fallback to registry
  const routes = ['registry', 'accounts', 'units', 'setup', 'apartment'];
  const route = routes.includes(v) ? v : 'registry';

  document.querySelectorAll('.content-view').forEach(x => x.classList.remove('active'));
  const viewNode = document.getElementById(`view-${route}`);
  if (!viewNode) {
    console.warn(`Missing view section for route: ${route}`);
    document.getElementById('view-registry')?.classList.add('active');
    return;
  }
  viewNode.classList.add('active');

  // Breadcrumb menu replaces sidebar nav links.

  if (route === 'accounts') { window.switchSubView('ledger'); renderCashLedger(); }
  if (route === 'registry') renderRegistry();
  if (route === 'setup') {
    document.getElementById('setup-name').value = portalState.community.name;
    document.getElementById('setup-car').value = portalState.community.defaults.cars;
    document.getElementById('setup-bike').value = portalState.community.defaults.bikes;
    renderAccessMappings();
  }
};

const renderResidents = async () => {
  const list = document.getElementById('resident-items');
  if (!list) return;
  list.innerHTML = '';
  const apartmentId = portalState.access?.activeApartmentId;
  if (!apartmentId || !supabase) {
    list.innerHTML = `<div style="padding:0.9rem; color:var(--text-dim);">Supabase required.</div>`;
    return;
  }

  const { data, error } = await supabase.from('residents')
    .select('id, unit_number, kind, full_name, phone, email, notes')
    .eq('apartment_id', apartmentId)
    .order('unit_number');
  if (error) {
    list.innerHTML = `<div style="padding:0.9rem; color:var(--danger); font-weight:800;">${error.message}</div>`;
    return;
  }

  (data || []).forEach(r => {
    const row = document.createElement('div');
    row.className = 'apt-row';
    row.style = "grid-template-columns: 120px 110px 1fr 160px 220px 90px; padding: 0.75rem 0.95rem; align-items: center;";
    row.innerHTML = `
      <div style="font-weight:800;">${r.unit_number}</div>
      <div style="font-size:0.72rem; font-weight:900; color:var(--text-dim); text-transform:uppercase;">${r.kind}</div>
      <div style="font-weight:800;">${r.full_name}</div>
      <div style="color:var(--text-dim); font-weight:700;">${r.phone || '-'}</div>
      <div style="color:var(--text-dim); font-weight:700;">${r.email || '-'}</div>
      <div style="text-align:right; display:flex; gap:0.35rem; justify-content:flex-end;">
        <button class="btn btn-outline" style="padding:0.2rem 0.45rem;" data-action="edit"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-outline" style="padding:0.2rem 0.45rem; color:var(--danger);" data-action="del"><i class="fa-solid fa-trash-can"></i></button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').onclick = () => openResidentModal(r);
    row.querySelector('[data-action="del"]').onclick = async () => {
      if (!confirm('Delete resident record?')) return;
      await supabase.from('residents').delete().eq('id', r.id);
      renderResidents();
    };
    list.appendChild(row);
  });
};

let editingResidentId = null;
const openResidentModal = (r = null) => {
  editingResidentId = r?.id || null;
  document.getElementById('resident-unit').value = r?.unit_number || '';
  document.getElementById('resident-kind').value = r?.kind || 'OWNER';
  document.getElementById('resident-name').value = r?.full_name || '';
  document.getElementById('resident-phone').value = r?.phone || '';
  document.getElementById('resident-email').value = r?.email || '';
  document.getElementById('resident-notes').value = r?.notes || '';
  document.getElementById('resident-modal').classList.add('active');
};

const closeResidentModal = () => {
  document.getElementById('resident-modal').classList.remove('active');
  editingResidentId = null;
};

const saveResident = async () => {
  if (!supabase) return;
  const apartmentId = portalState.access?.activeApartmentId;
  const payload = {
    apartment_id: apartmentId,
    unit_number: document.getElementById('resident-unit').value.trim(),
    kind: document.getElementById('resident-kind').value,
    full_name: document.getElementById('resident-name').value.trim(),
    phone: document.getElementById('resident-phone').value.trim(),
    email: document.getElementById('resident-email').value.trim(),
    notes: document.getElementById('resident-notes').value.trim()
  };
  if (!payload.unit_number || !payload.full_name) return alert('Unit + name required.');
  const q = editingResidentId
    ? supabase.from('residents').update(payload).eq('id', editingResidentId)
    : supabase.from('residents').insert(payload);
  const { error } = await q;
  if (error) return alert(error.message);
  closeResidentModal();
  renderResidents();
};

/**
 * Event Listener Initialization
 */
document.addEventListener('DOMContentLoaded', () => {
  // Mobile nav: add backdrop + topbar hamburger toggle for off-canvas sidebar.
  const ensureNavBackdrop = () => {
    if (document.querySelector('.nav-backdrop')) return;
    const d = document.createElement('div');
    d.className = 'nav-backdrop';
    d.setAttribute('aria-hidden', 'true');
    d.onclick = () => document.body.classList.remove('nav-expanded');
    document.body.appendChild(d);
  };
  ensureNavBackdrop();

  const mobileNavToggle = document.getElementById('mobile-nav-toggle');
  if (mobileNavToggle) {
    mobileNavToggle.onclick = () => {
      document.body.classList.toggle('nav-expanded');
    };
  }

  // Allow ESC to close the off-canvas nav quickly.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.body.classList.remove('nav-expanded');
  });

  // On mobile, keep heavy sections collapsed by default (desktop stays open via HTML).
  try {
    if (window.matchMedia && window.matchMedia('(max-width: 520px)').matches) {
      document.getElementById('registry-overview')?.removeAttribute('open');
      document.getElementById('pool-visualiser')?.removeAttribute('open');
    }
  } catch {
    // ignore
  }

  // Auth handlers
  const loginBtn = document.getElementById('auth-login-btn');
  const signupBtn = document.getElementById('auth-signup-btn');
  const emailEl = document.getElementById('auth-email');
  const passEl = document.getElementById('auth-password');

  const signIn = async () => {
    if (!supabase) return showAuth('Supabase is not configured.');
    const email = (emailEl?.value || '').trim();
    const password = (passEl?.value || '').trim();
    if (!email || !password) return showAuth('Email and password required.');
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return showAuth(error.message);
    await applyAuthToUI(data.session);
    hideAuth();
    ensureAccessState();
    if (data?.session?.user?.id) portalState.access.activeUserId = data.session.user.id;
    await syncAccessFromSupabase();
    setActiveApartment(portalState.access.activeApartmentId);
    renderAccessMappings();
    await pullState();
    processAnalytics();
    processFinances();
    renderRegistry();
  };

  const signUp = async () => {
    if (!supabase) return showAuth('Supabase is not configured.');
    const email = (emailEl?.value || '').trim();
    const password = (passEl?.value || '').trim();
    if (!email || !password) return showAuth('Email and password required.');
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return showAuth(error.message);
    if (!data.session) return showAuth('Account created. Please verify your email, then sign in.');
    await applyAuthToUI(data.session);
    hideAuth();
    ensureAccessState();
    if (data?.session?.user?.id) portalState.access.activeUserId = data.session.user.id;
    await syncAccessFromSupabase();
    setActiveApartment(portalState.access.activeApartmentId);
    renderAccessMappings();
    await pullState();
    processAnalytics();
    processFinances();
    renderRegistry();
  };

  if (loginBtn) loginBtn.onclick = signIn;
  if (signupBtn) signupBtn.onclick = signUp;

  // Global View Router
  window.addEventListener('hashchange', () => {
    const route = window.location.hash.slice(1);
    window.switchView(route);
  });

  // Registry Tactical controls
  const preventSearchAutofill = (el) => {
    if (!el) return;
    el.setAttribute('readonly', 'readonly');
    const unlock = () => {
      el.removeAttribute('readonly');
      el.removeEventListener('focus', unlock);
    };
    el.addEventListener('focus', unlock);
  };

  const searchInput = document.getElementById('apt-search');
  if (searchInput) {
    preventSearchAutofill(searchInput);
    searchInput.oninput = () => renderRegistry();
  }
  preventSearchAutofill(document.getElementById('cash-search'));
  preventSearchAutofill(document.getElementById('pool-search-input'));

  const sortSelect = document.getElementById('registry-sort');
  if (sortSelect) sortSelect.onchange = () => renderRegistry();

  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.body.dataset.registryFilter = btn.dataset.filter;
      renderRegistry();
    };
  });

  // KPI quick-filters (Registry)
  const setRegistryFilter = (filter) => {
    document.body.dataset.registryFilter = filter;
    // Keep pills in sync when the filter maps to one.
    document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
    const pill = document.querySelector(`.filter-pill[data-filter="${filter}"]`);
    if (pill) pill.classList.add('active');
    renderRegistry();
    document.getElementById('registry-units')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const bindKpi = (valueId, filter) => {
    const el = document.getElementById(valueId);
    const card = el?.closest?.('.metric-card');
    if (!card) return;
    card.classList.add('metric-card--clickable');
    card.onclick = () => setRegistryFilter(filter);
  };

  bindKpi('kpi-overlimit-cars', 'OVERLIMIT_CARS');
  bindKpi('kpi-overlimit-bikes', 'OVERLIMIT_BIKES');
  bindKpi('kpi-cars', 'CARS');
  bindKpi('kpi-bikes', 'BIKES');

  // Bulk Import Hook
  const csvFile = document.getElementById('csv-file');
  if (csvFile) csvFile.onchange = (e) => {
    if (e.target.files.length > 0) handleCSVImport(e.target.files[0]);
  };

  // Administration Logic
  document.getElementById('save-setup-btn').onclick = async () => {
    const name = document.getElementById('setup-name').value;
    const car_default = parseInt(document.getElementById('setup-car').value);
    const bike_default = parseInt(document.getElementById('setup-bike').value);

    const activeApartment = portalState.access.apartments.find(a => a.id === portalState.access.activeApartmentId);
    if (activeApartment && name) activeApartment.name = name;
    portalState.community.name = name;

    const apartment_id = portalState.access?.activeApartmentId;
    if (!apartment_id) return alert('No active apartment selected.');

    if (supabase) {
      // 1. Update Society Config
      const { error: cfgError } = await upsertSocietyConfig(apartment_id, { name, car_default, bike_default });
      if (cfgError) return alert(`Could not save policy: ${cfgError.message}`);

      // 2. Propagation: Apply new defaults to ALL units
      const { error } = await supabase.from('units').update({ car_limit: car_default, bike_limit: bike_default }).eq('apartment_id', apartment_id).neq('number', '');

      if (!error) {
        await pullState();
        ensureAccessState();
        if (activeApartment && name) {
          const refreshed = portalState.access.apartments.find(a => a.id === activeApartment.id);
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
  };

  document.getElementById('clear-all-btn').onclick = () => {
    if (confirm('DANGER: This will permanently wipe all community data (Vehicles, Accounts AND Units). Proceed?')) {
      localStorage.clear();
      portalState.units = [];
      portalState.finances.txns = [];
      persist();
      window.location.reload();
    }
  };

  document.getElementById('deep-repair-btn').onclick = () => {
    portalState.units.forEach(u => { if (!u.vehicles) u.vehicles = []; u.vehicles.forEach(v => { if (v.isParkingActive === undefined) v.isParkingActive = true; }); });
    portalState.finances.txns.forEach(t => { if (!t.wallet) t.wallet = 'CASH'; if (!t.type) t.type = 'OUT'; });
    persist(); alert('Deep repair complete. State sanitized.'); window.location.reload();
  };

  // User & Apartment Management Modals
  let activeUserIdForEdit = null;
  window.openUserModal = (userId = null) => {
    activeUserIdForEdit = userId;
    const user = portalState.access.users.find(u => u.id === userId);
    document.getElementById('access-user-name-v2').value = user?.name || '';
    document.getElementById('access-user-email-v2').value = user?.email || '';
    document.getElementById('access-user-role-v2').value = user?.role || 'resident_viewer';
    const aptSelect = document.getElementById('access-user-apartments-v2');
    Array.from(aptSelect.options).forEach(opt => {
      opt.selected = (user?.apartment_ids || []).includes(opt.value);
    });
    document.getElementById('user-access-modal').classList.add('active');
  };
  window.closeUserModal = () => document.getElementById('user-access-modal').classList.remove('active');

  let activeAptIdForEdit = null;
  window.openAptModal = (aptId = null) => {
    activeAptIdForEdit = aptId;
    const apt = portalState.access.apartments.find(a => a.id === aptId);
    document.getElementById('apt-mgmt-title').textContent = aptId ? 'Edit Apartment' : 'Add Apartment';
    document.getElementById('apt-mgmt-name').value = apt?.name || '';
    document.getElementById('apt-mgmt-modal').classList.add('active');
  };
  window.closeAptModal = () => document.getElementById('apt-mgmt-modal').classList.remove('active');

  document.getElementById('save-user-access-btn').onclick = async () => {
    const name = document.getElementById('access-user-name-v2').value.trim();
    const email = document.getElementById('access-user-email-v2').value.trim();
    const role = document.getElementById('access-user-role-v2').value;
    const aptSelect = document.getElementById('access-user-apartments-v2');
    const apartment_ids = Array.from(aptSelect.selectedOptions).map(o => o.value);

    if (!email) return alert('Email is required.');

    if (supabase) {
      const { data: prof, error: pErr } = await supabase.from('profiles').select('id, full_name, email, role').eq('email', email).single();
      if (pErr || !prof) return alert('User not found. Ask them to sign up first.');
      await supabase.from('profiles').update({ full_name: name || prof.full_name, role }).eq('id', prof.id);
      
      // Delete existing mappings for this user and re-insert (simple approach)
      await supabase.from('user_apartments').delete().eq('user_id', prof.id);
      for (const aid of apartment_ids) {
        await supabase.from('user_apartments').upsert({ user_id: prof.id, apartment_id: aid });
      }
      await syncAccessFromSupabase();
    } else {
      const user = activeUserIdForEdit 
        ? portalState.access.users.find(u => u.id === activeUserIdForEdit)
        : { id: `usr-${Date.now()}` };
      
      user.name = name;
      user.email = email;
      user.role = role;
      user.apartment_ids = apartment_ids;

      if (!activeUserIdForEdit) portalState.access.users.push(user);
      persist();
      renderAccessMappings();
    }
    window.closeUserModal();
  };

  document.getElementById('save-apt-mgmt-btn').onclick = async () => {
    const name = document.getElementById('apt-mgmt-name').value.trim();
    if (!name) return;

    if (supabase) {
      if (activeAptIdForEdit) {
        await supabase.from('apartments').update({ name }).eq('id', activeAptIdForEdit);
      } else {
        await supabase.from('apartments').insert({ name });
      }
      await syncAccessFromSupabase();
    } else {
      if (activeAptIdForEdit) {
        const apt = portalState.access.apartments.find(a => a.id === activeAptIdForEdit);
        if (apt) apt.name = name;
      } else {
        portalState.access.apartments.push({ id: `apt-${Date.now()}`, name });
      }
      persist();
      renderAccessMappings();
    }
    window.closeAptModal();
  };

  window.deleteUser = async (userId) => {
    if (!confirm('Revoke all access for this user?')) return;
    if (supabase) {
      await supabase.from('user_apartments').delete().eq('user_id', userId);
      // We don't delete the profile, just their access mappings.
      await syncAccessFromSupabase();
    } else {
      portalState.access.users = portalState.access.users.filter(u => u.id !== userId);
      persist();
      renderAccessMappings();
    }
  };

  window.deleteApartment = async (aptId) => {
    if (!confirm('Delete this apartment? This will NOT delete associated vehicles/units but will break access.')) return;
    if (supabase) {
      await supabase.from('apartments').delete().eq('id', aptId);
      await syncAccessFromSupabase();
    } else {
      portalState.access.apartments = portalState.access.apartments.filter(a => a.id !== aptId);
      persist();
      renderAccessMappings();
    }
  };

  // 🏢 Apartment Switching (Global)
  const apartmentSelectors = ['access-active-apartment', 'nav-apartment-switch', 'sidebar-apartment-switch', 'header-apartment-switch'];
  apartmentSelectors.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.onchange = async (e) => {
        await setActiveApartment(e.target.value);
        // Ensure all selectors stay in sync
        apartmentSelectors.forEach(sid => {
          const sel = document.getElementById(sid);
          if (sel) sel.value = e.target.value;
        });
      };
    }
  });

  const navToggle = document.getElementById('nav-toggle');
  if (navToggle) {
    navToggle.onclick = () => {
      document.body.classList.toggle('nav-expanded');
    };
  }

  document.querySelectorAll('.nav-link-btn').forEach(btn => {
    btn.onclick = () => {
      const route = btn.dataset.route;
      document.body.classList.remove('nav-expanded');
      window.location.hash = `#${route}`;
      window.switchView(route);
      const viewName = document.getElementById('topbar-view-name');
      if (viewName) viewName.textContent = route;
      if (route === 'apartment') renderResidents();
    };
  });

  // Defensive routing: delegated handler ensures nav always works (even if individual handlers are lost/overwritten).
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.nav-link-btn');
    if (!btn) return;
    const route = btn.dataset.route;
    if (!route) return;
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.remove('nav-expanded');
    window.location.hash = `#${route}`;
    window.switchView(route);
    const viewName = document.getElementById('topbar-view-name');
    if (viewName) viewName.textContent = route;
    if (route === 'apartment') renderResidents();
  }, true);

  const userBtn = document.getElementById('topbar-user-btn');
  const userMenu = document.getElementById('topbar-user-menu');
  const hideUserMenu = () => { if (userMenu) userMenu.style.display = 'none'; };
  if (userBtn && userMenu) {
    userBtn.onclick = (e) => {
      e.stopPropagation();
      userMenu.style.display = userMenu.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', hideUserMenu);
    userMenu.addEventListener('click', (e) => e.stopPropagation());
  }

  const profileBtn = document.getElementById('user-menu-profile');
  if (profileBtn) profileBtn.onclick = () => {
    const authUser = portalState.auth;
    const apartments = portalState.access?.apartments || [];
    const mappedIds = portalState.access?.users?.find(u => u.id === authUser?.id)?.apartment_ids || [];
    const mapped = apartments.filter(a => mappedIds.includes(a.id)).map(a => a.name).join(', ') || '—';
    hideUserMenu();
    alert(`${authUser?.name || authUser?.email || 'User'}\n\nRole: ${authUser?.role || 'resident_viewer'}\nApartments: ${mapped}`);
  };

  const manageBtn = document.getElementById('user-menu-manage');
  if (manageBtn) manageBtn.onclick = () => {
    hideUserMenu();
    window.location.hash = '#setup';
    window.switchView('setup');
    setTimeout(() => document.getElementById('access-users-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const resRefresh = document.getElementById('resident-refresh-btn');
  if (resRefresh) resRefresh.onclick = () => renderResidents();
  const resAdd = document.getElementById('resident-add-btn');
  if (resAdd) resAdd.onclick = () => openResidentModal(null);
  const resCancel = document.getElementById('resident-cancel-btn');
  if (resCancel) resCancel.onclick = () => closeResidentModal();
  const resSave = document.getElementById('resident-save-btn');
  if (resSave) resSave.onclick = () => saveResident();

  const logoutBtn = document.getElementById('user-menu-logout');
  if (logoutBtn) logoutBtn.onclick = () => {
    hideUserMenu();
    if (supabase) supabase.auth.signOut();
    localStorage.clear();
    showAuth('Signed out.');
  };

  const makeAdminBtn = document.getElementById('user-menu-make-admin');
  if (makeAdminBtn) makeAdminBtn.onclick = async () => {
    hideUserMenu();
    if (!supabase) return alert('Supabase not configured.');
    const { data: s } = await supabase.auth.getSession();
    const uid = s?.session?.user?.id;
    if (!uid) return showAuth('Please sign in again.');
    const { error } = await supabase.from('profiles').update({ role: 'admin' }).eq('id', uid);
    if (error) return alert(error.message);
    // Force refresh of UI gating after role change.
    const refreshed = await supabase.auth.getSession();
    await applyAuthToUI(refreshed.data.session);
    alert('You are now admin. Setup/User management is enabled.');
  };

  const activeUserSelect = document.getElementById('access-active-user');
  if (activeUserSelect) activeUserSelect.onchange = (e) => setActiveUser(e.target.value);

  // Modal Unified Button Hooks
  document.getElementById('save-mdl-btn').onclick = () => saveMdlData();
  document.getElementById('save-cash-btn').onclick = () => saveCashData();

  const registryDownload = document.getElementById('registry-download-xlsx');
  if (registryDownload) {
    registryDownload.onclick = () => {
      downloadVehicleRegistryXlsx().catch((err) => {
        console.error(err);
        alert('Download failed. Check the console for details.');
      });
    };
  }

  document.getElementById('pool-add-car')?.addEventListener('click', () => void addCommunityPoolSlot('car'));
  document.getElementById('pool-add-bike')?.addEventListener('click', () => void addCommunityPoolSlot('bike'));

  document.getElementById('registry-base-capacity')?.addEventListener('click', openCapacityModal);
  document.getElementById('capacity-close')?.addEventListener('click', closeCapacityModal);
  document.getElementById('capacity-cancel')?.addEventListener('click', closeCapacityModal);
  document.getElementById('capacity-apply-all')?.addEventListener('click', applyCapacityDefaultsToAll);
  document.getElementById('capacity-save')?.addEventListener('click', () => void saveCapacityAllocation());
  document.getElementById('capacity-search')?.addEventListener('input', refreshCapacityUnitList);

  // Parking Excel reconcile import
  const parkingImportModal = document.getElementById('parking-import-modal');
  const parkingImportStepPick = document.getElementById('parking-import-step-pick');
  const parkingImportStepPreview = document.getElementById('parking-import-step-preview');
  const parkingImportError = document.getElementById('parking-import-error');
  const parkingImportSummary = document.getElementById('parking-import-summary');
  const parkingImportWarn = document.getElementById('parking-import-warn');
  const parkingImportFileName = document.getElementById('parking-import-file-name');
  const xlsxFileInput = document.getElementById('xlsx-file');
  let pendingParkingImport = null;
  let pendingParkingFileName = '';

  const showParkingImportError = (msg) => {
    if (!parkingImportError) return;
    if (msg) {
      parkingImportError.style.display = 'block';
      parkingImportError.textContent = msg;
    } else {
      parkingImportError.style.display = 'none';
      parkingImportError.textContent = '';
    }
  };

  const resetParkingImportModal = () => {
    pendingParkingImport = null;
    pendingParkingFileName = '';
    if (parkingImportStepPick) parkingImportStepPick.style.display = 'block';
    if (parkingImportStepPreview) parkingImportStepPreview.style.display = 'none';
    showParkingImportError('');
    if (xlsxFileInput) xlsxFileInput.value = '';
  };

  const openParkingImportModal = () => {
    if (!supabase) return alert('Supabase is required for Excel reconcile.');
    resetParkingImportModal();
    parkingImportModal?.classList.add('active');
  };

  const closeParkingImportModal = () => {
    parkingImportModal?.classList.remove('active');
    resetParkingImportModal();
  };

  const getParkingImportMode = () => {
    const picked = document.querySelector('input[name="parking-import-mode"]:checked');
    return picked?.value === 'overwrite' ? 'overwrite' : 'merge';
  };

  const renderParkingPreview = (parsed, mode, fileName) => {
    const preview = buildImportPreview(parsed, mode);
    if (parkingImportFileName) parkingImportFileName.textContent = fileName;
    if (parkingImportSummary) {
      parkingImportSummary.innerHTML = `
        <div><strong>Mode:</strong> ${mode === 'overwrite' ? 'Overwrite' : 'Merge'}</div>
        <div><strong>Rows parsed:</strong> ${preview.rowCount}</div>
        <div><strong>Units:</strong> ${preview.unitCount} (${preview.newUnits} new, ${preview.updatedUnits} updated)</div>
        <div><strong>Vehicles:</strong> ${preview.vehicleCount} (${preview.newVehicles} new, ${preview.updatedVehicles} to update)</div>
        <div><strong>Sticker / RFID rows:</strong> ${preview.withSticker ?? 0} with sticker, ${preview.withRfid ?? 0} with RFID data</div>
        <div><strong>Rented / external parking:</strong> ${preview.rentedParking ?? 0} vehicle(s) with Parking_No ≠ Flat</div>
        ${mode === 'overwrite' && preview.removedVehicles > 0
          ? `<div style="color:#b45309;"><strong>Will remove:</strong> ${preview.removedVehicles} existing vehicle(s) not in file</div>`
          : ''}
      `;
    }
    if (parkingImportWarn) {
      if (mode === 'overwrite') {
        parkingImportWarn.style.display = 'block';
        parkingImportWarn.textContent =
          'Overwrite deletes all current vehicles for this apartment, then loads vehicles from the spreadsheet.';
      } else {
        parkingImportWarn.style.display = 'none';
        parkingImportWarn.textContent = '';
      }
    }
    if (parkingImportStepPick) parkingImportStepPick.style.display = 'none';
    if (parkingImportStepPreview) parkingImportStepPreview.style.display = 'block';
  };

  document.getElementById('registry-import-xlsx')?.addEventListener('click', openParkingImportModal);
  document.getElementById('parking-import-close')?.addEventListener('click', closeParkingImportModal);
  document.getElementById('parking-import-cancel')?.addEventListener('click', closeParkingImportModal);
  document.getElementById('parking-import-back')?.addEventListener('click', () => {
    if (parkingImportStepPick) parkingImportStepPick.style.display = 'block';
    if (parkingImportStepPreview) parkingImportStepPreview.style.display = 'none';
    showParkingImportError('');
  });
  document.getElementById('parking-import-choose-file')?.addEventListener('click', () => xlsxFileInput?.click());

  if (xlsxFileInput) {
    xlsxFileInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      showParkingImportError('');
      try {
        const parsed = await parseParkingExcelFile(file);
        pendingParkingImport = parsed;
        pendingParkingFileName = file.name;
        renderParkingPreview(parsed, getParkingImportMode(), file.name);
      } catch (err) {
        showParkingImportError(err?.message || 'Could not read that Excel file.');
      }
    };
  }

  document.getElementById('parking-import-apply')?.addEventListener('click', async () => {
    if (!pendingParkingImport) return;
    const mode = getParkingImportMode();
    if (mode === 'overwrite') {
      const ok = confirm(
        'This will delete ALL vehicles for the active apartment and replace them with the spreadsheet. Continue?',
      );
      if (!ok) return;
    }
    const applyBtn = document.getElementById('parking-import-apply');
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = 'Importing…';
    }
    showParkingImportError('');
    try {
      const result = await applyParkingImport(pendingParkingImport, mode);
      processAnalytics();
      renderRegistry();
      closeParkingImportModal();
      if (result.skippedRegistryMeta) {
        alert(
          'Import completed for units and vehicles, but RFID/sticker columns are missing in Supabase.\n\n' +
            'Open Supabase → SQL Editor and run supabase_vehicle_rfid_sticker.sql, then re-import to save sticker/RFID data.',
        );
      } else {
        alert(`Parking registry ${mode === 'overwrite' ? 'overwritten' : 'merged'} successfully.`);
      }
    } catch (err) {
      showParkingImportError(err?.message || 'Import failed.');
    } finally {
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply import';
      }
    }
  });

  // Registry Header Register Hook
  const addBtn = document.getElementById('add-vehicle-top');
  if (addBtn) addBtn.onclick = () => {
    const firstUnit = portalState.units[0];
    if (firstUnit) window.openMdl(firstUnit.id);
  };

  // Initialize Router State
  boot();
  const currentRoute = window.location.hash.slice(1) || 'registry';
  window.switchView(currentRoute);
  const viewName = document.getElementById('topbar-view-name');
  if (viewName) viewName.textContent = currentRoute;
});
