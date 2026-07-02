/**
 * Sentry Portal Modular Entry (Vercel Edition)
 * Primary Boot Sequence & View Coordination
 */
import { portalState, persist, migrateAndRecover, supabase, pullState, upsertSocietyConfig, isPlaceholderApartmentId, withTimeout } from './store.js';
import {
  processAnalytics,
  renderRegistry,
  saveMdlData,
  addVehicleToUnit,
  handleCSVImport,
  downloadVehicleRegistryXlsx,
  addCommunityPoolSlot,
  openCapacityModal,
  closeCapacityModal,
  applyCapacityDefaultsToAll,
  saveCapacityAllocation,
  refreshCapacityUnitList,
} from './registry.js';
import { processFinances, renderCashLedger, saveCashData, initExpenseModal, renderAuditReports, initAccountsSubViewTabs, syncAccountsSubViewTabs } from './finances.js';
import { initFinanceAnalyticsUi, renderFinanceAnalytics } from './financeAnalytics.js';
import { renderLedgerSyncPanel } from './ledgerSpreadsheetSync.js';
import { handleOAuthRedirectIfPresent } from './ledgerOAuth.js';
import { initMaintenanceBilling } from './maintenanceBilling.js';
import { initBulkCollectionImport } from './bulkCollectionImport.js';
import { initUnitDirectory, renderUnitDirectory, deleteFlatWithResidents, flatDeleteConfirmMessage } from './unitDirectory.js';
import { initResidentImport } from './residentImport.js';
import { initSetupAdmin, switchSetupSubView } from './admin.js';
import { initActivityAuditUi, renderActivityLogPage } from './activityAudit.js';
import { initStaffNotificationsUi, refreshStaffNotifications } from './staffNotifications.js';
import { initBankReconciliationUi, renderBankReconciliation } from './bankReconciliation.js';
import { initResidentPortal, renderPortalSubview } from './residentPortal.js';
import { initSecurityPortal, renderSecuritySubview } from './securityPortal.js';
import { initResidentLinks, renderResidentLinksAdmin, autoLinkResidentByEmail, acceptPendingInvites } from './residentLinks.js';
import { initPayments } from './payments.js';
import { initNotices } from './notices.js';
import { initOperations } from './operations.js';
import { openTransitionWizard } from './unitTransitions.js';
import { initParkingOps, renderParkingViolations, refreshParkingUi } from './parkingOps.js';
import { initPortfolio, renderPortfolioRollup } from './portfolio.js';
import { initDashboard, renderDashboard } from './dashboard.js';
import { renderApartmentModulePanel, renderUserModulePanel, saveUserModuleOverridesFromPanel } from './moduleAccessAdmin.js';
import { renderPageAccessAdmin, renderUserPageAccessPanel, saveUserPageOverridesFromPanel } from './pageAccessAdmin.js';
import { initGeneralLedger, renderGeneralLedger } from './generalLedger.js';
import { initEmailOutbox, renderEmailOutbox } from './emailOutbox.js';
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
import {
  parseParkingExcelFile,
  buildImportPreview,
  applyParkingImport,
} from './parkingImport.js';
import {
  openVehicleAuditModal,
  closeVehicleAuditModal,
  renderVehicleAuditModal,
  downloadPendingAuditCsv,
  markAllPendingVehicleAuditSynced,
  refreshAuditBadge,
} from './vehicleAudit.js';
import { withButtonBusy } from './buttonBusy.js';
import {
  loadResidents,
  saveResident as persistResident,
  deleteResident,
  getResidents,
  dedupeResidents,
  groupResidentsByUnit,
  splitResidentsByKind,
  classifyUnitOccupancy,
  computeResidentPageSummary,
  occupancySummaryLabel,
  occupancySummaryBadge,
  occupancySummaryHint,
  unitMissingOwners,
  normUnit,
  filterResidentsByOptions,
  unitPassesOccupancyFilter,
} from './residents.js';
import {
  getBlockOptions,
  getSelectedBlock,
  setSelectedBlock,
  unitNumberMatchesBlock,
} from './blockFilter.js';

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

const getProfile = async (userId) => {
  if (!supabase || !userId) return null;
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
    return data;
  } catch (err) {
    console.warn('[Auth] Profile fetch failed:', err.message);
    return null;
  }
};

const formatRoleLabel = (role) => {
  const match = ROLE_OPTIONS.find((r) => r.key === role || r.v1Key === role);
  return match?.label || v2KeyToLabel(role) || String(role || 'Viewer').replace(/_/g, ' ');
};

const can = (perm) => hasClientPermission(perm, resolveEffectivePermissions());

const applyPermissionsToNav = (perms) => {
    applyNavPermissions(new Set(perms || resolveEffectivePermissions()), !supabase);
};

const applyAuthToUIInner = async (session) => {
  const user = session?.user;
  if (!user) return;
  console.group('[Auth] Applying to UI');
  console.log('User:', user.id, user.email);
  const profile = await getProfile(user.id);
  console.log('Profile:', profile);
  const name = profile?.full_name || user.user_metadata?.full_name || profile?.email || user.email || 'User';
  let role = profile?.role || 'resident_viewer';
  let effectiveRoleKey = v1RoleToV2Key(role);
  const aptId = portalState.access?.activeApartmentId;
  if (supabase && aptId && !isPlaceholderApartmentId(aptId)) {
    const assignments = await loadUserRoleAssignments(user.id);
    const aptAssignment = assignments.find((a) => a.apartment_id === aptId);
    if (aptAssignment?.role_key) {
      effectiveRoleKey = aptAssignment.role_key;
      role = ROLE_OPTIONS.find((r) => r.key === aptAssignment.role_key)?.v1Key || role;
    }
  }
  portalState.auth = { id: user.id, email: user.email || profile?.email || '', name, role, effectiveRoleKey };

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
  if (aptId && supabase && !isPlaceholderApartmentId(aptId)) {
    console.log('Refreshing permissions for:', aptId);
    await refreshAuthPermissions(aptId);
    try {
      const { loadUserPageAccess } = await import('./pageAccess.js');
      await loadUserPageAccess(aptId, user.id, effectiveRoleKey);
    } catch { /* tables may not exist yet */ }
  } else {
    portalState.authPermissions = permissionsFromV1Role(role);
  }

  // RBAC gating (UI-level; server-side via RLS in SQL file)
  const manageBtn = document.getElementById('user-menu-manage');
  if (manageBtn) manageBtn.style.display = can('rbac.view') ? 'flex' : 'none';
  applyPermissionsToNav(portalState.authPermissions || resolveEffectivePermissions());
  refreshStaffNotifications().catch(() => {});

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
  console.groupEnd();
};

