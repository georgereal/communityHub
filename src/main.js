/**
 * Sentry Portal Modular Entry (Vercel Edition)
 * Primary Boot Sequence & View Coordination
 */
import { portalState, persist, migrateAndRecover, supabase, pullState, isPlaceholderApartmentId, withTimeout, ensureRouteState, resetLoadedDomains, getLoadedDomains } from './store.js';
import {
    renderAccessMappings,
    ensureAccessState,
    apartmentOptionsForUi,
    isSignedIn,
} from './mainBoot.js';
import {
  processAnalytics,
  renderRegistry,
  saveMdlData,
  addVehicleToUnit,
} from './registry.js';
import { processFinances, renderCashLedger } from './finances.js';
import {
  cleanAuthRedirectFromUrl,
  getEnabledSocialProviders,
  isSupabaseAuthRedirect,
  signInWithSocialProvider,
} from './socialAuth.js';
import { ensureViewMounted, showView } from './views/viewShell.js';
import { activateView } from './views/controllers.js';
import { initStaffNotificationsUi, refreshStaffNotifications } from './staffNotifications.js';
import { renderResidentLinksAdmin, autoLinkResidentByEmail, acceptPendingInvites } from './residentLinks.js';
import { openTransitionWizard } from './unitTransitions.js';
import { renderDashboard } from './dashboard.js';
import { renderApartmentModulePanel, renderUserModulePanel, saveUserModuleOverridesFromPanel } from './moduleAccessAdmin.js';
import { renderUserPageAccessPanel, saveUserPageOverridesFromPanel } from './pageAccessAdmin.js';
import {
    ROLE_OPTIONS,
    refreshAuthPermissions,
    resolveEffectivePermissions,
    permissionsFromV1Role,
    hasClientPermission,
    routeIsAllowed,
    saveUserAccess,
    loadUserRoleAssignments,
    primaryRoleFromAssignments,
    v2KeyToLabel,
    v1RoleToV2Key,
    isApartmentAdminUser,
    isSystemAdminUser,
    loadAllUserRoleAssignments,
    loadAllUserRoleAssignmentsCached,
    clearRoleAssignmentsCache,
} from './rbac.js';
import {
    DEFAULT_ROUTE,
    getDefaultRoute,
    findFirstAllowedRoute,
    applyNavPermissions,
    findPage,
    initNavInteraction,
    renderNavModules,
    resolveRoute,
    updateNavActiveState,
    updateNavBreadcrumb,
} from './navigation.js';
import { withButtonBusy } from './buttonBusy.js';

window.openTransitionWizard = openTransitionWizard;

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

let authApplyInflight = null;
let bootAuthHandled = false;
let cachedProfile = null;

const getProfile = async (userId, { useCache = true } = {}) => {
  if (!supabase || !userId) return null;
  if (useCache && cachedProfile?.id === userId) return cachedProfile;
  try {
    const { data, error } = await withTimeout(
      supabase
        .from('profiles')
        .select('id, full_name, role, email, last_apartment_id')
        .eq('id', userId)
        .maybeSingle(),
      15000,
      'Profile load',
    );
    if (error) {
      console.warn('[Auth] Profile fetch error:', error.message);
      return null;
    }
    if (data) cachedProfile = data;
    return data;
  } catch (err) {
    console.warn('[Auth] Profile fetch failed:', err.message);
    return null;
  }
};

const deferAfterFirstPaint = (fn, timeoutMs = 8000) => {
  const run = () => { void fn(); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: timeoutMs });
  else setTimeout(run, 250);
};

const refreshAuthUiShell = () => {
  const auth = portalState.auth;
  if (!auth?.id) return;
  const name = auth.name || auth.email || 'User';
  const initials = (name || 'U').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const roleLabel = formatRoleLabel(auth.effectiveRoleKey || auth.role);
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
  if (topbarRoleNode) topbarRoleNode.textContent = roleLabel;
  if (sidebarRole) sidebarRole.textContent = roleLabel;
  applyPermissionsToNav(portalState.authPermissions || resolveEffectivePermissions());
};

const formatRoleLabel = (role) => {
  const match = ROLE_OPTIONS.find((r) => r.key === role || r.v1Key === role);
  return match?.label || v2KeyToLabel(role) || String(role || 'Viewer').replace(/_/g, ' ');
};

const can = (perm) => hasClientPermission(perm, resolveEffectivePermissions());

const applyPermissionsToNav = (perms) => {
    applyNavPermissions(new Set(perms || resolveEffectivePermissions()), !supabase);
};

