/** Per-view activation — dynamic imports keep feature code out of the initial bundle. */

export async function activateView(route, page) {
    const view = page.view;
    const sub = page.subview || '';

    switch (view) {
        case 'dashboard': {
            const { renderDashboard } = await import('../dashboard.js');
            await renderDashboard();
            break;
        }
        case 'registry': {
            const { renderRegistry, refreshParkingUi } = await import('../registry.js');
            const { refreshAuditBadge } = await import('../vehicleAudit.js');
            renderRegistry();
            refreshParkingUi();
            void refreshAuditBadge();
            break;
        }
        case 'accounts': {
            const { syncAccountsSubViewTabs, processFinances, renderCashLedger } = await import('../finances.js');
            const { renderFinanceAnalytics } = await import('../financeAnalytics.js');
            const { renderBankReconciliation } = await import('../bankReconciliation.js');
            const { renderActivityLogPage } = await import('../activityAudit.js');
            const { renderGeneralLedger } = await import('../generalLedger.js');
            const { renderLedgerSyncPanel } = await import('../ledgerSpreadsheetSync.js');

            syncAccountsSubViewTabs(route);
            if (typeof window.switchSubView === 'function') {
                window.switchSubView(sub || 'ledger');
            }
            if (sub === 'reports') renderFinanceAnalytics();
            else if (sub === 'bank-recon') renderBankReconciliation();
            else if (sub === 'activity') await renderActivityLogPage();
            else if (sub === 'gl') renderGeneralLedger();
            else {
                processFinances();
                renderCashLedger();
                renderLedgerSyncPanel();
            }
            break;
        }
        case 'parking-fines': {
            const { renderParkingViolations, refreshParkingUi } = await import('../parkingOps.js');
            renderParkingViolations();
            refreshParkingUi();
            break;
        }
        case 'portfolio': {
            const { renderPortfolioRollup } = await import('../portfolio.js');
            await renderPortfolioRollup();
            break;
        }
        case 'email': {
            const { renderEmailOutbox } = await import('../emailOutbox.js');
            renderEmailOutbox();
            break;
        }
        case 'access-control': {
            const { renderAccessControlAdmin } = await import('../accessControlAdmin.js');
            await renderAccessControlAdmin();
            break;
        }
        case 'invoices': {
            if (typeof window.switchInvoiceSubView === 'function') {
                window.switchInvoiceSubView(sub || 'pending-dues');
            }
            break;
        }
        case 'portal': {
            document.querySelectorAll('.portal-subview').forEach((el) => {
                el.hidden = el.id !== `portal-subview-${sub}`;
            });
            const { renderPortalSubview } = await import('../residentPortal.js');
            await renderPortalSubview(sub || 'home');
            break;
        }
        case 'security': {
            document.querySelectorAll('.security-subview').forEach((el) => {
                el.hidden = el.id !== `security-subview-${sub}`;
            });
            const { renderSecuritySubview } = await import('../securityPortal.js');
            await renderSecuritySubview(sub || 'gate');
            break;
        }
        case 'operations': {
            if (typeof window.switchOperationsSubView === 'function') {
                window.switchOperationsSubView(sub || 'helpdesk');
            }
            break;
        }
        case 'setup': {
            const { portalState } = await import('../store.js');
            const { renderAccessMappings } = await import('../mainBoot.js');
            const { renderResidentLinksAdmin } = await import('../residentLinks.js');
            const { renderApartmentModulePanel } = await import('../moduleAccessAdmin.js');
            const { switchSetupSubView } = await import('../admin.js');

            const nameEl = document.getElementById('setup-name');
            const carEl = document.getElementById('setup-car');
            const bikeEl = document.getElementById('setup-bike');
            if (nameEl) nameEl.value = portalState.community.name;
            if (carEl) carEl.value = portalState.community.defaults.cars;
            if (bikeEl) bikeEl.value = portalState.community.defaults.bikes;
            renderAccessMappings();
            void renderResidentLinksAdmin();
            void renderApartmentModulePanel();
            const { renderAccessRequestsAdmin } = await import('../accessRequests.js');
            void renderAccessRequestsAdmin();
            switchSetupSubView(sub || 'society');
            break;
        }
        case 'apartment': {
            const { renderResidents } = await import('../mainBoot.js');
            renderResidents();
            break;
        }
        case 'units': {
            const { renderUnitDirectory } = await import('../unitDirectory.js');
            await renderUnitDirectory();
            break;
        }
        default:
            break;
    }
}
