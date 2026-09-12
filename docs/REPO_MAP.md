# CommunityHub / ApartmentMaintenance — Repository Map

> **Project:** ApartmentMaintenance (CommunityHub) — two apps, one Vercel project.
> **Shared (platform):** thin `api/*.js` re-exports for Vercel, plus `packages/auth` and `packages/server`.
> **Classic (archived):** `classic/src`, `classic/api`, `classic/sql` — not deployed on Vercel.
> **New (production):** `apps/new/src`, `apps/new/api`, `apps/new/pages`.
> **Shared:** `packages/auth`, `packages/server`, root `api/*.js` (Mongo REST + storage).

---

## 1. Repository Overview

```
├── .cursor
│   └── rules
│       └── ux-list-pages.mdc
├── .github
│   └── workflows
│       └── repo-map-check.yml
├── api
│   ├── activity-rest.js
│   ├── auth-rest.js
│   ├── finance-rest.js
│   ├── identity-rest.js
│   ├── integrations-rest.js
│   ├── passbook-webhook.js
│   ├── property-rest.js
│   └── storage.js
├── apps
│   └── new
│       ├── api
│       │   ├── activityMongo
│       │   │   ├── routes
│       │   │   │   └── events.js
│       │   │   ├── activityStore.js
│       │   │   ├── errors.js
│       │   │   ├── http.js
│       │   │   ├── indexes.js
│       │   │   └── permissions.js
│       │   ├── finance
│       │   │   └── [...path].js
│       │   ├── financeMongo
│       │   │   ├── services
│       │   │   │   ├── ledgerMutations.js
│       │   │   │   └── ledgerReads.js
│       │   │   ├── validation
│       │   │   │   └── ledger.js
│       │   │   ├── errors.js
│       │   │   ├── index.js
│       │   │   ├── money.js
│       │   │   └── permissions.js
│       │   ├── integrationsMongo
│       │   │   ├── routes
│       │   │   │   ├── passbook
│       │   │   │   │   ├── jobs
│       │   │   │   │   │   └── [id]
│       │   │   │   │   │       └── imported.js
│       │   │   │   │   └── jobs.js
│       │   │   │   ├── spreadsheet
│       │   │   │   │   ├── boot.js
│       │   │   │   │   ├── oauth-apps.js
│       │   │   │   │   ├── oauth-connections.js
│       │   │   │   │   ├── runs.js
│       │   │   │   │   └── settings.js
│       │   │   │   └── connections.js
│       │   │   ├── connectionsStore.js
│       │   │   ├── errors.js
│       │   │   ├── evolyxWorkflow.js
│       │   │   ├── http.js
│       │   │   ├── indexes.js
│       │   │   ├── passbookJobsStore.js
│       │   │   ├── passbookMap.js
│       │   │   ├── passbookService.js
│       │   │   ├── permissions.js
│       │   │   └── spreadsheetStore.js
│       │   ├── propertyMongo
│       │   │   ├── routes
│       │   │   │   ├── residents
│       │   │   │   │   ├── [id].js
│       │   │   │   │   └── import.js
│       │   │   │   ├── slots
│       │   │   │   │   ├── [id]
│       │   │   │   │   │   ├── assign.js
│       │   │   │   │   │   └── release.js
│       │   │   │   │   └── [id].js
│       │   │   │   ├── units
│       │   │   │   │   ├── [id].js
│       │   │   │   │   ├── import.js
│       │   │   │   │   └── parking-limits.js
│       │   │   │   ├── vehicles
│       │   │   │   │   ├── [id].js
│       │   │   │   │   └── import.js
│       │   │   │   ├── residents.js
│       │   │   │   ├── slots.js
│       │   │   │   ├── state.js
│       │   │   │   ├── units.js
│       │   │   │   └── vehicles.js
│       │   │   ├── audit.js
│       │   │   ├── errors.js
│       │   │   ├── http.js
│       │   │   ├── models.js
│       │   │   ├── mongoose.js
│       │   │   ├── permissions.js
│       │   │   └── service.js
│       │   ├── rbacMongo
│       │   │   ├── defaults.js
│       │   │   └── service.js
│       │   ├── activity-rest.js
│       │   ├── auth-rest.js
│       │   ├── dashboard-summary.js
│       │   ├── evolyxConnection.js
│       │   ├── external-connections.js
│       │   ├── external-proxy.js
│       │   ├── finance-mongo-mutations.js
│       │   ├── finance-mongo-reports.js
│       │   ├── finance-mongo.js
│       │   ├── finance-rest.js
│       │   ├── identity-rest.js
│       │   ├── integrations-rest.js
│       │   ├── passbook-jobs.js
│       │   ├── passbook-parse.js
│       │   ├── passbook-webhook.js
│       │   ├── passbookJobsStore.js
│       │   ├── property-rest.js
│       │   ├── rbac-mongo.js
│       │   └── workspace-boot.js
│       ├── pages
│       │   ├── admin
│       │   │   └── index.html
│       │   ├── finance
│       │   │   ├── bank-recon.html
│       │   │   ├── docs.html
│       │   │   ├── expense-plan.html
│       │   │   ├── invoices-raised.html
│       │   │   ├── ledger.html
│       │   │   └── reports.html
│       │   ├── home
│       │   │   └── index.html
│       │   ├── parking
│       │   │   └── index.html
│       │   ├── residents
│       │   │   └── index.html
│       │   └── units
│       │       └── index.html
│       └── src
│           ├── adminApp
│           │   ├── components
│           │   │   ├── PageHeader.jsx
│           │   │   └── SummaryStrip.jsx
│           │   ├── pages
│           │   │   ├── ActivityPage.jsx
│           │   │   ├── BankPage.jsx
│           │   │   ├── CategoriesPage.jsx
│           │   │   ├── IntegrationsPage.jsx
│           │   │   ├── PeoplePage.jsx
│           │   │   ├── RolesPage.jsx
│           │   │   ├── SocietyPage.jsx
│           │   │   ├── SpreadsheetSyncDialog.jsx
│           │   │   ├── StaffPage.jsx
│           │   │   └── VendorsPage.jsx
│           │   ├── admin-app.css
│           │   ├── api.js
│           │   ├── App.jsx
│           │   ├── boot.js
│           │   ├── main.jsx
│           │   ├── mount.jsx
│           │   └── pages.js
│           ├── appShell
│           │   ├── html
│           │   │   ├── boot-splash.html
│           │   │   └── layout.html
│           │   ├── chrome.js
│           │   ├── ensureChartJs.js
│           │   ├── forceDocumentNav.js
│           │   ├── mount.js
│           │   ├── mpaAuth.js
│           │   ├── mpaSession.js
│           │   ├── nav.js
│           │   ├── navPref.js
│           │   ├── navProgress.js
│           │   ├── routes.js
│           │   ├── shell.css
│           │   └── workspaceBoot.js
│           ├── components
│           │   └── CapGate.jsx
│           ├── financeApp
│           │   ├── html
│           │   │   ├── _bank-recon-modals.html
│           │   │   ├── _cash-modal.html
│           │   │   ├── _header-actions.html
│           │   │   ├── _ledger-line-modal.html
│           │   │   ├── _quick-capture.html
│           │   │   ├── bank-recon.html
│           │   │   ├── docs.html
│           │   │   ├── expense-plan.html
│           │   │   ├── invoices-raised.html
│           │   │   ├── ledger.html
│           │   │   └── reports.html
│           │   ├── ledger
│           │   │   ├── data.js
│           │   │   ├── exportExcel.js
│           │   │   ├── lineModal.js
│           │   │   └── view.js
│           │   ├── pages
│           │   │   ├── bank-recon.js
│           │   │   ├── docs.js
│           │   │   ├── expense-plan.js
│           │   │   ├── invoices-raised.js
│           │   │   ├── ledger.js
│           │   │   └── reports.js
│           │   ├── boot.js
│           │   ├── chrome.js
│           │   ├── finance-app.css
│           │   ├── financeNav.js
│           │   ├── mount.js
│           │   └── session.js
│           ├── financeNew
│           │   ├── api.js
│           │   ├── bankReconciliation.js
│           │   ├── bankStatementQueries.js
│           │   ├── billingBatches.js
│           │   ├── billingGroups.js
│           │   ├── billingHeads.js
│           │   ├── cashFloat.js
│           │   ├── cashFloatPredicates.js
│           │   ├── classicState.js
│           │   ├── duesAging.js
│           │   ├── expensePlan.js
│           │   ├── financeAnalytics.js
│           │   ├── financeDocuments.js
│           │   ├── financePermissions.js
│           │   ├── finances.js
│           │   ├── invoicesRaisedPage.js
│           │   ├── ledger.js
│           │   ├── ledgerBalance.js
│           │   ├── ledgerColFilter.js
│           │   ├── ledgerDisplayRows.js
│           │   ├── ledgerExport.js
│           │   ├── ledgerFilter.js
│           │   ├── ledgerStatementContext.js
│           │   ├── ledgerSummaryUi.js
│           │   ├── ledgerTable.js
│           │   ├── ledgerTxnLocal.js
│           │   ├── load.js
│           │   ├── loadReports.js
│           │   ├── maintenanceBilling.js
│           │   ├── mongoMutations.js
│           │   ├── mongoWrite.js
│           │   ├── nobrokerInvoicesRaised.js
│           │   ├── packCache.js
│           │   ├── payments.js
│           │   ├── pull.js
│           │   ├── quickCapture.js
│           │   ├── reports.js
│           │   ├── shell.js
│           │   ├── state.js
│           │   ├── vendors.js
│           │   ├── vouchers.js
│           │   ├── voucherStore.js
│           │   └── windowBridge.js
│           ├── homeApp
│           │   ├── boot.js
│           │   ├── home-app.css
│           │   ├── main.js
│           │   └── page.js
│           ├── listUi
│           │   └── ExcelColHeader.jsx
│           ├── propertyApp
│           │   ├── parking
│           │   │   ├── api.js
│           │   │   ├── BaseSlotsDialog.jsx
│           │   │   ├── InlineUnitEdit.jsx
│           │   │   ├── main.jsx
│           │   │   ├── NeighborRentDialog.jsx
│           │   │   ├── PoolAssignDialog.jsx
│           │   │   ├── PoolSlotDialog.jsx
│           │   │   ├── UnitParkingDialog.jsx
│           │   │   ├── VehicleFormDialog.jsx
│           │   │   └── VehicleList.jsx
│           │   ├── units
│           │   │   ├── api.js
│           │   │   ├── main.jsx
│           │   │   ├── UnitDetailDialog.jsx
│           │   │   ├── UnitFormDialog.jsx
│           │   │   ├── UnitImportDialog.jsx
│           │   │   └── UnitList.jsx
│           │   ├── boot.js
│           │   ├── client.js
│           │   ├── loadState.js
│           │   ├── mount.jsx
│           │   └── property-app.css
│           ├── residentsApp
│           │   ├── components
│           │   │   ├── ResidentFormDialog.jsx
│           │   │   └── ResidentImportDialog.jsx
│           │   ├── hooks
│           │   │   └── useListQueryParams.js
│           │   ├── pages
│           │   │   ├── ResidentDetails.jsx
│           │   │   └── ResidentList.jsx
│           │   ├── utils
│           │   │   └── listNavigation.js
│           │   ├── api.js
│           │   ├── App.jsx
│           │   ├── boot.js
│           │   ├── loadState.js
│           │   ├── main.jsx
│           │   ├── mount.jsx
│           │   ├── residents-app.css
│           │   └── theme.js
│           ├── runtime
│           │   ├── authHeaders.js
│           │   └── state.js
│           ├── accessLocks.js
│           ├── accessRequests.js
│           ├── activityAudit.js
│           ├── allocation.js
│           ├── apiJson.js
│           ├── authClient.js
│           ├── authRedirect.js
│           ├── bankClassificationRules.js
│           ├── bankStatementLineUtils.js
│           ├── bankStatementOrdering.js
│           ├── blockFilter.js
│           ├── bulkCollectionImport.js
│           ├── bulkInvoiceImport.js
│           ├── buttonBusy.js
│           ├── capabilities.js
│           ├── capUi.js
│           ├── classifyCombobox.js
│           ├── classifyOptions.js
│           ├── dbClient.js
│           ├── expenseCategories.js
│           ├── externalConnections.js
│           ├── financeApi.js
│           ├── financePageHelp.js
│           ├── financeReportsExport.js
│           ├── finances.js
│           ├── invoicePdf.js
│           ├── ledgerColumnMapping.js
│           ├── ledgerSpreadsheetSync.js
│           ├── ledgerTransform.js
│           ├── moduleAccess.js
│           ├── navigation.js
│           ├── parkingImport.js
│           ├── passbookEvolyx.js
│           ├── passbookJobImportAnalysis.js
│           ├── penaltyRules.js
│           ├── rbac.js
│           ├── rbacMatrix.js
│           ├── rbacMongoClient.js
│           ├── registry.js
│           ├── residentImport.js
│           ├── residentLinks.js
│           ├── residents.js
│           ├── spreadsheetSyncApi.js
│           ├── store.js
│           ├── uiMode.js
│           ├── unitDirectory.js
│           └── vendorFormat.js
├── classic
│   ├── api
│   │   ├── db.js
│   │   ├── dbAccess.js
│   │   ├── finance-mutations.js
│   │   ├── rpc.js
│   │   ├── state.js
│   │   ├── stateDomains.js
│   │   ├── storage.js
│   │   ├── sync.js
│   │   └── workspace-boot.js
│   ├── sql
│   │   ├── supabase_activity_audit_notifications.sql
│   │   ├── supabase_activity_audit_review.sql
│   │   ├── supabase_apartment_finance_state.sql
│   │   ├── supabase_gate_parcels.sql
│   │   ├── supabase_ledger_oauth.sql
│   │   ├── supabase_ledger_spreadsheet_sync.sql
│   │   ├── supabase_ledger_sync_journal.sql
│   │   ├── supabase_ledger_sync_run_logs.sql
│   │   ├── supabase_ledger_sync_service_account.sql
│   │   ├── supabase_module_access.sql
│   │   ├── supabase_notice_delivery.sql
│   │   ├── supabase_page_access.sql
│   │   ├── supabase_property_manager_permissions.sql
│   │   ├── supabase_society_role_rbac.sql
│   │   ├── supabase_user_directory_rls.sql
│   │   └── supabase_visitor_approvals.sql
│   ├── src
│   │   ├── assets
│   │   ├── views
│   │   │   ├── html
│   │   │   │   ├── access-control.html
│   │   │   │   ├── accounts.html
│   │   │   │   ├── apartment.html
│   │   │   │   ├── dashboard.html
│   │   │   │   ├── email.html
│   │   │   │   ├── finance-new-accounts.html
│   │   │   │   ├── finance-new-invoices.html
│   │   │   │   ├── invoices.html
│   │   │   │   ├── operations.html
│   │   │   │   ├── portal.html
│   │   │   │   ├── portfolio.html
│   │   │   │   ├── registry.html
│   │   │   │   ├── security.html
│   │   │   │   ├── setup.html
│   │   │   │   └── units.html
│   │   │   ├── inits
│   │   │   │   ├── accounts.js
│   │   │   │   ├── apartment.js
│   │   │   │   ├── dashboard.js
│   │   │   │   ├── email.js
│   │   │   │   ├── finance-new-accounts.js
│   │   │   │   ├── finance-new-invoices.js
│   │   │   │   ├── invoices.js
│   │   │   │   ├── operations.js
│   │   │   │   ├── portal.js
│   │   │   │   ├── portfolio.js
│   │   │   │   ├── registry.js
│   │   │   │   ├── security.js
│   │   │   │   ├── setup.js
│   │   │   │   └── units.js
│   │   │   ├── controllers.js
│   │   │   └── viewShell.js
│   │   ├── accessLocks.js
│   │   ├── accessRequests.js
│   │   ├── accessSync.js
│   │   ├── activityAudit.js
│   │   ├── admin.js
│   │   ├── allocation.js
│   │   ├── apiJson.js
│   │   ├── authRedirect.js
│   │   ├── authShell.js
│   │   ├── authUserKind.js
│   │   ├── bankClassificationRules.js
│   │   ├── bankReconciliation.js
│   │   ├── bankStatementLineUtils.js
│   │   ├── bankStatementOrdering.js
│   │   ├── billingBatches.js
│   │   ├── billingGroups.js
│   │   ├── billingHeads.js
│   │   ├── blockFilter.js
│   │   ├── bulkCollectionImport.js
│   │   ├── bulkInvoiceImport.js
│   │   ├── buttonBusy.js
│   │   ├── cashFloat.js
│   │   ├── classifyCombobox.js
│   │   ├── classifyOptions.js
│   │   ├── counter.js
│   │   ├── dashboard.css
│   │   ├── dashboard.js
│   │   ├── dbClient.js
│   │   ├── duesAging.js
│   │   ├── emailOutbox.js
│   │   ├── expenseCategories.js
│   │   ├── expensePlan.js
│   │   ├── externalConnections.js
│   │   ├── externalFetch.js
│   │   ├── financeAnalytics.js
│   │   ├── financeApi.js
│   │   ├── financeDocuments.js
│   │   ├── financeMobile.css
│   │   ├── financePageHelp.js
│   │   ├── financeReportsExport.js
│   │   ├── finances.js
│   │   ├── flatPicker.js
│   │   ├── gateWizard.css
│   │   ├── gateWizard.js
│   │   ├── generalLedger.js
│   │   ├── invoicePdf.js
│   │   ├── invoicesRaisedPage.js
│   │   ├── ledgerBalance.js
│   │   ├── ledgerColumnMapping.js
│   │   ├── ledgerDisplayRows.js
│   │   ├── ledgerExport.js
│   │   ├── ledgerFilter.js
│   │   ├── ledgerOAuth.js
│   │   ├── ledgerSheetRegion.js
│   │   ├── ledgerSpreadsheetSync.js
│   │   ├── ledgerStatementContext.js
│   │   ├── ledgerSync.css
│   │   ├── ledgerSyncApply.js
│   │   ├── ledgerSyncImport.js
│   │   ├── ledgerSyncJournal.js
│   │   ├── ledgerSyncLog.js
│   │   ├── ledgerSyncRunAudit.js
│   │   ├── ledgerTable.js
│   │   ├── ledgerTransform.js
│   │   ├── ledgerTxnLocal.js
│   │   ├── login.css
│   │   ├── loginPage.js
│   │   ├── main.js
│   │   ├── mainBoot.js
│   │   ├── maintenanceBilling.js
│   │   ├── microsoftExcelPush.js
│   │   ├── moduleAccess.css
│   │   ├── moduleAccess.js
│   │   ├── moduleAccessAdmin.js
│   │   ├── ms-callback.js
│   │   ├── navigation.js
│   │   ├── nobrokerInvoicesRaised.js
│   │   ├── noticeDelivery.js
│   │   ├── noticeEditor.js
│   │   ├── notices.css
│   │   ├── notices.js
│   │   ├── operations.js
│   │   ├── pageAccess.css
│   │   ├── pageAccess.js
│   │   ├── pageAccessAdmin.js
│   │   ├── pageAccessResolve.js
│   │   ├── parkingImport.js
│   │   ├── parkingOps.js
│   │   ├── parkingReconcileUi.js
│   │   ├── passbookEvolyx.js
│   │   ├── passbookJobImportAnalysis.js
│   │   ├── payments.js
│   │   ├── penaltyRules.js
│   │   ├── portfolio.js
│   │   ├── rbac.js
│   │   ├── rbacMatrix.js
│   │   ├── registry.js
│   │   ├── residentImport.js
│   │   ├── residentLinks.js
│   │   ├── residentPortal.js
│   │   ├── residents.js
│   │   ├── residentView.js
│   │   ├── securityPortal.css
│   │   ├── securityPortal.js
│   │   ├── setupSocietyUi.js
│   │   ├── socialAuth.js
│   │   ├── staffNotifications.js
│   │   ├── stateLoader.js
│   │   ├── store.js
│   │   ├── style.css
│   │   ├── syncCodeEditor.js
│   │   ├── transitionFees.js
│   │   ├── unitDirectory.js
│   │   ├── unitTransitions.js
│   │   ├── vehicleAudit.js
│   │   ├── visitorApprovals.js
│   │   ├── visitorGate.js
│   │   ├── visitors.css
│   │   └── visitors.js
│   ├── index.html
│   └── README.md
├── docs
│   ├── screenshots
│   │   ├── finance-bank-recon-mock.png
│   │   └── finance-reports-mock.png
│   ├── scripts
│   │   └── sql
│   │       ├── supabase_access_request_kind.sql
│   │       ├── supabase_access_requests.sql
│   │       ├── supabase_activity_audit_log.sql
│   │       ├── supabase_activity_audit_notifications.sql
│   │       ├── supabase_activity_audit_review.sql
│   │       ├── supabase_admin_reference.sql
│   │       ├── supabase_amenity_bookings.sql
│   │       ├── supabase_bank_classification_rules_report_exclude.sql
│   │       ├── supabase_bank_classification_rules.sql
│   │       ├── supabase_bank_opening_balance.sql
│   │       ├── supabase_bank_reconciliation.sql
│   │       ├── supabase_bank_statement_line_order.sql
│   │       ├── supabase_billing_batch_history.sql
│   │       ├── supabase_email_outbox.sql
│   │       ├── supabase_expense_plan_and_bills_entry.sql
│   │       ├── supabase_expense_plan_recurring_term.sql
│   │       ├── supabase_expense_references.sql
│   │       ├── supabase_external_connections.sql
│   │       ├── supabase_finance_documents_status.sql
│   │       ├── supabase_finance_documents.sql
│   │       ├── supabase_gate_parcels.sql
│   │       ├── supabase_general_ledger.sql
│   │       ├── supabase_helpdesk.sql
│   │       ├── supabase_ledger_oauth.sql
│   │       ├── supabase_ledger_spreadsheet_sync.sql
│   │       ├── supabase_ledger_sync_service_account.sql
│   │       ├── supabase_ledger_sync_v2.sql
│   │       ├── supabase_maintenance_billing_extra_pool.sql
│   │       ├── supabase_maintenance_billing_groups.sql
│   │       ├── supabase_maintenance_billing_v2.sql
│   │       ├── supabase_maintenance_billing.sql
│   │       ├── supabase_maintenance_penalty_rules.sql
│   │       ├── supabase_maintenance_reminders.sql
│   │       ├── supabase_nobroker_invoices_raised.sql
│   │       ├── supabase_notice_delivery.sql
│   │       ├── supabase_parking_slots_pool_kind.sql
│   │       ├── supabase_parking_violations.sql
│   │       ├── supabase_passbook_jobs.sql
│   │       ├── supabase_payment_intents.sql
│   │       ├── supabase_phase3_portal_bundle.sql
│   │       ├── supabase_rbac_v2.sql
│   │       ├── supabase_rbac.sql
│   │       ├── supabase_rename_public_tables_to_temp.sql
│   │       ├── supabase_resident_invites.sql
│   │       ├── supabase_resident_portal.sql
│   │       ├── supabase_residents_unified.sql
│   │       ├── supabase_restore_system_admin.sql
│   │       ├── supabase_rls_operational.sql
│   │       ├── supabase_security_portal.sql
│   │       ├── supabase_society_admin_role.sql
│   │       ├── supabase_society_assets.sql
│   │       ├── supabase_society_notices.sql
│   │       ├── supabase_society_role_crud_read_fix.sql
│   │       ├── supabase_staff_payroll.sql
│   │       ├── supabase_tenant_backfill_elixir.sql
│   │       ├── supabase_transactions_extras.sql
│   │       ├── supabase_transactions_ledger_exclude.sql
│   │       ├── supabase_transactions_report_exclude.sql
│   │       ├── supabase_unit_documents.sql
│   │       ├── supabase_unit_transitions_v2.sql
│   │       ├── supabase_unit_transitions.sql
│   │       ├── supabase_units_directory.sql
│   │       ├── supabase_vehicle_audit_log.sql
│   │       ├── supabase_vehicle_rfid_sticker.sql
│   │       ├── supabase_visitor_approvals.sql
│   │       ├── supabase_visitor_log.sql
│   │       └── supabase_visitor_parking.sql
│   ├── ARCHITECTURE_NEW.md
│   ├── finance-reports-preview.html
│   ├── finance-reports-preview.md
│   ├── FIREBASE_AUTH.md
│   ├── PHASED_REQUIREMENTS.md
│   └── REPO_MAP.md
├── packages
│   ├── auth
│   │   ├── authClient.js
│   │   ├── login.html
│   │   ├── microsoft-auth.html
│   │   ├── oauthMarkers.js
│   │   ├── oauthRedirect.js
│   │   └── server.js
│   └── server
│       ├── accountsAuth.js
│       ├── appSessionJwt.js
│       ├── auth-password.js
│       ├── auth-session.js
│       ├── mongoClient.js
│       ├── mongoLog.js
│       ├── mongoPasswordAuth.js
│       ├── oauth-microsoft.js
│       ├── oauth-service.js
│       ├── r2Storage.js
│       ├── serverAuth.js
│       ├── serverFirebaseAuth.js
│       ├── serverSupabase.js
│       ├── supabaseRest.js
│       ├── uiMode.js
│       └── vercelRequest.js
├── public
│   ├── favicon.svg
│   ├── finance-reports-preview.html
│   └── icons.svg
├── scripts
│   ├── git-hooks
│   │   ├── install-hooks.js
│   │   └── pre-push.js
│   ├── utilities
│   │   └── generate-repo-map.js
│   ├── apply-office-manager-finance-rbac.mjs
│   ├── capture-finance-screenshots.mjs
│   ├── check-import-boundary.mjs
│   ├── consolidate-vendors-mongo.mjs
│   ├── migrate-auth-to-firebase.mjs
│   ├── migrate-finance-to-mongo.mjs
│   ├── migrate-integrations-to-mongo.mjs
│   ├── migrate-ledger-sync-to-mongo.mjs
│   ├── migrate-logs-to-mongo.mjs
│   ├── migrate-property-to-mongo.mjs
│   ├── migrate-rbac-to-mongo.mjs
│   ├── mockFinanceState.js
│   ├── remodel-finance-mongo.mjs
│   ├── verify-build-chunks.mjs
│   ├── verify-vercel-api.mjs
│   └── write-api-shims.mjs
├── .cursorrules
├── .env.example
├── .gitignore
├── AGENTS.md
├── firebase-service-account.json
├── package-lock.json
├── package.json
├── vercel.json
├── vite.config.js
├── viteApiDev.js
└── viteAppLayout.js

```

