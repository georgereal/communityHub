/**
 * Access control settings hub: role permissions + page access tabs.
 */
import './pageAccess.css';
import { renderRolePermissionsAdmin } from './rolePermissionsAdmin.js';
import { renderPageAccessAdmin } from './pageAccessAdmin.js';

let activeTab = 'permissions';

function setActiveTab(tab) {
    activeTab = tab === 'pages' ? 'pages' : 'permissions';
}

export async function renderAccessControlAdmin() {
    const host = document.getElementById('access-control-admin-host');
    if (!host) return;

    host.innerHTML = `
      <div class="access-control-tabs" role="tablist" aria-label="Access control settings">
        <button type="button" class="access-control-tab ${activeTab === 'permissions' ? 'is-active' : ''}" data-tab="permissions" role="tab" aria-selected="${activeTab === 'permissions'}">
          <i class="fa-solid fa-key" aria-hidden="true"></i> Role Permissions
        </button>
        <button type="button" class="access-control-tab ${activeTab === 'pages' ? 'is-active' : ''}" data-tab="pages" role="tab" aria-selected="${activeTab === 'pages'}">
          <i class="fa-solid fa-table-columns" aria-hidden="true"></i> Page Access
        </button>
      </div>
      <div id="role-permissions-admin-host" ${activeTab === 'permissions' ? '' : 'hidden'}></div>
      <div id="page-access-admin-host" ${activeTab === 'pages' ? '' : 'hidden'}></div>`;

    host.querySelectorAll('.access-control-tab').forEach((btn) => {
        btn.onclick = () => {
            setActiveTab(btn.dataset.tab);
            void renderAccessControlAdmin();
        };
    });

    if (activeTab === 'permissions') {
        await renderRolePermissionsAdmin();
    } else {
        await renderPageAccessAdmin();
    }
}
