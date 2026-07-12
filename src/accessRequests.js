/**
 * Access requests — users without society membership request access; admins approve in Setup.
 */
import { portalState, supabase, isPlaceholderApartmentId } from './store.js';
import { ROLE_OPTIONS, saveUserAccess, loadUserRoleAssignments, v2KeyToLabel, hasClientPermission } from './rbac.js';
import { queueStaffNotifications } from './staffNotifications.js';

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const REQUESTABLE_ROLES = ROLE_OPTIONS.filter((r) =>
    ['resident_viewer', 'security', 'property_manager', 'accounts_manager'].includes(r.key),
);

export function canReviewAccessRequests() {
    const perms = portalState.authPermissions || [];
    return hasClientPermission('rbac.view', perms) || hasClientPermission('setup.view', perms);
}

export async function fetchRequestableApartments() {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('apartments')
        .select('id, name')
        .neq('name', '__SYSTEM__')
        .order('name');
    if (error) {
        console.warn('[accessRequests] apartment list failed:', error.message);
        return [];
    }
    return data || [];
}

export async function fetchMyPendingAccessRequests() {
    if (!supabase || !portalState.auth?.id) return [];
    const { data, error } = await supabase
        .from('access_requests')
        .select('id, apartment_id, requested_role_key, status, message, created_at')
        .eq('user_id', portalState.auth.id)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false });
    if (error) {
        if (/access_requests/i.test(error.message)) return [];
        throw error;
    }
    return data || [];
}

export async function submitAccessRequest({ apartmentId, roleKey = 'resident_viewer', message = '' }) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const uid = portalState.auth?.id;
    if (!uid) throw new Error('Sign in first.');

    const existing = await fetchMyPendingAccessRequests();
    if (existing.some((r) => r.apartment_id === apartmentId)) {
        throw new Error('You already have a pending request for this society.');
    }

    const { data, error } = await supabase
        .from('access_requests')
        .insert({
            id: crypto.randomUUID(),
            user_id: uid,
            apartment_id: apartmentId,
            requested_role_key: roleKey,
            message: message?.trim() || null,
            requester_email: portalState.auth?.email || null,
            requester_name: portalState.auth?.name || null,
            status: 'PENDING',
        })
        .select('id')
        .single();

    if (error) {
        if (/duplicate|unique/i.test(error.message)) {
            throw new Error('You already have a pending request for this society.');
        }
        if (/access_requests/i.test(error.message)) {
            throw new Error('Access requests are not enabled yet. Ask an admin to run supabase_access_requests.sql in Supabase.');
        }
        throw new Error(error.message);
    }
    return data;
}

export async function fetchPendingAccessRequestsForAdmin(apartmentId = null) {
    if (!supabase || !canReviewAccessRequests()) return [];
    const aptId = apartmentId || portalState.access?.activeApartmentId;
    if (!aptId) return [];

    const { data, error } = await supabase
        .from('access_requests')
        .select('id, user_id, apartment_id, requested_role_key, status, message, requester_email, requester_name, created_at')
        .eq('apartment_id', aptId)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false });

    if (error) {
        if (/access_requests/i.test(error.message)) return [];
        throw error;
    }
    return data || [];
}

async function notifyRequester(request, { title, body }) {
    await queueStaffNotifications([{
        apartment_id: request.apartment_id,
        user_id: request.user_id,
        title,
        body,
        access_request_id: request.id,
    }]);
}

export async function approveAccessRequest(request, { roleKey, adminNote = '' } = {}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    if (!canReviewAccessRequests()) throw new Error('You do not have permission to approve access requests.');

    const grantRole = roleKey || request.requested_role_key || 'resident_viewer';
    const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('id, full_name, email, role')
        .eq('id', request.user_id)
        .maybeSingle();
    if (profileErr) throw new Error(profileErr.message);
    if (!profile) throw new Error('User profile not found.');

    const previousAssignments = await loadUserRoleAssignments(request.user_id);
    await saveUserAccess({
        userId: request.user_id,
        name: profile.full_name || profile.email || 'User',
        email: profile.email || '',
        roleKey: grantRole,
        apartmentIds: [request.apartment_id],
        previousAssignments,
        managedApartmentIds: [request.apartment_id],
    });

    const { error: updErr } = await supabase
        .from('access_requests')
        .update({
            status: 'APPROVED',
            reviewed_by: portalState.auth?.id || null,
            reviewed_at: new Date().toISOString(),
            admin_note: adminNote?.trim() || null,
        })
        .eq('id', request.id)
        .eq('apartment_id', request.apartment_id)
        .eq('status', 'PENDING');
    if (updErr) throw new Error(updErr.message);

    const societyName = portalState.access?.apartments?.find((a) => a.id === request.apartment_id)?.name || 'your society';
    await notifyRequester(request, {
        title: 'Access approved',
        body: `Your access to ${societyName} was approved (${v2KeyToLabel(grantRole)}). Sign in again to load the workspace.`,
    });

    return { approved: true, roleKey: grantRole };
}

