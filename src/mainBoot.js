/** Shared access UI helpers and renderers used across boot and lazy views. */

import { portalState, isPlaceholderApartmentId } from './store.js';
import { ROLE_OPTIONS, v2KeyToLabel } from './rbac.js';

export { renderResidents } from './residentView.js';

export const isSignedIn = () => Boolean(portalState.auth?.id);

export const apartmentOptionsForUi = () => {
    const all = portalState.access?.apartments || [];
    const real = all.filter((a) => !isPlaceholderApartmentId(a.id));
    return real.length ? real : all;
};

export const ensureAccessState = () => {
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

export const renderAccessMappings = () => {
    ensureAccessState();
    const apartments = apartmentOptionsForUi();
    const users = portalState.access.users;

    const sidebarApartmentSelect = document.getElementById('sidebar-apartment-switch');
    const drawerApartmentSelect = document.getElementById('nav-apartment-switch');
    const headerApartmentSelect = document.getElementById('header-apartment-switch');
    const userMenuApartmentSelect = document.getElementById('user-menu-apartment-switch');
    const topbarApartmentName = document.getElementById('topbar-apartment-name');

    const placeholderOption = isSignedIn() && !apartments.length
        ? '<option value="">No societies</option>'
        : '<option value="">Select society…</option>';
    const apartmentOptions = apartments.length
        ? apartments.map((a) => `<option value="${a.id}">${a.name}</option>`).join('')
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
    syncSelect(userMenuApartmentSelect);

    if (topbarApartmentName) {
        const activeName = apartments.find((a) => a.id === activeId)?.name
            || (apartments.length === 1 ? apartments[0].name : '');
        topbarApartmentName.textContent = activeName;
        topbarApartmentName.hidden = !activeName;
    }

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
            usersListV2.innerHTML = directoryUsers.map((u) => {
                const mappedApts = apartments.filter((a) => (u.apartment_ids || []).includes(a.id));
                const aptChips = mappedApts.map((a) => `<span class="apt-chip">${a.name}</span>`).join('') || '<span style="color:var(--text-dim); font-style:italic;">No access</span>';
                const initials = (u.name || 'U').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
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

    const portfolioGrid = document.getElementById('portfolio-grid');
    if (portfolioGrid) {
        portfolioGrid.innerHTML = apartments.map((a) => {
            const userCount = users.filter((u) => (u.apartment_ids || []).includes(a.id)).length;
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

    const userRoleSelectV2 = document.getElementById('access-user-role-v2');
    if (userRoleSelectV2) {
        userRoleSelectV2.innerHTML = ROLE_OPTIONS.map((r) => `<option value="${r.key}">${r.label}</option>`).join('');
    }
    const userAptsSelectV2 = document.getElementById('access-user-apartments-v2');
    if (userAptsSelectV2) {
        userAptsSelectV2.innerHTML = apartments.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
    }
};
