/** Auth profile + topbar/sidebar UI refresh (no imports from main.js). */

import { portalState, supabase, withTimeout } from './store.js';
import { ROLE_OPTIONS, v2KeyToLabel, resolveEffectivePermissions, v1RoleToV2Key } from './rbac.js';
import { applyNavPermissions } from './navigation.js';

let cachedProfile = null;

export const getProfile = async (userId, { useCache = true } = {}) => {
    if (!supabase || !userId) return null;
    if (useCache && cachedProfile?.id === userId) return cachedProfile;
    try {
        const { data, error } = await withTimeout(
            supabase
                .from('profiles')
                .select('id, full_name, role, email, last_apartment_id')
                .eq('id', userId)
                .maybeSingle(),
            15000,
            'Profile load',
        );
        if (error) {
            console.warn('[Auth] Profile fetch error:', error.message);
            return null;
        }
        if (data) cachedProfile = data;
        return data;
    } catch (err) {
        console.warn('[Auth] Profile fetch failed:', err.message);
        return null;
    }
};

export const clearCachedProfile = () => {
    cachedProfile = null;
};

export const deferAfterFirstPaint = (fn, timeoutMs = 8000) => {
    const run = () => { void fn(); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: timeoutMs });
    else setTimeout(run, 250);
};

export const formatRoleLabel = (role) => {
    const byKey = ROLE_OPTIONS.find((r) => r.key === role);
    if (byKey) return byKey.label;
    // Legacy profiles.role = 'admin' must not resolve to System Administrator
    const key = v1RoleToV2Key(role);
    return ROLE_OPTIONS.find((r) => r.key === key)?.label
        || v2KeyToLabel(key)
        || String(role || 'Viewer').replace(/_/g, ' ');
};

export const refreshAuthUiShell = () => {
    const auth = portalState.auth;
    if (!auth?.id) return;
    const name = auth.name || auth.email || 'User';
    const initials = (name || 'U').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
    const roleLabel = formatRoleLabel(auth.effectiveRoleKey || auth.role);
    const topbarInitialsNode = document.getElementById('topbar-user-initials');
    const topbarNameNode = document.getElementById('topbar-user-name');
    const topbarRoleNode = document.getElementById('topbar-user-role');
    const sidebarInitials = document.getElementById('sidebar-user-initials');
    const sidebarName = document.getElementById('sidebar-user-name');
    const sidebarRole = document.getElementById('sidebar-user-role');
    if (topbarInitialsNode) topbarInitialsNode.textContent = initials;
    if (sidebarInitials) sidebarInitials.textContent = initials;
    if (topbarNameNode) topbarNameNode.textContent = name;
    if (sidebarName) sidebarName.textContent = name;
    if (topbarRoleNode) topbarRoleNode.textContent = roleLabel;
    if (sidebarRole) sidebarRole.textContent = roleLabel;
    applyNavPermissions(new Set(portalState.authPermissions || resolveEffectivePermissions()), !supabase);
};