**Scale:** ~351 JavaScript modules, ~17 CSS files, ~42 HTML entry pages.

---

## 2. `src/` — Frontend Feature Modules

Classic SPA (archived): `classic/src/main.js` — not in production build.
New MPAs: `apps/new/src/*App` plus HTML in `apps/new/pages/`. New nav is MPA-only.

### Directory tree

```
├── api
│   ├── db.js
│   ├── dbAccess.js
│   ├── finance-mutations.js
│   ├── rpc.js
│   ├── state.js
│   ├── stateDomains.js
│   ├── storage.js
│   ├── sync.js
│   └── workspace-boot.js
├── sql
│   ├── supabase_activity_audit_notifications.sql
│   ├── supabase_activity_audit_review.sql
│   ├── supabase_apartment_finance_state.sql
│   ├── supabase_gate_parcels.sql
│   ├── supabase_ledger_oauth.sql
│   ├── supabase_ledger_spreadsheet_sync.sql
│   ├── supabase_ledger_sync_journal.sql
│   ├── supabase_ledger_sync_run_logs.sql
│   ├── supabase_ledger_sync_service_account.sql
│   ├── supabase_module_access.sql
│   ├── supabase_notice_delivery.sql
│   ├── supabase_page_access.sql
│   ├── supabase_property_manager_permissions.sql
│   ├── supabase_society_role_rbac.sql
│   ├── supabase_user_directory_rls.sql
│   └── supabase_visitor_approvals.sql
├── src
│   ├── assets
│   ├── views
│   │   ├── html
│   │   │   ├── access-control.html
│   │   │   ├── accounts.html
│   │   │   ├── apartment.html
│   │   │   ├── dashboard.html
│   │   │   ├── email.html
│   │   │   ├── finance-new-accounts.html
│   │   │   ├── finance-new-invoices.html
│   │   │   ├── invoices.html
│   │   │   ├── operations.html
│   │   │   ├── portal.html
│   │   │   ├── portfolio.html
│   │   │   ├── registry.html
│   │   │   ├── security.html
│   │   │   ├── setup.html
│   │   │   └── units.html
│   │   ├── inits
│   │   │   ├── accounts.js
│   │   │   ├── apartment.js
│   │   │   ├── dashboard.js
│   │   │   ├── email.js
│   │   │   ├── finance-new-accounts.js
│   │   │   ├── finance-new-invoices.js
│   │   │   ├── invoices.js
│   │   │   ├── operations.js
│   │   │   ├── portal.js
│   │   │   ├── portfolio.js
│   │   │   ├── registry.js
│   │   │   ├── security.js
│   │   │   ├── setup.js
│   │   │   └── units.js
│   │   ├── controllers.js
│   │   └── viewShell.js
│   ├── accessLocks.js
│   ├── accessRequests.js
│   ├── accessSync.js
│   ├── activityAudit.js
│   ├── admin.js
│   ├── allocation.js
│   ├── apiJson.js
│   ├── authRedirect.js
│   ├── authShell.js
│   ├── authUserKind.js
│   ├── bankClassificationRules.js
│   ├── bankReconciliation.js
│   ├── bankStatementLineUtils.js
│   ├── bankStatementOrdering.js
│   ├── billingBatches.js
│   ├── billingGroups.js
│   ├── billingHeads.js
│   ├── blockFilter.js
│   ├── bulkCollectionImport.js
│   ├── bulkInvoiceImport.js
│   ├── buttonBusy.js
│   ├── cashFloat.js
│   ├── classifyCombobox.js
│   ├── classifyOptions.js
│   ├── counter.js
│   ├── dashboard.css
│   ├── dashboard.js
│   ├── dbClient.js
│   ├── duesAging.js
│   ├── emailOutbox.js
│   ├── expenseCategories.js
│   ├── expensePlan.js
│   ├── externalConnections.js
│   ├── externalFetch.js
│   ├── financeAnalytics.js
│   ├── financeApi.js
│   ├── financeDocuments.js
│   ├── financeMobile.css
│   ├── financePageHelp.js
│   ├── financeReportsExport.js
│   ├── finances.js
│   ├── flatPicker.js
│   ├── gateWizard.css
│   ├── gateWizard.js
│   ├── generalLedger.js
│   ├── invoicePdf.js
│   ├── invoicesRaisedPage.js
│   ├── ledgerBalance.js
│   ├── ledgerColumnMapping.js
│   ├── ledgerDisplayRows.js
│   ├── ledgerExport.js
│   ├── ledgerFilter.js
│   ├── ledgerOAuth.js
│   ├── ledgerSheetRegion.js
│   ├── ledgerSpreadsheetSync.js
│   ├── ledgerStatementContext.js
│   ├── ledgerSync.css
│   ├── ledgerSyncApply.js
│   ├── ledgerSyncImport.js
│   ├── ledgerSyncJournal.js
│   ├── ledgerSyncLog.js
│   ├── ledgerSyncRunAudit.js
│   ├── ledgerTable.js
│   ├── ledgerTransform.js
│   ├── ledgerTxnLocal.js
│   ├── login.css
│   ├── loginPage.js
│   ├── main.js
│   ├── mainBoot.js
│   ├── maintenanceBilling.js
│   ├── microsoftExcelPush.js
│   ├── moduleAccess.css
│   ├── moduleAccess.js
│   ├── moduleAccessAdmin.js
│   ├── ms-callback.js
│   ├── navigation.js
│   ├── nobrokerInvoicesRaised.js
│   ├── noticeDelivery.js
│   ├── noticeEditor.js
│   ├── notices.css
│   ├── notices.js
│   ├── operations.js
│   ├── pageAccess.css
│   ├── pageAccess.js
│   ├── pageAccessAdmin.js
│   ├── pageAccessResolve.js
│   ├── parkingImport.js
│   ├── parkingOps.js
│   ├── parkingReconcileUi.js
│   ├── passbookEvolyx.js
│   ├── passbookJobImportAnalysis.js
│   ├── payments.js
│   ├── penaltyRules.js
│   ├── portfolio.js
│   ├── rbac.js
│   ├── rbacMatrix.js
│   ├── registry.js
│   ├── residentImport.js
│   ├── residentLinks.js
│   ├── residentPortal.js
│   ├── residents.js
│   ├── residentView.js
│   ├── securityPortal.css
│   ├── securityPortal.js
│   ├── setupSocietyUi.js
│   ├── socialAuth.js
│   ├── staffNotifications.js
│   ├── stateLoader.js
│   ├── store.js
│   ├── style.css
│   ├── syncCodeEditor.js
│   ├── transitionFees.js
│   ├── unitDirectory.js
│   ├── unitTransitions.js
│   ├── vehicleAudit.js
│   ├── visitorApprovals.js
│   ├── visitorGate.js
│   ├── visitors.css
│   └── visitors.js
├── index.html
└── README.md

--- apps ---
└── new
    ├── api
    │   ├── activityMongo
    │   │   ├── routes
    │   │   │   └── events.js
    │   │   ├── activityStore.js
    │   │   ├── errors.js
    │   │   ├── http.js
    │   │   ├── indexes.js
    │   │   └── permissions.js
    │   ├── finance
    │   │   └── [...path].js
    │   ├── financeMongo
    │   │   ├── services
    │   │   │   ├── ledgerMutations.js
    │   │   │   └── ledgerReads.js
    │   │   ├── validation
    │   │   │   └── ledger.js
    │   │   ├── errors.js
    │   │   ├── index.js
    │   │   ├── money.js
    │   │   └── permissions.js
    │   ├── integrationsMongo
    │   │   ├── routes
    │   │   │   ├── passbook
    │   │   │   │   ├── jobs
    │   │   │   │   │   └── [id]
    │   │   │   │   │       └── imported.js
    │   │   │   │   └── jobs.js
    │   │   │   ├── spreadsheet
    │   │   │   │   ├── boot.js
    │   │   │   │   ├── oauth-apps.js
    │   │   │   │   ├── oauth-connections.js
    │   │   │   │   ├── runs.js
    │   │   │   │   └── settings.js
    │   │   │   └── connections.js
    │   │   ├── connectionsStore.js
    │   │   ├── errors.js
    │   │   ├── evolyxWorkflow.js
    │   │   ├── http.js
    │   │   ├── indexes.js
    │   │   ├── passbookJobsStore.js
    │   │   ├── passbookMap.js
    │   │   ├── passbookService.js
    │   │   ├── permissions.js
    │   │   └── spreadsheetStore.js
    │   ├── propertyMongo
    │   │   ├── routes
    │   │   │   ├── residents
    │   │   │   │   ├── [id].js
    │   │   │   │   └── import.js
    │   │   │   ├── slots
    │   │   │   │   ├── [id]
    │   │   │   │   │   ├── assign.js
    │   │   │   │   │   └── release.js
    │   │   │   │   └── [id].js
    │   │   │   ├── units
    │   │   │   │   ├── [id].js
    │   │   │   │   ├── import.js
    │   │   │   │   └── parking-limits.js
    │   │   │   ├── vehicles
    │   │   │   │   ├── [id].js
    │   │   │   │   └── import.js
    │   │   │   ├── residents.js
    │   │   │   ├── slots.js
    │   │   │   ├── state.js
    │   │   │   ├── units.js
    │   │   │   └── vehicles.js
    │   │   ├── audit.js
    │   │   ├── errors.js
    │   │   ├── http.js
    │   │   ├── models.js
    │   │   ├── mongoose.js
    │   │   ├── permissions.js
    │   │   └── service.js
    │   ├── rbacMongo
    │   │   ├── defaults.js
    │   │   └── service.js
    │   ├── activity-rest.js
    │   ├── auth-rest.js
    │   ├── dashboard-summary.js
    │   ├── evolyxConnection.js
    │   ├── external-connections.js
    │   ├── external-proxy.js
    │   ├── finance-mongo-mutations.js
    │   ├── finance-mongo-reports.js
    │   ├── finance-mongo.js
    │   ├── finance-rest.js
    │   ├── identity-rest.js
    │   ├── integrations-rest.js
    │   ├── passbook-jobs.js
    │   ├── passbook-parse.js
    │   ├── passbook-webhook.js
    │   ├── passbookJobsStore.js
    │   ├── property-rest.js
    │   ├── rbac-mongo.js
    │   └── workspace-boot.js
    ├── pages
    │   ├── admin
    │   │   └── index.html
    │   ├── finance
    │   │   ├── bank-recon.html
    │   │   ├── docs.html
    │   │   ├── expense-plan.html
    │   │   ├── invoices-raised.html
    │   │   ├── ledger.html
    │   │   └── reports.html
    │   ├── home
    │   │   └── index.html
    │   ├── parking
    │   │   └── index.html
    │   ├── residents
    │   │   └── index.html
    │   └── units
    │       └── index.html
    └── src
        ├── adminApp
        │   ├── components
        │   │   ├── PageHeader.jsx
        │   │   └── SummaryStrip.jsx
        │   ├── pages
        │   │   ├── ActivityPage.jsx
        │   │   ├── BankPage.jsx
        │   │   ├── CategoriesPage.jsx
        │   │   ├── IntegrationsPage.jsx
        │   │   ├── PeoplePage.jsx
        │   │   ├── RolesPage.jsx
        │   │   ├── SocietyPage.jsx
        │   │   ├── SpreadsheetSyncDialog.jsx
        │   │   ├── StaffPage.jsx
        │   │   └── VendorsPage.jsx
        │   ├── admin-app.css
        │   ├── api.js
        │   ├── App.jsx
        │   ├── boot.js
        │   ├── main.jsx
        │   ├── mount.jsx
        │   └── pages.js
        ├── appShell
        │   ├── html
        │   │   ├── boot-splash.html
        │   │   └── layout.html
        │   ├── chrome.js
        │   ├── ensureChartJs.js
        │   ├── forceDocumentNav.js
        │   ├── mount.js
        │   ├── mpaAuth.js
        │   ├── mpaSession.js
        │   ├── nav.js
        │   ├── navPref.js
        │   ├── navProgress.js
        │   ├── routes.js
        │   ├── shell.css
        │   └── workspaceBoot.js
        ├── components
        │   └── CapGate.jsx
        ├── financeApp
        │   ├── html
        │   │   ├── _bank-recon-modals.html
        │   │   ├── _cash-modal.html
        │   │   ├── _header-actions.html
        │   │   ├── _ledger-line-modal.html
        │   │   ├── _quick-capture.html
        │   │   ├── bank-recon.html
        │   │   ├── docs.html
        │   │   ├── expense-plan.html
        │   │   ├── invoices-raised.html
        │   │   ├── ledger.html
        │   │   └── reports.html
        │   ├── ledger
        │   │   ├── data.js
        │   │   ├── exportExcel.js
        │   │   ├── lineModal.js
        │   │   └── view.js
        │   ├── pages
        │   │   ├── bank-recon.js
        │   │   ├── docs.js
        │   │   ├── expense-plan.js
        │   │   ├── invoices-raised.js
        │   │   ├── ledger.js
        │   │   └── reports.js
        │   ├── boot.js
        │   ├── chrome.js
        │   ├── finance-app.css
        │   ├── financeNav.js
        │   ├── mount.js
        │   └── session.js
        ├── financeNew
        │   ├── api.js
        │   ├── bankReconciliation.js
        │   ├── bankStatementQueries.js
        │   ├── billingBatches.js
        │   ├── billingGroups.js
        │   ├── billingHeads.js
        │   ├── cashFloat.js
        │   ├── cashFloatPredicates.js
        │   ├── classicState.js
        │   ├── duesAging.js
        │   ├── expensePlan.js
        │   ├── financeAnalytics.js
        │   ├── financeDocuments.js
        │   ├── financePermissions.js
        │   ├── finances.js
        │   ├── invoicesRaisedPage.js
        │   ├── ledger.js
        │   ├── ledgerBalance.js
        │   ├── ledgerColFilter.js
        │   ├── ledgerDisplayRows.js
        │   ├── ledgerExport.js
        │   ├── ledgerFilter.js
        │   ├── ledgerStatementContext.js
        │   ├── ledgerSummaryUi.js
        │   ├── ledgerTable.js
        │   ├── ledgerTxnLocal.js
        │   ├── load.js
        │   ├── loadReports.js
        │   ├── maintenanceBilling.js
        │   ├── mongoMutations.js
        │   ├── mongoWrite.js
        │   ├── nobrokerInvoicesRaised.js
        │   ├── packCache.js
        │   ├── payments.js
        │   ├── pull.js
        │   ├── quickCapture.js
        │   ├── reports.js
        │   ├── shell.js
        │   ├── state.js
        │   ├── vendors.js
        │   ├── vouchers.js
        │   ├── voucherStore.js
        │   └── windowBridge.js
        ├── homeApp
        │   ├── boot.js
        │   ├── home-app.css
        │   ├── main.js
        │   └── page.js
        ├── listUi
        │   └── ExcelColHeader.jsx
        ├── propertyApp
        │   ├── parking
        │   │   ├── api.js
        │   │   ├── BaseSlotsDialog.jsx
        │   │   ├── InlineUnitEdit.jsx
        │   │   ├── main.jsx
        │   │   ├── NeighborRentDialog.jsx
        │   │   ├── PoolAssignDialog.jsx
        │   │   ├── PoolSlotDialog.jsx
        │   │   ├── UnitParkingDialog.jsx
        │   │   ├── VehicleFormDialog.jsx
        │   │   └── VehicleList.jsx
        │   ├── units
        │   │   ├── api.js
        │   │   ├── main.jsx
        │   │   ├── UnitDetailDialog.jsx
        │   │   ├── UnitFormDialog.jsx
        │   │   ├── UnitImportDialog.jsx
        │   │   └── UnitList.jsx
        │   ├── boot.js
        │   ├── client.js
        │   ├── loadState.js
        │   ├── mount.jsx
        │   └── property-app.css
        ├── residentsApp
        │   ├── components
        │   │   ├── ResidentFormDialog.jsx
        │   │   └── ResidentImportDialog.jsx
        │   ├── hooks
        │   │   └── useListQueryParams.js
        │   ├── pages
        │   │   ├── ResidentDetails.jsx
        │   │   └── ResidentList.jsx
        │   ├── utils
        │   │   └── listNavigation.js
        │   ├── api.js
        │   ├── App.jsx
        │   ├── boot.js
        │   ├── loadState.js
        │   ├── main.jsx
        │   ├── mount.jsx
        │   ├── residents-app.css
        │   └── theme.js
        ├── runtime
        │   ├── authHeaders.js
        │   └── state.js
        ├── accessLocks.js
        ├── accessRequests.js
        ├── activityAudit.js
        ├── allocation.js
        ├── apiJson.js
        ├── authClient.js
        ├── authRedirect.js
        ├── bankClassificationRules.js
        ├── bankStatementLineUtils.js
        ├── bankStatementOrdering.js
        ├── blockFilter.js
        ├── bulkCollectionImport.js
        ├── bulkInvoiceImport.js
        ├── buttonBusy.js
        ├── capabilities.js
        ├── capUi.js
        ├── classifyCombobox.js
        ├── classifyOptions.js
        ├── dbClient.js
        ├── expenseCategories.js
        ├── externalConnections.js
        ├── financeApi.js
        ├── financePageHelp.js
        ├── financeReportsExport.js
        ├── finances.js
        ├── invoicePdf.js
        ├── ledgerColumnMapping.js
        ├── ledgerSpreadsheetSync.js
        ├── ledgerTransform.js
        ├── moduleAccess.js
        ├── navigation.js
        ├── parkingImport.js
        ├── passbookEvolyx.js
        ├── passbookJobImportAnalysis.js
        ├── penaltyRules.js
        ├── rbac.js
        ├── rbacMatrix.js
        ├── rbacMongoClient.js
        ├── registry.js
        ├── residentImport.js
        ├── residentLinks.js
        ├── residents.js
        ├── spreadsheetSyncApi.js
        ├── store.js
        ├── uiMode.js
        ├── unitDirectory.js
        └── vendorFormat.js

--- packages ---
├── auth
│   ├── authClient.js
│   ├── login.html
│   ├── microsoft-auth.html
│   ├── oauthMarkers.js
│   ├── oauthRedirect.js
│   └── server.js
└── server
    ├── accountsAuth.js
    ├── appSessionJwt.js
    ├── auth-password.js
    ├── auth-session.js
    ├── mongoClient.js
    ├── mongoLog.js
    ├── mongoPasswordAuth.js
    ├── oauth-microsoft.js
    ├── oauth-service.js
    ├── r2Storage.js
    ├── serverAuth.js
    ├── serverFirebaseAuth.js
    ├── serverSupabase.js
    ├── supabaseRest.js
    ├── uiMode.js
    └── vercelRequest.js

```

