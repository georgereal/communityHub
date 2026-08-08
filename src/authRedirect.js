/** Shared redirects between the main app and `/login`. */

export const AUTH_FLASH_KEY = 'communityhub_auth_flash';

export function isLoginPath(pathname = window.location.pathname) {
    const p = String(pathname || '').replace(/\/+$/, '') || '/';
    return p === '/login' || p === '/login.html';
}

export function takeAuthFlash() {
    try {
        const msg = sessionStorage.getItem(AUTH_FLASH_KEY) || '';
        sessionStorage.removeItem(AUTH_FLASH_KEY);
        return msg;
    } catch {
        return '';
    }
}

export function goToLogin(msg = '') {
    try {
        if (msg) sessionStorage.setItem(AUTH_FLASH_KEY, String(msg));
    } catch { /* ignore */ }
    if (isLoginPath()) {
        window.dispatchEvent(new CustomEvent('auth-flash', { detail: { message: msg || '' } }));
        return;
    }
    window.location.assign('/login');
}

export function goToApp(hash = '') {
    const h = hash && !hash.startsWith('#') ? `#${hash}` : (hash || '');
    window.location.assign(`/${h}`);
}
