/**
 * Admin UI: society role → page templates + per-user page overrides.
 */
import './pageAccess.css';
import { portalState, supabase } from './store.js';
import { hasClientPermission, v2KeyToLabel } from './rbac.js';
import { pageCatalogByModule } from './navigation.js';
import { applyNavPermissions } from './navigation.js';
import { resolveEffectivePermissions } from './rbac.js';
import {
    buildRolePageEditorState,
    buildUserPageOverrideState,
    saveSocietyRolePageAccess,
    saveUserPageOverrides,
    loadUserPageAccess,
    getSocietyScopedRoles,
} from './pageAccess.js';

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function pageCheckboxRow(page, checked, inputAttr) {
    return `<label class="page-access-row">
      <span class="page-access-row__label">${esc(page.label)}</span>
      <input type="checkbox" data-page-route="${esc(page.route)}" ${checked ? 'checked' : ''} ${inputAttr || ''} />
    </label>`;
}

function pageOverrideRow(page, value) {
    const selected = value === 'grant' ? 'grant' : value === 'deny' ? 'deny' : 'inherit';
    return `<label class="page-access-row page-access-row--user">
      <span class="page-access-row__label">${esc(page.label)}</span>
      <select data-user-page-route="${esc(page.route)}" class="page-access-row__select">
        <option value="inherit" ${selected === 'inherit' ? 'selected' : ''}>Inherit role</option>
        <option value="grant" ${selected === 'grant' ? 'selected' : ''}>Allow</option>
        <option value="deny" ${selected === 'deny' ? 'selected' : ''}>Deny</option>
      </select>
    </label>`;
}

function moduleSection(mod, innerHtml, open = false) {
    return `<details class="page-access-module" ${open ? 'open' : ''}>
      <summary><i class="fa-solid ${mod.moduleIcon}" aria-hidden="true"></i> ${esc(mod.moduleLabel)}</summary>
      <div class="page-access-module__pages">${innerHtml}</div>
    </details>`;
}

let selectedRoleKey = 'property_manager';

export async function renderPageAccessAdmin() {
    const host = document.getElementById('page-access-admin-host');
    if (!host) return;

    if (!hasClientPermission('rbac.edit')) {
        host.innerHTML = '<p class="page-access-hint">Only apartment administrators can manage roles and page access.</p>';
        return;
    }

    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) {
        host.innerHTML = '<p class="page-access-hint">Select a society first.</p>';
        return;
    }

    const aptName = portalState.access.apartments.find((a) => a.id === apartmentId)?.name || 'this society';
    host.innerHTML = '<p class="page-access-hint"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading…</p>';

    let societyRoles = [];
    let editorState = { states: {} };
    try {
        societyRoles = await getSocietyScopedRoles();
        if (!societyRoles.includes(selectedRoleKey)) {
            selectedRoleKey = societyRoles[0] || 'property_manager';
        }
        editorState = await buildRolePageEditorState(apartmentId, selectedRoleKey);
    } catch (err) {
        host.innerHTML = `<p class="page-access-hint page-access-hint--error">${esc(err.message)}</p>`;
        return;
    }

    const roleOptions = societyRoles.map((key) =>
        `<option value="${key}" ${key === selectedRoleKey ? 'selected' : ''}>${esc(v2KeyToLabel(key))}</option>`,
    ).join('');

    const modules = pageCatalogByModule(false);
    const pagesHtml = modules.map((mod, idx) => {
        const rows = mod.pages.map((page) =>
            pageCheckboxRow(page, editorState.states[page.route] === true, ''),
        ).join('');
        return moduleSection(mod, rows, idx === 0);
    }).join('');

    host.innerHTML = `
      <header class="page-access-header">
        <div>
          <h2 class="page-access-title">Page Access</h2>
          <p class="page-access-hint">Configure which pages each role can open in <strong>${esc(aptName)}</strong>.
            Unchecked pages are hidden from the menu and blocked by route. Page access builds on the permissions set in the <strong>Role Permissions</strong> tab.</p>
        </div>
      </header>
      <div class="page-access-toolbar">
        <label class="page-access-toolbar__role">
          <span>Role</span>
          <select id="page-access-role-select">${roleOptions}</select>
        </label>
        <div class="page-access-toolbar__actions">
          <button type="button" class="btn btn-outline btn--small" id="page-access-select-all">Select all</button>
          <button type="button" class="btn btn-outline btn--small" id="page-access-select-none">Select none</button>
          <button type="button" class="btn btn-primary btn--small" id="page-access-save-role">
            <i class="fa-solid fa-floppy-disk"></i> Save role pages
          </button>
        </div>
      </div>
      <div class="page-access-grid" id="page-access-role-grid">${pagesHtml}</div>
      <p class="page-access-hint page-access-hint--footer">
        Tip: assign users a role in <strong>Society Profile → User Access Directory</strong>, then add per-user page overrides in the user edit modal.
      </p>`;

    document.getElementById('page-access-role-select').onchange = (e) => {
        selectedRoleKey = e.target.value;
        void renderPageAccessAdmin();
    };

    document.getElementById('page-access-select-all').onclick = () => {
        host.querySelectorAll('#page-access-role-grid input[type=checkbox]').forEach((el) => { el.checked = true; });
    };
    document.getElementById('page-access-select-none').onclick = () => {
        host.querySelectorAll('#page-access-role-grid input[type=checkbox]').forEach((el) => { el.checked = false; });
    };

    document.getElementById('page-access-save-role').onclick = async () => {
        const states = {};
        host.querySelectorAll('#page-access-role-grid input[data-page-route]').forEach((el) => {
            states[el.dataset.pageRoute] = el.checked;
        });
        try {
            await saveSocietyRolePageAccess(apartmentId, selectedRoleKey, states);
            const uid = portalState.auth?.id;
            const roleKey = portalState.auth?.effectiveRoleKey;
            if (uid && roleKey) await loadUserPageAccess(apartmentId, uid, roleKey);
            applyNavPermissions(new Set(resolveEffectivePermissions()));
            alert('Role page access saved.');
        } catch (err) {
            alert(err.message || 'Could not save role pages.');
        }
    };
}

