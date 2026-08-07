# CommunityHub / ApartmentMaintenance — Repository Map

> **Project:** ApartmentMaintenance (CommunityHub) — Vite + vanilla JS + Supabase single-page app.
> **Stack:** Vite (vite build) · vanilla JS modules · Supabase (Postgres + RLS) · Vercel serverless `api/*.js` endpoints · ExcelJS/PDF/Quill.
> **Conventions:** SQL migrations as `supabase_*.sql` at repo root; feature modules in `src/`; UI in `index.html` + `src/style.css`; serverless handlers in `api/`.

---

## 1. Repository Overview

```
├── .cursor
├── .github
│   └── workflows
│       └── repo-map-check.yml
├── api
│   ├── accountsAuth.js
│   ├── auth-session.js
│   ├── dashboard-summary.js
│   ├── db.js
│   ├── dbAccess.js
│   ├── evolyxConnection.js
│   ├── external-connections.js
│   ├── external-proxy.js
│   ├── finance-mutations.js
│   ├── oauth-microsoft.js
│   ├── oauth-service.js
│   ├── passbook-jobs.js
│   ├── passbook-parse.js
│   ├── passbook-webhook.js
│   ├── passbookJobsStore.js
│   ├── r2Storage.js
│   ├── rpc.js
│   ├── serverAuth.js
│   ├── serverSupabase.js
│   ├── state.js
│   ├── stateDomains.js
│   ├── storage.js
│   ├── supabaseRest.js
│   ├── sync.js
│   ├── vercelRequest.js
│   └── workspace-boot.js
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
│   │       ├── supabase_resident_invites.sql
│   │       ├── supabase_resident_portal.sql
│   │       ├── supabase_residents_unified.sql
│   │       ├── supabase_restore_system_admin.sql
│   │       ├── supabase_rls_operational.sql
│   │       ├── supabase_security_portal.sql
│   │       ├── supabase_society_admin_role.sql
│   │       ├── supabase_society_assets.sql
│   │       ├── supabase_society_notices.sql
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
│   ├── finance-reports-preview.html
│   ├── finance-reports-preview.md
│   ├── PHASED_REQUIREMENTS.md
│   └── REPO_MAP.md
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
│   ├── capture-finance-screenshots.mjs
│   ├── mockFinanceState.js
│   ├── verify-build-chunks.mjs
│   └── verify-vercel-api.mjs
├── src
│   ├── assets
│   ├── views
│   │   ├── html
│   │   │   ├── access-control.html
│   │   │   ├── accounts.html
│   │   │   ├── apartment.html
│   │   │   ├── dashboard.html
│   │   │   ├── email.html
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
│   ├── authClient.js
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
├── .cursorrules
├── .gitignore
├── AGENTS.md
├── index.html
├── microsoft-auth.html
├── package-lock.json
├── package.json
├── supabase_activity_audit_notifications.sql
├── supabase_activity_audit_review.sql
├── supabase_apartment_finance_state.sql
├── supabase_gate_parcels.sql
├── supabase_ledger_oauth.sql
├── supabase_ledger_spreadsheet_sync.sql
├── supabase_ledger_sync_journal.sql
├── supabase_ledger_sync_run_logs.sql
├── supabase_ledger_sync_service_account.sql
├── supabase_module_access.sql
├── supabase_notice_delivery.sql
├── supabase_page_access.sql
├── supabase_property_manager_permissions.sql
├── supabase_society_role_rbac.sql
├── supabase_user_directory_rls.sql
├── supabase_visitor_approvals.sql
├── vercel.json
├── vite.config.js
└── viteApiDev.js

```

**Scale:** ~146 JavaScript modules, ~10 CSS files, ~15 HTML entry pages.

---

## 2. `src/` — Frontend Feature Modules

The SPA is modular: `src/main.js` boots → `src/store.js` hydrates state → `src/navigation.js` maps routes →
`src/views/controllers.js` lazily activates the active view's feature modules (dynamic `import()`, keeping the initial bundle small).

### Directory tree

