/**
 * Staff in-app notifications — bell popover + optional toast on new alerts
 */
import { portalState, supabase, isPlaceholderApartmentId } from './store.js';
import { routeIsAllowed } from './rbac.js';

const REVIEWER_V2 = new Set(['society_admin', 'apartment_admin', 'accounts_manager']);
const REVIEWER_V1 = new Set(['admin', 'accounts_manager']);

let panelOpen = false;
let toastTimer = null;
let lastUnreadCount = null;

const formatWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function staffNotificationsEnabled() {
    const role = portalState.auth?.effectiveRoleKey || portalState.auth?.role;
    return role && role !== 'resident_viewer';
}

export async function fetchStaffNotifications({ limit = 40, unreadOnly = false } = {}) {
    if (!supabase || !staffNotificationsEnabled()) return [];
    const uid = portalState.auth?.id;
    const aptId = portalState.access?.activeApartmentId;
    if (!uid || !aptId || isPlaceholderApartmentId(aptId)) return [];

    let q = supabase
        .from('user_notifications')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (unreadOnly) q = q.is('read_at', null);

    const { data, error } = await q;
    if (error) {
        if (/user_notifications/i.test(error.message)) return [];
        throw error;
    }
    return data || [];
}

export async function markNotificationRead(id) {
    if (!supabase || !id) return;
    const { error } = await supabase
        .from('user_notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', portalState.auth?.id);
    if (error) throw new Error(error.message);
}

export async function markAllNotificationsRead() {
    if (!supabase) return;
    const uid = portalState.auth?.id;
    if (!uid) return;
    const { error } = await supabase
        .from('user_notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', uid)
        .is('read_at', null);
    if (error) throw new Error(error.message);
}

export async function queueStaffNotifications(rows = []) {
    if (!rows.length || !supabase) return 0;
    const payload = rows.map((row) => ({
        id: crypto.randomUUID(),
        apartment_id: row.apartment_id,
        user_id: row.user_id,
        title: row.title,
        body: row.body,
        notice_id: row.notice_id || null,
        visitor_log_id: row.visitor_log_id || null,
        visitor_unit_id: row.visitor_unit_id || null,
        activity_audit_log_id: row.activity_audit_log_id || null,
        access_request_id: row.access_request_id || null,
    }));
    const { error } = await supabase.from('user_notifications').insert(payload);
    if (error) {
        if (/activity_audit_log_id|access_request_id/i.test(error.message)) {
            payload.forEach((p) => {
                delete p.activity_audit_log_id;
                delete p.access_request_id;
            });
            const { error: retryErr } = await supabase.from('user_notifications').insert(payload);
            if (retryErr) {
                console.warn('[notifications] queue failed:', retryErr.message);
                return 0;
            }
            return payload.length;
        }
        console.warn('[notifications] queue failed:', error.message);
        return 0;
    }
    return payload.length;
}

export async function getReviewerUserIds(apartmentId, excludeUserId = null) {
    const ids = new Set();

    (portalState.access?.users || []).forEach((u) => {
        if (!u.apartment_ids?.includes(apartmentId)) return;
        const aptRole = u.apartment_roles?.[apartmentId];
        if (aptRole && REVIEWER_V2.has(aptRole)) ids.add(u.id);
        else if (REVIEWER_V1.has(u.role)) ids.add(u.id);
    });

    if (!ids.size && supabase) {
        const { data: roleRows } = await supabase
            .from('user_role_assignments')
            .select('user_id, role_key')
            .eq('apartment_id', apartmentId)
            .eq('scope', 'apartment')
            .in('role_key', ['society_admin', 'apartment_admin', 'accounts_manager']);
        (roleRows || []).forEach((r) => ids.add(r.user_id));

        if (!ids.size) {
            const { data: mappings } = await supabase
                .from('user_apartments')
                .select('user_id')
                .eq('apartment_id', apartmentId);
            const userIds = [...new Set((mappings || []).map((m) => m.user_id))];
            if (userIds.length) {
                const { data: profiles } = await supabase
                    .from('profiles')
                    .select('id, role')
                    .in('id', userIds);
                (profiles || []).forEach((p) => {
                    if (REVIEWER_V1.has(p.role)) ids.add(p.id);
                });
            }
        }
    }

    if (excludeUserId) ids.delete(excludeUserId);
    return [...ids];
}

const activityLogRoute = () => 'admin-activity';

const navigateForNotification = async (note) => {
    if (note.access_request_id) {
        if (routeIsAllowed('admin-society')) {
            await window.switchView?.('admin-society');
            const { renderAccessRequestsAdmin } = await import('./accessRequests.js');
            const { openSetupSection } = await import('./setupSocietyUi.js');
            await renderAccessRequestsAdmin();
            openSetupSection('people');
            return;
        }
        alert('Open Administration → Society settings to review pending access requests.');
        return;
    }
    if (note.activity_audit_log_id) {
        window.switchView?.(activityLogRoute());
        return;
    }
    if (note.visitor_log_id && routeIsAllowed('security-gate')) {
        window.switchView?.('security-gate');
    }
};

