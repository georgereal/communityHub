/**
 * Vendor display name formatting — Title Case (start caps, rest lower).
 * Keeps common business acronyms uppercase.
 */

const VENDOR_ACRONYMS = new Set([
    'llp', 'pvt', 'ltd', 'llc', 'opc', 'gst', 'dg', 'upi', 'neft', 'rtgs', 'imps',
    'bescom', 'bwssb', 'act',
]);

function titleCaseToken(token) {
    if (!token) return token;
    const lower = token.toLowerCase();
    const bare = lower.replace(/\./g, '');
    if (VENDOR_ACRONYMS.has(bare)) {
        return bare === 'pvt' || bare === 'llp' || bare === 'ltd' || bare === 'llc' || bare === 'opc'
            ? bare.toUpperCase()
            : bare.toUpperCase();
    }
    // Digits / codes like 9w → 9W style for leading number+letter
    if (/^\d+[a-z]+$/i.test(token)) {
        return token.replace(/^(\d+)([a-z]+)$/i, (_, n, letters) => n + letters.toUpperCase());
    }
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * "siddeshwar electrical - spares" → "Siddeshwar Electrical - Spares"
 * "AIRTEL WIFI" → "Airtel Wifi"
 */
export function titleCaseVendor(name) {
    const raw = String(name || '').trim().replace(/\s+/g, ' ');
    if (!raw) return '';
    return raw
        .split(/(\s+|-)/)
        .map((part) => {
            if (!part || /^\s+$/.test(part) || part === '-') return part;
            return titleCaseToken(part);
        })
        .join('');
}