### Feature module index

| File | Purpose |
| --- | --- |
| classic/accessLocks.js | Access lock guard (HMR-safe) |
| classic/accessRequests.js | Access request handling |
| classic/accessSync.js | Access user directory sync |
| classic/activityAudit.js | Activity audit log page |
| classic/admin.js | Setup subview switching & admin helpers |
| classic/allocation.js | Parking slot allocation |
| classic/apiJson.js | API JSON request helpers |
| classic/authRedirect.js | classic/auth Redirect |
| classic/authShell.js | Auth UI shell |
| classic/authUserKind.js | classic/auth User Kind |
| classic/bankClassificationRules.js | Bank statement classification rules |
| classic/bankReconciliation.js | Bank reconciliation UI |
| classic/bankStatementLineUtils.js | Bank statement line utilities |
| classic/bankStatementOrdering.js | Bank statement line ordering |
| classic/billingBatches.js | Billing batch history |
| classic/billingGroups.js | Billing groups & group units |
| classic/billingHeads.js | Maintenance charge heads |
| classic/blockFilter.js | Block filter helper |
| classic/bulkCollectionImport.js | Bulk collection import |
| classic/bulkInvoiceImport.js | Bulk invoice import |
| classic/buttonBusy.js | Busy-state button helper |
| classic/cashFloat.js | Cash float management |
| classic/classifyCombobox.js | Classification combobox |
| classic/classifyOptions.js | Classification options |
| classic/counter.js | Counter helper |
| classic/dashboard.css | Dashboard styles |
| classic/dashboard.js | Dashboard render |
| classic/dbClient.js | Supabase client + apartment state fetch |
| classic/duesAging.js | Dues aging report |
| classic/emailOutbox.js | Email outbox |
| classic/expenseCategories.js | Expense categories |
| classic/expensePlan.js | Expense plan & recurring items |
| classic/externalConnections.js | External connections / Integrations client |
| classic/externalFetch.js | External fetch helpers |
| classic/financeAnalytics.js | Finance reports & analytics |
| classic/financeApi.js | Finance API client |
| classic/financeDocuments.js | Bills & receipts document management |
| classic/financeMobile.css | Mobile finance styles |
| classic/financePageHelp.js | classic/finance Page Help |
| classic/financeReportsExport.js | Export finance reports (Excel) |
| classic/finances.js | Cash & bank ledger engine + processFinances |
| classic/flatPicker.js | Flat (units) picker helper |
| classic/gateWizard.css | Gate wizard styles |
| classic/gateWizard.js | Gate wizard / visitor check-in flow |
| classic/generalLedger.js | General ledger entry management |
| classic/invoicePdf.js | Invoice PDF generation & share |
| classic/invoicesRaisedPage.js | Invoices-raised list page |
| classic/ledgerBalance.js | Ledger balance computation |
| classic/ledgerColumnMapping.js | Ledger column mapping for imports |
| classic/ledgerDisplayRows.js | Ledger table row rendering |
| classic/ledgerExport.js | Ledger export |
| classic/ledgerFilter.js | Ledger filtering |
| classic/ledgerOAuth.js | Bank OAuth connections for ledger sync |
| classic/ledgerSheetRegion.js | Spreadsheet region detection |
| classic/ledgerSpreadsheetSync.js | Spreadsheet sync panel (admin-sync) |
| classic/ledgerStatementContext.js | Bank statement context helpers |
| classic/ledgerSync.css | Ledger sync styles |
| classic/ledgerSyncApply.js | Apply ledger sync rows |
| classic/ledgerSyncImport.js | Ledger sync import |
| classic/ledgerSyncJournal.js | Ledger sync journal |
| classic/ledgerSyncLog.js | Ledger sync run log |
| classic/ledgerSyncRunAudit.js | Ledger sync run audit UI |
| classic/ledgerTable.js | Ledger table rendering |
| classic/ledgerTransform.js | Ledger row transform helpers |
| classic/ledgerTxnLocal.js | Local (offline) ledger transactions |
| classic/login.css | classic/login |
| classic/loginPage.js | classic/login Page |
| classic/main.js | Entry point / primary boot sequence & view coordination |
| classic/mainBoot.js | Shared boot helpers (access mappings, resident rendering, apartment options) |
| classic/maintenanceBilling.js | Maintenance billing engine + invoices page |
| classic/microsoftExcelPush.js | Push finance data to Excel via Microsoft Graph |
| classic/moduleAccess.css | Module access styles |
| classic/moduleAccess.js | Module-level access / isModuleEnabled |
| classic/moduleAccessAdmin.js | Module access admin panel |
| classic/ms-callback.js | Microsoft (MSAL) auth redirect callback |
| classic/navigation.js | Modules, pages, routing & permission gating (NAV_MODULES) |
| classic/nobrokerInvoicesRaised.js | NoBroker invoices-raised list |
| classic/noticeDelivery.js | Notice delivery |
| classic/noticeEditor.js | Notice editor |
| classic/notices.css | Notices styles |
| classic/notices.js | Notices feature |
| classic/operations.js | classic/operations |
| classic/pageAccess.css | Page access styles |
| classic/pageAccess.js | Page-level access |
| classic/pageAccessAdmin.js | Page access admin panel |
| classic/pageAccessResolve.js | Page access route resolution |
| classic/parkingImport.js | Parking data import |
| classic/parkingOps.js | Parking operations UI refresh |
| classic/parkingReconcileUi.js | Parking reconciliation UI |
| classic/passbookEvolyx.js | Evolyx passbook job handling |
| classic/passbookJobImportAnalysis.js | Passbook job import analysis |
| classic/payments.js | Payments / collections |
| classic/penaltyRules.js | Maintenance penalty rules |
| classic/portfolio.js | Portfolio rollup view |
| classic/rbac.js | RBAC: roles, permissions, effective-role resolution |
| classic/rbacMatrix.js | RBAC permission matrix UI |
| classic/registry.js | Parking & vehicle registry (offline-first) + analytics |
| classic/residentImport.js | Resident import (Excel/CSV) |
| classic/residentLinks.js | Resident ↔ unit link admin |
| classic/residentPortal.js | Resident self-service portal subviews |
| classic/residents.js | Residents CRUD |
| classic/residentView.js | Resident detail view |
| classic/securityPortal.css | Security portal styles |
| classic/securityPortal.js | Security gate portal (gate desk / visitor log / passes) |
| classic/setupSocietyUi.js | classic/setup Society Ui |
| classic/socialAuth.js | Social provider sign-in (Google / Microsoft) |
| classic/staffNotifications.js | Staff notifications UI |
| classic/stateLoader.js | Domain loaders & STATE_DOMAINS registry for partitioned state |
| classic/store.js | Central state (portalState) + Supabase client + pullState hydration |
| classic/style.css | Global styles |
| classic/syncCodeEditor.js | Sync code editor |
| classic/transitionFees.js | Transition fee computation |
| classic/unitDirectory.js | Unit directory (block/bhk/area) |
| classic/unitTransitions.js | Move-in / move-out transition wizard |
| classic/vehicleAudit.js | Vehicle audit log & badge refresh |
| classic/visitorApprovals.js | Visitor approvals workflow |
| classic/visitorGate.js | Gate-side visitor handling |
| classic/visitors.css | Visitors styles |
| classic/visitors.js | Visitor log UI |
| apps/new/accessLocks.js | Access lock guard (HMR-safe) |
| apps/new/accessRequests.js | Access request handling |
| apps/new/activityAudit.js | Activity audit log page |
| apps/new/allocation.js | Parking slot allocation |
| apps/new/apiJson.js | API JSON request helpers |
| apps/new/authClient.js | Auth client & session handling |
| apps/new/authRedirect.js | new/auth Redirect |
| apps/new/bankClassificationRules.js | Bank statement classification rules |
| apps/new/bankStatementLineUtils.js | Bank statement line utilities |
| apps/new/bankStatementOrdering.js | Bank statement line ordering |
| apps/new/blockFilter.js | Block filter helper |
| apps/new/bulkCollectionImport.js | Bulk collection import |
| apps/new/bulkInvoiceImport.js | Bulk invoice import |
| apps/new/buttonBusy.js | Busy-state button helper |
| apps/new/capabilities.js | Named action capabilities for new screens (can / assertCan) |
| apps/new/capUi.js | new/cap Ui |
| apps/new/classifyCombobox.js | Classification combobox |
| apps/new/classifyOptions.js | Classification options |
| apps/new/dbClient.js | Supabase client + apartment state fetch |
| apps/new/expenseCategories.js | Expense categories |
| apps/new/externalConnections.js | External connections / Integrations client |
| apps/new/financeApi.js | Finance API client |
| apps/new/financePageHelp.js | new/finance Page Help |
| apps/new/financeReportsExport.js | Export finance reports (Excel) |
| apps/new/finances.js | Cash & bank ledger engine + processFinances |
| apps/new/invoicePdf.js | Invoice PDF generation & share |
| apps/new/ledgerColumnMapping.js | Ledger column mapping for imports |
| apps/new/ledgerSpreadsheetSync.js | Spreadsheet sync panel (admin-sync) |
| apps/new/ledgerTransform.js | Ledger row transform helpers |
| apps/new/moduleAccess.js | Module-level access / isModuleEnabled |
| apps/new/navigation.js | Modules, pages, routing & permission gating (NAV_MODULES) |
| apps/new/parkingImport.js | Parking data import |
| apps/new/passbookEvolyx.js | Evolyx passbook job handling |
| apps/new/passbookJobImportAnalysis.js | Passbook job import analysis |
| apps/new/penaltyRules.js | Maintenance penalty rules |
| apps/new/rbac.js | RBAC: roles, permissions, effective-role resolution |
| apps/new/rbacMatrix.js | RBAC permission matrix UI |
| apps/new/rbacMongoClient.js | Client Mongo RBAC writes (New UI) |
| apps/new/registry.js | Parking & vehicle registry (offline-first) + analytics |
| apps/new/residentImport.js | Resident import (Excel/CSV) |
| apps/new/residentLinks.js | Resident ↔ unit link admin |
| apps/new/residents.js | Residents CRUD |
| apps/new/spreadsheetSyncApi.js | new/spreadsheet Sync Api |
| apps/new/store.js | Central state (portalState) + Supabase client + pullState hydration |
| apps/new/uiMode.js | Classic (Postgres) vs New (Mongo) UI mode |
| apps/new/unitDirectory.js | Unit directory (block/bhk/area) |
| apps/new/vendorFormat.js | new/vendor Format |

