/**
 * Admin UI for apartment / user module toggles.
 */
import './moduleAccess.css';
import { portalState, supabase } from './store.js';
import { hasClientPermission } from './rbac.js';
import {
    MODULE_CATALOG,
    LOCKED_MODULE_KEYS,
    fetchApartmentModuleSettings,
    fetchUserModuleAccess,
    readModuleToggleValues,
    saveApartmentModuleSettings,
    saveUserModuleAccess,
} from './moduleAccess.js';
import { applyNavPermissions } from './navigation.js';
import { resolveEffectivePermissions } from './rbac.js';

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function apartmentToggleRow(mod, enabled) {
    return `<label class="module-toggle-row">
      <span class="module-toggle-row__lead">
        <i class="fa-solid ${mod.icon}" aria-hidden="true"></i>
        <span>
          <strong>${esc(mod.label)}</strong>
          <small>${esc(mod.description)}</small>
        </span>
      </span>
      <input type="checkbox" data-module-key="${mod.key}" ${enabled !== false ? 'checked' : ''} />
    </label>`;
}

function userOverrideRow(mod, value) {
    const selected = value === true ? 'on' : value === false ? 'off' : 'inherit';
    return `<label class="module-toggle-row module-toggle-row--user">
      <span class="module-toggle-row__lead">
        <i class="fa-solid ${mod.icon}" aria-hidden="true"></i>
        <strong>${esc(mod.label)}</strong>
      </span>
      <select data-user-module-key="${mod.key}" class="module-toggle-row__select">
        <option value="inherit" ${selected === 'inherit' ? 'selected' : ''}>Inherit society</option>
        <option value="on" ${selected === 'on' ? 'selected' : ''}>Enabled</option>
        <option value="off" ${selected === 'off' ? 'selected' : ''}>Disabled</option>
      </select>
    </label>`;
}

export async function renderApartmentModulePanel() {
    const host = document.getElementById('apartment-module-settings');
    if (!host) return;
    if (!hasClientPermission('setup.edit')) {
        host.innerHTML = '<p class="module-access-hint">Only admins can configure module access.</p>';
        return;
    }

    const apartmentId = portalState.access?.activeApartmentId;
    if (!apartmentId) {
        host.innerHTML = '<p class="module-access-hint">Select a society first.</p>';
        return;
    }

    host.innerHTML = '<p class="module-access-hint"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading…</p>';

    let settings = {};
    try {
        settings = await fetchApartmentModuleSettings(apartmentId);
    } catch (err) {
        host.innerHTML = `<p class="module-access-hint module-access-hint--error">${esc(err.message)}</p>`;
        return;
    }

    const aptName = portalState.access.apartments.find((a) => a.id === apartmentId)?.name || 'this society';

    host.innerHTML = `
      <p class="module-access-hint">Turn modules on or off for <strong>${esc(aptName)}</strong>. Admins always see all modules. Disabled modules are hidden from other users' menus and routes.</p>
      <div class="module-toggle-grid" id="apartment-module-grid">
        ${MODULE_CATALOG.map((mod) => {
        const locked = LOCKED_MODULE_KEYS.has(mod.key);
        if (locked) {
            return `<div class="module-toggle-row module-toggle-row--locked">
              <span class="module-toggle-row__lead">
                <i class="fa-solid ${mod.icon}" aria-hidden="true"></i>
                <span><strong>${esc(mod.label)}</strong><small>${esc(mod.description)} · always on</small></span>
              </span>
              <input type="checkbox" checked disabled title="Administration cannot be disabled" />
            </div>`;
        }
        return apartmentToggleRow(mod, settings[mod.key]);
    }).join('')}
      </div>
      <div class="module-access-actions">
        <button type="button" class="btn btn-primary btn--small" id="save-apartment-modules-btn">
          <i class="fa-solid fa-floppy-disk"></i> Save module settings
        </button>
      </div>`;

    document.getElementById('save-apartment-modules-btn').onclick = async () => {
        const grid = document.getElementById('apartment-module-grid');
        const values = readModuleToggleValues(grid, 'module');
        try {
            await saveApartmentModuleSettings(apartmentId, values);
            const { loadModuleAccess } = await import('./moduleAccess.js');
            await loadModuleAccess(apartmentId);
            applyNavPermissions(new Set(resolveEffectivePermissions()));
            alert('Module settings saved.');
        } catch (err) {
            alert(err.message || 'Could not save module settings.');
        }
    };
}

export async function renderUserModulePanel(userId, apartmentIds = []) {
    const host = document.getElementById('user-module-access-panel');
    if (!host) return;

    if (!hasClientPermission('setup.edit')) {
        host.hidden = true;
        return;
    }

    const role = document.getElementById('access-user-role-v2')?.value;
    if (role === 'apartment_admin') {
        host.innerHTML = '<p class="module-access-hint">Apartment admins always have access to all modules.</p>';
        host.hidden = false;
        return;
    }

    if (!userId || !apartmentIds.length) {
        host.innerHTML = '<p class="module-access-hint">Save the user first, then edit again to set per-user module overrides.</p>';
        host.hidden = false;
        return;
    }

    if (apartmentIds.length > 1) {
        host.innerHTML = `<p class="module-access-hint">Module overrides will apply to all ${apartmentIds.length} selected societies.</p>
          <div class="module-toggle-grid" id="user-module-grid">
            ${MODULE_CATALOG.filter((mod) => !LOCKED_MODULE_KEYS.has(mod.key)).map((mod) => userOverrideRow(mod, null)).join('')}
          </div>`;
        host.hidden = false;
        return;
    }

    let overrides = {};
    if (supabase) {
        try {
            overrides = await fetchUserModuleAccess(userId, apartmentIds[0]);
        } catch {
            /* table may not exist yet */
        }
    }

    host.innerHTML = `
      <label class="module-access-label">Module access overrides</label>
      <p class="module-access-hint">Optional — leave as <em>Inherit society</em> to use society defaults above.</p>
      <div class="module-toggle-grid" id="user-module-grid">
        ${MODULE_CATALOG.filter((mod) => !LOCKED_MODULE_KEYS.has(mod.key)).map((mod) => userOverrideRow(mod, overrides[mod.key])).join('')}
      </div>`;
    host.hidden = false;
}

export function readUserModuleOverridesFromPanel() {
    const grid = document.getElementById('user-module-grid');
    if (!grid) return {};
    const values = {};
    MODULE_CATALOG.forEach(({ key }) => {
        const el = grid.querySelector(`[data-user-module-key="${key}"]`);
        if (!el) return;
        const v = el.value;
        values[key] = v === 'inherit' ? null : v === 'on';
    });
    return values;
}

export async function saveUserModuleOverridesFromPanel(userId, apartmentIds) {
    if (!hasClientPermission('setup.edit')) return;
    const role = document.getElementById('access-user-role-v2')?.value;
    if (role === 'apartment_admin') return;
    const overrides = readUserModuleOverridesFromPanel();
    await saveUserModuleAccess(userId, apartmentIds, overrides);
}