export async function denyAccessRequest(request, { adminNote = '' } = {}) {
    if (!supabase) throw new Error('Supabase is not configured.');
    if (!canReviewAccessRequests()) throw new Error('You do not have permission to deny access requests.');

    const { error } = await supabase
        .from('access_requests')
        .update({
            status: 'DENIED',
            reviewed_by: portalState.auth?.id || null,
            reviewed_at: new Date().toISOString(),
            admin_note: adminNote?.trim() || null,
        })
        .eq('id', request.id)
        .eq('apartment_id', request.apartment_id)
        .eq('status', 'PENDING');
    if (error) throw new Error(error.message);

    const societyName = portalState.access?.apartments?.find((a) => a.id === request.apartment_id)?.name || 'the society';
    const note = adminNote?.trim();
    await notifyRequester(request, {
        title: 'Access request declined',
        body: note
            ? `Your request for ${societyName} was declined: ${note}`
            : `Your request for ${societyName} was declined. Contact the association office if you need help.`,
    });

    return { denied: true };
}

export async function renderAccessRequestsAdmin() {
    const container = document.getElementById('access-requests-admin');
    if (!container) return;

    if (!canReviewAccessRequests()) {
        container.hidden = true;
        return;
    }

    container.hidden = false;
    const pending = await fetchPendingAccessRequestsForAdmin();
    if (!pending.length) {
        container.innerHTML = `
          <div class="access-requests-empty" style="padding:1.25rem; color:var(--text-dim); font-size:0.85rem;">
            No pending access requests for this society.
          </div>`;
        return;
    }

    const roleOptions = ROLE_OPTIONS
        .filter((r) => r.key !== 'system_admin')
        .map((r) => `<option value="${r.key}">${esc(r.label)}</option>`)
        .join('');

    container.innerHTML = pending.map((req) => {
        const name = req.requester_name || req.requester_email || 'Unknown user';
        const email = req.requester_email || '—';
        const when = req.created_at
            ? new Date(req.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
            : '';
        const defaultRole = req.requested_role_key || 'resident_viewer';
        const message = req.message ? `<p class="access-request-note">${esc(req.message)}</p>` : '';

        return `
          <div class="access-request-row" data-request-id="${req.id}">
            <div class="access-request-main">
              <div class="access-request-user">
                <strong>${esc(name)}</strong>
                <span class="access-request-email">${esc(email)}</span>
              </div>
              <div class="access-request-meta">
                Requested ${esc(v2KeyToLabel(defaultRole))} · ${esc(when)}
              </div>
              ${message}
            </div>
            <div class="access-request-actions">
              <select class="access-request-role expense-combobox" aria-label="Role to grant">
                ${ROLE_OPTIONS.filter((r) => r.key !== 'system_admin').map((r) =>
                    `<option value="${r.key}" ${r.key === defaultRole ? 'selected' : ''}>${esc(r.label)}</option>`,
                ).join('')}
              </select>
              <input type="text" class="access-request-note-input expense-combobox" placeholder="Optional note" />
              <div class="access-request-btns">
                <button type="button" class="btn btn-primary btn--small access-request-approve">Approve</button>
                <button type="button" class="btn btn-outline btn--small access-request-deny">Decline</button>
              </div>
            </div>
          </div>`;
    }).join('');

    container.querySelectorAll('.access-request-approve').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = btn.closest('.access-request-row');
            const id = row?.dataset.requestId;
            const request = pending.find((r) => r.id === id);
            if (!request) return;
            const roleKey = row.querySelector('.access-request-role')?.value || request.requested_role_key;
            const adminNote = row.querySelector('.access-request-note-input')?.value || '';
            btn.disabled = true;
            try {
                await approveAccessRequest(request, { roleKey, adminNote });
                const { syncAccessFromSupabase } = await import('./accessSync.js');
                await syncAccessFromSupabase();
                const { renderAccessMappings } = await import('./mainBoot.js');
                renderAccessMappings();
                await renderAccessRequestsAdmin();
            } catch (err) {
                alert(err?.message || 'Could not approve request.');
                btn.disabled = false;
            }
        });
    });

    container.querySelectorAll('.access-request-deny').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const row = btn.closest('.access-request-row');
            const id = row?.dataset.requestId;
            const request = pending.find((r) => r.id === id);
            if (!request) return;
            const adminNote = row.querySelector('.access-request-note-input')?.value || '';
            if (!confirm('Decline this access request?')) return;
            btn.disabled = true;
            try {
                await denyAccessRequest(request, { adminNote });
                await renderAccessRequestsAdmin();
            } catch (err) {
                alert(err?.message || 'Could not decline request.');
                btn.disabled = false;
            }
        });
    });
}