```
├── assets
├── views
│   ├── html
│   │   ├── access-control.html
│   │   ├── accounts.html
│   │   ├── apartment.html
│   │   ├── dashboard.html
│   │   ├── email.html
│   │   ├── invoices.html
│   │   ├── operations.html
│   │   ├── portal.html
│   │   ├── portfolio.html
│   │   ├── registry.html
│   │   ├── security.html
│   │   ├── setup.html
│   │   └── units.html
│   ├── inits
│   │   ├── accounts.js
│   │   ├── apartment.js
│   │   ├── dashboard.js
│   │   ├── email.js
│   │   ├── invoices.js
│   │   ├── operations.js
│   │   ├── portal.js
│   │   ├── portfolio.js
│   │   ├── registry.js
│   │   ├── security.js
│   │   ├── setup.js
│   │   └── units.js
│   ├── controllers.js
│   └── viewShell.js
├── accessLocks.js
├── accessRequests.js
├── accessSync.js
├── activityAudit.js
├── admin.js
├── allocation.js
├── apiJson.js
├── authClient.js
├── authShell.js
├── authUserKind.js
├── bankClassificationRules.js
├── bankReconciliation.js
├── bankStatementLineUtils.js
├── bankStatementOrdering.js
├── billingBatches.js
├── billingGroups.js
├── billingHeads.js
├── blockFilter.js
├── bulkCollectionImport.js
├── bulkInvoiceImport.js
├── buttonBusy.js
├── cashFloat.js
├── classifyCombobox.js
├── classifyOptions.js
├── counter.js
├── dashboard.css
├── dashboard.js
├── dbClient.js
├── duesAging.js
├── emailOutbox.js
├── expenseCategories.js
├── expensePlan.js
├── externalConnections.js
├── externalFetch.js
├── financeAnalytics.js
├── financeApi.js
├── financeDocuments.js
├── financeMobile.css
├── financeReportsExport.js
├── finances.js
├── flatPicker.js
├── gateWizard.css
├── gateWizard.js
├── generalLedger.js
├── invoicePdf.js
├── invoicesRaisedPage.js
├── ledgerBalance.js
├── ledgerColumnMapping.js
├── ledgerDisplayRows.js
├── ledgerExport.js
├── ledgerFilter.js
├── ledgerOAuth.js
├── ledgerSheetRegion.js
├── ledgerSpreadsheetSync.js
├── ledgerStatementContext.js
├── ledgerSync.css
├── ledgerSyncApply.js
├── ledgerSyncImport.js
├── ledgerSyncJournal.js
├── ledgerSyncLog.js
├── ledgerSyncRunAudit.js
├── ledgerTable.js
├── ledgerTransform.js
├── ledgerTxnLocal.js
├── main.js
├── mainBoot.js
├── maintenanceBilling.js
├── microsoftExcelPush.js
├── moduleAccess.css
├── moduleAccess.js
├── moduleAccessAdmin.js
├── ms-callback.js
├── navigation.js
├── nobrokerInvoicesRaised.js
├── noticeDelivery.js
├── noticeEditor.js
├── notices.css
├── notices.js
├── operations.js
├── pageAccess.css
├── pageAccess.js
├── pageAccessAdmin.js
├── pageAccessResolve.js
├── parkingImport.js
├── parkingOps.js
├── parkingReconcileUi.js
├── passbookEvolyx.js
├── passbookJobImportAnalysis.js
├── payments.js
├── penaltyRules.js
├── portfolio.js
├── rbac.js
├── rbacMatrix.js
├── registry.js
├── residentImport.js
├── residentLinks.js
├── residentPortal.js
├── residents.js
├── residentView.js
├── securityPortal.css
├── securityPortal.js
├── setupSocietyUi.js
├── socialAuth.js
├── staffNotifications.js
├── stateLoader.js
├── store.js
├── style.css
├── syncCodeEditor.js
├── transitionFees.js
├── unitDirectory.js
├── unitTransitions.js
├── vehicleAudit.js
├── visitorApprovals.js
├── visitorGate.js
├── visitors.css
└── visitors.js

```

### Feature module index