export async function renderUserPageAccessPanel(userId, apartmentIds = []) {
    const host = document.getElementById('user-page-access-panel');
    if (!host) return;

    if (!hasClientPermission('rbac.edit')) {
        host.hidden = true;
        return;
    }

    const roleKey = document.getElementById('access-user-role-v2')?.value || 'resident_viewer';
    if (roleKey === 'apartment_admin') {
        host.innerHTML = '<p class="page-access-hint">Apartment admins use the role template without page overrides.</p>';
        host.hidden = false;
        return;
    }

    if (!userId || !apartmentIds.length) {
        host.innerHTML = '<p class="page-access-hint">Save the user first, then edit again to set extra page access.</p>';
        host.hidden = false;
        return;
    }

    if (apartmentIds.length > 1) {
        host.innerHTML = `<p class="page-access-hint">Page overrides apply to all ${apartmentIds.length} selected societies.</p>
          <div class="page-access-grid page-access-grid--compact" id="user-page-grid">
            ${pageCatalogByModule(false).map((mod, idx) => {
            const rows = mod.pages.map((p) => pageOverrideRow(p, 'inherit')).join('');
            return moduleSection(mod, rows, idx === 0);
        }).join('')}
          </div>`;
        host.hidden = false;
        return;
    }

    host.innerHTML = '<p class="page-access-hint"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading…</p>';
    host.hidden = false;

    let editor = { states: {} };
    try {
        editor = await buildUserPageOverrideState(userId, apartmentIds[0], roleKey);
    } catch {
        host.innerHTML = '<p class="page-access-hint">Page override tables not available yet — run supabase_page_access.sql.</p>';
        return;
    }

    host.innerHTML = `
      <label class="module-access-label">Extra page access</label>
      <p class="page-access-hint">Optional — override the role template for this user. <em>Inherit role</em> uses the society role settings above.</p>
      <div class="page-access-grid page-access-grid--compact" id="user-page-grid">
        ${pageCatalogByModule(false).map((mod, idx) => {
        const rows = mod.pages.map((p) => pageOverrideRow(p, editor.states[p.route] || 'inherit')).join('');
        return moduleSection(mod, rows, idx === 0);
    }).join('')}
      </div>`;
}

export function readUserPageOverridesFromPanel() {
    const grid = document.getElementById('user-page-grid');
    if (!grid) return {};
    const values = {};
    grid.querySelectorAll('[data-user-page-route]').forEach((el) => {
        values[el.dataset.userPageRoute] = el.value;
    });
    return values;
}

export async function saveUserPageOverridesFromPanel(userId, apartmentIds) {
    if (!hasClientPermission('rbac.edit')) return;
    const roleKey = document.getElementById('access-user-role-v2')?.value;
    if (!roleKey || roleKey === 'apartment_admin') return;
    const overrides = readUserPageOverridesFromPanel();
    for (const apartmentId of apartmentIds) {
        await saveUserPageOverrides(userId, apartmentId, roleKey, overrides);
    }
    if (portalState.auth?.id === userId && portalState.access?.activeApartmentId) {
        await loadUserPageAccess(
            portalState.access.activeApartmentId,
            userId,
            portalState.auth.effectiveRoleKey || roleKey,
        );
        applyNavPermissions(new Set(resolveEffectivePermissions()));
    }
}