const applyAuthToUI = (session) => {
  if (authApplyInflight) return authApplyInflight;
  authApplyInflight = applyAuthToUIInner(session).finally(() => {
    authApplyInflight = null;
  });
  return authApplyInflight;
};

const isSignedIn = () => Boolean(portalState.auth?.id);

const signOut = async (message = 'Signed out.') => {
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
      processAnalytics();
      processFinances();
      renderRegistry();
      window.switchView(resolveRoute(window.location.hash.slice(1), portalState.auth?.role));
    };
  }
};

const apartmentOptionsForUi = () => {
  const all = portalState.access?.apartments || [];
  const real = all.filter((a) => !isPlaceholderApartmentId(a.id));
  return real.length ? real : all;
};

const ensureAccessState = () => {
  if (!portalState.access) {
    if (isSignedIn()) {
      portalState.access = {
        apartments: [],
        users: [],
        activeApartmentId: null,
        activeUserId: portalState.auth.id,
      };
    } else {
      portalState.access = {
        apartments: [{ id: 'apt-default', name: 'Offline' }],
        users: [],
        activeApartmentId: 'apt-default',
        activeUserId: null,
      };
    }
  }
  if (!portalState.access.apartments.length && !isSignedIn()) {
    portalState.access.apartments.push({ id: 'apt-default', name: 'Offline' });
  }
  if (isSignedIn()) {
    if (isPlaceholderApartmentId(portalState.access.activeApartmentId)) {
      const realApt = portalState.access.apartments.find((a) => !isPlaceholderApartmentId(a.id));
      portalState.access.activeApartmentId = realApt?.id || null;
    }
  } else if (!portalState.access.activeApartmentId || isPlaceholderApartmentId(portalState.access.activeApartmentId)) {
    const realApt = portalState.access.apartments.find((a) => !isPlaceholderApartmentId(a.id));
    portalState.access.activeApartmentId = realApt?.id || portalState.access.apartments[0]?.id || 'apt-default';
  }
  if (!portalState.access.users.length) {
    if (portalState.auth?.id) {
      portalState.access.users.push({
        id: portalState.auth.id,
        name: portalState.auth.name || portalState.auth.email || 'User',
        email: portalState.auth.email || '',
        role: portalState.auth.role,
        apartment_ids: portalState.access.apartments
          .map((a) => a.id)
          .filter((id) => !isPlaceholderApartmentId(id)),
      });
      portalState.access.activeUserId = portalState.auth.id;
    } else if (!isSignedIn()) {
      portalState.access.users.push({
        id: 'usr-default',
        name: 'Offline user',
        email: '',
        apartment_ids: [portalState.access.activeApartmentId],
      });
      portalState.access.activeUserId = 'usr-default';
    }
  }
  if (!portalState.access.activeUserId) {
    portalState.access.activeUserId = portalState.access.users[0].id;
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

  const headerSelect = document.getElementById('header-apartment-switch');
  if (headerSelect) headerSelect.value = apartmentId;

  persist();

  if (supabase) {
    const { data: s } = await supabase.auth.getSession();
    if (s?.session?.user?.id) {
      await supabase.from('profiles').update({ last_apartment_id: apartmentId }).eq('id', s.session.user.id);
    }
  }

  console.log('Pulling state for apartment...');
  const success = await pullState();
  console.log('Pull State Success:', success);
  if (success) {
    await refreshAuthPermissions(apartmentId);
    applyPermissionsToNav(portalState.authPermissions);
    await autoLinkResidentByEmail();
    await acceptPendingInvites();
    document.dispatchEvent(new CustomEvent('apartment-data-loaded'));
    renderAccessMappings();
    renderRegistry();
    if (document.getElementById('view-dashboard')?.classList.contains('active')) {
      void renderDashboard();
    }
    if (document.getElementById('view-setup')?.classList.contains('active')) {
      void renderApartmentModulePanel();
    }
    applyPermissionsToNav(portalState.authPermissions);
    refreshStaffNotifications().catch(() => {});
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

const renderAccessMappings = () => {
  ensureAccessState();
  const apartments = apartmentOptionsForUi();
  const users = portalState.access.users;

  // 1. Sidebar/Header Selects
  const sidebarApartmentSelect = document.getElementById('sidebar-apartment-switch');
  const drawerApartmentSelect = document.getElementById('nav-apartment-switch');
  const headerApartmentSelect = document.getElementById('header-apartment-switch');

  const placeholderOption = isSignedIn() && !apartments.length
    ? '<option value="">No societies</option>'
    : '<option value="">Select society…</option>';
  const apartmentOptions = apartments.length
    ? apartments.map(a => `<option value="${a.id}">${a.name}</option>`).join('')
    : placeholderOption;
  const activeId = portalState.access.activeApartmentId;
  const syncSelect = (el) => {
    if (!el) return;
    el.innerHTML = apartmentOptions;
    if (activeId && apartments.some((a) => a.id === activeId)) el.value = activeId;
    else if (apartments.length === 1) el.value = apartments[0].id;
    else el.value = '';
  };
  syncSelect(sidebarApartmentSelect);
  syncSelect(drawerApartmentSelect);
  syncSelect(headerApartmentSelect);

  // 2. New User Directory Table (v2)
  const usersListV2 = document.getElementById('access-users-list-v2');
  if (usersListV2) {
    const showUnassigned = document.getElementById('access-users-show-unassigned')?.checked
      ?? portalState.access.showUnassignedUsers
      ?? false;
    portalState.access.showUnassignedUsers = showUnassigned;

    const directoryUsers = users.filter((u) => {
      if (!activeId) return true;
      const hasSociety = (u.apartment_ids || []).includes(activeId);
      if (hasSociety) return true;
      return showUnassigned;
    });

    const activeAptName = apartments.find((a) => a.id === activeId)?.name || 'this society';

    if (!directoryUsers.length) {
      usersListV2.innerHTML = `
        <div class="user-directory-empty" style="padding:2rem; text-align:center; color:var(--text-dim);">
          <p style="font-weight:600; margin-bottom:0.35rem;">No users found for ${activeAptName}</p>
          <p style="font-size:0.82rem; max-width:28rem; margin:0 auto;">
            Residents appear here after they sign up and you assign access, or enable
            “Include users without society access” to find accounts waiting to be linked.
          </p>
        </div>`;
    } else {
      usersListV2.innerHTML = directoryUsers.map(u => {
        const mappedApts = apartments.filter(a => (u.apartment_ids || []).includes(a.id));
        const aptChips = mappedApts.map(a => `<span class="apt-chip">${a.name}</span>`).join('') || '<span style="color:var(--text-dim); font-style:italic;">No access</span>';
        const initials = (u.name || 'U').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
        const aptRole = activeId && u.apartment_roles?.[activeId];
        const displayRole = aptRole || u.role;
        const roleLabel = ROLE_OPTIONS.find((r) => r.key === displayRole || r.v1Key === displayRole)?.label
          || v2KeyToLabel(displayRole) || displayRole || 'Viewer';

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
            <span class="role-badge ${displayRole || 'resident_viewer'}">${roleLabel}</span>
          </div>
          <div class="apt-chips">${aptChips}</div>
          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button class="btn-icon" onclick="window.openResidentLinkModal('${u.id}', '${(u.email || '').replace(/'/g, "\\'")}')" title="Link portal flat"><i class="fa-solid fa-link"></i></button>
            <button class="btn-icon" onclick="window.openUserModal('${u.id}')" title="Edit Access"><i class="fa-solid fa-pen-to-square"></i></button>
            <button class="btn-icon danger" onclick="window.deleteUser('${u.id}')" title="Revoke All Access"><i class="fa-solid fa-user-slash"></i></button>
          </div>
        </div>
      `;
      }).join('');
    }
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

const resolveActiveApartment = async (uid, profile) => {
  if (!supabase || !uid) return { apartments: [], activeId: null };
  console.group('[Access] Resolving active apartment');

  const { data: mappings, error: mapError } = await withTimeout(
    supabase
      .from('user_apartments')
      .select('apartment_id, apartments(id, name)')
      .eq('user_id', uid),
    15000,
    'Apartment access',
  );
  if (mapError) console.error('[access] user_apartments query failed:', mapError.message);

  let pool = (mappings || [])
    .map((m) => m.apartments)
    .filter((a) => a && a.name !== '__SYSTEM__');

  if (!pool.length && !mapError && (mappings || []).length) {
    const ids = [...new Set((mappings || []).map((m) => m.apartment_id).filter(Boolean))];
    if (ids.length) {
      const { data: apartmentsRaw } = await withTimeout(
        supabase.from('apartments').select('id, name').in('id', ids),
        15000,
        'Apartments list',
      );
      pool = (apartmentsRaw || []).filter((a) => a.name !== '__SYSTEM__');
    }
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
    return { apartments: [], activeId: null };
  }

  const cur = portalState.access?.activeApartmentId;
  if (cur && !isPlaceholderApartmentId(cur) && pool.some((a) => a.id === cur)) {
    console.log('Using current:', cur);
    console.groupEnd();
    return { apartments: pool, activeId: cur };
  }

  const last = profile?.last_apartment_id;
  if (last && pool.some((a) => a.id === last)) {
    console.log('Using last profile apt:', last);
    console.groupEnd();
    return { apartments: pool, activeId: last };
  }

  const preferred = pool.find((a) => /elixir/i.test(a.name || ''));
  if (preferred) {
    console.log('Using preferred (Elixir):', preferred.id);
    console.groupEnd();
    return { apartments: pool, activeId: preferred.id };
  }

  const cachedName = (portalState.community?.name || '').trim().toLowerCase();
  if (cachedName && cachedName !== 'communityhub' && cachedName !== 'offline') {
    const byName = pool.find((a) => (a.name || '').trim().toLowerCase() === cachedName);
    if (byName) {
      console.log('Using cached name match:', byName.id);
      console.groupEnd();
      return { apartments: pool, activeId: byName.id };
    }
  }

  console.log('Using first in pool:', pool[0].id);
  console.groupEnd();
  return { apartments: pool, activeId: pool[0].id };
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

const syncAccessFromSupabase = async () => {
  if (!supabase) return false;
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData?.session?.user?.id;
  if (!uid) return false;

  ensureAccessState();

  const selfProfile = await getProfile(uid);
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

  const { apartments, activeId } = await resolveActiveApartment(uid, selfProfile);
  if (!apartments.length || !activeId) {
    console.error('[access] No apartments available for this user', { apartments: apartments.length, activeId, uid });
    renderAccessMappings();
    return false;
  }

  portalState.access.apartments = apartments;
  portalState.access.activeApartmentId = activeId;

  const loaded = await setActiveApartment(activeId);
  if (!loaded) {
    console.error('[access] setActiveApartment failed for', activeId, portalState.lastPullMeta);
    renderAccessMappings();
    return false;
  }

  await refreshAuthPermissions(activeId);
  applyPermissionsToNav(portalState.authPermissions);

  const { data: selfMappings } = await withTimeout(
    supabase.from('user_apartments').select('apartment_id').eq('user_id', uid),
    15000,
    'Your apartment access',
  );
  if (portalState.access.users?.length) {
    portalState.access.users[0].apartment_ids = (selfMappings || []).map((m) => m.apartment_id);
  }

  persist();
  renderAccessMappings();
  void loadAccessUserDirectory(activeId, uid);
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

const boot = async () => {
  document.body.prepend(Object.assign(document.createElement('div'), { id: 'sentry-boot-loader', innerHTML: '<div style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.9); display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:9999; color:#fff;"><i class="fa-solid fa-hotel fa-spin" style="font-size:2rem; margin-bottom:1rem; color:var(--accent);"></i><div style="font-weight:900; letter-spacing:1px; text-transform:uppercase; font-size:0.75rem;">Initializing CommunityHub</div></div>' }));

  let bootHasSupabaseSession = false;
  let bootSession = null;
  let accessSynced = false;

  try {
    if (supabase) {
      setBootLoaderMessage('Checking session…');
      const { data } = await withTimeout(supabase.auth.getSession(), 15000, 'Session check');
      if (!data?.session) {
        showAuth();
        return;
      }
      bootHasSupabaseSession = true;
      bootSession = data.session;
      bootAuthHandled = true;
      repairLocalCache();
      setBootLoaderMessage('Loading profile…');
      await applyAuthToUI(bootSession);
      setBootLoaderMessage('Loading society data…');
      accessSynced = await withTimeout(syncAccessFromSupabase(), 120000, 'Society sync');
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
      await applyAuthToUI(bootSession);
      renderAccessMappings();
      showWorkspaceGate('Could not load society data automatically. Select your society below, or check the browser console.');
    } else if (bootSession) {
      await applyAuthToUI(bootSession);
    }

    renderAccessMappings();
    processAnalytics();
    processFinances();
    renderRegistry();

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

window.switchView = (v) => {
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
  document.querySelectorAll('.content-view').forEach((x) => x.classList.remove('active'));
  const viewNode = document.getElementById(`view-${page.view}`);
  if (!viewNode) {
    console.warn(`Missing view section for route: ${route}`);
    document.getElementById(`view-${page.view === 'portal' ? 'portal' : 'registry'}`)?.classList.add('active');
    return;
  }
  viewNode.classList.add('active');

  if (window.location.hash.slice(1) !== route) {
    window.location.hash = `#${route}`;
  }

  updateNavActiveState(route);
  updateNavBreadcrumb(route);

  if (page.view === 'portal') {
    document.querySelectorAll('.portal-subview').forEach((el) => {
      el.hidden = el.id !== `portal-subview-${page.subview}`;
    });
    void renderPortalSubview(page.subview || 'home');
  }
  if (page.view === 'security') {
    document.querySelectorAll('.security-subview').forEach((el) => {
      el.hidden = el.id !== `security-subview-${page.subview}`;
    });
    void renderSecuritySubview(page.subview || 'gate');
  }
  if (page.view === 'operations') {
    window.switchOperationsSubView?.(page.subview || 'helpdesk');
  }
  if (page.view === 'accounts') {
    syncAccountsSubViewTabs(route);
    window.switchSubView(page.subview || 'ledger');
    if (page.subview === 'reports') renderFinanceAnalytics();
    else if (page.subview === 'bank-recon') renderBankReconciliation();
    else if (page.subview === 'activity') void renderActivityLogPage();
    else if (page.subview === 'gl') renderGeneralLedger();
    else {
      renderCashLedger();
      renderLedgerSyncPanel();
    }
  }
  if (page.view === 'parking-fines') {
    renderParkingViolations();
    refreshParkingUi();
  }
  if (page.view === 'portfolio') void renderPortfolioRollup();
  if (page.view === 'email') renderEmailOutbox();
  if (page.view === 'access-control') void renderPageAccessAdmin();
  if (page.view === 'dashboard') void renderDashboard();
  if (page.view === 'invoices') window.switchInvoiceSubView(page.subview || 'pending-dues');
  if (page.view === 'registry') {
    renderRegistry();
    refreshParkingUi();
    void refreshAuditBadge();
  }
  if (page.view === 'setup') {
    document.getElementById('setup-name').value = portalState.community.name;
    document.getElementById('setup-car').value = portalState.community.defaults.cars;
    document.getElementById('setup-bike').value = portalState.community.defaults.bikes;
    renderAccessMappings();
    void renderResidentLinksAdmin();
    void renderApartmentModulePanel();
    switchSetupSubView(page.subview || 'society');
  }
  if (page.view === 'apartment') renderResidents();
  if (page.view === 'units') void renderUnitDirectory();
};

let residentSummaryFilter = '';

const getResidentFilterOptions = () => ({
  filterQ: (document.getElementById('resident-filter')?.value || '').trim().toLowerCase(),
  kind: document.getElementById('resident-kind-filter')?.value || '',
  residency: document.getElementById('resident-residency-filter')?.value || '',
  primaryOnly: document.getElementById('resident-primary-filter')?.checked || false,
});

const hasResidentPersonFilters = (opts) =>
  Boolean(opts.filterQ || opts.kind || opts.residency || opts.primaryOnly);

const hasAnyResidentFilters = (opts) =>
  Boolean(hasResidentPersonFilters(opts) || residentSummaryFilter);

const buildScopedUnitNumbers = (block, allResidents) => {
  const fromUnits = (portalState.units || [])
    .filter((u) => u.is_community !== true)
    .filter((u) => !block || unitNumberMatchesBlock(u.number, block))
    .map((u) => u.number);
  const fromResidents = [...new Set((allResidents || []).map((r) => r.unit_number))];
  const merged = [...fromUnits];
  fromResidents.forEach((n) => {
    if (!block || unitNumberMatchesBlock(n, block)) {
      if (!merged.some((x) => normUnit(x) === normUnit(n))) merged.push(n);
    }
  });
  return merged;
};

const renderResidentRow = (r, esc) => {
  const residingBadge = (r.kind || '').toUpperCase() !== 'TENANT' && r.is_residing === false
    ? ' <span class="resident-residing-badge resident-residing-badge--away">Non-residing</span>'
    : '';
  return `
    <div class="apt-row resident-group-row" data-resident-id="${r.id}">
      <div class="resident-name">${esc(r.full_name)}${r.is_primary ? ' <span class="resident-primary-badge">Primary</span>' : ''}${residingBadge}</div>
      <div class="resident-phone" data-label="Phone">${esc(r.phone || '—')}</div>
      <div class="resident-email" data-label="Email">${esc(r.email || '—')}</div>
      <div class="resident-actions">
        <button class="btn btn-outline btn--icon" data-action="portal" title="Portal access"><i class="fa-solid fa-link"></i></button>
        <button class="btn btn-outline btn--icon" data-action="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-outline btn--icon btn--danger" data-action="del" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
      </div>
    </div>`;
};

const formatResidentNameList = (list, esc) => {
  if (!list.length) return '';
  return list.map((r) => {
    const primary = r.is_primary ? ' ★' : '';
    const away = (r.kind || '').toUpperCase() !== 'TENANT' && r.is_residing === false ? ' (away)' : '';
    return `${esc(r.full_name)}${primary}${away}`;
  }).join(' · ');
};

const previewNamesForUnit = (occ, owners, tenants) => {
  if (occ === 'TENANT_OCCUPIED') return tenants;
  if (occ === 'OWNER_OCCUPIED') return owners.filter((r) => r.is_residing !== false);
  if (occ === 'VACANT') return owners.filter((r) => r.is_residing === false);
  return [];
};

const previewFallbackLabel = (occ) => {
  if (occ === 'NON_ALLOTABLE') return 'Non-allotable';
  if (occ === 'VACANT') return 'Nobody residing';
  if (occ === 'UNDER_RENOVATION') return 'Under renovation';
  if (occ === 'LOCKED') return 'Locked';
  if (occ === 'DEVELOPER_HOLD') return 'Developer hold';
  return 'No residents';
};

const renderResidentKindSection = (label, list, esc) => {
  if (!list.length) {
    return `
      <div class="resident-kind-section">
        <h4 class="resident-kind-section__title">${label} <span class="resident-kind-section__count">0</span></h4>
        <p class="resident-kind-section__empty">None recorded</p>
      </div>`;
  }
  return `
    <div class="resident-kind-section">
      <h4 class="resident-kind-section__title">${label} <span class="resident-kind-section__count">${list.length}</span></h4>
      <div class="resident-kind-section__rows">
        <div class="registry-header resident-group-header resident-group-header--kind">
          <span>Name</span><span>Phone</span><span>Email</span><span style="text-align:right;">Action</span>
        </div>
        ${list.map((r) => renderResidentRow(r, esc)).join('')}
      </div>
    </div>`;
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

  let data;
  try {
    data = await loadResidents(true);
  } catch (err) {
    list.innerHTML = `<div style="padding:0.9rem; color:var(--danger); font-weight:800;">${err?.message || 'Could not load residents.'}</div>`;
    return;
  }

  const block = getSelectedBlock();
  const filterOpts = getResidentFilterOptions();
  const blockFiltered = (data || []).filter((r) => !block || unitNumberMatchesBlock(r.unit_number, block));
  const { residents: allUnique } = dedupeResidents(blockFiltered);

  const personFiltered = filterResidentsByOptions(allUnique, filterOpts);
  const { residents: uniqueResidents, hiddenCount } = dedupeResidents(personFiltered);

  const scopedUnits = buildScopedUnitNumbers(block, allUnique);
  const summary = computeResidentPageSummary(allUnique, scopedUnits);

  const residentsByUnit = new Map();
  allUnique.forEach((r) => {
    const key = normUnit(r.unit_number);
    if (!residentsByUnit.has(key)) residentsByUnit.set(key, []);
    residentsByUnit.get(key).push(r);
  });

  const personFilteredIds = new Set(uniqueResidents.map((r) => r.id));
  const showKindOnly = residentSummaryFilter === 'owners' ? 'OWNER'
    : residentSummaryFilter === 'tenants' ? 'TENANT' : filterOpts.kind;

  const visibleGroups = [];
  scopedUnits.forEach((unitNum) => {
    const unitRecord = portalState.units.find((u) => normUnit(u.number) === normUnit(unitNum));
    const allForUnit = residentsByUnit.get(normUnit(unitNum)) || [];
    const occ = classifyUnitOccupancy(allForUnit, unitRecord);
    const missingOwners = unitMissingOwners(allForUnit);

    if (!unitPassesOccupancyFilter(occ, residentSummaryFilter, { missingOwners })) return;

    const hasPersonFilter = hasResidentPersonFilters(filterOpts);
    if (hasPersonFilter) {
      const matching = allForUnit.filter((r) => personFilteredIds.has(r.id));
      const showEmptyFlat = !matching.length && (
        (occ === 'VACANT' && residentSummaryFilter === 'VACANT')
        || (occ === 'NON_ALLOTABLE' && residentSummaryFilter === 'NON_ALLOTABLE')
        || (missingOwners && residentSummaryFilter === 'no_owner')
      );
      if (showEmptyFlat) {
        visibleGroups.push({ block: unitRecord?.block || '—', unit: unitNum, residents: [], occ, missingOwners });
        return;
      }
      if (!matching.length) return;
      visibleGroups.push({
        block: groupResidentsByUnit(matching)[0]?.block || '—',
        unit: unitNum,
        residents: matching,
        occ,
        missingOwners,
      });
      return;
    }

    if ((occ === 'VACANT' || occ === 'NON_ALLOTABLE') && residentSummaryFilter
      && residentSummaryFilter !== occ && residentSummaryFilter !== 'all' && residentSummaryFilter !== 'no_owner') {
      return;
    }
    if (residentSummaryFilter === 'no_owner' && !missingOwners) return;

    visibleGroups.push({
      block: allForUnit.length ? (groupResidentsByUnit(allForUnit)[0]?.block || '—') : (unitRecord?.block || '—'),
      unit: unitNum,
      residents: allForUnit,
      occ,
      missingOwners,
    });
  });

  visibleGroups.sort((a, b) => {
    const blockCmp = String(a.block).localeCompare(String(b.block), undefined, { numeric: true });
    if (blockCmp) return blockCmp;
    return String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true });
  });

  if (!visibleGroups.length) {
    list.innerHTML = `<p class="maintenance-dues-empty">${hasAnyResidentFilters(filterOpts) ? 'No residents match your filters.' : 'No residents recorded yet. Use Import file or Add to get started.'}</p>`;
    return;
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const summaryCards = [
    { key: 'all', label: 'Flats', value: summary.totalFlats, tone: '', hint: 'All flats in scope. Status cards count flats once each.' },
    {
      key: 'OWNER_OCCUPIED',
      label: 'Owner residing',
      value: summary.ownerOccupied,
      tone: 'owner',
      sub: `${summary.totalOwners} owners · ${summary.nonResidingOwners} non-residing`,
      hint: occupancySummaryHint('OWNER_OCCUPIED'),
    },
    {
      key: 'TENANT_OCCUPIED',
      label: 'Tenant occupied',
      value: summary.tenantOccupied,
      tone: 'tenant',
      sub: `${summary.totalTenants} tenants`,
      hint: occupancySummaryHint('TENANT_OCCUPIED'),
    },
    { key: 'VACANT', label: 'Vacant', value: summary.vacant, tone: 'vacant', hint: occupancySummaryHint('VACANT') },
    { key: 'NON_ALLOTABLE', label: 'Non-allotable', value: summary.nonAllotable, tone: 'non-allotable', hint: occupancySummaryHint('NON_ALLOTABLE') },
    { key: 'no_owner', label: 'No owner', value: summary.noOwnerFlats, tone: 'warn', hint: occupancySummaryHint('NO_OWNER') },
  ].filter((c) => c.value > 0 || ['all', 'VACANT', 'NON_ALLOTABLE', 'OWNER_OCCUPIED', 'TENANT_OCCUPIED', 'no_owner'].includes(c.key));

  if (summary.underRenovation) summaryCards.push({ key: 'UNDER_RENOVATION', label: 'Renovation', value: summary.underRenovation, tone: 'reno' });
  if (summary.locked) summaryCards.push({ key: 'LOCKED', label: 'Locked', value: summary.locked, tone: 'locked' });
  if (summary.developerHold) summaryCards.push({ key: 'DEVELOPER_HOLD', label: 'Dev hold', value: summary.developerHold, tone: 'dev' });

  const activeFilterLabel = summaryCards.find((c) => c.key === residentSummaryFilter)?.label;

  list.innerHTML = `
    <section class="resident-summary" aria-label="Occupancy summary">
      ${summaryCards.map((c) => `
        <button type="button" class="resident-summary-card resident-summary-card--${c.tone || 'default'}${residentSummaryFilter === c.key ? ' resident-summary-card--active' : ''}" data-summary-filter="${c.key}" title="${esc(c.hint || `Filter by ${c.label}`)}">
          <span class="resident-summary-card__label">${esc(c.label)}</span>
          <strong class="resident-summary-card__value">${c.value}</strong>
          ${c.sub ? `<span class="resident-summary-card__sub">${esc(c.sub)}</span>` : ''}
        </button>`).join('')}
      <p class="resident-summary-legend"><strong>Vacant</strong> = nobody residing. <strong>Non-allotable</strong> = no owner and no tenant on record. Click a flat row to expand details.</p>
    </section>
    ${(hasAnyResidentFilters(filterOpts)) ? `
      <div class="resident-active-filters">
        <span><i class="fa-solid fa-filter"></i> Filtered${activeFilterLabel ? `: ${esc(activeFilterLabel)}` : ''}${filterOpts.filterQ ? ` · “${esc(filterOpts.filterQ)}”` : ''}</span>
        <button type="button" class="btn btn-outline btn--small" id="resident-clear-filters">Clear filters</button>
      </div>` : ''}
    ${hiddenCount ? `<p class="resident-dupe-hint"><i class="fa-solid fa-circle-info"></i> ${hiddenCount} duplicate record(s) hidden. Delete extras via the trash icon if they appear after refresh.</p>` : ''}
    <div class="resident-unit-groups">
      ${visibleGroups.map((g) => {
        const occ = g.occ || classifyUnitOccupancy(g.residents, portalState.units.find((u) => normUnit(u.number) === normUnit(g.unit)));
        let { owners, tenants } = splitResidentsByKind(g.residents);
        if (showKindOnly === 'OWNER') tenants = [];
        else if (showKindOnly === 'TENANT') owners = [];
        const blockLabel = g.block && g.block !== '—' ? g.block : '';
        const noOwnerFlag = g.missingOwners ?? unitMissingOwners(g.residents);
        const previewList = previewNamesForUnit(occ, owners, tenants);
        const previewNamesHtml = previewList.length
          ? formatResidentNameList(previewList, esc)
          : `<span class="resident-unit-group__names-muted">${esc(previewFallbackLabel(occ))}</span>`;
        return `
        <details class="resident-unit-group${noOwnerFlag ? ' resident-unit-group--no-owner' : ''}">
          <summary class="resident-unit-group__summary">
            <div class="resident-unit-group__title">
              ${blockLabel ? `<span class="resident-unit-group__block">Block ${esc(blockLabel)}</span>` : ''}
              <strong class="resident-unit-group__unit">${esc(g.unit)}</strong>
              <span class="occupancy-badge ${occupancySummaryBadge(occ)}">${esc(occupancySummaryLabel(occ))}</span>
              ${noOwnerFlag ? '<span class="occupancy-badge occ-no-owner" title="No owner on record">No owner</span>' : ''}
            </div>
            <span class="resident-unit-group__names">${previewNamesHtml}</span>
            <span class="resident-unit-group__summary-actions">
              <i class="fa-solid fa-chevron-down resident-unit-group__chevron" aria-hidden="true"></i>
              <button type="button" class="btn btn-outline btn--small btn--danger resident-unit-delete" data-unit="${esc(g.unit)}" title="Delete flat and all residents">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </span>
          </summary>
          <div class="resident-unit-group__body">
            ${renderResidentKindSection('Owners', owners, esc)}
            ${renderResidentKindSection('Tenants', tenants, esc)}
          </div>
        </details>`;
      }).join('')}
    </div>`;

  list.querySelectorAll('[data-summary-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.summaryFilter;
      residentSummaryFilter = residentSummaryFilter === key ? '' : key;
      renderResidents();
    });
  });

  document.getElementById('resident-clear-filters')?.addEventListener('click', () => {
    residentSummaryFilter = '';
    const search = document.getElementById('resident-filter');
    const kind = document.getElementById('resident-kind-filter');
    const residency = document.getElementById('resident-residency-filter');
    const primary = document.getElementById('resident-primary-filter');
    if (search) search.value = '';
    if (kind) kind.value = '';
    if (residency) residency.value = '';
    if (primary) primary.checked = false;
    renderResidents();
  });

  list.querySelectorAll('.resident-group-row').forEach((row) => {
    const id = row.dataset.residentId;
    const r = uniqueResidents.find((x) => x.id === id);
    if (!r) return;
    row.querySelector('[data-action="portal"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      window.openResidentLinkModal(null, r.email || '', r.id, r.email ? 'invite' : 'manual');
    });
    row.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openResidentModal(r);
    });
    row.querySelector('[data-action="del"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete resident record?')) return;
      try {
        await deleteResident(r.id);
        renderResidents();
        window.refreshUnitDetailIfOpen?.();
      } catch (err) {
        alert(err?.message || 'Could not delete resident.');
      }
    });
  });

  list.querySelectorAll('.resident-unit-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const unitNumber = btn.dataset.unit;
      const unitResidents = allUnique.filter((r) => normUnit(r.unit_number) === normUnit(unitNumber));
      if (!confirm(flatDeleteConfirmMessage(unitNumber, unitResidents))) return;
      await withButtonBusy(btn, 'Deleting…', async () => {
        await deleteFlatWithResidents(unitNumber);
        await renderResidents();
        window.refreshUnitDetailIfOpen?.();
      }).catch((err) => alert(err?.message || 'Could not delete flat.'));
    });
  });
};