| File | Purpose |
| --- | --- |
| src/accessLocks.js | Access lock guard (HMR-safe) |
| src/accessRequests.js | Access request handling |
| src/accessSync.js | Access user directory sync |
| src/activityAudit.js | Activity audit log page |
| src/admin.js | Setup subview switching & admin helpers |
| src/allocation.js | Parking slot allocation |
| src/apiJson.js | API JSON request helpers |
| src/authClient.js | Auth client & session handling |
| src/authShell.js | Auth UI shell |
| src/authUserKind.js | auth User Kind |
| src/bankClassificationRules.js | Bank statement classification rules |
| src/bankReconciliation.js | Bank reconciliation UI |
| src/bankStatementLineUtils.js | Bank statement line utilities |
| src/bankStatementOrdering.js | Bank statement line ordering |
| src/billingBatches.js | Billing batch history |
| src/billingGroups.js | Billing groups & group units |
| src/billingHeads.js | Maintenance charge heads |
| src/blockFilter.js | Block filter helper |
| src/bulkCollectionImport.js | Bulk collection import |
| src/bulkInvoiceImport.js | Bulk invoice import |
| src/buttonBusy.js | Busy-state button helper |
| src/cashFloat.js | Cash float management |
| src/classifyCombobox.js | Classification combobox |
| src/classifyOptions.js | Classification options |
| src/counter.js | Counter helper |
| src/dashboard.css | Dashboard styles |
| src/dashboard.js | Dashboard render |
| src/dbClient.js | Supabase client + apartment state fetch |
| src/duesAging.js | Dues aging report |
| src/emailOutbox.js | Email outbox |
| src/expenseCategories.js | Expense categories |
| src/expensePlan.js | Expense plan & recurring items |
| src/externalConnections.js | External connections (admin) |
| src/externalFetch.js | External fetch helpers |
| src/financeAnalytics.js | Finance reports & analytics |
| src/financeApi.js | Finance API client |
| src/financeDocuments.js | Bills & receipts document management |
| src/financeMobile.css | Mobile finance styles |
| src/financeReportsExport.js | Export finance reports (Excel) |
| src/finances.js | Cash & bank ledger engine + processFinances |
| src/flatPicker.js | Flat (units) picker helper |
| src/gateWizard.css | Gate wizard styles |
| src/gateWizard.js | Gate wizard / visitor check-in flow |
| src/generalLedger.js | General ledger entry management |
| src/invoicePdf.js | Invoice PDF generation & share |
| src/invoicesRaisedPage.js | Invoices-raised list page |
| src/ledgerBalance.js | Ledger balance computation |
| src/ledgerColumnMapping.js | Ledger column mapping for imports |
| src/ledgerDisplayRows.js | Ledger table row rendering |
| src/ledgerExport.js | Ledger export |
| src/ledgerFilter.js | Ledger filtering |
| src/ledgerOAuth.js | Bank OAuth connections for ledger sync |
| src/ledgerSheetRegion.js | Spreadsheet region detection |
| src/ledgerSpreadsheetSync.js | Spreadsheet sync panel (admin-sync) |
| src/ledgerStatementContext.js | Bank statement context helpers |
| src/ledgerSync.css | Ledger sync styles |
| src/ledgerSyncApply.js | Apply ledger sync rows |
| src/ledgerSyncImport.js | Ledger sync import |
| src/ledgerSyncJournal.js | Ledger sync journal |
| src/ledgerSyncLog.js | Ledger sync run log |
| src/ledgerSyncRunAudit.js | Ledger sync run audit UI |
| src/ledgerTable.js | Ledger table rendering |
| src/ledgerTransform.js | Ledger row transform helpers |
| src/ledgerTxnLocal.js | Local (offline) ledger transactions |
| src/main.js | Entry point / primary boot sequence & view coordination |
| src/mainBoot.js | Shared boot helpers (access mappings, resident rendering, apartment options) |
| src/maintenanceBilling.js | Maintenance billing engine + invoices page |
| src/microsoftExcelPush.js | Push finance data to Excel via Microsoft Graph |
| src/moduleAccess.css | Module access styles |
| src/moduleAccess.js | Module-level access / isModuleEnabled |
| src/moduleAccessAdmin.js | Module access admin panel |
| src/ms-callback.js | Microsoft (MSAL) auth redirect callback |
| src/navigation.js | Modules, pages, routing & permission gating (NAV_MODULES) |
| src/nobrokerInvoicesRaised.js | NoBroker invoices-raised list |
| src/noticeDelivery.js | Notice delivery |
| src/noticeEditor.js | Notice editor |
| src/notices.css | Notices styles |
| src/notices.js | Notices feature |
| src/operations.js | operations |
| src/pageAccess.css | Page access styles |
| src/pageAccess.js | Page-level access |
| src/pageAccessAdmin.js | Page access admin panel |
| src/pageAccessResolve.js | Page access route resolution |
| src/parkingImport.js | Parking data import |
| src/parkingOps.js | Parking operations UI refresh |
| src/parkingReconcileUi.js | Parking reconciliation UI |
| src/passbookEvolyx.js | Evolyx passbook job handling |
| src/passbookJobImportAnalysis.js | Passbook job import analysis |
| src/payments.js | Payments / collections |
| src/penaltyRules.js | Maintenance penalty rules |
| src/portfolio.js | Portfolio rollup view |
| src/rbac.js | RBAC: roles, permissions, effective-role resolution |
| src/rbacMatrix.js | RBAC permission matrix UI |
| src/registry.js | Parking & vehicle registry (offline-first) + analytics |
| src/residentImport.js | Resident import (Excel/CSV) |
| src/residentLinks.js | Resident ↔ unit link admin |
| src/residentPortal.js | Resident self-service portal subviews |
| src/residents.js | Residents CRUD |
| src/residentView.js | Resident detail view |
| src/securityPortal.css | Security portal styles |
| src/securityPortal.js | Security gate portal (gate desk / visitor log / passes) |
| src/setupSocietyUi.js | setup Society Ui |
| src/socialAuth.js | Social provider sign-in (Google / Microsoft) |
| src/staffNotifications.js | Staff notifications UI |
| src/stateLoader.js | Domain loaders & STATE_DOMAINS registry for partitioned state |
| src/store.js | Central state (portalState) + Supabase client + pullState hydration |
| src/style.css | Global styles |
| src/syncCodeEditor.js | Sync code editor |
| src/transitionFees.js | Transition fee computation |
| src/unitDirectory.js | Unit directory (block/bhk/area) |
| src/unitTransitions.js | Move-in / move-out transition wizard |
| src/vehicleAudit.js | Vehicle audit log & badge refresh |
| src/visitorApprovals.js | Visitor approvals workflow |
| src/visitorGate.js | Gate-side visitor handling |
| src/visitors.css | Visitors styles |
| src/visitors.js | Visitor log UI |

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
| property-activity | Activity Log | accounts | activity |
| finance-ledger | Ledger | accounts | ledger |
| finance-docs | Bills & receipts | accounts | finance-docs |
| finance-expense-plan | Expense plan | accounts | expense-plan |
| finance-billing-pending | Pending Dues | invoices | pending-dues |
| finance-billing-list | All Invoices | invoices | list |
| finance-billing-collections | Collections | invoices | collections |
| finance-billing-batches | Billing Batches | invoices | batches |
| finance-billing-aging | Aging Report | invoices | aging |
| finance-bank-recon | Bank Reconciliation | accounts | bank-recon |
| finance-activity | Activity Log | accounts | activity |
| finance-reports | Reports & Reconciliation | accounts | reports |
| finance-invoices-raised | Invoices Raised | accounts | invoices-raised |
| admin-access | Roles | access-control | — |
| admin-society | Society Profile | setup | society |
| admin-bank | Bank Account | setup | bank |
| admin-vendors | Vendors | setup | vendors |
| admin-subcats | Sub-categories | setup | subcats |
| admin-staff | Staff Directory | setup | staff |
| admin-connections | External Connections | setup | connections |
| admin-sync | Spreadsheet Sync | setup | sync |
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
├── accountsAuth.js
├── auth-session.js
├── dashboard-summary.js
├── db.js
├── dbAccess.js
├── evolyxConnection.js
├── external-connections.js
├── external-proxy.js
├── finance-mutations.js
├── oauth-microsoft.js
├── oauth-service.js
├── passbook-jobs.js
├── passbook-parse.js
├── passbook-webhook.js
├── passbookJobsStore.js
├── r2Storage.js
├── rpc.js
├── serverAuth.js
├── serverSupabase.js
├── state.js
├── stateDomains.js
├── storage.js
├── supabaseRest.js
├── sync.js
├── vercelRequest.js
└── workspace-boot.js