const syncBackendSession = async (session) => {
  const accessToken = session?.access_token;
  if (!accessToken) return false;
  try {
    const res = await fetch('/api/auth-session', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
};

const clearBackendSession = async () => {
  try {
    await fetch('/api/auth-session', { method: 'DELETE' });
  } catch {
    // ignore
  }
};

const applyAuthToUIInner = async (session, options = {}) => {
  const {
    profile: profileOverride = null,
    refreshPermissions = true,
    notifications = true,
    adminRpc = true,
    roleAssignments: roleAssignmentsOverride = null,
  } = options;
  const user = session?.user;
  if (!user) return;
  console.group('[Auth] Applying to UI');
  console.log('User:', user.id, user.email);
  const profile = profileOverride || await getProfile(user.id);
  console.log('Profile:', profile);
  const name = profile?.full_name || user.user_metadata?.full_name || profile?.email || user.email || 'User';
  let role = profile?.role || 'resident_viewer';
  let effectiveRoleKey = v1RoleToV2Key(role);
  let isSystemAdmin = false;
  const aptId = portalState.access?.activeApartmentId;
  let roleAssignments = roleAssignmentsOverride;
  if (supabase && (refreshPermissions || !portalState.auth?.id)) {
    roleAssignments = roleAssignments ?? await loadAllUserRoleAssignmentsCached(user.id);
    isSystemAdmin = roleAssignments.some((r) => r.scope === 'system' && r.role_key === 'system_admin');
    if (isSystemAdmin) {
      effectiveRoleKey = 'system_admin';
      role = 'admin';
    } else if (aptId && !isPlaceholderApartmentId(aptId)) {
      const aptAssignment = roleAssignments.find((a) => a.scope === 'apartment' && a.apartment_id === aptId);
      if (aptAssignment?.role_key) {
        effectiveRoleKey = aptAssignment.role_key;
        role = ROLE_OPTIONS.find((r) => r.key === aptAssignment.role_key)?.v1Key || role;
      }
    }
  } else if (portalState.auth?.isSystemAdmin) {
    isSystemAdmin = true;
    effectiveRoleKey = portalState.auth.effectiveRoleKey || effectiveRoleKey;
    role = portalState.auth.role || role;
  }
  portalState.auth = {
    id: user.id,
    email: user.email || profile?.email || '',
    name,
    role,
    effectiveRoleKey,
    isSystemAdmin,
  };

  const initials = (name || 'U').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
  const roleLabel = formatRoleLabel(effectiveRoleKey || role);
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
  if (topbarRoleNode) topbarRoleNode.textContent = roleLabel;
  if (sidebarRole) sidebarRole.textContent = roleLabel;

  portalState.authPermissions = null;
  if (refreshPermissions && aptId && supabase && !isPlaceholderApartmentId(aptId)) {
    console.log('Refreshing permissions for:', aptId);
    await refreshAuthPermissions(aptId, roleAssignments);
    const pageAccessReady = getLoadedDomains().includes('core');
    if (!pageAccessReady) {
      try {
        const { loadUserPageAccess } = await import('./pageAccess.js');
        await loadUserPageAccess(aptId, user.id, effectiveRoleKey);
      } catch { /* tables may not exist yet */ }
    }
  } else if (!portalState.authPermissions?.length) {
    portalState.authPermissions = permissionsFromV1Role(role);
  }

  // RBAC gating (UI-level; server-side via RLS in SQL file)
  const manageBtn = document.getElementById('user-menu-manage');
  if (manageBtn) manageBtn.style.display = (isApartmentAdminUser() || can('rbac.view')) ? 'flex' : 'none';
  applyPermissionsToNav(portalState.authPermissions || resolveEffectivePermissions());
  if (notifications && aptId && !isPlaceholderApartmentId(aptId)) {
    deferAfterFirstPaint(() => refreshStaffNotifications().catch(() => {}));
  }

  // Show "Make me admin" only if no admin exists yet and user isn't already an office bearer.
  const makeAdminBtn = document.getElementById('user-menu-make-admin');
  if (adminRpc && makeAdminBtn && supabase && !isApartmentAdminUser()) {
    deferAfterFirstPaint(async () => {
      try {
        const { data } = await supabase.rpc('no_admin_exists');
        makeAdminBtn.style.display = data ? 'flex' : 'none';
      } catch {
        makeAdminBtn.style.display = 'none';
      }
    });
  } else if (makeAdminBtn) {
    makeAdminBtn.style.display = 'none';
  }
  console.groupEnd();
};

const applyAuthToUI = (session, options = {}) => {
  if (authApplyInflight) return authApplyInflight;
  authApplyInflight = applyAuthToUIInner(session, options).finally(() => {
    authApplyInflight = null;
  });
  return authApplyInflight;
};


const signOut = async (message = 'Signed out.') => {
  await clearBackendSession();
  if (supabase) await supabase.auth.signOut();
  localStorage.removeItem('sentry_portal_v5_platinum');
  showAuth(message);
};

const hideWorkspaceGate = () => {
  const modal = document.getElementById('workspace-gate-modal');
  if (modal) modal.classList.remove('active');
};

const showWorkspaceGate = (message = '') => {
  const modal = document.getElementById('workspace-gate-modal');
  const select = document.getElementById('workspace-gate-select');
  const err = document.getElementById('workspace-gate-error');
  const msg = document.getElementById('workspace-gate-message');
  if (!modal || !select) return;

  const apartments = (portalState.access?.apartments || []).filter((a) => !isPlaceholderApartmentId(a.id));
  if (!apartments.length) {
    if (msg) {
      msg.textContent = message || 'No societies are linked to your account. Ask an admin to grant access in Setup → Users.';
    }
    select.innerHTML = '<option value="">No societies available</option>';
    select.disabled = true;
  } else {
    if (msg) {
      msg.textContent = message || 'Choose which apartment society to load. Your data is stored per society.';
    }
    select.disabled = false;
    select.innerHTML = apartments.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
    const active = portalState.access?.activeApartmentId;
    if (active && apartments.some((a) => a.id === active)) select.value = active;
    else select.value = apartments[0].id;
  }

  if (err) { err.style.display = 'none'; err.textContent = ''; }
  modal.classList.add('active');
};

const initWorkspaceGate = () => {
  const confirmBtn = document.getElementById('workspace-gate-confirm');
  const logoutBtn = document.getElementById('workspace-gate-logout');
  const select = document.getElementById('workspace-gate-select');
  const err = document.getElementById('workspace-gate-error');

  if (logoutBtn) {
    logoutBtn.onclick = () => {
      hideWorkspaceGate();
      void signOut();
    };
  }

  if (confirmBtn && select) {
    confirmBtn.onclick = async () => {
      const aptId = select.value;
      if (!aptId || isPlaceholderApartmentId(aptId)) {
        if (err) {
          err.style.display = 'block';
          err.textContent = 'Select a society first.';
        }
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Loading…';
      const ok = await setActiveApartment(aptId);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Load society';
      if (!ok) {
        if (err) {
          err.style.display = 'block';
          err.textContent = 'Could not load society data. Check the browser console or try again.';
        }
        return;
      }
      hideWorkspaceGate();
      window.switchView(resolveRoute(window.location.hash.slice(1), portalState.auth?.role));
    };
  }
};

const setActiveApartment = async (apartmentId) => {
  if (isPlaceholderApartmentId(apartmentId)) {
    console.warn('[access] Ignoring placeholder apartment id');
    return false;
  }
  console.group('[Access] Setting active apartment:', apartmentId);

  let apt = portalState.access?.apartments?.find(a => a.id === apartmentId);
  if (!apt && supabase) {
    console.log('Apartment not in state, fetching from DB...');
    const { data } = await supabase.from('apartments').select('id, name').eq('id', apartmentId).maybeSingle();
    if (data) {
      apt = data;
      if (!portalState.access.apartments.some((a) => a.id === data.id)) {
        portalState.access.apartments.push(data);
      }
    }
  }
  if (!apt) {
    console.error('[access] Unknown apartment id:', apartmentId);
    console.groupEnd();
    return false;
  }

  portalState.access.activeApartmentId = apartmentId;
  portalState.community.name = apt.name;
  resetLoadedDomains();

  const headerSelect = document.getElementById('header-apartment-switch');
  if (headerSelect) headerSelect.value = apartmentId;

  persist();

  if (supabase) {
    const { data: s } = await supabase.auth.getSession();
    if (s?.session?.user?.id) {
      await supabase.from('profiles').update({ last_apartment_id: apartmentId }).eq('id', s.session.user.id);
    }
  }

  console.log('Pulling core state for apartment...');
  const success = await pullState({ domain: 'core' });
  console.log('Pull State Success:', success);
  if (success) {
    const roleAssignments = await loadAllUserRoleAssignmentsCached(portalState.auth?.id);
    await refreshAuthPermissions(apartmentId, roleAssignments);
    applyPermissionsToNav(portalState.authPermissions);
    deferAfterFirstPaint(async () => {
      try {
        await autoLinkResidentByEmail();
        await acceptPendingInvites();
      } catch { /* non-blocking */ }
      refreshStaffNotifications().catch(() => {});
    });
    document.dispatchEvent(new CustomEvent('apartment-data-loaded'));
    renderAccessMappings();
    if (document.getElementById('view-dashboard')?.classList.contains('active')) {
      void renderDashboard();
    }
    if (document.getElementById('view-setup')?.classList.contains('active')) {
      void renderApartmentModulePanel();
    }
    if (typeof window.renderCashLedger === 'function') window.renderCashLedger();
    if (typeof window.renderFinanceAnalytics === 'function') window.renderFinanceAnalytics();
    if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();
  }
  console.groupEnd();
  return success;
};

const setActiveUser = (userId) => {
  const user = portalState.access.users.find(u => u.id === userId);
  if (!user) return;
  portalState.access.activeUserId = userId;
  renderAccessMappings();
  persist();
};

const resolveActiveApartment = async (uid, profile) => {
  if (!supabase || !uid) return { apartments: [], activeId: null, apartmentIds: [] };
  console.group('[Access] Resolving active apartment');

  const { data: mappings, error: mapError } = await withTimeout(
    supabase
      .from('user_apartments')
      .select('apartment_id')
      .eq('user_id', uid),
    15000,
    'Apartment access',
  );
  if (mapError) console.error('[access] user_apartments query failed:', mapError.message);

  let pool = [];
  const mappedIds = [...new Set((mappings || []).map((m) => m.apartment_id).filter(Boolean))];
  if (mappedIds.length) {
    const { data: apartmentsRaw, error: aptListErr } = await withTimeout(
      supabase.from('apartments').select('id, name').in('id', mappedIds),
      15000,
      'Apartments list',
    );
    if (aptListErr) console.error('[access] apartments query failed:', aptListErr.message);
    pool = (apartmentsRaw || []).filter((a) => a.name !== '__SYSTEM__');
  }

  if (!pool.length && (profile?.role === 'admin' || portalState.auth?.role === 'admin')) {
    const { data: apartmentsRaw, error: aptError } = await withTimeout(
      supabase.from('apartments').select('id, name').order('name'),
      15000,
      'Apartments list',
    );
    if (aptError) console.error('[access] apartments query failed:', aptError.message);
    pool = (apartmentsRaw || []).filter((a) => a.name !== '__SYSTEM__');
  }

  console.log('Pool:', pool);

  if (!pool.length) {
    console.error('[access] No apartments in pool for user', uid);
    console.groupEnd();
    return { apartments: [], activeId: null, apartmentIds: [] };
  }

  const cur = portalState.access?.activeApartmentId;
  if (cur && !isPlaceholderApartmentId(cur) && pool.some((a) => a.id === cur)) {
    console.log('Using current:', cur);
    console.groupEnd();
    return { apartments: pool, activeId: cur, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
  }

  const last = profile?.last_apartment_id;
  if (last && pool.some((a) => a.id === last)) {
    console.log('Using last profile apt:', last);
    console.groupEnd();
    return { apartments: pool, activeId: last, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
  }

  const preferred = pool.find((a) => /elixir/i.test(a.name || ''));
  if (preferred) {
    console.log('Using preferred (Elixir):', preferred.id);
    console.groupEnd();
    return { apartments: pool, activeId: preferred.id, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
  }

  const cachedName = (portalState.community?.name || '').trim().toLowerCase();
  if (cachedName && cachedName !== 'communityhub' && cachedName !== 'offline') {
    const byName = pool.find((a) => (a.name || '').trim().toLowerCase() === cachedName);
    if (byName) {
      console.log('Using cached name match:', byName.id);
      console.groupEnd();
      return { apartments: pool, activeId: byName.id, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
    }
  }

  console.log('Using first in pool:', pool[0].id);
  console.groupEnd();
  return { apartments: pool, activeId: pool[0].id, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
};

const loadAccessUserDirectory = async (activeId, uid) => {
  if (!supabase || !activeId) return;
  try {
    const [{ data: aptMappings, error: mapErr }, { data: roleRows, error: roleErr }] = await Promise.all([
      withTimeout(
        supabase.from('user_apartments').select('user_id, apartment_id').eq('apartment_id', activeId),
        15000,
        'User mappings',
      ),
      withTimeout(
        supabase.from('user_role_assignments').select('user_id, apartment_id, role_key').eq('scope', 'apartment').eq('apartment_id', activeId),
        15000,
        'Role assignments',
      ),
    ]);
    if (mapErr) console.error('[access] user_apartments query failed:', mapErr.message);
    if (roleErr && !/user_role_assignments/i.test(roleErr.message)) {
      console.error('[access] user_role_assignments query failed:', roleErr.message);
    }

    const userIds = [...new Set((aptMappings || []).map((m) => m.user_id))];
    if (!userIds.length) return;

    const { data: profiles, error: profilesErr } = await withTimeout(
      supabase.from('profiles').select('id, full_name, email, role').in('id', userIds).order('full_name'),
      15000,
      'User directory',
    );
    if (profilesErr) console.error('[access] profiles query failed:', profilesErr.message);
    if (!profiles?.length) return;

    const map = new Map();
    (aptMappings || []).forEach((m) => {
      if (!map.has(m.user_id)) map.set(m.user_id, []);
      map.get(m.user_id).push(m.apartment_id);
    });
    const rolesByUser = new Map();
    (roleRows || []).forEach((r) => {
      if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, {});
      rolesByUser.get(r.user_id)[r.apartment_id] = r.role_key;
    });

    portalState.access.users = profiles.map((p) => ({
      id: p.id,
      name: p.full_name || p.email || p.id,
      email: p.email || '',
      role: p.role || 'resident_viewer',
      apartment_ids: map.get(p.id) || [],
      apartment_roles: rolesByUser.get(p.id) || {},
    }));

    if (!portalState.access.activeUserId || !portalState.access.users.some((u) => u.id === portalState.access.activeUserId)) {
      portalState.access.activeUserId = uid;
    }
    persist();
    renderAccessMappings();
  } catch (err) {
    console.warn('[access] User directory load skipped:', err.message);
  }
};

const syncAccessFromSupabase = async (profileOverride = null) => {
  if (!supabase) return false;
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) return false;

  ensureAccessState();
  clearRoleAssignmentsCache();

  const selfProfile = profileOverride || await getProfile(uid);
  if (selfProfile) {
    portalState.access.users = [{
      id: selfProfile.id,
      name: selfProfile.full_name || selfProfile.email || 'User',
      email: selfProfile.email || '',
      role: selfProfile.role || 'resident_viewer',
      apartment_ids: [],
    }];
    portalState.access.activeUserId = uid;
  }

  const { apartments, activeId, apartmentIds } = await resolveActiveApartment(uid, selfProfile);
  if (!apartments.length || !activeId) {
    console.error('[access] No apartments available for this user', { apartments: apartments.length, activeId, uid });
    renderAccessMappings();
    return false;
  }

  portalState.access.apartments = apartments;
  portalState.access.activeApartmentId = activeId;
  if (portalState.access.users?.length && apartmentIds?.length) {
    portalState.access.users[0].apartment_ids = apartmentIds;
  }

  const loaded = await setActiveApartment(activeId);
  if (!loaded) {
    console.error('[access] setActiveApartment failed for', activeId, portalState.lastPullMeta);
    renderAccessMappings();
    return false;
  }

  const roleAssignments = await loadAllUserRoleAssignmentsCached(uid);
  if (portalState.auth) {
    if (portalState.auth.isSystemAdmin) {
      portalState.auth.effectiveRoleKey = 'system_admin';
      portalState.auth.role = 'admin';
    } else {
      const aptAssignment = roleAssignments.find((a) => a.scope === 'apartment' && a.apartment_id === activeId);
      if (aptAssignment?.role_key) {
        portalState.auth.effectiveRoleKey = aptAssignment.role_key;
        portalState.auth.role = ROLE_OPTIONS.find((r) => r.key === aptAssignment.role_key)?.v1Key || portalState.auth.role;
      }
    }
  }
  refreshAuthUiShell();

  persist();
  renderAccessMappings();
  deferAfterFirstPaint(() => loadAccessUserDirectory(activeId, uid));
  return true;
};

/**
 * Global Boot Sequence: Partition Restoration & Initialization
 */
/**
 * Global Boot Sequence: Relational Retrieval & Modular Hydration
 */
const repairLocalCache = () => {
  try {
    const raw = localStorage.getItem('sentry_portal_v5_platinum');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (isPlaceholderApartmentId(saved.access?.activeApartmentId)) {
      saved.access.activeApartmentId = null;
      localStorage.setItem('sentry_portal_v5_platinum', JSON.stringify(saved));
    }
  } catch {
    /* ignore corrupt cache */
  }
};

const setBootLoaderMessage = (message) => {
  const label = document.querySelector('#sentry-boot-loader div div:last-child');
  if (label) label.textContent = message;
};

const removeBootLoader = () => document.getElementById('sentry-boot-loader')?.remove();

const finishAuthSession = async (session) => {
  if (!session?.user?.id) return false;
  await syncBackendSession(session);
  await applyAuthToUI(session);
  hideAuth();
  hideWorkspaceGate();
  portalState.access = portalState.access || { users: [], apartments: [] };
  portalState.access.activeUserId = session.user.id;
  const profile = await getProfile(session.user.id);
  const synced = await syncAccessFromSupabase(profile);
  if (!synced) showWorkspaceGate('Sign-in succeeded but society data did not load. Select your society below.');
  else {
    processAnalytics();
    processFinances();
    renderRegistry();
  }
  window.switchView(resolveRoute(window.location.hash.slice(1), portalState.auth?.role));
  return synced;
};

const renderSocialAuthButtons = () => {
  const section = document.getElementById('auth-social-section');
  const container = document.getElementById('auth-social-buttons');
  if (!section || !container) return;

  const providers = supabase ? getEnabledSocialProviders() : [];
  container.replaceChildren();
  if (!providers.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  providers.forEach((provider) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'auth-social-btn';
    btn.dataset.provider = provider.id;
    btn.setAttribute('aria-label', `Continue with ${provider.label}`);
    btn.innerHTML = `<i class="${provider.iconClass}" aria-hidden="true"></i><span>${provider.label}</span>`;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const { error } = await signInWithSocialProvider(supabase, provider.id);
        if (error) showAuth(error.message);
      } catch (err) {
        showAuth(err?.message || 'Social sign-in failed.');
      } finally {
        btn.disabled = false;
      }
    };
    container.appendChild(btn);
  });
};

const boot = async () => {
  document.body.prepend(Object.assign(document.createElement('div'), { id: 'sentry-boot-loader', innerHTML: '<div style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.9); display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:9999; color:#fff;"><i class="fa-solid fa-hotel fa-spin" style="font-size:2rem; margin-bottom:1rem; color:var(--accent);"></i><div style="font-weight:900; letter-spacing:1px; text-transform:uppercase; font-size:0.75rem;">Initializing CommunityHub</div></div>' }));

  let bootHasSupabaseSession = false;
  let bootSession = null;
  let accessSynced = false;

  try {
    if (supabase) {
      setBootLoaderMessage('Checking session…');
      const authRedirect = isSupabaseAuthRedirect();
      const oauthParams = authRedirect ? new URLSearchParams(window.location.search) : null;
      const { data } = await withTimeout(supabase.auth.getSession(), 15000, 'Session check');
      if (authRedirect) {
        const oauthError = oauthParams?.get('error');
        if (oauthError && !data?.session) {
          showAuth(oauthParams.get('error_description') || oauthError);
        }
        cleanAuthRedirectFromUrl();
      }
      if (!data?.session) {
        showAuth();
        return;
      }
      bootHasSupabaseSession = true;
      bootSession = data.session;
      bootAuthHandled = true;
      repairLocalCache();
      await syncBackendSession(bootSession);
      setBootLoaderMessage('Loading profile…');
      const bootProfile = await getProfile(bootSession.user.id);
      await applyAuthToUI(bootSession, {
        profile: bootProfile,
        refreshPermissions: false,
        notifications: false,
        adminRpc: false,
      });
      setBootLoaderMessage('Loading society data…');
      accessSynced = await withTimeout(syncAccessFromSupabase(bootProfile), 120000, 'Society sync');
    }

    if (!accessSynced && bootHasSupabaseSession && bootSession?.user?.id) {
      setBootLoaderMessage('Resolving society access…');
      const profile = await getProfile(bootSession.user.id);
      const { apartments, activeId } = await resolveActiveApartment(bootSession.user.id, profile);
      if (apartments.length && activeId) {
        portalState.access = portalState.access || { users: [], activeUserId: bootSession.user.id };
        portalState.access.apartments = apartments;
        portalState.access.activeApartmentId = activeId;
        renderAccessMappings();
        accessSynced = await setActiveApartment(activeId);
      }
    }

    if (!accessSynced && !bootHasSupabaseSession) {
      ensureAccessState();
      const connected = await migrateAndRecover({ signedIn: false });
      if (!connected) console.warn('Cloud Registry Offline - Falling back to local cache.');
      ensureAccessState();

      if (!isPlaceholderApartmentId(portalState.access?.activeApartmentId)) {
        await setActiveApartment(portalState.access.activeApartmentId);
      }
    } else if (!accessSynced && bootHasSupabaseSession) {
      refreshAuthUiShell();
      renderAccessMappings();
      showWorkspaceGate('Could not load society data automatically. Select your society below, or check the browser console.');
    } else if (bootSession && accessSynced) {
      refreshAuthUiShell();
    }

    renderAccessMappings();
    const route = resolveRoute(window.location.hash.slice(1), portalState.auth?.role);
    window.switchView(route);
  } catch (err) {
    console.error('[boot] failed:', err);
    if (bootHasSupabaseSession) {
      renderAccessMappings();
      showWorkspaceGate(err?.message || 'Startup failed. Select your society below or refresh the page.');
    } else {
      showAuth(err?.message || 'Startup failed. Please refresh and try again.');
    }
  } finally {
    removeBootLoader();
  }
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
let routingGuard = false;

window.switchView = async (v) => {
  if (routingGuard) return;
  const route = resolveRoute(v, portalState.auth?.role);
  const fallback = findFirstAllowedRoute(portalState.auth?.role);
  if (!routeIsAllowed(route, !supabase)) {
    if (route === fallback) {
      console.warn('[nav] Blocked route matches fallback — no accessible page:', route);
      alert('You do not have permission to access this page.');
      return;
    }
    routingGuard = true;
    alert('You do not have permission to access this page.');
    routingGuard = false;
    window.switchView(fallback);
    return;
  }

  const meta = findPage(route);
  if (!meta) {
    console.warn(`Unknown route: ${v}`);
    if (route === fallback) return;
    routingGuard = true;
    window.switchView(fallback);
    routingGuard = false;
    return;
  }

  const { page } = meta;
  document.body.classList.add('route-loading');
  try {
    await ensureRouteState(route);
    await ensureViewMounted(page.view);
    showView(page.view);
    if (window.location.hash.slice(1) !== route) {
      window.location.hash = `#${route}`;
    }
    updateNavActiveState(route);
    updateNavBreadcrumb(route);
    await activateView(route, page);
  } catch (err) {
    console.warn('[nav] View activation failed:', err?.message || err);
  } finally {
    document.body.classList.remove('route-loading');
  }
};


/**
 * Event Listener Initialization
 */
document.addEventListener('DOMContentLoaded', async () => {
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
      document.getElementById('registry-summaries')?.removeAttribute('open');
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
    await finishAuthSession(data.session);
  };

  const signUp = async () => {
    if (!supabase) return showAuth('Supabase is not configured.');
    const email = (emailEl?.value || '').trim();
    const password = (passEl?.value || '').trim();
    if (!email || !password) return showAuth('Email and password required.');
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return showAuth(error.message);
    if (!data.session) return showAuth('Account created. Please verify your email, then sign in.');
    await finishAuthSession(data.session);
  };

  if (loginBtn) loginBtn.onclick = signIn;
  if (signupBtn) signupBtn.onclick = signUp;
  renderSocialAuthButtons();

  initWorkspaceGate();

  if (supabase) {
    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'INITIAL_SESSION' && !bootAuthHandled) return;
      if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION')) {
        await syncBackendSession(session);
        if (event === 'TOKEN_REFRESHED') {
          await applyAuthToUI(session, { refreshPermissions: false, notifications: false, adminRpc: false });
        } else if (event === 'SIGNED_IN') {
          await applyAuthToUI(session, { refreshPermissions: false, notifications: false, adminRpc: false });
        } else {
          await applyAuthToUI(session);
        }
        if (event === 'SIGNED_IN') {
          hideAuth();
          hideWorkspaceGate();
          const profile = await getProfile(session.user.id);
          const synced = await syncAccessFromSupabase(profile);
          if (!synced) showWorkspaceGate();
        }
      }
      if (event === 'SIGNED_OUT') {
        await clearBackendSession();
        showAuth();
      }
    });
  }

  // Global View Router
  window.addEventListener('hashchange', () => {
    window.switchView(window.location.hash.slice(1));
  });

  // User & Apartment Management Modals
  let activeUserIdForEdit = null;
  window.openUserModal = async (userId = null) => {
    activeUserIdForEdit = userId;
    const user = portalState.access.users.find(u => u.id === userId);
    document.getElementById('access-user-name-v2').value = user?.name || '';
    document.getElementById('access-user-email-v2').value = user?.email || '';
    let roleVal = v1RoleToV2Key(user?.role || 'resident_viewer');
    if (userId && supabase) {
      const assignments = await loadUserRoleAssignments(userId);
      if (assignments.length) roleVal = primaryRoleFromAssignments(assignments);
    }
    document.getElementById('access-user-role-v2').value = roleVal;
    const aptSelect = document.getElementById('access-user-apartments-v2');
    Array.from(aptSelect.options).forEach(opt => {
      opt.selected = (user?.apartment_ids || []).includes(opt.value);
    });
    const refreshUserModules = () => {
      const apartment_ids = Array.from(aptSelect.selectedOptions).map(o => o.value);
      void renderUserModulePanel(userId, apartment_ids);
      void renderUserPageAccessPanel(userId, apartment_ids);
    };
    aptSelect.onchange = refreshUserModules;
    document.getElementById('access-user-role-v2').onchange = refreshUserModules;
    refreshUserModules();
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
      const previousAssignments = await loadUserRoleAssignments(prof.id);
      try {
        await saveUserAccess({
          userId: prof.id,
          name: name || prof.full_name,
          email,
          roleKey: role,
          apartmentIds: apartment_ids,
          previousAssignments,
          managedApartmentIds: (portalState.access?.apartments || []).map((a) => a.id),
        });
        await saveUserModuleOverridesFromPanel(prof.id, apartment_ids);
        await saveUserPageOverridesFromPanel(prof.id, apartment_ids);
      } catch (err) {
        return alert(err?.message || 'Could not save user access.');
      }
      await syncAccessFromSupabase();
      const { data: sess } = await supabase.auth.getSession();
      if (sess?.session?.user?.id === prof.id) {
        portalState.authPermissions = null;
        await applyAuthToUI(sess.session);
        const currentRoute = window.location.hash.slice(1);
        if (currentRoute && !routeIsAllowed(currentRoute, !supabase)) {
          window.switchView(findFirstAllowedRoute(portalState.auth?.role));
        }
      }
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
      const scopeIds = (portalState.access?.apartments || []).map((a) => a.id);
      for (const aid of scopeIds) {
        await supabase.from('user_apartments').delete().eq('user_id', userId).eq('apartment_id', aid);
        await supabase
          .from('user_role_assignments')
          .delete()
          .eq('user_id', userId)
          .eq('scope', 'apartment')
          .eq('apartment_id', aid);
      }
      // We don't delete the profile, just their access mappings for societies you manage.
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
  const apartmentSelectors = ['access-active-apartment', 'nav-apartment-switch', 'sidebar-apartment-switch', 'header-apartment-switch', 'user-menu-apartment-switch'];
  apartmentSelectors.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.onchange = async (e) => {
        const aptId = e.target.value;
        if (!aptId || isPlaceholderApartmentId(aptId)) return;
        await setActiveApartment(aptId);
        apartmentSelectors.forEach(sid => {
          const sel = document.getElementById(sid);
          if (sel) sel.value = aptId;
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
    window.switchView('admin-settings');
    setTimeout(() => document.getElementById('access-users-list-v2')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const logoutBtn = document.getElementById('user-menu-logout');
  if (logoutBtn) logoutBtn.onclick = () => {
    hideUserMenu();
    void signOut();
  };

  const topbarLogoutBtn = document.getElementById('topbar-logout-btn');
  if (topbarLogoutBtn) topbarLogoutBtn.onclick = () => void signOut();

  const makeAdminBtn = document.getElementById('user-menu-make-admin');
  if (makeAdminBtn) makeAdminBtn.onclick = async () => {
    hideUserMenu();
    if (!supabase) return alert('Supabase not configured.');
    const { data: s } = await supabase.auth.getSession();
    const uid = s?.session?.user?.id;
    if (!uid) return showAuth('Please sign in again.');
    const aptId = portalState.access?.activeApartmentId;
    const { error } = await supabase.from('profiles').update({ role: 'admin' }).eq('id', uid);
    if (error) return alert(error.message);
    if (aptId && !isPlaceholderApartmentId(aptId)) {
      await supabase.from('user_role_assignments').delete()
        .eq('user_id', uid).eq('scope', 'apartment').eq('apartment_id', aptId);
      const { error: roleErr } = await supabase.from('user_role_assignments').insert({
        user_id: uid,
        role_key: 'apartment_admin',
        scope: 'apartment',
        apartment_id: aptId,
      });
      if (roleErr && !/user_role_assignments/i.test(roleErr.message)) {
        console.warn('[auth] role assignment insert failed:', roleErr.message);
      }
    }
    const refreshed = await supabase.auth.getSession();
    await applyAuthToUI(refreshed.data.session);
    alert('You are now Association Office Bearer (admin). Open Administration in the sidebar.');
  };

  const activeUserSelect = document.getElementById('access-active-user');
  if (activeUserSelect) activeUserSelect.onchange = (e) => setActiveUser(e.target.value);

  // Modal Unified Button Hooks
  document.getElementById('save-mdl-btn')?.addEventListener('click', () => {
    void withButtonBusy(document.getElementById('save-mdl-btn'), 'Saving…', saveMdlData);
  });

  document.getElementById('add-vehicle-btn')?.addEventListener('click', () => {
    const uid = portalState.activeUnitId;
    const plate = document.getElementById('new-v-plate')?.value || '';
    const type = document.getElementById('new-v-type')?.value || 'CAR';
    const btn = document.getElementById('add-vehicle-btn');
    void withButtonBusy(btn, 'Adding…', async () => {
      if (!uid) throw new Error('Flat not found. Close and reopen this dialog.');
      await addVehicleToUnit(uid, plate, type);
      const plateEl = document.getElementById('new-v-plate');
      if (plateEl) plateEl.value = '';
    }).catch((err) => alert(err?.message || 'Could not add vehicle.'));
  });

  document.getElementById('new-v-plate')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('add-vehicle-btn')?.click();
    }
  });

  document.querySelectorAll('.unit-parking-type__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof window.syncNewVehicleType === 'function') {
        window.syncNewVehicleType(btn.dataset.vType);
      }
    });
  });
  initStaffNotificationsUi();
  document.addEventListener('module-access-loaded', () => {
    applyPermissionsToNav(portalState.authPermissions);
  });
  renderNavModules();
  initNavInteraction((route) => window.switchView(route));
  applyNavPermissions(new Set(portalState.authPermissions || []), !supabase);

  // Initialize Router State
  console.log('Main: Starting boot sequence...');
  await boot();
  console.log('Main: Boot complete. Initializing ledger sync...');
  import('./ledgerSpreadsheetSync.js')
    .then(({ initLedgerSpreadsheetSync }) => initLedgerSpreadsheetSync())
    .catch((err) => console.warn('[boot] Ledger sync init skipped:', err?.message));
  console.log('Main: Ledger sync init scheduled.');
});
