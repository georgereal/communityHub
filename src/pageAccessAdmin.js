/**
 * Roles admin — RBAC matrices: modules, pages (incl. sub-pages), CRUD.
 */
import './pageAccess.css';
import { portalState } from './store.js';
import { hasClientPermission, v2KeyToLabel, resolveEffectivePermissions } from './rbac.js';
import { applyNavPermissions } from './navigation.js';
import { LOCKED_MODULE_KEYS } from './moduleAccess.js';
import {
    SOCIETY_SCOPED_ROLES,
    buildUserPageOverrideState,
    saveUserPageOverrides,
    loadUserPageAccess,
} from './pageAccess.js';
import { pageCatalogByModule } from './navigation.js';
import {
    CRUD_ACTIONS,
    buildRbacMatrixState,
    saveRbacMatrix,
    loadCrudAccessForRole,
    loadRoleModuleAccess,
} from './rbacMatrix.js';

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

let matrixState = null;
let activeTab = 'pages';

function roleHeaderCells(roles) {
    return roles.map((key) =>
        `<th class="rbac-col" title="${esc(v2KeyToLabel(key))}"><span>${esc(v2KeyToLabel(key))}</span></th>`,
    ).join('');
}

function moduleMatrixHtml(state) {
    const { roles, modules, moduleEnabled } = state;
    const body = modules.map((mod) => {
        const locked = LOCKED_MODULE_KEYS.has(mod.key);
        const cells = roles.map((role) => {
            const on = moduleEnabled[role]?.[mod.key] !== false;
            return `<td class="rbac-cell">
        <input type="checkbox" data-rbac-module="${esc(mod.key)}" data-rbac-role="${esc(role)}"
          ${on ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="${esc(mod.label)} for ${esc(v2KeyToLabel(role))}" />
      </td>`;
        }).join('');
        return `<tr>
      <th scope="row" class="rbac-row-label">
        <i class="fa-solid ${mod.icon}" aria-hidden="true"></i>
        <span>${esc(mod.label)}</span>
        ${locked ? '<small class="rbac-lock">Always on</small>' : ''}
      </th>
      ${cells}
    </tr>`;
    }).join('');

    return `<div class="rbac-table-wrap">
    <table class="rbac-matrix">
      <thead><tr><th class="rbac-corner">Module</th>${roleHeaderCells(roles)}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function pagesMatrixHtml(state) {
    const { roles, pageGroups, pages } = state;
    const sections = pageGroups.map((group) => {
        const rows = group.pages.map((page) => {
            const cells = roles.map((role) => {
                const on = pages[role]?.[page.route] === true;
                return `<td class="rbac-cell">
          <input type="checkbox" data-rbac-page="${esc(page.route)}" data-rbac-role="${esc(role)}"
            ${on ? 'checked' : ''} aria-label="${esc(page.label)} for ${esc(v2KeyToLabel(role))}" />
        </td>`;
            }).join('');
            const sub = page.hideFromNav ? ' rbac-row-label--sub' : '';
            const mark = page.hideFromNav ? '<span class="rbac-submark">sub</span>' : '';
            return `<tr>
        <th scope="row" class="rbac-row-label${sub}">
          <span>${esc(page.label)}</span>${mark}
        </th>
        ${cells}
      </tr>`;
        }).join('');

        return `<tbody class="rbac-group">
      <tr class="rbac-group-head">
        <th colspan="${roles.length + 1}">
          <i class="fa-solid ${group.moduleIcon}" aria-hidden="true"></i>
          ${esc(group.moduleLabel)}
        </th>
      </tr>
      ${rows}
    </tbody>`;
    }).join('');

    return `<div class="rbac-table-wrap">
    <table class="rbac-matrix rbac-matrix--pages">
      <thead><tr><th class="rbac-corner">Page</th>${roleHeaderCells(roles)}</tr></thead>
      ${sections}
    </table>
  </div>`;
}

function crudMatrixHtml(state) {
    const { roles, resources, crud } = state;
    const actionHeads = CRUD_ACTIONS.map((a) =>
        `<th class="rbac-crud-action" title="${esc(a.label)}">${esc(a.short)}</th>`,
    ).join('');

    const roleBlocks = roles.map((role) =>
        `<th class="rbac-crud-role" colspan="${CRUD_ACTIONS.length}" title="${esc(v2KeyToLabel(role))}">
      <span>${esc(v2KeyToLabel(role))}</span>
    </th>`,
    ).join('');

    const actionRow = roles.map(() => actionHeads).join('');

    const body = resources.map((res) => {
        const cells = roles.map((role) => CRUD_ACTIONS.map((a) => {
            const on = !!crud[role]?.[res.key]?.[a.key];
            return `<td class="rbac-cell rbac-cell--crud">
        <input type="checkbox"
          data-rbac-crud-resource="${esc(res.key)}"
          data-rbac-crud-action="${esc(a.key)}"
          data-rbac-role="${esc(role)}"
          ${on ? 'checked' : ''}
          aria-label="${esc(res.label)} ${esc(a.label)} for ${esc(v2KeyToLabel(role))}" />
      </td>`;
        }).join('')).join('');
        return `<tr>
      <th scope="row" class="rbac-row-label">
        <span>${esc(res.label)}</span>
        <small class="rbac-resource-key">${esc(res.key)}</small>
      </th>
      ${cells}
    </tr>`;
    }).join('');

    return `<div class="rbac-table-wrap">
    <table class="rbac-matrix rbac-matrix--crud">
      <thead>
        <tr><th class="rbac-corner" rowspan="2">Resource</th>${roleBlocks}</tr>
        <tr>${actionRow}</tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <p class="page-access-hint page-access-hint--footer">
    C = Create, R = Read, U = Update, D = Delete. Until finer checks ship everywhere, Read maps to <code>*.view</code> and Create/Update/Delete map to <code>*.edit</code> for API gates.
  </p>`;
}

function readMatrixFromDom(host, state) {
    const pages = {};
    const moduleEnabled = {};
    const crud = {};
    state.roles.forEach((role) => {
        pages[role] = { ...(state.pages[role] || {}) };
        moduleEnabled[role] = { ...(state.moduleEnabled[role] || {}) };
        crud[role] = {};
        Object.keys(state.crud[role] || {}).forEach((res) => {
            crud[role][res] = { ...(state.crud[role][res] || {}) };
        });
    });

    host.querySelectorAll('input[data-rbac-page]').forEach((el) => {
        const role = el.dataset.rbacRole;
        const route = el.dataset.rbacPage;
        if (role && route) pages[role][route] = el.checked;
    });
    host.querySelectorAll('input[data-rbac-module]').forEach((el) => {
        const role = el.dataset.rbacRole;
        const mod = el.dataset.rbacModule;
        if (role && mod) moduleEnabled[role][mod] = el.checked;
    });
    host.querySelectorAll('input[data-rbac-crud-resource]').forEach((el) => {
        const role = el.dataset.rbacRole;
        const resource = el.dataset.rbacCrudResource;
        const action = el.dataset.rbacCrudAction;
        if (role && resource && action) {
            crud[role][resource] = crud[role][resource] || { create: false, read: false, update: false, delete: false };
            crud[role][resource][action] = el.checked;
        }
    });

    return { pages, moduleEnabled, crud };
}

export async function renderPageAccessAdmin({ reload = true } = {}) {
    const host = document.getElementById('page-access-admin-host');
    if (!host) return;

    if (!hasClientPermission('rbac.edit')) {
        host.innerHTML = '<p class="page-access-hint">Only apartment administrators can manage roles and access.</p>';
        return;
    }

    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) {
        host.innerHTML = '<p class="page-access-hint">Select a society first.</p>';
        return;
    }

    const aptName = portalState.access.apartments.find((a) => a.id === apartmentId)?.name || 'this society';

    if (reload || !matrixState) {
        host.innerHTML = '<p class="page-access-hint"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading role matrix…</p>';
        try {
            matrixState = await buildRbacMatrixState(apartmentId);
        } catch (err) {
            host.innerHTML = `<p class="page-access-hint page-access-hint--error">${esc(err.message)}</p>`;
            return;
        }
    }

    const tab = (id, label) =>
        `<button type="button" class="rbac-tab ${activeTab === id ? 'is-active' : ''}" data-rbac-tab="${id}">${label}</button>`;

    let body = '';
    if (activeTab === 'modules') body = moduleMatrixHtml(matrixState);
    else if (activeTab === 'crud') body = crudMatrixHtml(matrixState);
    else body = pagesMatrixHtml(matrixState);

    host.innerHTML = `
    <header class="page-access-header">
      <div>
        <h2 class="page-access-title">Roles</h2>
        <p class="page-access-hint">
          RBAC for <strong>${esc(aptName)}</strong>: modules, pages (and sub-pages), and CRUD per role.
          Columns are roles — compare and edit in one table. Assign users in Society Profile → User Access Directory.
        </p>
      </div>
      <button type="button" class="btn btn-primary" id="rbac-save-all">
        <i class="fa-solid fa-floppy-disk"></i> Save all changes
      </button>
    </header>
    <div class="rbac-tabs" role="tablist">
      ${tab('pages', 'Pages')}
      ${tab('modules', 'Modules')}
      ${tab('crud', 'CRUD')}
    </div>
    <div class="rbac-panel" id="rbac-panel">${body}</div>`;

    host.querySelectorAll('[data-rbac-tab]').forEach((btn) => {
        btn.onclick = () => {
            const draft = readMatrixFromDom(host, matrixState);
            matrixState = { ...matrixState, ...draft };
            activeTab = btn.dataset.rbacTab;
            void renderPageAccessAdmin({ reload: false });
        };
    });

    document.getElementById('rbac-save-all').onclick = async () => {
        const btn = document.getElementById('rbac-save-all');
        const draft = readMatrixFromDom(host, matrixState);
        matrixState = { ...matrixState, ...draft };
        btn.disabled = true;
        const prev = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Saving…';
        try {
            await saveRbacMatrix(apartmentId, draft);
            const uid = portalState.auth?.id;
            const roleKey = portalState.auth?.effectiveRoleKey;
            if (uid && roleKey) {
                await loadUserPageAccess(apartmentId, uid, roleKey);
                await loadRoleModuleAccess(apartmentId, roleKey);
                await loadCrudAccessForRole(apartmentId, roleKey);
            }
            applyNavPermissions(new Set(resolveEffectivePermissions()));
            alert('Role access saved.');
            matrixState = null;
            void renderPageAccessAdmin({ reload: true });
        } catch (err) {
            alert(err.message || 'Could not save role access.');
        } finally {
            btn.disabled = false;
            btn.innerHTML = prev;
        }
    };
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

export async function renderUserPageAccessPanel(userId, apartmentIds = []) {
    const host = document.getElementById('user-page-access-panel');
    if (!host) return;

    if (!hasClientPermission('rbac.edit')) {
        host.hidden = true;
        return;
    }

    const roleKey = document.getElementById('access-user-role-v2')?.value || 'resident_viewer';
    if (roleKey === 'society_admin') {
        host.innerHTML = '<p class="page-access-hint">Society administrators use the role template without page overrides.</p>';
        host.hidden = false;
        return;
    }

    const apartmentId = apartmentIds[0] || portalState.access?.activeApartmentId;
    if (!userId || !apartmentId) {
        host.innerHTML = '<p class="page-access-hint">Select a user and society.</p>';
        host.hidden = false;
        return;
    }

    host.hidden = false;
    host.innerHTML = '<p class="page-access-hint"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading…</p>';

    let editorState;
    try {
        editorState = await buildUserPageOverrideState(userId, apartmentId, roleKey);
    } catch (err) {
        host.innerHTML = `<p class="page-access-hint page-access-hint--error">${esc(err.message)}</p>`;
        return;
    }

    const modules = pageCatalogByModule(false);
    const html = modules.map((mod, idx) => {
        const rows = mod.pages.map((page) =>
            pageOverrideRow(page, editorState.states[page.route]),
        ).join('');
        return moduleSection(mod, rows, idx === 0);
    }).join('');

    host.innerHTML = `
    <p class="page-access-hint">Per-user page overrides (optional). Blank inherit uses the role matrix.</p>
    <div class="page-access-grid page-access-grid--compact">${html}</div>`;
}

export async function saveUserPageOverridesFromPanel(userId, apartmentIds = []) {
    const host = document.getElementById('user-page-access-panel');
    if (!host || host.hidden) return;
    const roleKey = document.getElementById('access-user-role-v2')?.value || 'resident_viewer';
    if (roleKey === 'society_admin') return;
    const apartmentId = apartmentIds[0] || portalState.access?.activeApartmentId;
    if (!userId || !apartmentId) return;

    const states = {};
    host.querySelectorAll('[data-user-page-route]').forEach((el) => {
        states[el.dataset.userPageRoute] = el.value;
    });
    await saveUserPageOverrides(userId, apartmentId, roleKey, states);
}

// keep export for any leftover imports
export { SOCIETY_SCOPED_ROLES };