```

### Endpoint index

| Endpoint | Purpose |
| --- | --- |
| accountsAuth.js | Accounts/session auth endpoint |
| auth-session.js | Auth session endpoint |
| dashboard-summary.js | Dashboard summary endpoint |
| db.js | DB access (Supabase) |
| dbAccess.js | DB access helpers |
| evolyxConnection.js | Evolyx external connection |
| external-connections.js | External connections read/write |
| external-proxy.js | External API proxy |
| finance-mutations.js | Finance write mutations |
| oauth-microsoft.js | Microsoft OAuth flow |
| oauth-service.js | OAuth service helper |
| passbook-jobs.js | Evolyx passbook jobs |
| passbook-parse.js | Passbook file parsing |
| passbook-webhook.js | Passbook webhook |
| passbookJobsStore.js | Passbook jobs store helper |
| r2Storage.js | S3/R2 storage upload |
| rpc.js | Postgres RPC endpoint (with maxDuration) |
| serverAuth.js | Server-side auth helpers |
| serverSupabase.js | Serverless endpoint |
| state.js | State hydration endpoint |
| stateDomains.js | State domain data |
| storage.js | File storage |
| supabaseRest.js | Supabase REST helper |
| sync.js | Scheduled sync (Vercel cron) |
| vercelRequest.js | Vercel request helper |
| workspace-boot.js | Workspace boot helper |

---

## 5. `scripts/` — Root Tooling

```
├── git-hooks
│   ├── install-hooks.js
│   └── pre-push.js
├── utilities
│   └── generate-repo-map.js
├── capture-finance-screenshots.mjs
├── mockFinanceState.js
├── verify-build-chunks.mjs
└── verify-vercel-api.mjs

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
│       ├── supabase_resident_invites.sql
│       ├── supabase_resident_portal.sql
│       ├── supabase_residents_unified.sql
│       ├── supabase_restore_system_admin.sql
│       ├── supabase_rls_operational.sql
│       ├── supabase_security_portal.sql
│       ├── supabase_society_admin_role.sql
│       ├── supabase_society_assets.sql
│       ├── supabase_society_notices.sql
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
├── finance-reports-preview.html
├── finance-reports-preview.md
├── PHASED_REQUIREMENTS.md
└── REPO_MAP.md