---

## 3. Views & Routes

Routes are declared in `src/navigation.js` (`NAV_MODULES`). Each page maps to a `view` handled by `src/views/controllers.js`
and an optional `subview`.

| Route | Label | View | Subview |
| --- | --- | --- | --- |
| dashboard | Dashboard | dashboard | — |
| portal-home | Home | portal | home |
| portal-invoices | Invoices | portal | invoices |
| portal-payments | Payments | portal | payments |
| portal-vehicles | Vehicles | portal | vehicles |
| portal-notices | Notices | portal | notices |
| portal-tickets | Tickets | portal | tickets |
| security-gate | Gate desk | security | gate |
| security-log | Visitor log | security | log |
| security-passes | Parking passes | security | passes |
| property-vehicles | Parking & Vehicles | registry | — |
| property-residents | Residents | apartment | — |
| property-units | Unit Directory | units | — |
| ops-helpdesk | Helpdesk | operations | helpdesk |
| ops-transitions | Move-in / out | operations | transitions |
| ops-notices | Notices | operations | notices |
| ops-assets | Assets | operations | assets |
| ops-amenities | Amenities | operations | amenities |
| ops-visitors | Visitors | operations | visitors |
| ops-payroll | Staff & Payroll | operations | payroll |
| pn-units | Unit Directory | property-new | — |
| pn-vehicles | Parking & Vehicles | property-new | — |
| pn-residents | Residents | property-new | — |
| finance-reports | Financial reports | accounts | reports |
| finance-ledger | Ledger | accounts | ledger |
| finance-docs | Bills & receipts | accounts | finance-docs |
| finance-expense-plan | Expense plan | accounts | expense-plan |
| finance-billing-pending | Pending Dues | invoices | pending-dues |
| finance-billing-list | All Invoices | invoices | list |
| finance-billing-collections | Collections | invoices | collections |
| finance-billing-batches | Billing Batches | invoices | batches |
| finance-billing-aging | Aging Report | invoices | aging |
| finance-bank-recon | Bank Reconciliation | accounts | bank-recon |
| finance-invoices-raised | Invoices Raised | accounts | invoices-raised |
| fn-reports | Financial reports | finance-new-accounts | reports |
| fn-ledger | Ledger | finance-new-accounts | ledger |
| fn-docs | Bills & receipts | finance-new-accounts | finance-docs |
| fn-expense-plan | Expense plan | finance-new-accounts | expense-plan |
| fn-billing-pending | Pending Dues | finance-new-invoices | pending-dues |
| fn-billing-list | All Invoices | finance-new-invoices | list |
| fn-billing-collections | Collections | finance-new-invoices | collections |
| fn-billing-batches | Billing Batches | finance-new-invoices | batches |
| fn-billing-aging | Aging Report | finance-new-invoices | aging |
| fn-bank-recon | Bank Reconciliation | finance-new-accounts | bank-recon |
| fn-invoices-raised | Invoices Raised | finance-new-accounts | invoices-raised |
| an-society | Society profile | admin-new | — |
| an-people | People & access | admin-new | — |
| an-vendors | Vendors | admin-new | — |
| an-categories | Sub-categories | admin-new | — |
| an-staff | Staff directory | admin-new | — |
| an-integrations | Integrations | admin-new | — |
| an-roles | Roles | admin-new | — |
| admin-activity | Activity Log | accounts | activity |
| admin-access | Roles | access-control | — |
| admin-society | Profile | setup | society |
| admin-bank | Bank account | setup | bank |
| admin-vendors | Vendors | setup | vendors |
| admin-subcats | Sub-categories | setup | subcats |
| admin-staff | Staff directory | setup | staff |
| admin-connections | External connections | setup | connections |
| admin-sync | Spreadsheet sync | setup | sync |
| admin-portfolio | Portfolio Rollup | portfolio | — |
| admin-email | Email Outbox | email | — |

