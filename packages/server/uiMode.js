/** UI mode from `ch_ui_mode` cookie (same as `src/uiMode.js`). Default is New. */

const COOKIE = 'ch_ui_mode';

function parseCookies(cookieHeader = '') {
    return Object.fromEntries(
        String(cookieHeader || '')
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const idx = part.indexOf('=');
                if (idx < 0) return [part, ''];
                return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
            }),
    );
}

export function requestUiMode(req) {
    const cookies = parseCookies(req?.headers?.cookie || '');
    const raw = String(cookies[COOKIE] || '').trim();
    return raw === 'classic' ? 'classic' : 'new';
}

export function isNewUiRequest(req) {
    return requestUiMode(req) !== 'classic';
}
