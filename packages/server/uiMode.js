/** UI mode — production is New MPAs only (classic SPA archived). */

export function requestUiMode(_req) {
    return 'new';
}

export function isNewUiRequest(_req) {
    return true;
}
