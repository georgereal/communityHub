/**
 * Sign-in path: resident portal vs office staff.
 * Stored in sessionStorage so the workspace gate knows which access flow to use.
 */
export const AUTH_USER_KIND_KEY = 'communityhub_auth_user_kind';

/** @typedef {'resident' | 'office'} AuthUserKind */

/** @returns {AuthUserKind} */
export function getAuthUserKind() {
    try {
        const v = sessionStorage.getItem(AUTH_USER_KIND_KEY);
        return v === 'office' ? 'office' : 'resident';
    } catch {
        return 'resident';
    }
}

/** @param {AuthUserKind} kind */
export function setAuthUserKind(kind) {
    try {
        sessionStorage.setItem(AUTH_USER_KIND_KEY, kind === 'office' ? 'office' : 'resident');
    } catch {
        /* ignore */
    }
}

export function clearAuthUserKind() {
    try {
        sessionStorage.removeItem(AUTH_USER_KIND_KEY);
    } catch {
        /* ignore */
    }
}

export function isOfficeAuthKind() {
    return getAuthUserKind() === 'office';
}

export const AUTH_KIND_LABELS = {
    resident: 'Resident',
    office: 'Office staff',
};

/** Placeholder until society admin assigns a real role on approval. */
export const OFFICE_PENDING_ROLE_KEY = 'office_pending';
