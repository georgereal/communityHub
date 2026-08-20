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

export function goToLogin(msg = '', { next } = {}) {
    try {
        if (msg) sessionStorage.setItem(AUTH_FLASH_KEY, String(msg));
    } catch { /* ignore */ }
    if (isLoginPath()) {
        window.dispatchEvent(new CustomEvent('auth-flash', { detail: { message: msg || '' } }));
        return;
    }
    const params = new URLSearchParams();
    const nextPath = next || `${window.location.pathname}${window.location.search || ''}`;
    if (nextPath && nextPath !== '/' && !isLoginPath(nextPath.split('?')[0])) {
        params.set('next', nextPath);
    }
    const q = params.toString();
    window.location.assign(`/login.html${q ? `?${q}` : ''}`);
}

/** Safe post-login destination from ?next= (same-origin path only). */
export function consumeLoginNext() {
    try {
        const params = new URLSearchParams(window.location.search);
        const next = params.get('next') || '';
        if (!next.startsWith('/') || next.startsWith('//')) return null;
        if (next.startsWith('/login')) return null;
        return next;
    } catch {
        return null;
    }
}

export function goToApp(hash = '') {
    const next = consumeLoginNext();
    if (next) {
        window.location.assign(next);
        return;
    }
    const h = hash && !hash.startsWith('#') ? `#${hash}` : (hash || '');
    window.location.assign(`/${h}`);
}
