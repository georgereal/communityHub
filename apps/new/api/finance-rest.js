/**
 * Top-level Vercel function for Finance-New REST.
 * Nested `api/finance/[...path].js` is often omitted from Vite deployments
 * (platform 404 HTML). Rewrites in vercel.json send /api/finance/* here.
 */
export { default } from './finance/[...path].js';
