# Billing & Accounting Phase 1 Deployment Notes

## Tenant Model

WMS365 Billing & Accounting is accounting for the WMS365 Master Customer, also called the 3PL Company.

- `master_customers`: the top-level 3PL company using WMS365.
- `sub_customers`: the 3PL company's client accounts. Existing `owner_accounts` seed into this table.
- `warehouses`: warehouse/location records under the master customer. Existing fulfillment locations seed into this table.
- Invoices, payments, expenses, billing activity, vendor bills, journals, and audit logs carry master-customer ownership fields.

The live app currently seeds existing data into the default master customer `WMS365 MASTER COMPANY` so current WMS365 data is not wiped or orphaned.

## Phase 1 Delivered

- Billing & Accounting module label in the WMS365 app.
- Dedicated authenticated Billing & Accounting page: `/billing-accounting`.
- Backward-compatible `/api/billing-finance` routes plus `/api/billing-accounting` alias.
- Master customer, sub-customer, and warehouse ownership tables.
- Tenant ownership columns on invoices, payments, expenses, vendors, vendor bills, billing events, journals, and audit logs.
- Invoice discounts, payment instructions, email status, and last emailed timestamp.
- Invoice attachments and invoice email log tables.
- Customer portal invoice list endpoint.
- Customer portal invoice PDF endpoint.
- Customer portal UI section for current/past invoices, total billed, unpaid balance, and PDF download.
- Safe invoice email abstraction:
  - Sends when SMTP/Resend/SendGrid settings exist.
  - Saves an invoice email draft/log when email is not configured.
- Lightweight generated invoice PDF response without adding a new rendering dependency.

## Railway Migration

Production migration was applied with:

```powershell
railway run --service wms365Scanner --environment production -- node scripts/railway-billing-finance-db.js migrate
```

Verification:

```powershell
railway run --service wms365Scanner --environment production -- node scripts/railway-billing-finance-db.js probe
```

Expected tables include:

- `master_customers`
- `warehouses`
- `sub_customers`
- `invoices`
- `invoice_lines`
- `invoice_attachments`
- `invoice_email_logs`
- `payments`
- `expenses`
- `vendor_bills`
- `journal_entries`

## Railway Deployment

Deploy command used:

```powershell
railway up --service wms365Scanner --environment production --message "Deploy Billing Accounting Phase 1"
```

Health check:

```powershell
Invoke-WebRequest -Uri https://app.wms365.co/api/health -UseBasicParsing
```

The latest verified deployment was healthy with `databaseReady: true`.

## Environment Variables

Existing email variables are used; no credentials are hardcoded.

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
- `SMTP_REPLY_TO`
- `EMAIL_PROVIDER`
- `RESEND_API_KEY`
- `SENDGRID_API_KEY`
- `PUBLIC_SITE_URL`

If email is not configured, invoice email actions save a draft/log instead of failing hard.

## Testing Checklist

- App health: `/api/health` returns `ok: true`.
- Warehouse app opens and shows `Billing & Accounting` in navigation.
- Accounting role can open Billing & Accounting.
- Warehouse worker role cannot see Billing & Accounting.
- Create a draft invoice for a sub-customer.
- Approve or send the invoice and confirm it locks.
- Download invoice PDF from the app.
- Record a partial payment and confirm balance due changes.
- Log into the customer portal as that sub-customer.
- Confirm only that sub-customer's invoices appear.
- Download invoice PDF from the customer portal.
- Add an expense and confirm P&L changes.
- Run Profit & Loss report.

## Next Zoho Replacement Work

Phase 1 is usable foundation, but Zoho replacement still needs deeper workflows:

- Full invoice attachment upload UI and backup report generation.
- Customer portal invoice backup detail screen.
- Vendor bill entry and payment UI.
- Expense receipt upload and retrieval.
- True Excel/PDF export generation for reports.
- AR aging and customer statement portal views.
- Rate-card application during invoice generation.
- Auto billing events from receiving, storage, pick/pack, shipping, labour, freight, and special projects.
- Customer profitability and warehouse profitability reports from allocated costs.
- Optional payment gateway integration for online invoice payment.
