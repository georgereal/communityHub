/**
 * Admin UI: society role → permission templates.
 */
import './pageAccess.css';
import { portalState } from './store.js';
import { hasClientPermission, refreshAuthPermissions, resolveEffectivePermissions, v2KeyToLabel } from './rbac.js';
import { applyNavPermissions } from './navigation.js';
import {
    buildRolePermissionEditorState,
    getSocietyRoleOptions,
    permissionsByModule,
    saveSocietyRolePermissions,
} from './rolePermissions.js';

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function permissionCheckboxRow(perm, checked) {
    return `<label class="page-access-row">
      <span class="page-access-row__label">
        <strong>${esc(perm.key)}</strong>
        <span class="page-access-row__desc">${esc(perm.description)}</span>
      </span>
      <input type="checkbox" data-permission-key="${esc(perm.key)}" ${checked ? 'checked' : ''} />
    </label>`;
}

function moduleSection(mod, innerHtml, open = false) {
    return `<details class="page-access-module" ${open ? 'open' : ''}>
      <summary>${esc(mod.moduleLabel)}</summary>
      <div class="page-access-module__pages">${innerHtml}</div>
    </details>`;
}

let selectedRoleKey = 'property_manager';

export async function renderRolePermissionsAdmin() {
    const host = document.getElementById('role-permissions-admin-host');
    if (!host) return;

    if (!hasClientPermission('rbac.edit')) {
        host.innerHTML = '<p class="page-access-hint">Only users with access control permissions can manage role permissions.</p>';
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
        societyRoles = await getSocietyRoleOptions();
        if (!societyRoles.some((r) => r.key === selectedRoleKey)) {
            selectedRoleKey = societyRoles[0]?.key || 'property_manager';
        }
        editorState = await buildRolePermissionEditorState(apartmentId, selectedRoleKey);
    } catch (err) {
        host.innerHTML = `<p class="page-access-hint page-access-hint--error">${esc(err.message)}</p>`;
        return;
    }

    const roleOptions = societyRoles.map((role) =>
        `<option value="${esc(role.key)}" ${role.key === selectedRoleKey ? 'selected' : ''}>${esc(role.label || v2KeyToLabel(role.key))}</option>`,
    ).join('');

    const modules = permissionsByModule(editorState.catalog);
    const permissionsHtml = modules.map((mod, idx) => {
        const rows = mod.permissions.map((perm) =>
            permissionCheckboxRow(perm, editorState.states[perm.key] === true),
        ).join('');
        return moduleSection(mod, rows, idx === 0);
    }).join('');

    host.innerHTML = `
      <header class="page-access-header">
        <div>
          <h2 class="page-access-title">Role Permissions</h2>
          <p class="page-access-hint">Choose what each role can do in <strong>${esc(aptName)}</strong>.
            Checked permissions allow actions such as viewing modules, editing records, and opening admin tools.
            Changes apply on top of platform defaults — unchecked overrides revert to the default for that role.</p>
        </div>
      </header>
      <div class="page-access-toolbar">
        <label class="page-access-toolbar__role">
          <span>Role</span>
          <select id="role-permissions-role-select">${roleOptions}</select>
        </label>
        <div class="page-access-toolbar__actions">
          <button type="button" class="btn btn-outline btn--small" id="role-permissions-select-all">Select all</button>
          <button type="button" class="btn btn-outline btn--small" id="role-permissions-select-none">Select none</button>
          <button type="button" class="btn btn-primary btn--small" id="role-permissions-save-role">
            <i class="fa-solid fa-floppy-disk"></i> Save role permissions
          </button>
        </div>
      </div>
      <div class="page-access-grid" id="role-permissions-grid">${permissionsHtml}</div>
      <p class="page-access-hint page-access-hint--footer">
        After saving permissions, use the <strong>Page Access</strong> tab to fine-tune which pages appear in the menu for each role.
      </p>`;

    document.getElementById('role-permissions-role-select').onchange = (e) => {
        selectedRoleKey = e.target.value;
        void renderRolePermissionsAdmin();
    };

    document.getElementById('role-permissions-select-all').onclick = () => {
        host.querySelectorAll('#role-permissions-grid input[type=checkbox]').forEach((el) => { el.checked = true; });
    };
    document.getElementById('role-permissions-select-none').onclick = () => {
        host.querySelectorAll('#role-permissions-grid input[type=checkbox]').forEach((el) => { el.checked = false; });
    };

    document.getElementById('role-permissions-save-role').onclick = async () => {
        const states = {};
        host.querySelectorAll('#role-permissions-grid input[data-permission-key]').forEach((el) => {
            states[el.dataset.permissionKey] = el.checked;
        });
        try {
            await saveSocietyRolePermissions(apartmentId, selectedRoleKey, states);
            const aptId = portalState.access?.activeApartmentId;
            if (aptId) await refreshAuthPermissions(aptId);
            applyNavPermissions(new Set(resolveEffectivePermissions()));
            alert('Role permissions saved.');
        } catch (err) {
            alert(err.message || 'Could not save role permissions.');
        }
    };
}
