# Customer Warehouse User Access Scope

This scope covers customer-side users who need to work in the warehouse app, not the customer portal. Example: Ken at T-Dot needs warehouse-side access for T-Dot work across the warehouses T-Dot uses, without seeing other companies in those same warehouses.

## Access Rule

Customer warehouse users must be scoped by company first.

- Give the user direct company access only to their customer account.
- Do not give the user direct fulfillment-location / warehouse access.
- Let the app show warehouse context through the company's work records and company-to-warehouse assignments.
- Never grant broad warehouse-location access when the user belongs to a customer, because warehouse access can inherit visibility into every company assigned to that warehouse.

## Current Example

Ken:

- Email: `ken@tdwtradingco.com`
- Role: `warehouse_worker`
- Direct company: `T-DOT / TDW TRADING CO`
- Direct warehouse/location access: none
- Inherited company access: none

T-Dot is assigned to these warehouses:

- `TK HOME Scarborough`
- `Fully Built - Chicago`
- `Grey Wolf 3PL - Mississauga`

Ken can work with T-Dot activity at those warehouses, but must not see other customers using those warehouses.

## Roles

Recommended roles for customer warehouse users:

- `warehouse_worker`: mobile/warehouse task execution, limited action set.
- `warehouse_customer_service`: only when the customer user truly needs order/inbound status operations.

Do not use:

- `warehouse_admin`
- `admin`
- `super_admin`

Those roles are internal/admin roles and can manage more system areas.

## Provisioning Checklist

Before creating access:

1. Confirm the user's exact email address.
2. Confirm the exact customer company account name in `owner_accounts`.
3. Confirm which warehouses the company uses in `company_fulfillment_locations`.
4. Confirm the user should not see any other company in those warehouses.
5. Generate a temporary password and send it only through the WMS365 support sender.

Database rules:

- Insert/update `app_users` with role `warehouse_worker`.
- Insert exactly one row in `app_user_company_access` for the customer company.
- Delete all rows for that user in `app_user_fulfillment_location_access`.
- Delete any direct company access rows for other companies.
- Delete any active `app_sessions` for that user after changing access, so old sessions cannot carry stale scope.

Verification rules:

- `app_users.role` is `warehouse_worker`.
- `app_users.is_active` is true.
- `app_user_company_access` has only the customer company.
- `app_user_fulfillment_location_access` has zero rows.
- Inherited companies through warehouse assignments are empty for the user.
- API queries for other companies return `403` or empty results.
- Integration create/update routes return `403`.

## UI / Product Behavior

The warehouse user admin form has an explicit "Customer Warehouse User" access profile:

- The form requires exactly one customer company.
- The form disables direct warehouse/location assignment for this profile.
- The server rejects direct warehouse/location assignment even if a crafted request bypasses the UI.
- The server rejects `warehouse_admin`, `admin`, and `super_admin` roles for this profile.
- The saved user response reports `accessProfile: "customer_warehouse_user"` so future edits reload into the same mode.

Recommended admin copy:

> Customer warehouse users see only the selected customer account. They may work with that customer's activity across assigned warehouses, but they do not receive warehouse-wide access.

## Automation Requirement

Future provisioning should use a guarded script or admin endpoint that:

- Requires a target company account.
- Requires a user email.
- Defaults to `warehouse_worker`.
- Rejects `warehouse_admin`, `admin`, and `super_admin`.
- Clears direct warehouse-location assignments.
- Verifies final access before sending the welcome email.
- Sends email only from `support@wms365.co`.
- Logs the access sweep in `activity_log`.

## Regression Tests

Backend tests cover:

- Customer warehouse user profile keeps exactly one direct company and zero direct warehouse/location grants.
- Customer warehouse user profile rejects admin roles.
- Customer warehouse user profile rejects direct warehouse/location assignment.
- Single-company worker access is reported back as `customer_warehouse_user`.

## Operational Runbook

For a future user like Ken:

1. Resolve the exact customer account name.
2. Create/update the user as `warehouse_worker`.
3. Select the "Customer Warehouse User" access profile.
4. Assign only the customer account in direct company access.
5. Confirm warehouse/location checkboxes are disabled and empty.
6. Save the user, which clears stale app sessions.
7. Run a Playwright/API sweep:
   - `/api/app/me`
   - `/api/app/companies`
   - company work lists
   - forbidden company probes
   - integration read/write probes
8. Send the welcome email from `support@wms365.co`.