function hideToast() {
    const toast = document.getElementById('notification-toast');
    if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
    }
    if (toast) toast.hidden = true;
}

function showNotificationToast(note) {
    if (!note || panelOpen) return;
    const toast = document.getElementById('notification-toast');
    if (!toast) return;

    toast.innerHTML = `
      <span class="notification-toast__title">${esc(note.title)}</span>
      <span class="notification-toast__body">${esc(note.body)}</span>`;
    toast.dataset.notifId = note.id || '';
    toast.dataset.auditId = note.activity_audit_log_id || '';
    toast.hidden = false;

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
}

function renderNotificationBadge() {
    const badge = document.getElementById('topbar-notif-badge');
    const count = portalState.notifications?.unreadCount || 0;
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

function renderNotificationPanel() {
    const list = document.getElementById('topbar-notifications-list');
    if (!list || !panelOpen) return;

    const notes = portalState.notifications?.items || [];
    if (!notes.length) {
        list.innerHTML = '<p class="notifications-panel__empty">No notifications yet.</p>';
        return;
    }

    list.innerHTML = notes.map((n) => `
      <button type="button" class="notifications-panel__item${n.read_at ? '' : ' notifications-panel__item--unread'}"
        data-notif-id="${n.id}"
        data-audit-id="${n.activity_audit_log_id || ''}"
        data-access-request-id="${n.access_request_id || ''}"
        data-visitor-log-id="${n.visitor_log_id || ''}">
        <span class="notifications-panel__item-title">${esc(n.title)}</span>
        <span class="notifications-panel__item-body">${esc(n.body)}</span>
        <span class="notifications-panel__item-when">${formatWhen(n.created_at)}</span>
      </button>`).join('');
}

function setPanelOpen(open) {
    const panel = document.getElementById('topbar-notifications-panel');
    const btn = document.getElementById('topbar-notifications-btn');
    if (!panel) return;

    panelOpen = open;
    panel.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');

    if (open) {
        hideToast();
        renderNotificationPanel();
    }
}

let refreshNotificationsInflight = null;

export async function refreshStaffNotifications({ showToast = true } = {}) {
    if (refreshNotificationsInflight) return refreshNotificationsInflight;

    refreshNotificationsInflight = (async () => {
        const anchor = document.getElementById('topbar-notifications-anchor');
        if (!staffNotificationsEnabled()) {
            if (anchor) anchor.hidden = true;
            setPanelOpen(false);
            return;
        }
        if (anchor) anchor.hidden = false;

        const notes = await fetchStaffNotifications({ limit: 40 });
        const unreadCount = notes.filter((n) => !n.read_at).length;
        const latestUnread = notes.find((n) => !n.read_at) || null;

        if (showToast && lastUnreadCount !== null && unreadCount > lastUnreadCount && latestUnread) {
            showNotificationToast(latestUnread);
        }
        lastUnreadCount = unreadCount;

        portalState.notifications = { items: notes, unreadCount };
        renderNotificationBadge();
        if (panelOpen) renderNotificationPanel();
    })().finally(() => {
        refreshNotificationsInflight = null;
    });

    return refreshNotificationsInflight;
}

export function initStaffNotificationsUi() {
    const btn = document.getElementById('topbar-notifications-btn');
    const panel = document.getElementById('topbar-notifications-panel');
    const list = document.getElementById('topbar-notifications-list');
    const markAll = document.getElementById('topbar-notifications-mark-all');
    const toast = document.getElementById('notification-toast');

    if (!btn || !panel) return;

    setPanelOpen(false);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = !panelOpen;
        setPanelOpen(opening);
        if (opening) {
            refreshStaffNotifications({ showToast: false }).catch(() => {});
        }
    });

    markAll?.addEventListener('click', (e) => {
        e.stopPropagation();
        markAllNotificationsRead()
            .then(() => refreshStaffNotifications({ showToast: false }))
            .catch((err) => alert(err?.message || 'Could not mark notifications read.'));
    });

    list?.addEventListener('click', (e) => {
        const item = e.target.closest('.notifications-panel__item');
        if (!item) return;
        const id = item.dataset.notifId;
        const note = (portalState.notifications?.items || []).find((n) => n.id === id) || {
            id,
            activity_audit_log_id: item.dataset.auditId || null,
            access_request_id: item.dataset.accessRequestId || null,
            visitor_log_id: item.dataset.visitorLogId || null,
        };
        markNotificationRead(id)
            .then(() => refreshStaffNotifications({ showToast: false }))
            .then(() => navigateForNotification(note))
            .catch((err) => alert(err?.message || 'Could not open notification.'));
        setPanelOpen(false);
    });

    toast?.addEventListener('click', () => {
        hideToast();
        setPanelOpen(true);
        refreshStaffNotifications({ showToast: false }).catch(() => {});
    });

    document.addEventListener('click', (e) => {
        if (!panelOpen) return;
        if (e.target.closest('#topbar-notifications-panel') || e.target.closest('#topbar-notifications-btn')) return;
        setPanelOpen(false);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (panelOpen) setPanelOpen(false);
            hideToast();
        }
    });
}

window.refreshStaffNotifications = refreshStaffNotifications;
