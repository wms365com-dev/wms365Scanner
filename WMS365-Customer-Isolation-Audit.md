# WMS365 Customer Isolation Audit

Date: 2026-05-23

## Summary

Customer portal isolation has been hardened with centralized account scoping, route-level portal permissions, defensive resource ownership checks, and automated cross-account attack tests.

The portal now enforces customer scope before every `/api/portal/*` route except login and recovery endpoints. Any top-level account/company/customer parameters in portal requests must match the logged-in portal account. Direct document and invoice ID guessing is hidden behind `404` responses and logged as suspicious activity.

## Routes Audited

Protected by centralized portal session and account-scope middleware:

- `GET /api/portal/me`
- `POST /api/portal/logout`
- `POST /api/portal/feedback`
- `GET /api/portal/inventory`
- `GET /api/portal/inventory/export.csv`
- `GET /api/portal/items`
- `POST /api/portal/items`
- `PUT /api/portal/items/:id`
- `GET /api/portal/orders`
- `POST /api/portal/orders`
- `PUT /api/portal/orders/:id`
- `POST /api/portal/orders/:id/archive`
- `POST /api/portal/orders/:id/documents`
- `POST /api/portal/orders/:id/release`
- `GET /api/portal/ship-to-addresses`
- `GET /api/portal/inbounds`
- `POST /api/portal/inbounds`
- `POST /api/portal/inbounds/:id/documents`
- `GET /api/portal/kitting-requests`
- `POST /api/portal/kitting-requests`
- `GET /api/portal/delivery-appointments`
- `POST /api/portal/delivery-appointments`
- `GET /api/portal/invoices`
- `GET /api/portal/invoices/:id/pdf`
- `GET /api/portal/invoices/:id/attachments`
- `GET /api/portal/order-documents/:id`
- `GET /api/portal/inbound-documents/:id`

Public portal endpoints:

- `POST /api/portal/login`
- `POST /api/portal/recovery/username`
- `POST /api/portal/recovery/password`

## Fixes Implemented

- Added `portal_permissions` to `portal_vendor_access`.
- Added migration: `migrations/20260523_portal_customer_isolation.sql`.
- Added centralized portal permission keys:
  - `inventory-only`
  - `order-entry`
  - `document-access`
  - `billing`
  - `admin`
- Added centralized portal route rules through `getPortalRouteRule`.
- Added centralized request account-scope validation through `assertPortalRequestAccountScope`.
- Added portal resource ownership validation through `assertPortalResourceAccount`.
- Added suspicious cross-account access logging through `logPortalScopeViolation`.
- Hardened portal session validation to reject sessions without a valid customer account/email.
- Hardened direct document/invoice access:
  - invoice PDF ID tampering
  - invoice attachment ID tampering
  - outbound order document ID tampering
  - inbound document ID tampering
- Added desktop portal user permission controls.
- Added automated tests in `portal-isolation.spec.js`.
- Added `npm run test:portal-isolation`.

## Permission Matrix

| Portal Area | Permission Required |
| --- | --- |
| Inventory page | `inventory-only` |
| Inventory export | `inventory-only` |
| Item lookup | `inventory-only` |
| Item create/update | `admin` |
| Orders | `order-entry` |
| Ship-to addresses | `order-entry` |
| Inbounds | `order-entry` |
| Delivery appointments | `order-entry` |
| Kitting requests | `order-entry` |
| Order documents | `document-access` |
| Inbound documents | `document-access` |
| Invoices | `billing` |
| Invoice PDFs | `billing` |
| Invoice attachments | `billing` |
| Feedback | authenticated customer portal user |

## Automated Tests Added

`portal-isolation.spec.js` verifies:

- Query string account tampering is rejected.
- Body account tampering is rejected.
- Same-account parameters are allowed.
- Direct document/invoice ID guessing is hidden with `404`.
- Inventory export requires inventory permission.
- Document routes require document access.
- Billing routes require billing access.
- Portal item maintenance requires admin permission.

## Remaining Recommendations

- Add database foreign keys where portal records can safely reference a canonical `owner_accounts.id` instead of relying on `account_name` text.
- Backfill `portal_vendor_access.portal_permissions` for existing portal users after deciding which users should receive billing/admin access.
- Add end-to-end browser/API tests against a real test database with two seeded customers and real portal sessions.
- Consider recursive account-parameter scanning for selected JSON payloads after confirming it will not block legitimate ship-to/contact company names.
- Add a customer-visible permissions page later if customers will self-manage portal users.
- Add alerting for repeated `security` activity log entries from the same portal user/IP.
