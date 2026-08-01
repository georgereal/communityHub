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
            const { renderRegistry } = await import('../registry.js');
            const { refreshParkingUi } = await import('../parkingOps.js');
            const { refreshAuditBadge } = await import('../vehicleAudit.js');
            const { initParkingReconcileUi } = await import('../parkingReconcileUi.js');
            initParkingReconcileUi();
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
            const { renderLedgerSyncPanel } = await import('../ledgerSpreadsheetSync.js');

            syncAccountsSubViewTabs(route);
            if (typeof window.switchSubView === 'function') {
                window.switchSubView(sub || 'ledger');
            }
            if (sub === 'reports') renderFinanceAnalytics();
            else if (sub === 'finance-docs') {
                const { initFinanceDocumentsPage, renderFinanceDocumentsPage } = await import('../financeDocuments.js');
                initFinanceDocumentsPage();
                renderFinanceDocumentsPage();
            }
            else if (sub === 'expense-plan') {
                const { initExpensePlanPage, renderExpensePlanPage } = await import('../expensePlan.js');
                initExpensePlanPage();
                renderExpensePlanPage();
            }
            else if (sub === 'invoices-raised') {
                const { initInvoicesRaisedPage, renderInvoicesRaisedPage } = await import('../invoicesRaisedPage.js');
                initInvoicesRaisedPage();
                renderInvoicesRaisedPage();
            }
            else if (sub === 'bank-recon') renderBankReconciliation();
            else if (sub === 'activity') await renderActivityLogPage();
            else {
                processFinances();
                renderCashLedger();
                renderLedgerSyncPanel();
            }

            // Finance/admin may finish after first paint (boot gate / parallel loads).
            if (!window.__accountsDomainRefreshWired) {
                window.__accountsDomainRefreshWired = true;
                document.addEventListener('domain-data-loaded', (e) => {
                    if (!document.getElementById('view-accounts')?.classList.contains('active')) return;
                    const d = e.detail?.domain;
                    if (d !== 'finance' && d !== 'admin') return;
                    processFinances();
                    if (document.getElementById('cash-ledger-items')) renderCashLedger();
                    renderLedgerSyncPanel();
                });
            }
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
        case 'setup': {
            const { portalState } = await import('../store.js');
            const { renderAccessMappings } = await import('../mainBoot.js');
            const { renderResidentLinksAdmin } = await import('../residentLinks.js');
            const { renderApartmentModulePanel } = await import('../moduleAccessAdmin.js');
            const { switchSetupSubView } = await import('../admin.js');
            const { loadAccessUserDirectory } = await import('../accessSync.js');

            const nameEl = document.getElementById('setup-name');
            const carEl = document.getElementById('setup-car');
            const bikeEl = document.getElementById('setup-bike');
            if (nameEl) nameEl.value = portalState.community.name;
            if (carEl) carEl.value = portalState.community.defaults.cars;
            if (bikeEl) bikeEl.value = portalState.community.defaults.bikes;
            const aptId = portalState.access?.activeApartmentId;
            const uid = portalState.auth?.id;
            if (aptId && uid) void loadAccessUserDirectory(aptId, uid);
            renderAccessMappings();
            void renderResidentLinksAdmin();
            void renderApartmentModulePanel();
            const { renderAccessRequestsAdmin } = await import('../accessRequests.js');
            void renderAccessRequestsAdmin();
            switchSetupSubView(sub || 'society');
            break;
        }
        case 'access-control': {
            const { portalState } = await import('../store.js');
            const { loadAccessUserDirectory } = await import('../accessSync.js');
            const { renderPageAccessAdmin } = await import('../pageAccessAdmin.js');
            const aptId = portalState.access?.activeApartmentId;
            const uid = portalState.auth?.id;
            if (aptId && uid) await loadAccessUserDirectory(aptId, uid);
            await renderPageAccessAdmin();
            break;
        }
        case 'invoices': {
            const { renderInvoicesPage } = await import('../maintenanceBilling.js');
            if (typeof window.switchInvoiceSubView === 'function') {
                window.switchInvoiceSubView(sub || 'pending-dues');
            } else {
                renderInvoicesPage();
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
