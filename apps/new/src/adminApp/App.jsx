import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ADMIN_PAGES, adminPageFromPathname } from './pages.js';
import SocietyPage from './pages/SocietyPage.jsx';
import PeoplePage from './pages/PeoplePage.jsx';
import VendorsPage from './pages/VendorsPage.jsx';
import CategoriesPage from './pages/CategoriesPage.jsx';
import StaffPage from './pages/StaffPage.jsx';
import IntegrationsPage from './pages/IntegrationsPage.jsx';
import RolesPage from './pages/RolesPage.jsx';

const PAGE_COMPONENTS = {
    'an-society': SocietyPage,
    'an-people': PeoplePage,
    'an-vendors': VendorsPage,
    'an-categories': CategoriesPage,
    'an-staff': StaffPage,
    'an-integrations': IntegrationsPage,
    'an-roles': RolesPage,
};

function InAppNav() {
    const navigate = useNavigate();
    useEffect(() => {
        const onNav = (e) => {
            const href = String(e.detail?.href || '');
            if (!href) return;
            const pathOnly = href.split('?')[0].split('#')[0];
            // Cross-app: always full document load — never history API.
            if (!pathOnly.startsWith('/admin')) {
                void import('../appShell/forceDocumentNav.js').then((m) => {
                    m.forceDocumentNavigation(href);
                });
                return;
            }
            let path = pathOnly.replace(/^\/admin/, '') || '/';
            if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
            navigate(path || '/');
        };
        window.addEventListener('ch-mpa-inapp-nav', onNav);
        return () => window.removeEventListener('ch-mpa-inapp-nav', onNav);
    }, [navigate]);
    return null;
}

function ShellSync() {
    const loc = useLocation();
    useEffect(() => {
        const page = adminPageFromPathname(`/admin${loc.pathname === '/' ? '/society' : loc.pathname}`);
        const pageEl = document.getElementById('topbar-nav-page');
        const modEl = document.getElementById('topbar-nav-module');
        if (pageEl) pageEl.textContent = page.label;
        if (modEl) {
            const ops = ['an-vendors', 'an-categories'].includes(page.route);
            modEl.textContent = ops ? 'Operations' : 'Administration';
        }
        document.title = `${page.label} · CommunityHub`;
        import('../appShell/nav.js').then((m) => m.setActiveNavRoute?.(page.route));
    }, [loc.pathname]);
    return null;
}

export default function AdminApp() {
    return (
        <BrowserRouter basename="/admin">
            <InAppNav />
            <ShellSync />
            <Routes>
                <Route path="/" element={<Navigate to="/society" replace />} />
                <Route path="/portal" element={<Navigate to="/people" replace />} />
                <Route path="/bank" element={<Navigate to="/society" replace />} />
                {ADMIN_PAGES.map((p) => {
                    const Cmp = PAGE_COMPONENTS[p.route];
                    return <Route key={p.route} path={p.path} element={<Cmp />} />;
                })}
                <Route path="*" element={<Navigate to="/society" replace />} />
            </Routes>
        </BrowserRouter>
    );
}

export { ADMIN_PAGES };
