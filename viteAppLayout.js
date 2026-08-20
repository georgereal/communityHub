/**
 * One Vercel project, two apps:
 *   apps/classic — SPA to phase out (public URL /)
 *   apps/new     — MPAs to keep building (public URL /home, /admin, …; alias /new/…)
 *
 * HTML lives next to each app. Build emits the public URLs so classic and new
 * share the same origin until classic is retired. Then set Vite `base: '/new/'`
 * and point MPA_ROUTE_PATHS at /new/home etc.
 */
import { resolve, dirname, join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';

const root = process.cwd();

export const HTML_ENTRIES = {
    main: { src: 'apps/classic/index.html', out: 'index.html' },
    login: { src: 'packages/auth/login.html', out: 'login.html' },
    microsoftAuth: { src: 'packages/auth/microsoft-auth.html', out: 'microsoft-auth.html' },
    home: { src: 'apps/new/pages/home/index.html', out: 'home/index.html' },
    admin: { src: 'apps/new/pages/admin/index.html', out: 'admin/index.html' },
    residents: { src: 'apps/new/pages/residents/index.html', out: 'residents/index.html' },
    parking: { src: 'apps/new/pages/parking/index.html', out: 'parking/index.html' },
    units: { src: 'apps/new/pages/units/index.html', out: 'units/index.html' },
    financeLedger: { src: 'apps/new/pages/finance/ledger.html', out: 'finance/ledger.html' },
    financeReports: { src: 'apps/new/pages/finance/reports.html', out: 'finance/reports.html' },
    financeDocs: { src: 'apps/new/pages/finance/docs.html', out: 'finance/docs.html' },
    financeExpensePlan: { src: 'apps/new/pages/finance/expense-plan.html', out: 'finance/expense-plan.html' },
    financeInvoicesRaised: { src: 'apps/new/pages/finance/invoices-raised.html', out: 'finance/invoices-raised.html' },
    financeBankRecon: { src: 'apps/new/pages/finance/bank-recon.html', out: 'finance/bank-recon.html' },
};

export function htmlInputMap() {
    return Object.fromEntries(
        Object.entries(HTML_ENTRIES).map(([key, { src }]) => [key, resolve(root, src)]),
    );
}

const SPA_PREFIX_TO_FILE = [
    ['/home', '/apps/new/pages/home/index.html'],
    ['/admin', '/apps/new/pages/admin/index.html'],
    ['/residents', '/apps/new/pages/residents/index.html'],
    ['/parking', '/apps/new/pages/parking/index.html'],
    ['/units', '/apps/new/pages/units/index.html'],
];

function stripNewPrefix(pathname) {
    if (pathname === '/new' || pathname === '/new/') return '/home/';
    if (pathname.startsWith('/new/')) return pathname.slice(4);
    return pathname;
}

function spaFileForPath(pathname) {
    for (const [prefix, file] of SPA_PREFIX_TO_FILE) {
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return file;
    }
    return null;
}

/** Rewrite public URLs in Vite dev to HTML files under apps/*. */
export function rewriteDevHtmlUrl(url) {
    const raw = url || '';
    const qIndex = raw.indexOf('?');
    const pathOnly = (qIndex === -1 ? raw : raw.slice(0, qIndex)).split('#')[0];
    const q = qIndex === -1 ? '' : raw.slice(qIndex);
    if (pathOnly.startsWith('/api/') || pathOnly.startsWith('/assets/') || pathOnly.startsWith('/@') || pathOnly.startsWith('/node_modules')) {
        return null;
    }
    if (pathOnly === '/login.html') return `/packages/auth/login.html${q}`;
    if (pathOnly === '/microsoft-auth.html') return `/packages/auth/microsoft-auth.html${q}`;
    if (pathOnly === '/login' || pathOnly.startsWith('/login?')) return null;

    if (pathOnly === '/' || pathOnly === '/index.html') {
        return `/apps/classic/index.html${q}`;
    }

    const publicPath = stripNewPrefix(pathOnly);

    if (publicPath.startsWith('/finance/') && publicPath.endsWith('.html')) {
        return `/apps/new/pages${publicPath}${q}`;
    }

    const pathNoSlash = publicPath.replace(/\/$/, '') || '/';
    const spaPath = pathNoSlash.endsWith('/index.html')
        ? pathNoSlash.slice(0, -'/index.html'.length)
        : pathNoSlash;
    const spa = spaFileForPath(spaPath);
    if (spa && (!spaPath.includes('.') || pathNoSlash.endsWith('/index.html'))) {
        return `${spa}${q}`;
    }
    return null;
}

export function flattenHtmlPlugin() {
    return {
        name: 'flatten-app-html',
        apply: 'build',
        writeBundle() {
            const dist = join(root, 'dist');
            for (const { src, out } of Object.values(HTML_ENTRIES)) {
                if (src === out) continue;
                const from = join(dist, src);
                const to = join(dist, out);
                if (!existsSync(from)) continue;
                mkdirSync(dirname(to), { recursive: true });
                renameSync(from, to);
            }
        },
    };
}

export function appHtmlDevPlugin() {
    return {
        name: 'app-html-dev-paths',
        configureServer(server) {
            server.middlewares.use((req, _res, next) => {
                const nextUrl = rewriteDevHtmlUrl(req.url || '');
                if (nextUrl) req.url = nextUrl;
                next();
            });
        },
    };
}
