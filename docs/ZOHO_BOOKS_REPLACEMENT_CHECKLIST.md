# WMS365 Billing & Accounting: Zoho Books Replacement Checklist

Status key:
- [x] Done in WMS365
- [~] Partially done / needs production hardening
- [ ] Not done yet

## System Of Record Foundation

- [x] Run Playwright reconnaissance against Zoho Books and WMS365 Billing & Accounting.
- [~] Zoho Books authenticated successfully in a visible Playwright session for `Grey Wolf 3PL & Logistics Inc`; WMS365 Billing & Accounting still needs an authenticated WMS365 session for a true live-to-live comparison.
- [x] Run Billing & Accounting schema initialization against the production Postgres database with `DATABASE_URL` configured.
- [~] Add a formal migration runner or deployable SQL migration process instead of relying only on startup schema initialization.
- [x] Add Railway-safe migration probe/apply helper: `scripts/railway-billing-finance-db.js`.
- [x] Add first deployable SQL migration for accounting control hardening: `migrations/20260512_billing_finance_accounting_controls.sql`.
- [ ] Add API integration tests that run against a real Postgres test database.
- [x] Keep Billing & Accounting as a separate WMS365 module from the legacy Billing Ledger.
- [x] Restrict Billing & Accounting to Super Admin, Admin, Accounting, and Finance Manager roles.
- [x] Add Master Customer / 3PL Company ownership tables: `master_customers`, `sub_customers`, and `warehouses`.
- [x] Backfill existing WMS365 `owner_accounts` as sub-customers under the default master customer.

## Invoice Controls

- [x] Add sequence-backed invoice numbering with configurable prefixes, padding, and next number.
- [x] Lock invoices after they are sent, partially paid, paid, or voided.
- [x] Prevent line edits on posted/locked invoices.
- [x] Support status transitions with audit logs: draft, sent, partial, paid, overdue, void.
- [x] Add generated invoice PDF endpoint.
- [~] Replace lightweight PDF output with richer branded PDF templates.
- [x] Add email invoice action with safe draft/log fallback.
- [ ] Add real email delivery templates/settings.
- [~] Add credit note table and basic data model.
- [ ] Add full credit note workflow and accounting postings.
- [~] Add recurring invoice fields.
- [ ] Add recurring invoice scheduler/generation.
- [~] Add customer portal invoice viewing and PDF download.
- [ ] Add customer statement generation.

## Payments And Customer Credits

- [~] Track payments and basic invoice allocation.
- [x] Prevent allocations that exceed payment amount or invoice balance.
- [x] Track overpayments as customer credit balances.
- [x] Post payment journals with unapplied amounts to a customer credits liability account.
- [ ] Add multi-invoice allocation UI.
- [ ] Add customer credit application workflow.

## Accounting Controls

- [~] Post automatic journal entries for invoices, payments, and expenses.
- [~] Make posted journal entries immutable.
- [x] Add reversing journal entries.
- [ ] Add accounting periods and period close/lock controls.
- [ ] Add retained earnings/year-end close handling.
- [ ] Add AR/AP subledger reconciliation reports.
- [x] Add validation that every journal entry balances before posting.

## Canadian Tax Center

- [~] Seed Canadian HST/GST/PST tax codes.
- [~] Track tax collected, tax paid, and tax payable summary.
- [ ] Add province-specific tax selection rules.
- [ ] Add customer/vendor tax exemptions.
- [ ] Add tax-inclusive and tax-exclusive line handling.
- [ ] Add filing-period tax reports.

## Banking

- [~] Add bank accounts and manual bank transactions.
- [ ] Add CSV import parser.
- [ ] Add transaction matching rules.
- [ ] Add reconciliation workflow with matched/unmatched status.
- [ ] Post bank transactions to the general ledger.

## Payables And Expenses

- [~] Track vendors and expenses.
- [~] Add vendor bill/vendor payment tables.
- [ ] Add full vendor bill UI.
- [ ] Add full vendor payment UI.
- [ ] Post AP bills and vendor payments separately from expenses.
- [ ] Add receipt attachment storage/retrieval workflow.

## Warehouse Billing Automation

- [~] Create billing events and invoice from approved billing events.
- [ ] Auto-create billing events for every listed warehouse activity type.
- [ ] Add billing leakage report from unbilled warehouse activity.
- [ ] Add monthly minimum/rate-card enforcement during invoice generation.
- [ ] Add customer-specific rate-card override resolution.
- [ ] Add rate history review UI.

## Reports And Exports

- [~] Add core report endpoint for P&L, balance sheet, cash flow, trial balance, general ledger, AR aging, and profitability.
- [ ] Harden financial statements from journal ledger balances, not dashboard approximations.
- [ ] Add true Excel export files.
- [ ] Add true PDF report files.
- [~] Add CSV-style exports.
- [ ] Add date/customer/warehouse/category/status filters to every export/report.

## Production Readiness

- [x] Deploy Billing & Finance module code to Railway production service `wms365Scanner`.
- [x] Deploy Billing & Accounting Phase 1 to Railway production service `wms365Scanner`.
- [ ] Add Playwright coverage for role visibility: finance users can see the module, warehouse workers cannot.
- [ ] Add Playwright coverage for invoice creation, payment allocation, expense posting, and P&L output.
- [ ] Add audit log viewer/filtering in the UI.
- [ ] Add import/export recovery procedures for accountants.
- [ ] Add future integration adapter boundaries for Zoho Books, QuickBooks, Stripe, bank feeds, payroll, multi-company, and multi-currency.

## Playwright Zoho Books Gap Check

Observed in the authenticated Zoho Books account:

- [x] Zoho account context: `Grey Wolf 3PL & Logistics Inc`, all locations.
- [x] Zoho left rail areas identified: Home, Items, Inventory, Sales, Purchases, Time Tracking, Banking, Filing & Compliance, Accountant, Reports, Documents.
- [x] WMS365 already covers warehouse-native Items/Inventory workflows outside Billing & Accounting.
- [~] WMS365 Billing & Accounting covers invoices, payments, expenses, vendors, banking, accounting, tax, reports, and exports in one module, but the live WMS365 page comparison still requires login.
- [ ] Match Zoho Sales invoice workflow end to end: create invoice, save draft, approve/send, email PDF, record partial payment, show invoice aging.
- [ ] Match Zoho Purchases workflow end to end: create vendor bill, attach receipt, mark unpaid/paid/overdue, record vendor payment, post AP journal.
- [ ] Match Zoho Banking workflow end to end: manual transaction, CSV import, matching, reconciliation, and ledger posting.
- [ ] Match Zoho Accountant workflow: chart of accounts, journals, trial balance, general ledger, accountant export packet.
- [ ] Match Zoho Reports workflow: P&L, balance sheet, cash flow, tax reports, AR/AP aging, customer statements, and export to CSV/PDF/Excel.
- [ ] Match Zoho Documents/backups workflow: invoice attachments, generated warehouse billing backup, portal download, and dispute/question handling.
- [ ] Add a repeatable Playwright comparison spec that logs into both apps with saved auth state and captures screenshots plus nav/field inventories.
