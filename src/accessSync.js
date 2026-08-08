/** Society access resolution and state loading (decoupled from main.js entry). */

import {
    portalState,
    persist,
    supabase,
    pullState,
    isPlaceholderApartmentId,
    withTimeout,
    resetLoadedDomains,
    applyBootPayload,
} from './store.js';
import { renderAccessMappings, ensureAccessState } from './mainBoot.js';
import {
    ROLE_OPTIONS,
    refreshAuthPermissions,
    loadAllUserRoleAssignmentsCached,
    clearRoleAssignmentsCache,
    seedRoleAssignmentsCache,
    rolePermissionFloor,
    v1RoleToV2Key,
} from './rbac.js';
import { applyNavPermissions } from './navigation.js';
import { refreshStaffNotifications } from './staffNotifications.js';
import { renderDashboard, seedDashboardSummary } from './dashboard.js';
import { deferAfterFirstPaint, getProfile, refreshAuthUiShell } from './authShell.js';
import {
    accessLocks,
    withApartmentSelectSuppressed,
    invalidateWorkspaceAccess,
    beginApartmentSwitch,
} from './accessLocks.js';
import { readApiJson } from './apiJson.js';

export {
    isApartmentSelectSuppressed,
    invalidateWorkspaceAccess,
    withApartmentSelectSuppressedAsync,
    isSocietyHydrating,
} from './accessLocks.js';

async function fetchWorkspaceBoot(apartmentHint = null) {
    const hint = apartmentHint && !isPlaceholderApartmentId(apartmentHint) ? apartmentHint : '';
    const key = hint || '__auto__';
    if (accessLocks.workspaceBootInflight && accessLocks.workspaceBootInflightKey === key) {
        return accessLocks.workspaceBootInflight;
    }
    // Reuse any in-flight boot for the same auto-resolve (null hint) or exact apt.
    if (accessLocks.workspaceBootInflight && !hint && accessLocks.workspaceBootInflightKey === '__auto__') {
        return accessLocks.workspaceBootInflight;
    }

    accessLocks.workspaceBootInflightKey = key;
    accessLocks.workspaceBootInflight = (async () => {
        const params = new URLSearchParams();
        if (hint) params.set('apartment_id', hint);
        const qs = params.toString();
        const headers = {};
        let token = null;
        try {
            const { data } = await supabase.auth.getSession();
            token = data?.session?.access_token || null;
        } catch { /* ignore */ }
        if (!token) {
            // Avoid a 30–60s hanging 401 on the server when HMR boots before auth is ready.
            throw Object.assign(new Error('Sign in required.'), { status: 401 });
        }
        headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`/api/workspace-boot${qs ? `?${qs}` : ''}`, {
            method: 'GET',
            credentials: 'include',
            headers,
        });
        const { ok, json, error } = await readApiJson(res);
        if (!ok) throw Object.assign(
            new Error(json?.error || error || 'Workspace boot failed.'),
            { status: res.status },
        );
        return json;
    })().finally(() => {
        if (accessLocks.workspaceBootInflightKey === key) {
            accessLocks.workspaceBootInflight = null;
            accessLocks.workspaceBootInflightKey = null;
        }
    });

    return accessLocks.workspaceBootInflight;
}

function scheduleOnceNotifications(apartmentId) {
    if (!apartmentId || isPlaceholderApartmentId(apartmentId)) return;
    if (accessLocks.notificationsForApt === apartmentId) return;
    accessLocks.notificationsForApt = apartmentId;
    deferAfterFirstPaint(() => {
        refreshStaffNotifications().catch(() => {});
    });
}

function applyAuthFromBoot(boot) {
    const profile = boot.profile;
    const roleKey = boot.effectiveRoleKey
        || (boot.isSystemAdmin ? 'system_admin' : null)
        || v1RoleToV2Key(profile?.role || 'resident_viewer');
    const v1Role = ROLE_OPTIONS.find((r) => r.key === roleKey)?.v1Key || profile?.role || 'resident_viewer';

    if (portalState.auth) {
        portalState.auth.effectiveRoleKey = roleKey;
        portalState.auth.role = v1Role;
        portalState.auth.isSystemAdmin = !!boot.isSystemAdmin;
        if (profile?.full_name) portalState.auth.name = profile.full_name;
        if (profile?.email) portalState.auth.email = profile.email;
    }

    const floor = rolePermissionFloor(roleKey);
    // Boot list is authoritative — including [] (empty = no access). Never invent from floor.
    if (Array.isArray(boot.permissions)) {
        portalState.authPermissions = [...new Set(boot.permissions)];
    } else if (boot.isSystemAdmin) {
        portalState.authPermissions = floor;
    } else {
        portalState.authPermissions = [];
    }
}

