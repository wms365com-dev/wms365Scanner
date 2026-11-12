# WMS365 Customer and Warehouse Isolation Audit

Last reviewed: 2026-08-31

## Objective

Prevent customer-to-customer and warehouse-to-warehouse disclosure across every WMS365 surface. Access requires the intersection of:

- authenticated user and active session
- assigned customer account
- assigned fulfillment warehouse
- permitted role and action
- resource state when the workflow has state-specific restrictions

A match on customer or warehouse alone is never sufficient. Super-admin access is the only platform override and remains audited.

## Mandatory Build Gate

Every production build must run `npm run audit:access-control` and the complete automated test suite. Deployment stops when any check fails.

The access-control audit must verify:

1. Global warehouse authentication precedes protected API routes.
2. Customer portal routes inherit tenant-scoping middleware.
3. Sales-order ID routes are registered after the central customer-and-warehouse guard.
4. Order lists filter by assigned customers and then assigned warehouses.
5. Documents, previews, downloads, batch printing, labels, shipments, exports, and print jobs enforce the same scope as their parent record.
6. Warehouse email recipients are derived from the order warehouse and remain private through BCC.
7. Every denied decision is written to the restricted-access audit log.
8. Customer portal resource IDs cannot be used to retrieve another customer's records.

## Required Change Review

For every feature touching business data, record the answers to these questions in the implementation or review notes:

- What customer owns the resource?
- What warehouse owns or fulfills the resource?
- Which roles can view, create, change, print, export, email, or delete it?
- Does the database query contain customer and warehouse scope before returning data?
- Are child resources such as documents, labels, shipments, and billing events checked through their parent?
- Can changing a path ID, query value, body value, or HTTP method cross either boundary?
- Do background jobs and outbound emails reconstruct and enforce the same access context?
- Are denial decisions logged without exposing confidential record contents?

## Test Matrix

Each protected resource family must include positive and negative tests for:

| User context | Resource context | Expected result |
| --- | --- | --- |
| Customer A, Warehouse 1 | Customer A, Warehouse 1 | Allow only the permitted action |
| Customer A, Warehouse 1 | Customer B, Warehouse 1 | Restrict and audit |
| Customer A, Warehouse 1 | Customer A, Warehouse 2 | Restrict and audit |
| Customer A, Warehouse 1 | Customer B, Warehouse 2 | Restrict and audit |
| Customer portal A | Customer portal B record ID | Not found or restricted; audit |
| Warehouse worker | Administrative function | Restrict and audit |
| Super admin | Any resource | Allow and retain normal activity history |

Run the matrix against screens, direct API calls, mobile, documents, previews, print jobs, PDFs, spreadsheets, email generation, integrations, and scheduled jobs.

## Test Data Rules

- Use only the designated WMS365 test company for transaction tests.
- Never create test records in a live customer account.
- Use at least two test customers and two test warehouses so both isolation boundaries are exercised.
- Roll back test transactions after verification.
- Live verification is read-only unless the user explicitly requests a real business transaction.

## Deployment Process

1. Run the access-control audit.
2. Run the complete test suite.
3. Run the rollback-only test-company workflow.
4. Deploy the exact reviewed commit.
5. Confirm Railway health and database readiness.
6. Run a post-deployment isolation canary using test users from different customers and warehouses.
7. Review new restricted-access events and production errors.
8. Stop or roll back if any cross-scope request succeeds.

## Ongoing Review

- Review restricted-access events weekly and after every security-related release.
- Escalate repeated attempts, unusual exports, batch printing, or document access to the platform owner.
- Perform a complete route and permission audit monthly.
- Perform an incident review immediately after any confirmed or suspected disclosure.
- Preserve access, print, document, and email logs needed to determine whether data was only visible, printed, downloaded, or sent.

## Industry Review

Reviewed 2026-08-31 using official sources:

- Extensiv separates warehouse and customer user types, assigns warehouse users to warehouses and customer users to customers, and recommends verifying access before credentials are provided: https://help.extensiv.com/en_US/1623698
- Extensiv defines separate Warehouse and Customer roles and warns when customer roles receive warehouse-level permissions: https://help.extensiv.com/user-setup/managing-user-roles
- ShipHero uses explicit role permissions and recommends least-privilege role configuration: https://software-help.shiphero.com/hc/en-us/articles/20710949742733-Creating-and-Managing-Roles-and-Permissions
- AWS recommends centralized policy decisions and pervasive tenant isolation instead of scattered custom endpoint logic: https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/introduction.html
- OWASP recommends deny-by-default access, authorization on every request, appropriate logging, and automated authorization tests: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP classifies missing record-level authorization as API1:2023 Broken Object Level Authorization and says every endpoint using a client-supplied record ID must check access: https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/

These sources provide workflow and security patterns only. WMS365 must not copy competitor code, text, layouts, or protected assets.