**View activation** — `src/views/controllers.js` dispatches on `view`:
`dashboard`, `registry`, `accounts` (finance), `portfolio`, `email`, `setup` (admin), `access-control`,
`invoices` (billing), `portal` (resident), `security` (gate), `operations`, `apartment` (residents), `units`.

---

## 4. `api/` — Vercel Serverless Endpoints

Serverless handlers (Node.js, Vercel Functions). `vercel.json` sets `maxDuration` for long-running endpoints and a
cron (`/api/sync` daily 06:00 UTC). During local dev, `viteApiDev.js` mounts these directly; `VITE_LOCAL_API=0`
proxies `/api` to the deployed origin (`communityhub.evolyx.in`).

```
├── activity-rest.js
├── auth-rest.js
├── finance-rest.js
├── identity-rest.js
├── integrations-rest.js
├── passbook-webhook.js
├── property-rest.js
└── storage.js

```

### Endpoint index

| Endpoint | Purpose |
| --- | --- |
| activity-rest.js | Activity audit REST entry |
| auth-rest.js | Auth domain (session cookie + Mongo password) |
| finance-rest.js | Finance-New REST entry |
| identity-rest.js | Identity/admin (RBAC, workspace boot, dashboard) |
| integrations-rest.js | Integrations REST entry (connections + passbook + legacy OAuth) |
| passbook-webhook.js | Passbook webhook (public, Mongo) |
| property-rest.js | Property-New REST entry |
| storage.js | File storage |

