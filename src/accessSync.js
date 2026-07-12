/** Society access resolution and state loading (decoupled from main.js entry). */

import {
    portalState,
    persist,
    supabase,
    pullState,
    isPlaceholderApartmentId,
    withTimeout,
    resetLoadedDomains,
} from './store.js';
import { renderAccessMappings, ensureAccessState } from './mainBoot.js';
import {
    ROLE_OPTIONS,
    refreshAuthPermissions,
    loadAllUserRoleAssignmentsCached,
    clearRoleAssignmentsCache,
} from './rbac.js';
import { applyNavPermissions } from './navigation.js';
import { autoLinkResidentByEmail, acceptPendingInvites } from './residentLinks.js';
import { refreshStaffNotifications } from './staffNotifications.js';
import { renderDashboard } from './dashboard.js';
import { renderApartmentModulePanel } from './moduleAccessAdmin.js';
import { deferAfterFirstPaint, getProfile, refreshAuthUiShell } from './authShell.js';

export const resolveActiveApartment = async (uid, profile) => {
    if (!supabase || !uid) return { apartments: [], activeId: null, apartmentIds: [] };
    console.group('[Access] Resolving active apartment');

    const { data: mappings, error: mapError } = await withTimeout(
        supabase
            .from('user_apartments')
            .select('apartment_id')
            .eq('user_id', uid),
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

    console.log('Pool:', pool);

    if (!pool.length) {
        console.error('[access] No apartments in pool for user', uid);
        console.groupEnd();
        return { apartments: [], activeId: null, apartmentIds: [] };
    }

    const cur = portalState.access?.activeApartmentId;
    if (cur && !isPlaceholderApartmentId(cur) && pool.some((a) => a.id === cur)) {
        console.log('Using current:', cur);
        console.groupEnd();
        return { apartments: pool, activeId: cur, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
    }

    const last = profile?.last_apartment_id;
    if (last && pool.some((a) => a.id === last)) {
        console.log('Using last profile apt:', last);
        console.groupEnd();
        return { apartments: pool, activeId: last, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
    }

    const preferred = pool.find((a) => /elixir/i.test(a.name || ''));
    if (preferred) {
        console.log('Using preferred (Elixir):', preferred.id);
        console.groupEnd();
        return { apartments: pool, activeId: preferred.id, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
    }

    const cachedName = (portalState.community?.name || '').trim().toLowerCase();
    if (cachedName && cachedName !== 'communityhub' && cachedName !== 'offline') {
        const byName = pool.find((a) => (a.name || '').trim().toLowerCase() === cachedName);
        if (byName) {
            console.log('Using cached name match:', byName.id);
            console.groupEnd();
            return { apartments: pool, activeId: byName.id, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
        }
    }

    console.log('Using first in pool:', pool[0].id);
    console.groupEnd();
    return { apartments: pool, activeId: pool[0].id, apartmentIds: mappedIds.length ? mappedIds : pool.map((a) => a.id) };
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

export const setActiveApartment = async (apartmentId) => {
    if (isPlaceholderApartmentId(apartmentId)) {
        console.warn('[access] Ignoring placeholder apartment id');
        return false;
    }
    console.group('[Access] Setting active apartment:', apartmentId);

    let apt = portalState.access?.apartments?.find((a) => a.id === apartmentId);
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
    resetLoadedDomains();

    const headerSelect = document.getElementById('header-apartment-switch');
    if (headerSelect) headerSelect.value = apartmentId;

    persist();

    if (supabase) {
        const { data: s } = await supabase.auth.getSession();
        if (s?.session?.user?.id) {
            await supabase.from('profiles').update({ last_apartment_id: apartmentId }).eq('id', s.session.user.id);
        }
    }

    console.log('Pulling core state for apartment...');
    const success = await pullState({ domain: 'core' });
    console.log('Pull State Success:', success);
    if (success) {
        const roleAssignments = await loadAllUserRoleAssignmentsCached(portalState.auth?.id);
        await refreshAuthPermissions(apartmentId, roleAssignments);
        applyNavPermissions(new Set(portalState.authPermissions || []));
        deferAfterFirstPaint(async () => {
            try {
                await autoLinkResidentByEmail();
                await acceptPendingInvites();
            } catch { /* non-blocking */ }
            refreshStaffNotifications().catch(() => {});
        });
        document.dispatchEvent(new CustomEvent('apartment-data-loaded'));
        renderAccessMappings();
        if (document.getElementById('view-dashboard')?.classList.contains('active')) {
            void renderDashboard();
        }
        if (document.getElementById('view-setup')?.classList.contains('active')) {
            void renderApartmentModulePanel();
        }
        if (typeof window.renderCashLedger === 'function') window.renderCashLedger();
        if (typeof window.renderFinanceAnalytics === 'function') window.renderFinanceAnalytics();
        if (typeof window.renderInvoicesPage === 'function') window.renderInvoicesPage();
    }
    console.groupEnd();
    return success;
};

export const syncAccessFromSupabase = async (profileOverride = null) => {
    if (!supabase) return false;
    const { data: sessionData } = await supabase.auth.getSession();
    const uid = sessionData?.session?.user?.id;
    if (!uid) return false;

    ensureAccessState();
    clearRoleAssignmentsCache();

    const selfProfile = profileOverride || await getProfile(uid);
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

    const { apartments, activeId, apartmentIds } = await resolveActiveApartment(uid, selfProfile);
    if (!apartments.length || !activeId) {
        console.error('[access] No apartments available for this user', { apartments: apartments.length, activeId, uid });
        renderAccessMappings();
        return false;
    }

    portalState.access.apartments = apartments;
    portalState.access.activeApartmentId = activeId;
    if (portalState.access.users?.length && apartmentIds?.length) {
        portalState.access.users[0].apartment_ids = apartmentIds;
    }

    const loaded = await setActiveApartment(activeId);
    if (!loaded) {
        console.error('[access] setActiveApartment failed for', activeId, portalState.lastPullMeta);
        renderAccessMappings();
        return false;
    }

    const roleAssignments = await loadAllUserRoleAssignmentsCached(uid);
    if (portalState.auth) {
        if (portalState.auth.isSystemAdmin) {
            portalState.auth.effectiveRoleKey = 'system_admin';
            portalState.auth.role = 'admin';
        } else {
            const aptAssignment = roleAssignments.find((a) => a.scope === 'apartment' && a.apartment_id === activeId);
            if (aptAssignment?.role_key) {
                portalState.auth.effectiveRoleKey = aptAssignment.role_key;
                portalState.auth.role = ROLE_OPTIONS.find((r) => r.key === aptAssignment.role_key)?.v1Key || portalState.auth.role;
            }
        }
    }
    refreshAuthUiShell();

    persist();
    renderAccessMappings();
    deferAfterFirstPaint(() => loadAccessUserDirectory(activeId, uid));
    return true;
};
