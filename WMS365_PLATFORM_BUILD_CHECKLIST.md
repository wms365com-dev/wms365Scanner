# WMS365 Platform Architecture Build Checklist

This checklist is the release contract for the WMS365 platform upgrade. A section is
complete only when every acceptance item is checked and backed by an automated test or
documented production verification.

## Release Rules

- [x] Existing customer portal, warehouse, mobile, Shopify, billing, and printing tests pass.
- [x] Schema changes exist in both `migrations/` and the boot-time schema in `server.js`.
- [x] New writes are tenant-scoped and warehouse-scoped where applicable.
- [x] External write operations are idempotent.
- [x] Unexpected errors remain private and provide a customer-safe support reference.
- [ ] Production deployment is staged, health checked, and rollback-compatible.
- [x] No billing email is sent while billing email delivery remains paused.

## 1. Versioned Partner API

- [x] Stable `/api/v1` namespace.
- [x] Consistent success envelope: `data`, `meta`, and optional `links`.
- [x] Consistent error envelope: `error.code`, `error.message`, `error.requestId`.
- [x] Cursor pagination with bounded page sizes.
- [x] Filtering by company-safe identifiers, status, and date ranges.
- [x] Stable external IDs for orders, shipments, inventory, and jobs.
- [x] `Idempotency-Key` required for external writes.
- [x] Replayed requests return the original result without duplicate writes.
- [x] Rate limiting and audit logging.
- [x] Test and production credentials are isolated.

## 2. Customer Orders and Warehouse Shipments

- [x] Customer order remains the commercial request.
- [x] One order can own multiple warehouse shipments.
- [x] Every shipment belongs to exactly one fulfillment warehouse.
- [x] Shipment lines reference customer order lines.
- [x] Split-location release creates one shipment per required warehouse.
- [x] Pick ticket and packing slip are shipment-specific.
- [x] Carrier, tracking, BOL, shipment documents, pallet counts, and shipped date are shipment-specific.
- [x] Short-shipped quantities are recorded per shipment line.
- [x] Customer notifications summarize every shipment and shortage.
- [x] Existing single-location orders remain compatible.
- [x] Reopening or editing an order cannot orphan shipment records or allocations.

## 3. Inventory Transaction Service

- [x] Append-only inventory ledger exists.
- [x] Database trigger prevents ledger updates and deletes.
- [x] Every receive mutation uses the shared inventory transaction service.
- [x] Every move mutation uses the shared inventory transaction service.
- [x] Every adjustment mutation uses the shared inventory transaction service.
- [x] Every hold and release-from-hold mutation uses the shared service.
- [x] Every allocation, pick, unpick, ship, cancellation, and reversal is recorded.
- [x] Transactions include company, warehouse, location, SKU, lot, expiry, actor, device, source, and idempotency key.
- [x] Inventory cannot be negative under concurrent operations.
- [x] Reversal operations append compensating entries and never edit history.

## 4. Asynchronous Bulk Jobs

- [x] Bulk imports return a job ID immediately.
- [x] Job states: queued, running, completed, completed-with-warnings, failed, cancelled.
- [x] Row states: accepted, warning, rejected.
- [x] Worker claims are atomic and stale claims are recoverable.
- [x] Retry count and next retry time are visible.
- [x] Progress totals are visible to authorized users.
- [x] Original file checksum prevents accidental duplicate jobs.
- [x] Downloadable CSV error report includes row, field, message, and suggested correction.
- [x] Customer and warehouse application screens expose only their permitted jobs.
- [x] Large jobs do not block web requests.

## 5. Billing Transactions

- [x] Structured billing event table exists.
- [x] Event keys support duplicate prevention.
- [x] Receiving completion emits configured receiving and pallet events.
- [x] Shipment completion emits processing, carton, pallet, document, rush, freight, and labour events.
- [x] Storage events are generated from reviewed snapshots.
- [x] Events remain reviewable before invoicing.
- [x] Approved events lock their source facts.
- [x] Corrections use void or credit events instead of history edits.
- [x] Billing email delivery remains paused until explicitly enabled.
- [x] Billing audit reconciles operational records to billing events.

## 6. Warehouse Tasks

- [x] Shared warehouse task model exists.
- [x] Receiving, putaway, pick, pack, ship, count, replenishment, kitting, and exception task types exist.
- [x] Every operational order and inbound status transition creates or advances the correct task.
- [x] Task claims are atomic and idempotent.
- [x] Assignment, worker, device, timestamps, exception, and completion evidence are retained.
- [x] Repeated button presses cannot duplicate transitions.
- [x] Blocked tasks show the reason and next action.
- [x] RUSH and not-yet-ready work are clearly prioritized.
- [x] Task history is append-only and available to authorized warehouse users.

## 7. Cycle Counts and Variances

- [x] Count records track system quantity, counted quantity, and variance.
- [x] Counts require review before posting.
- [x] Variance thresholds classify count approval severity.
- [x] Questionable stock can be moved to the warehouse investigation location.
- [x] Count posting and investigation movement are one atomic transaction.
- [x] Recounts preserve prior attempts.
- [x] Approval records reviewer, reason, and evidence.
- [x] Customer availability excludes pending and investigation quantities.

## 8. OAuth and Scoped Integrations

- [x] Customer-approved integration applications.
- [x] Hashed client secrets and refresh tokens.
- [x] Short-lived access tokens.
- [x] Revocable refresh tokens.
- [x] Scopes include inventory read, order read/write, shipment read/write, and job read/write.
- [x] Tokens are restricted to assigned customer companies.
- [x] Test and production applications are separated.
- [x] Token issuance, refresh, use, and revocation are audited.
- [x] Secrets are displayed only once.

## 9. API Documentation and Changelog

- [x] OpenAPI document for every `/api/v1` endpoint.
- [x] Authentication, pagination, idempotency, and filtering documentation.
- [x] Example order, split shipment, inventory adjustment, and bulk job workflows.
- [x] Documentation page.
- [x] Versioned changelog with breaking-change labels.
- [x] Deprecation policy and sunset dates.
- [x] Contract tests verify the OpenAPI document matches live routes.

## Final Verification

- [x] Fresh database boot migration passes.
- [x] Existing production-like database migration passes.
- [x] Full automated test suite passes.
- [x] Test-company customer order creates correct single and split shipments.
- [x] Test-company inbound, receiving, putaway, count, investigation, pick, stage, and shipment flows pass.
- [x] Duplicate external requests create no duplicate records.
- [x] Bulk job failure produces a useful downloadable report.
- [x] Billing events reconcile without sending billing emails.
- [x] Partner API authorization cannot cross customer boundaries.
- [ ] Production health, logs, and smoke tests pass after deployment.