---

## 5. `scripts/` — Root Tooling

```
├── git-hooks
│   ├── install-hooks.js
│   └── pre-push.js
├── utilities
│   └── generate-repo-map.js
├── apply-office-manager-finance-rbac.mjs
├── capture-finance-screenshots.mjs
├── check-import-boundary.mjs
├── consolidate-vendors-mongo.mjs
├── migrate-auth-to-firebase.mjs
├── migrate-finance-to-mongo.mjs
├── migrate-integrations-to-mongo.mjs
├── migrate-ledger-sync-to-mongo.mjs
├── migrate-logs-to-mongo.mjs
├── migrate-property-to-mongo.mjs
├── migrate-rbac-to-mongo.mjs
├── mockFinanceState.js
├── remodel-finance-mongo.mjs
├── verify-build-chunks.mjs
├── verify-vercel-api.mjs
└── write-api-shims.mjs

```

- `verify-build-chunks.mjs` — validates `vite build` output chunking.
- `verify-vercel-api.mjs` — verifies Vercel API handler wiring.
- `mockFinanceState.js` — mock finance state for screenshots/tests.
- `capture-finance-screenshots.mjs` — Playwright screenshot capture (see `docs/screenshots`).

---

## 6. `docs/` & `public/`

### docs/
```
├── screenshots
│   ├── finance-bank-recon-mock.png
│   └── finance-reports-mock.png
├── scripts
│   └── sql
│       ├── supabase_access_request_kind.sql
│       ├── supabase_access_requests.sql
│       ├── supabase_activity_audit_log.sql
│       ├── supabase_activity_audit_notifications.sql
│       ├── supabase_activity_audit_review.sql
│       ├── supabase_admin_reference.sql
│       ├── supabase_amenity_bookings.sql
│       ├── supabase_bank_classification_rules_report_exclude.sql
│       ├── supabase_bank_classification_rules.sql
│       ├── supabase_bank_opening_balance.sql
│       ├── supabase_bank_reconciliation.sql
│       ├── supabase_bank_statement_line_order.sql
│       ├── supabase_billing_batch_history.sql
│       ├── supabase_email_outbox.sql
│       ├── supabase_expense_plan_and_bills_entry.sql
│       ├── supabase_expense_plan_recurring_term.sql
│       ├── supabase_expense_references.sql
│       ├── supabase_external_connections.sql
│       ├── supabase_finance_documents_status.sql
│       ├── supabase_finance_documents.sql
│       ├── supabase_gate_parcels.sql
│       ├── supabase_general_ledger.sql
│       ├── supabase_helpdesk.sql
│       ├── supabase_ledger_oauth.sql
│       ├── supabase_ledger_spreadsheet_sync.sql
│       ├── supabase_ledger_sync_service_account.sql
│       ├── supabase_ledger_sync_v2.sql
│       ├── supabase_maintenance_billing_extra_pool.sql
│       ├── supabase_maintenance_billing_groups.sql
│       ├── supabase_maintenance_billing_v2.sql
│       ├── supabase_maintenance_billing.sql
│       ├── supabase_maintenance_penalty_rules.sql
│       ├── supabase_maintenance_reminders.sql
│       ├── supabase_nobroker_invoices_raised.sql
│       ├── supabase_notice_delivery.sql
│       ├── supabase_parking_slots_pool_kind.sql
│       ├── supabase_parking_violations.sql
│       ├── supabase_passbook_jobs.sql
│       ├── supabase_payment_intents.sql
│       ├── supabase_phase3_portal_bundle.sql
│       ├── supabase_rbac_v2.sql
│       ├── supabase_rbac.sql
│       ├── supabase_rename_public_tables_to_temp.sql
│       ├── supabase_resident_invites.sql
│       ├── supabase_resident_portal.sql
│       ├── supabase_residents_unified.sql
│       ├── supabase_restore_system_admin.sql
│       ├── supabase_rls_operational.sql
│       ├── supabase_security_portal.sql
│       ├── supabase_society_admin_role.sql
│       ├── supabase_society_assets.sql
│       ├── supabase_society_notices.sql
│       ├── supabase_society_role_crud_read_fix.sql
│       ├── supabase_staff_payroll.sql
│       ├── supabase_tenant_backfill_elixir.sql
│       ├── supabase_transactions_extras.sql
│       ├── supabase_transactions_ledger_exclude.sql
│       ├── supabase_transactions_report_exclude.sql
│       ├── supabase_unit_documents.sql
│       ├── supabase_unit_transitions_v2.sql
│       ├── supabase_unit_transitions.sql
│       ├── supabase_units_directory.sql
│       ├── supabase_vehicle_audit_log.sql
│       ├── supabase_vehicle_rfid_sticker.sql
│       ├── supabase_visitor_approvals.sql
│       ├── supabase_visitor_log.sql
│       └── supabase_visitor_parking.sql
├── ARCHITECTURE_NEW.md
├── finance-reports-preview.html
├── finance-reports-preview.md
├── FIREBASE_AUTH.md
├── PHASED_REQUIREMENTS.md
└── REPO_MAP.md

```