/** Legacy resolver kept for workspace-gate fallback paths. */
export const resolveActiveApartment = async (uid, profile) => {
    if (!supabase || !uid) return { apartments: [], activeId: null, apartmentIds: [] };

    const key = `${uid}:${profile?.last_apartment_id || ''}:${portalState.access?.activeApartmentId || ''}`;
    if (accessLocks.resolveInflight && accessLocks.resolveInflightKey === key) {
        return accessLocks.resolveInflight;
    }

    accessLocks.resolveInflightKey = key;
    accessLocks.resolveInflight = (async () => {
        const { data: mappings, error: mapError } = await withTimeout(
            supabase.from('user_apartments').select('apartment_id').eq('user_id', uid),
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

        if (!pool.length) {
            return { apartments: [], activeId: null, apartmentIds: [] };
        }

        const cur = portalState.access?.activeApartmentId;
        if (cur && !isPlaceholderApartmentId(cur) && pool.some((a) => a.id === cur)) {
            return { apartments: pool, activeId: cur, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
        }
        const last = profile?.last_apartment_id;
        if (last && pool.some((a) => a.id === last)) {
            return { apartments: pool, activeId: last, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
        }
        return { apartments: pool, activeId: pool[0].id, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
    })().finally(() => {
        if (accessLocks.resolveInflightKey === key) {
            accessLocks.resolveInflight = null;
            accessLocks.resolveInflightKey = null;
        }
    });

    return accessLocks.resolveInflight;
};

/** Staff directory for Setup / Access Control only — never on dashboard boot. */
export const loadAccessUserDirectory = async (activeId, uid, { force = false } = {}) => {
    if (!supabase || !activeId) return;
    if (!force && accessLocks.directoryForApt === activeId) return;
    if (accessLocks.directoryInflight) return accessLocks.directoryInflight;

    accessLocks.directoryInflight = (async () => {
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
            if (!userIds.length) {
                accessLocks.directoryForApt = activeId;
                return;
            }

            const { data: profiles, error: profilesErr } = await withTimeout(
                supabase.from('profiles').select('id, full_name, email, role').in('id', userIds).order('full_name'),
                15000,
                'User directory',
            );
            if (profilesErr) console.error('[access] profiles query failed:', profilesErr.message);
            if (!profiles?.length) {
                accessLocks.directoryForApt = activeId;
                return;
            }

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
            accessLocks.directoryForApt = activeId;
            persist();
            withApartmentSelectSuppressed(() => renderAccessMappings());
        } catch (err) {
            console.warn('[access] User directory load skipped:', err.message);
        } finally {
            accessLocks.directoryInflight = null;
        }
    })();

    return accessLocks.directoryInflight;
};

/**
 * Apply a /api/workspace-boot payload into portal state (one network round-trip).
 */
async function hydrateFromWorkspaceBoot(boot) {
    ensureAccessState();
    portalState.access.apartments = boot.apartments || [];
    portalState.access.activeApartmentId = boot.activeApartmentId;
    if (portalState.access.users?.length && boot.apartmentIds?.length) {
        portalState.access.users[0].apartment_ids = boot.apartmentIds;
    }
    if (boot.profile) {
        portalState.access.users = [{
            id: boot.profile.id,
            name: boot.profile.full_name || boot.profile.email || 'User',
            email: boot.profile.email || '',
            role: boot.profile.role || 'resident_viewer',
            apartment_ids: boot.apartmentIds || [],
        }];
        portalState.access.activeUserId = boot.profile.id;
    }

    applyAuthFromBoot(boot);
    seedRoleAssignmentsCache(boot.profile?.id || portalState.auth?.id, boot.roleAssignments || []);
    applyBootPayload(boot);
    if (boot.crudAccess && Object.keys(boot.crudAccess).length) {
        document.dispatchEvent(new CustomEvent('crud-access-loaded'));
    }

    if (boot.summary) seedDashboardSummary(boot.activeApartmentId, boot.summary);

    accessLocks.readyApartmentId = boot.activeApartmentId;
    accessLocks.workspaceReady = true;
    accessLocks.lastWrittenLastApartmentId = boot.activeApartmentId;

    persist();
    refreshAuthUiShell();
    applyNavPermissions(new Set(portalState.authPermissions || []));
    withApartmentSelectSuppressed(() => renderAccessMappings());

    document.dispatchEvent(new CustomEvent('apartment-data-loaded'));
    document.dispatchEvent(new CustomEvent('module-access-loaded'));

    scheduleOnceNotifications(boot.activeApartmentId);
    schedulePostBootAccessLoads(boot.activeApartmentId, boot.profile?.id || portalState.auth?.id);

    if (document.getElementById('view-dashboard')?.classList.contains('active')) {
        void renderDashboard();
    }
}

/** Module / page / CRUD maps — not on the boot critical path. */
function schedulePostBootAccessLoads(apartmentId, userId) {
    if (!apartmentId) return;
    deferAfterFirstPaint(() => {
        void (async () => {
            try {
                const { loadModuleAccess } = await import('./moduleAccess.js');
                await loadModuleAccess(apartmentId, userId || null);
                document.dispatchEvent(new CustomEvent('module-access-loaded'));
            } catch (err) {
                console.warn('[access] module access deferred load skipped:', err?.message || err);
            }
            try {
                const { loadUserPageAccess } = await import('./pageAccess.js');
                const roleKey = portalState.auth?.effectiveRoleKey
                    || v1RoleToV2Key(portalState.auth?.role);
                await loadUserPageAccess(apartmentId, userId, roleKey);
                applyNavPermissions(new Set(portalState.authPermissions || []));
            } catch (err) {
                console.warn('[access] page access deferred load skipped:', err?.message || err);
            }
            try {
                const { loadCrudAccessForRole } = await import('./rbacMatrix.js');
                const roleKey = portalState.auth?.effectiveRoleKey
                    || v1RoleToV2Key(portalState.auth?.role);
                await loadCrudAccessForRole(apartmentId, roleKey);
                document.dispatchEvent(new CustomEvent('crud-access-loaded'));
            } catch (err) {
                console.warn('[access] CRUD access deferred load skipped:', err?.message || err);
            }
        })();
    });
}

export const setActiveApartment = async (apartmentId, { force = false } = {}) => {
    if (isPlaceholderApartmentId(apartmentId)) {
        console.warn('[access] Ignoring placeholder apartment id');
        return false;
    }

    // If society sync is already hydrating, wait for it instead of starting a second boot.
    if (accessLocks.syncAccessInflight) {
        try { await accessLocks.syncAccessInflight; } catch { /* ignore */ }
        if (accessLocks.readyApartmentId === apartmentId && accessLocks.workspaceReady) {
            return true;
        }
    }

    const alreadyReady = accessLocks.readyApartmentId === apartmentId
        && accessLocks.workspaceReady;
    // Same-apartment "force" from select churn is a no-op once workspace is ready.
    if (alreadyReady && (!force || apartmentId === portalState.access?.activeApartmentId)) {
        return true;
    }

    if (accessLocks.setActiveInflight && accessLocks.setActiveInflightId === apartmentId) {
        return accessLocks.setActiveInflight;
    }
    if (accessLocks.setActiveInflight) {
        try { await accessLocks.setActiveInflight; } catch { /* ignore */ }
        if (accessLocks.readyApartmentId === apartmentId && accessLocks.workspaceReady) {
            return true;
        }
    }

    accessLocks.setActiveInflightId = apartmentId;
    accessLocks.setActiveInflight = (async () => {
        console.group('[Access] Setting active apartment:', apartmentId);
        accessLocks.societyHydrating = true;
        try {
            if (accessLocks.readyApartmentId && accessLocks.readyApartmentId !== apartmentId) {
                beginApartmentSwitch(apartmentId);
            } else if (force) {
                beginApartmentSwitch(apartmentId);
            }

            const boot = await withTimeout(
                fetchWorkspaceBoot(apartmentId),
                120000,
                'Workspace boot',
            );
            if (!boot.activeApartmentId) return false;

            if (boot.activeApartmentId !== apartmentId
                && !(boot.apartments || []).some((a) => a.id === apartmentId)) {
                console.error('[access] No access to apartment', apartmentId);
                return false;
            }

            if ((boot.apartments || []).some((a) => a.id === apartmentId)) {
                boot.activeApartmentId = apartmentId;
            }

            resetLoadedDomains();
            await hydrateFromWorkspaceBoot(boot);
            return true;
        } catch (err) {
            console.error('[access] setActiveApartment failed:', err?.message || err);
            portalState.access.activeApartmentId = apartmentId;
            resetLoadedDomains();
            const success = await pullState({ domain: 'core', force: true });
            if (success) {
                accessLocks.readyApartmentId = apartmentId;
                accessLocks.workspaceReady = true;
                const roleAssignments = await loadAllUserRoleAssignmentsCached(portalState.auth?.id);
                await refreshAuthPermissions(apartmentId, roleAssignments);
                applyNavPermissions(new Set(portalState.authPermissions || []));
                document.dispatchEvent(new CustomEvent('apartment-data-loaded'));
                withApartmentSelectSuppressed(() => renderAccessMappings());
            }
            return success;
        } finally {
            accessLocks.societyHydrating = false;
            console.groupEnd();
            if (accessLocks.setActiveInflightId === apartmentId) {
                accessLocks.setActiveInflight = null;
                accessLocks.setActiveInflightId = null;
            }
        }
    })();

    return accessLocks.setActiveInflight;
};

export const syncAccessFromSupabase = async (profileOverride = null) => {
    if (!supabase) return false;

    // Sticky when RBAC/workspace is ready — core/dashboard data loads async after login.
    if (
        accessLocks.workspaceReady
        && accessLocks.readyApartmentId
        && !profileOverride?.__force
    ) {
        return true;
    }
    if (accessLocks.syncAccessInflight) return accessLocks.syncAccessInflight;

    accessLocks.societyHydrating = true;
    accessLocks.syncAccessInflight = (async () => {
        try {
            const { data: sessionData } = await supabase.auth.getSession();
            const uid = sessionData?.session?.user?.id;
            if (!uid) return false;

            ensureAccessState();
            if (portalState.auth?.id && portalState.auth.id !== uid) {
                clearRoleAssignmentsCache();
                invalidateWorkspaceAccess();
            }

            const hint = portalState.access?.activeApartmentId
                || profileOverride?.last_apartment_id
                || null;

            const boot = await withTimeout(
                fetchWorkspaceBoot(hint),
                120000,
                'Workspace boot',
            );

            if (!boot.apartments?.length || !boot.activeApartmentId) {
                console.error('[access] No apartments available for this user', { uid });
                withApartmentSelectSuppressed(() => renderAccessMappings());
                return false;
            }

            if (!portalState.auth?.id) {
                // Minimal auth shell if applyAuthToUI has not run yet
                portalState.auth = {
                    id: uid,
                    email: boot.profile?.email || '',
                    name: boot.profile?.full_name || boot.profile?.email || 'User',
                    role: boot.profile?.role || 'resident_viewer',
                    effectiveRoleKey: boot.effectiveRoleKey || 'resident_viewer',
                    isSystemAdmin: !!boot.isSystemAdmin,
                };
            }

            resetLoadedDomains();
            await hydrateFromWorkspaceBoot(boot);
            return true;
        } catch (err) {
            console.error('[access] workspace boot failed, falling back:', err?.message || err);
            const uid = portalState.auth?.id;
            const selfProfile = profileOverride || await getProfile(uid);
            const { apartments, activeId, apartmentIds } = await resolveActiveApartment(uid, selfProfile);
            if (!apartments.length || !activeId) return false;
            portalState.access.apartments = apartments;
            if (portalState.access.users?.length && apartmentIds?.length) {
                portalState.access.users[0].apartment_ids = apartmentIds;
            }
            // Clear sync inflight before setActive — otherwise setActive waits on this same promise (deadlock).
            accessLocks.syncAccessInflight = null;
            return setActiveApartment(activeId);
        } finally {
            accessLocks.societyHydrating = false;
            accessLocks.syncAccessInflight = null;
        }
    })();

    return accessLocks.syncAccessInflight;
};
