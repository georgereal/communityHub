/**
 * Identity / admin domain — RBAC, workspace boot, home dashboard KPIs.
 * vercel.json rewrites keep legacy URLs (/api/rbac-mongo, /api/new/workspace-boot, …).
 */
import rbacMongo from './rbac-mongo.js';
import workspaceBoot from './workspace-boot.js';
import dashboardSummary from './dashboard-summary.js';

function identityPathFromReq(req) {
    const rewritten = req.query?.__identityPath;
    if (typeof rewritten === 'string' && rewritten) {
        return rewritten.replace(/^\/+|\/+$/g, '');
    }
    try {
        const raw = req.url || '';
        const u = new URL(raw.startsWith('http') ? raw : `http://local${raw}`);
        const path = u.pathname.replace(/\/+$/, '');
        if (path.endsWith('/rbac-mongo') || path.includes('/identity/rbac')) return 'rbac';
        if (path.endsWith('/workspace-boot') || path.includes('/identity/workspace-boot')) {
            return 'workspace-boot';
        }
        if (path.endsWith('/dashboard-summary') || path.includes('/identity/dashboard-summary')) {
            return 'dashboard-summary';
        }
        const idx = path.indexOf('/api/identity/');
        if (idx >= 0) {
            return path.slice(idx + '/api/identity/'.length).split('/').filter(Boolean).join('/');
        }
    } catch { /* ignore */ }
    return '';
}

export default async function handler(req, res) {
    const path = identityPathFromReq(req);
    if (path === 'rbac' || path === 'rbac-mongo') {
        return rbacMongo(req, res);
    }
    if (path === 'workspace-boot' || path === 'new/workspace-boot') {
        return workspaceBoot(req, res);
    }
    if (path === 'dashboard-summary' || path === 'dashboard') {
        return dashboardSummary(req, res);
    }
    return res.status(404).json({
        error: `No route for identity path "${path || '(empty)'}".`,
    });
}