`PHASED_REQUIREMENTS.md` is the product spec (phases/sprints) — hand it to an agent to implement features in order.
`ARCHITECTURE_NEW.md` is the New-app REST domain guide (Finance / Property / Integrations segregation).

### public/
```
├── favicon.svg
├── finance-reports-preview.html
└── icons.svg

```

---

## 7. Supabase SQL Migrations (root `supabase_*.sql`)

Schema + RLS migrations. **Run manually** in the Supabase SQL Editor (see `docs/scripts/sql/` for the canonical set).

| File | Purpose |
| --- | --- |


---

## 8. Root Configuration

| File | Purpose |
| --- | --- |
| AGENTS.md | Repo config / entry point |
| firebase-service-account.json | Repo config / entry point |
| package.json | Repo config / entry point |
| vercel.json | Repo config / entry point |
| vite.config.js | Repo config / entry point |
| viteApiDev.js | Repo config / entry point |
| viteAppLayout.js | Repo config / entry point |

---

## 9. Key Architectural Concepts

- **New REST domains (Mongo):** segregate by capability — Finance `/api/finance`, Property `/api/property`,
  Integrations `/api/integrations`, Identity `/api/rbac-mongo`. Do **not** hang provider credentials or OCR
  jobs under finance. Full guide: `docs/ARCHITECTURE_NEW.md`.