```

`PHASED_REQUIREMENTS.md` is the product spec (phases/sprints) — hand it to an agent to implement features in order.

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
| `supabase_activity_audit_notifications.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_activity_audit_review.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_apartment_finance_state.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_gate_parcels.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_ledger_oauth.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_ledger_spreadsheet_sync.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_ledger_sync_journal.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_ledger_sync_run_logs.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_ledger_sync_service_account.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_module_access.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_notice_delivery.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_page_access.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_property_manager_permissions.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_society_role_rbac.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_user_directory_rls.sql` | Supabase SQL migration (run manually in SQL Editor) |
| `supabase_visitor_approvals.sql` | Supabase SQL migration (run manually in SQL Editor) |

---

## 8. Root Configuration

| File | Purpose |
| --- | --- |
| AGENTS.md | Repo config / entry point |
| index.html | Repo config / entry point |
| microsoft-auth.html | Repo config / entry point |
| package.json | Repo config / entry point |
| vercel.json | Repo config / entry point |
| vite.config.js | Repo config / entry point |
| viteApiDev.js | Repo config / entry point |

---

## 9. Key Architectural Concepts

- **State:** `src/store.js` — `portalState` (units, slots, finances, access, community) hydrated by `pullState()`;
  partitioned read-only domains via `stateLoader.js` / `stateDomains.js`.
- **Data access:** browser → Supabase client (`src/dbClient.js`) and/or Vercel `/api/*` endpoints; admin/finance
  mutations go through `api/finance-mutations.js`. Spreadsheet sync via `api/ledger*`, Excel push via Microsoft Graph.
- **Auth:** `authClient.js` + `socialAuth.js` (Google/Microsoft), MSAL callback (`microsoft-auth.html`, `ms-callback.js`).
- **RBAC & access:** `rbac.js` / `rbacMatrix.js` (roles/permissions), `moduleAccess*`, `pageAccess*`, `accessSync.js`.
- **Views:** lazy-activated per route (`views/controllers.js`), each `views/inits/*.js` wires view-specific init.
- **Deployment:** Vercel (`vercel.json`) — SPA rewrite to `index.html`, `api/*` serverless, cron sync, immutable assets.

---

## 10. Development Commands

### Root

- `npm run dev` → `vite`
- `npm run build` → `vite build && node scripts/verify-build-chunks.mjs`
- `npm run preview` → `vite preview`
- `npm run verify:vercel-api` → `node scripts/verify-vercel-api.mjs`
- `npm run generate-repo-map` → `node scripts/utilities/generate-repo-map.js`
- `npm run setup:hooks` → `node scripts/git-hooks/install-hooks.js`

---

*Auto-generated by `scripts/utilities/generate-repo-map.js`. Last updated: 2026-08-07.*