window.renderResidents = renderResidents;

const populateResidentBlockFilter = () => {
  const sel = document.getElementById('resident-block-filter');
  if (!sel) return;
  const blocks = getBlockOptions();
  const selected = getSelectedBlock();
  sel.innerHTML = `<option value="">All blocks</option>${blocks.map((b) =>
    `<option value="${b}" ${b === selected ? 'selected' : ''}>${b}</option>`,
  ).join('')}`;
  sel.onchange = (e) => {
    setSelectedBlock(e.target.value);
    renderResidents();
  };
};

const exportResidentsExcel = async () => {
  const ExcelJS = (await import('exceljs')).default;
  await loadResidents(true);
  const block = getSelectedBlock();
  const filterOpts = getResidentFilterOptions();
  const rows = filterResidentsByOptions(getResidents(), filterOpts)
    .filter((r) => !block || unitNumberMatchesBlock(r.unit_number, block));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Residents');
  ws.addRow(['Flat', 'Type', 'Name', 'Phone', 'Email', 'Notes']);
  rows.forEach((r) => ws.addRow([
    r.unit_number,
    r.kind,
    r.full_name,
    r.phone || '',
    r.email || '',
    r.notes || '',
  ]));
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Residents_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};

let editingResidentId = null;

const syncResidentModalFields = () => {
  const kind = document.getElementById('resident-kind')?.value || 'OWNER';
  const isOwner = kind === 'OWNER';
  const residingWrap = document.getElementById('resident-residing-wrap');
  const primaryWrap = document.getElementById('resident-primary-wrap');
  const hint = document.getElementById('resident-residing-hint');
  if (residingWrap) residingWrap.style.display = isOwner ? '' : 'none';
  if (primaryWrap) primaryWrap.style.display = isOwner ? '' : 'none';
  if (hint) hint.style.display = isOwner ? '' : 'none';
};