- **State:** Classic `classic/src/store.js` (Postgres, archived). New `apps/new/src/runtime/state.js` (Mongo session). Auth in `packages/auth`.
  partitioned read-only domains via `stateLoader.js` / `stateDomains.js`.
- **Data access:** New screens → domain REST (`/api/finance`, `/api/property`, `/api/integrations`). Classic → Supabase
  client and/or legacy `/api/*` shims. Spreadsheet sync via ledger OAuth; Excel push via Microsoft Graph.
- **Integrations:** Evolyx passbook OCR config + jobs live in Mongo (`external_connections`, `passbook_ocr_jobs`).
  Admin + Finance-New call `/api/integrations/*`; public Evolyx callback remains `/api/passbook-webhook`.
- **Auth:** `authClient.js` + `socialAuth.js` (Google/Microsoft), MSAL callback (`microsoft-auth.html`, `ms-callback.js`).
- **RBAC & access:** `ch_ui_mode` cookie selects the store. New: Mongo identity (`rbac_directory`, `rbac_societies`, assignments) + policy. Classic: Postgres profiles/memberships/RBAC tables. Auth JWT remains Supabase.
  UI actions use `src/capabilities.js`. Fallback remains `rbac.js` / `rbacMatrix.js` until Mongo is populated.
- **Views:** lazy-activated per route (`views/controllers.js`), each `views/inits/*.js` wires view-specific init.
- **Deployment:** Vercel (`vercel.json`) — SPA rewrite to `index.html`, `api/*` serverless, cron sync, immutable assets.

---

## 10. Development Commands

### Root

- `npm run dev` → `vite`
- `npm run build` → `vite build && node scripts/verify-build-chunks.mjs`
- `npm run preview` → `vite preview`
- `npm run verify:vercel-api` → `node scripts/verify-vercel-api.mjs`
- `npm run migrate:finance-mongo` → `node scripts/migrate-finance-to-mongo.mjs`
- `npm run migrate:finance-mongo-remodel` → `node scripts/remodel-finance-mongo.mjs`
- `npm run migrate:property-mongo` → `node scripts/migrate-property-to-mongo.mjs`
- `npm run migrate:rbac-mongo` → `node scripts/migrate-rbac-to-mongo.mjs`
- `npm run migrate:auth-firebase` → `node scripts/migrate-auth-to-firebase.mjs`
- `npm run migrate:logs-mongo` → `node scripts/migrate-logs-to-mongo.mjs`
- `npm run migrate:integrations-mongo` → `node scripts/migrate-integrations-to-mongo.mjs`
- `npm run migrate:ledger-sync-mongo` → `node scripts/migrate-ledger-sync-to-mongo.mjs`
- `npm run apply:office-manager-rbac` → `node scripts/apply-office-manager-finance-rbac.mjs`
- `npm run consolidate:vendors-mongo` → `node scripts/consolidate-vendors-mongo.mjs`
- `npm run generate-repo-map` → `node scripts/utilities/generate-repo-map.js`
- `npm run check:import-boundary` → `node scripts/check-import-boundary.mjs`
- `npm run setup:hooks` → `node scripts/git-hooks/install-hooks.js`

---

*Auto-generated by `scripts/utilities/generate-repo-map.js`. Last updated: 2026-09-12.*
