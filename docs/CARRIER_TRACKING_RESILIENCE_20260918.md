# Carrier Tracking Resilience

Review date: 2026-09-18. Priority: high.

## Scope

Revision `carrier-resilience-20260918-v6` strengthens the isolated carrier worker.
It does not change order processing, inventory, billing, permissions, database
schemas, or customer notification settings.

Customer value: more reliable delivery updates for Shopify follow-up automation.
Warehouse value: independent shipment failures no longer stop other tracking checks.

## Changes

- Respect HTTP 429/503 Retry-After with independent carrier cooldowns.
- Do not use browser fallback to bypass carrier throttling or identity failures.
- Isolate discovery and rolled-back scan failures; keep retries scoped and bounded.
- Validate carrier identity before recording a scan.
- Recheck active and delivered state under the persistence lock.
- Bound tracking batches to ten minutes and release deferred claims for later work.
- Maintain progress heartbeats without hiding discovery-quality warnings.
- Restrict error codes and diagnostic output so provider text cannot leak private data.

## Safety And Acceptance

Risks include false delivery, stale scans, throttling, abandoned claims, and
cross-store updates. Existing identity, tenant, warehouse, fulfillment, and
idempotency guards remain in force. All transaction testing uses isolated mocks;
no test data or test notifications are permitted in live customer accounts.

Dependencies: the existing worker runtime and its current database role. No
migration is required. Unchanged runtime modules were verified by SHA-256 against
the live v5 worker before packaging.

Acceptance: focused failure fixtures, full shared regression suite, route access
audit, isolated package tests, and post-deployment revision/health verification.
Read-only carrier checks must not invent delivery events or send customer emails.
This release does not claim to verify real inbox notification behavior.

## Official References

- Shopify fulfillmentEventCreate: https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentEventCreate
- Extensiv release notes: https://help.extensiv.com/en_US/2026/extensiv-2026-q3-release-notes

Reviewed 2026-09-18. Shopify requires fulfillment-write scope and the applicable
fulfill-and-ship permission. Extensiv tracking capabilities are workflow signals,
not evidence of its internal retry or idempotency implementation.

## Release Evidence

- Focused tracking tests: 30 passed.
- Isolated worker package tests: 63 passed.
- Access-control audit: passed, 295 routes checked.
- Full shared suite: 648 passed, zero failed, skipped, or cancelled.
- First v6 deployment `5933ffb5-dd26-4640-8abe-23306c040d50`: successful.
  Private health reported revision v6, quality OK, and successful completion at
  2026-09-18T15:13:47.172Z with zero unresolved, discovery, carrier or Shopify
  failures. This cycle had no due carrier checks; it is not a substitute for
  carrier probes.
- Read-only production probes: Canpar, ICS and GLS each returned confirmed
  DELIVERED. Canpar/ICS used approved observed-confirmation time because their
  scans lack verified timezone offsets. GLS provided carrier-offset time and one
  verified package. Probes did not persist scans or publish Shopify events.
- Final deployment `e1be2320-1e9a-43b6-8715-00d4ab393ff4`: successful. All
  63 isolated tests also passed inside the production container build.
  Running worker and HTTP reader hashes exactly matched the local tested package.
  Private health reported revision v6 and quality OK, with successful completion
  at 2026-09-18T15:16:43.376Z and zero unresolved, discovery, carrier or Shopify
  failures. No carrier records were due in this cycle.

Rollback: redeploy the prior successful isolated worker package. Do not deploy
the unrelated main application worktree as part of this change.