export async function initAccessRequestWorkspaceGate() {
    const requestPanel = document.getElementById('workspace-gate-request-panel');
    const selectPanel = document.getElementById('workspace-gate-select-panel');
    const pendingPanel = document.getElementById('workspace-gate-pending-panel');
    const aptSelect = document.getElementById('workspace-gate-request-apartment');
    const roleSelect = document.getElementById('workspace-gate-request-role');
    const messageEl = document.getElementById('workspace-gate-request-message');
    const submitBtn = document.getElementById('workspace-gate-request-submit');
    const errEl = document.getElementById('workspace-gate-error');
    const titleEl = document.getElementById('workspace-gate-title');

    if (!requestPanel || !selectPanel || !pendingPanel) return;

    const apartments = (portalState.access?.apartments || []).filter((a) => !isPlaceholderApartmentId(a.id));
    const hasSocietyAccess = apartments.length > 0;

    if (hasSocietyAccess) {
        requestPanel.hidden = true;
        pendingPanel.hidden = true;
        selectPanel.hidden = false;
        if (titleEl) titleEl.textContent = 'Select your society';
        return;
    }

    selectPanel.hidden = true;
    const pending = await fetchMyPendingAccessRequests();

    if (pending.length) {
        requestPanel.hidden = true;
        pendingPanel.hidden = false;
        if (titleEl) titleEl.textContent = 'Access request pending';
        const list = document.getElementById('workspace-gate-pending-list');
        const aptNames = Object.fromEntries((await fetchRequestableApartments()).map((a) => [a.id, a.name]));
        if (list) {
            list.innerHTML = pending.map((r) => {
                const society = aptNames[r.apartment_id] || 'Society';
                const role = v2KeyToLabel(r.requested_role_key);
                return `<li><strong>${esc(society)}</strong> — ${esc(role)}</li>`;
            }).join('');
        }
        return;
    }

    pendingPanel.hidden = true;
    requestPanel.hidden = false;
    if (titleEl) titleEl.textContent = 'Request society access';

    const requestable = await fetchRequestableApartments();
    if (aptSelect) {
        if (!requestable.length) {
            aptSelect.innerHTML = '<option value="">No societies available</option>';
            aptSelect.disabled = true;
        } else {
            aptSelect.disabled = false;
            aptSelect.innerHTML = `<option value="">— Select society —</option>${requestable.map((a) =>
                `<option value="${a.id}">${esc(a.name)}</option>`,
            ).join('')}`;
        }
    }

    if (roleSelect && !roleSelect.options.length) {
        roleSelect.innerHTML = REQUESTABLE_ROLES.map((r) =>
            `<option value="${r.key}">${esc(r.label)}</option>`,
        ).join('');
    }

    if (submitBtn && !submitBtn.dataset.wired) {
        submitBtn.dataset.wired = '1';
        submitBtn.addEventListener('click', async () => {
            const apartmentId = aptSelect?.value;
            const roleKey = roleSelect?.value || 'resident_viewer';
            const message = messageEl?.value || '';
            if (!apartmentId) {
                if (errEl) {
                    errEl.style.display = 'block';
                    errEl.textContent = 'Select a society first.';
                }
                return;
            }
            submitBtn.disabled = true;
            if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
            try {
                await submitAccessRequest({ apartmentId, roleKey, message });
                await initAccessRequestWorkspaceGate();
            } catch (err) {
                if (errEl) {
                    errEl.style.display = 'block';
                    errEl.textContent = err?.message || 'Could not submit request.';
                }
            } finally {
                submitBtn.disabled = false;
            }
        });
    }
}