const openResidentModal = (r = null) => {
  editingResidentId = r?.id || null;
  document.getElementById('resident-unit').value = r?.unit_number || '';
  document.getElementById('resident-kind').value = r?.kind || 'OWNER';
  document.getElementById('resident-name').value = r?.full_name || '';
  document.getElementById('resident-phone').value = r?.phone || '';
  document.getElementById('resident-email').value = r?.email || '';
  document.getElementById('resident-notes').value = r?.notes || '';
  document.getElementById('resident-residing').value = r?.is_residing === false ? 'false' : 'true';
  document.getElementById('resident-primary').checked = !!r?.is_primary;
  syncResidentModalFields();
  document.getElementById('resident-modal').classList.add('active');
  requestAnimationFrame(() => document.getElementById('resident-name')?.focus());
};

const closeResidentModal = () => {
  document.getElementById('resident-modal').classList.remove('active');
  editingResidentId = null;
};
window.openResidentModal = openResidentModal;
window.closeResidentModal = closeResidentModal;
window.openTransitionWizard = openTransitionWizard;

const saveResident = async () => {
  const kind = document.getElementById('resident-kind').value;
  const payload = {
    unit_number: document.getElementById('resident-unit').value.trim(),
    kind,
    full_name: document.getElementById('resident-name').value.trim(),
    phone: document.getElementById('resident-phone').value.trim(),
    email: document.getElementById('resident-email').value.trim(),
    notes: document.getElementById('resident-notes').value.trim(),
    is_primary: document.getElementById('resident-primary').checked,
    is_residing: document.getElementById('resident-residing').value !== 'false',
  };
  try {
    const reviewHint = await persistResident(payload, editingResidentId);
    closeResidentModal();
    renderResidents();
    window.refreshUnitDetailIfOpen?.();
    if (reviewHint) alert(reviewHint);
  } catch (err) {
    alert(err?.message || 'Could not save resident.');
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
    await applyAuthToUI(data.session);
    hideAuth();
    hideWorkspaceGate();
    if (data?.session?.user?.id) portalState.access = portalState.access || { users: [], apartments: [] };
    if (data?.session?.user?.id) portalState.access.activeUserId = data.session.user.id;
    const synced = await syncAccessFromSupabase();
    if (!synced) showWorkspaceGate('Sign-in succeeded but society data did not load. Select your society below.');
    else {
      processAnalytics();
      processFinances();
      renderRegistry();
    }
    window.switchView(resolveRoute(window.location.hash.slice(1), portalState.auth?.role));
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
    hideWorkspaceGate();
    if (data?.session?.user?.id) portalState.access = portalState.access || { users: [], apartments: [] };
    if (data?.session?.user?.id) portalState.access.activeUserId = data.session.user.id;
    const synced = await syncAccessFromSupabase();
    if (!synced) showWorkspaceGate('Account created but society data did not load. Select your society below.');
    else {
      processAnalytics();
      processFinances();
      renderRegistry();
    }
    window.switchView(resolveRoute(window.location.hash.slice(1), portalState.auth?.role));
  };

  if (loginBtn) loginBtn.onclick = signIn;
  if (signupBtn) signupBtn.onclick = signUp;

  initWorkspaceGate();

  if (supabase) {
    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'INITIAL_SESSION' && !bootAuthHandled) return;
      if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION')) {
        await applyAuthToUI(session);
        if (event === 'SIGNED_IN') {
          hideAuth();
          hideWorkspaceGate();
          const synced = await syncAccessFromSupabase();
          if (!synced) showWorkspaceGate();
          else {
            processAnalytics();
            processFinances();
            renderRegistry();
          }
        }
      }
      if (event === 'SIGNED_OUT') showAuth();
    });
  }

  // Global View Router
  window.addEventListener('hashchange', () => {
    window.switchView(window.location.hash.slice(1));
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

  // Summary bar: EH / BH / rent pills open focused pool views
  const summaryFocusLabels = {
    cars: 'Community pool — Cars (EH)',
    bikes: 'Community pool — Bikes (BH)',
    rentals: 'Flat-to-flat rentals',
  };
  const summaryFocusTargets = {
    cars: 'pool-visualiser',
    bikes: 'bike-pool-visualiser',
    rentals: 'flat-rental-visualiser',
  };

  const initSummaryFocus = () => {
    const summaries = document.getElementById('registry-summaries');
    const body = summaries?.querySelector('.page-section__body--summaries');
    const focusBar = document.getElementById('summary-focus-bar');
    const focusLabel = document.getElementById('summary-focus-label');
    const showAllBtn = document.getElementById('summary-show-all');
    if (!summaries || !body) return;

    const setSummaryFocus = (focus) => {
      if (!focus || focus === 'all') {
        body.removeAttribute('data-focus');
        focusBar?.setAttribute('hidden', '');
        document.querySelectorAll('.ms-pill--jump').forEach((p) => p.classList.remove('is-active'));
        return;
      }
      body.dataset.focus = focus;
      if (focusBar) focusBar.removeAttribute('hidden');
      if (focusLabel) focusLabel.textContent = summaryFocusLabels[focus] || '';
      document.querySelectorAll('.ms-pill--jump').forEach((p) => {
        p.classList.toggle('is-active', p.dataset.summaryFocus === focus);
      });
    };

    const openSummaryFocus = (focus) => {
      summaries.setAttribute('open', '');
      setSummaryFocus(focus);
      requestAnimationFrame(() => {
        document.getElementById(summaryFocusTargets[focus])?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    };

    document.querySelectorAll('.ms-pill--jump').forEach((btn) => {
      const stop = (e) => e.stopPropagation();
      btn.addEventListener('mousedown', stop);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const focus = btn.dataset.summaryFocus;
        const isActive = btn.classList.contains('is-active') && summaries.open && body.dataset.focus === focus;
        if (isActive) setSummaryFocus('all');
        else openSummaryFocus(focus);
      });
    });

    showAllBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSummaryFocus('all');
    });

    summaries.addEventListener('toggle', () => {
      if (!summaries.open) setSummaryFocus('all');
    });
  };

  initSummaryFocus();

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
  const apartmentSelectors = ['access-active-apartment', 'nav-apartment-switch', 'sidebar-apartment-switch', 'header-apartment-switch'];
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

  document.getElementById('access-users-show-unassigned')?.addEventListener('change', () => renderAccessMappings());

  const resRefresh = document.getElementById('resident-refresh-btn');
  if (resRefresh) resRefresh.onclick = () => renderResidents();
  const resExport = document.getElementById('resident-export-btn');
  if (resExport) resExport.onclick = () => exportResidentsExcel().catch((err) => alert(err?.message || 'Export failed.'));
  const resAdd = document.getElementById('resident-add-btn');
  if (resAdd) resAdd.onclick = () => openResidentModal(null);
  const resCancel = document.getElementById('resident-cancel-btn');
  if (resCancel) resCancel.onclick = () => closeResidentModal();
  const resSave = document.getElementById('resident-save-btn');
  if (resSave) resSave.onclick = () => saveResident();
  document.getElementById('resident-kind')?.addEventListener('change', syncResidentModalFields);
  populateResidentBlockFilter();
  document.getElementById('resident-filter')?.addEventListener('input', () => renderResidents());
  document.getElementById('resident-kind-filter')?.addEventListener('change', () => renderResidents());
  document.getElementById('resident-residency-filter')?.addEventListener('change', () => renderResidents());
  document.getElementById('resident-primary-filter')?.addEventListener('change', () => renderResidents());
  document.addEventListener('block-filter-change', () => {
    const sel = document.getElementById('resident-block-filter');
    if (sel) sel.value = getSelectedBlock();
    if (document.getElementById('view-apartment')?.classList.contains('active')) renderResidents();
  });

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
  document.getElementById('save-cash-btn').onclick = () => {
    void withButtonBusy(document.getElementById('save-cash-btn'), 'Saving…', saveCashData);
  };
  initExpenseModal();
  initAccountsSubViewTabs();
  initMaintenanceBilling();
  initBulkCollectionImport();
  initActivityAuditUi();
  initStaffNotificationsUi();
  initBankReconciliationUi();
  initFinanceAnalyticsUi();
  initUnitDirectory();
  initResidentImport();
  initResidentPortal();
  initSecurityPortal();
  initResidentLinks();
  initPayments();
  initNotices();
  initOperations();
  initParkingOps();
  initPortfolio();
  initDashboard();
  document.addEventListener('module-access-loaded', () => {
    applyPermissionsToNav(portalState.authPermissions);
  });
  initGeneralLedger();
  window.renderLedgerSyncPanel = renderLedgerSyncPanel;
  window.renderFinanceAnalytics = renderFinanceAnalytics;
  window.processFinances = processFinances;
  initEmailOutbox();
  renderNavModules();
  initNavInteraction((route) => window.switchView(route));
  applyNavPermissions(new Set(portalState.authPermissions || []), !supabase);
  initSetupAdmin();

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

  document.getElementById('registry-change-log')?.addEventListener('click', () => void openVehicleAuditModal());
  document.getElementById('audit-log-close')?.addEventListener('click', closeVehicleAuditModal);
  document.getElementById('audit-pending-only')?.addEventListener('change', () => void renderVehicleAuditModal());
  document.getElementById('audit-export-csv')?.addEventListener('click', () => void downloadPendingAuditCsv());
  document.getElementById('audit-mark-synced')?.addEventListener('click', async () => {
    if (!confirm('Mark all pending vehicle changes as synced to the other system?')) return;
    const btn = document.getElementById('audit-mark-synced');
    await withButtonBusy(btn, 'Updating…', async () => {
      const { error } = await markAllPendingVehicleAuditSynced();
      if (error) throw new Error(error.message || 'Could not update sync status.');
      await renderVehicleAuditModal();
      await refreshAuditBadge();
    }).catch((err) => alert(err.message));
  });
  document.getElementById('capacity-close')?.addEventListener('click', closeCapacityModal);
  document.getElementById('capacity-cancel')?.addEventListener('click', closeCapacityModal);
  document.getElementById('capacity-apply-all')?.addEventListener('click', applyCapacityDefaultsToAll);
  document.getElementById('capacity-save')?.addEventListener('click', () => {
    void withButtonBusy(document.getElementById('capacity-save'), 'Saving…', saveCapacityAllocation);
  });
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
        <div><strong>Vehicles:</strong> ${preview.vehicleCount} (${preview.carCount ?? 0} cars, ${preview.bikeCount ?? 0} bikes)</div>
        <div><strong>Changes:</strong> ${preview.newVehicles} new, ${preview.updatedVehicles} to update</div>
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
    showParkingImportError('');
    await withButtonBusy(applyBtn, 'Importing…', async () => {
      const result = await applyParkingImport(pendingParkingImport, mode);
      processAnalytics();
      renderRegistry();
      void refreshAuditBadge();
      closeParkingImportModal();
      if (result.skippedRegistryMeta) {
        alert(
          'Import completed for units and vehicles, but RFID/sticker columns are missing in Supabase.\n\n' +
            'Open Supabase → SQL Editor and run supabase_vehicle_rfid_sticker.sql, then re-import to save sticker/RFID data.',
        );
      } else {
        alert(`Parking registry ${mode === 'overwrite' ? 'overwritten' : 'merged'} successfully.`);
      }
    }).catch((err) => showParkingImportError(err?.message || 'Import failed.'));
  });

  // Initialize Router State
  console.log('Main: Starting boot sequence...');
  await boot();
  console.log('Main: Boot complete. Initializing ledger sync...');
  import('./ledgerSpreadsheetSync.js')
    .then(({ initLedgerSpreadsheetSync }) => initLedgerSpreadsheetSync())
    .catch((err) => console.warn('[boot] Ledger sync init skipped:', err?.message));
  console.log('Main: Ledger sync init scheduled.');
});
