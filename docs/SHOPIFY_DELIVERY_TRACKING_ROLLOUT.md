# Shopify Delivery Tracking and Notifications

Review date: 2026-09-17. Priority: high.

Customer value: carrier-confirmed order status and consistent delivery messages.
Warehouse value: fewer tracking enquiries and visible delivery exceptions.
Risks: false delivery, repeated emails, incorrect package ownership, unknown remote
outcomes, carrier layout changes, browser resource use and customer-data exposure.

## Architecture

Extend the existing immutable shipment tracking hub, with a per-store opt-in.
Persist Shopify fulfillment/package bindings and a durable fulfillment-event
outbox. Reconcile Shopify's fulfillment events before retrying a send, including
after an ambiguous timeout. Preserve expected package membership; one missing
package prevents a shared fulfillment's DELIVERED event.

Notification configuration belongs to a specific integration and customer. A
separate durable notification outbox preserves recipient, provenance, channel,
deduplication identity, attempts and outcome. Shopify event acceptance is not an
email-delivery receipt. Unknown Shopify send outcomes must not trigger a duplicate
WMS email. BOTH is an explicit store decision, not an automatic fallback.

Initial fulfillment requests use notifyCustomer=true when shipping confirmation
is selected in the enabled SHOPIFY or BOTH mode. Disabled notifications and
WMS365-only mode do not request an additional native shipping confirmation.
Shopify-native out-for-delivery and delivered emails require enabled Shopify store settings.
WMS-only native-event messages require an audited review of the corresponding
Shopify setting, or an explicit BOTH configuration. SMS also requires current
recipient consent, a valid phone number and a configured SMS provider.

Shopify carrier events still update the order-status page in every delivery
notification mode. The event mutation has no per-event native email suppression
switch. Before enabling tracking with native events excluded, WMS365 requires an
audited, account/store-specific DISABLED review of each corresponding Shopify
setting. A review is not proof that any particular email was sent. WMS fallback
does not release old events based on a later configuration review.

Late scans cannot publish a status older than an already-published scan or
regress a delivered fulfillment. Invalidated rows remain in history but are
permanently excluded from replay and no longer obstruct newer valid evidence.
The notification worker checks current scoped delivery evidence while holding
the fulfillment lock through sending; invalidated delivery cannot release a
pending delivered email. Manual closure also prevents queued status publication.

## Current Runtime Gates

### Carrier Parser Correction, September 18, 2026

Root causes reproduced against official carrier responses: Canpar NSR physical
delivery scans were unmapped; ICS repeats its latest update timestamp across
earlier progress scans; GLS rejected older Service Alert labels before selecting
each piece's current scan. The corrected reader requires exact Canpar NSR code
and reviewed descriptions plus delivered=true, binds tied ICS progress rows to
the independently matching summary status/date, and selects every GLS piece's
latest machine scan before mapping status. Service Alert maps to EXCEPTION.
Unknown current scans, tied exceptions, identity conflicts, guessed times and
partially delivered packages still cannot confirm delivery. Historical scan
timestamps and parcel identities remain validated even when old wording is ignored.

Worker revision carrier-parser-20260918-v3 reports rejected checks and per-carrier
error counts separately from process liveness. Failed checks leave a warning in
worker health rather than clearing last_error unconditionally. The health response
contains only aggregate tracking metrics, not customer identities or tracking numbers.
Six genuine previously missed deliveries passed read-only pre-deployment checks.
These checks did not create Shopify events, emails, inventory or billing records.
Additional reviewed scans cover ICS pickup, delivery attempt, damaged,
undeliverable and SMARTSpot pickup states, and Canpar TRF/HLD/INO transit or hold
states. These are never treated as delivery evidence.

Isolated worker deployment `7dee6b39-da03-4858-85af-98000eb81441` started at
2026-09-18T13:08:35Z. No main-site deployment or schema change was required.
All 633 shared tests, 49 packaged worker tests and the access-control audit passed.
The pinned test company 1510 was verified read-only; no live test transactions
were created. The worker role cannot update orders, inventory, inbounds, billing
or customer accounts. Hosted source hashes matched the tested package.

Hosted read-only probes passed for delivery on all three carriers, Canpar hold,
ICS damage and ICS pickup. The deployed v3 health endpoint subsequently reported
a completed cycle: 47 checks, 47 confirmed scans, zero rejected checks and zero
Shopify failures. The corresponding cycle completed at 2026-09-18T13:13:43Z and
reported 12 sent Shopify status updates. A separate read-only Shopify query
verified every recorded remote event ID and status: five DELAYED, five
CARRIER_PICKED_UP, one IN_TRANSIT and one OUT_FOR_DELIVERY.
No unresolved carrier-layout errors
remained among active scoped trackers. Genuine exceptions remain open:
ORD-000697 (damage), ORD-000716 (service alert), ORD-000736 (undeliverable),
ORD-000782 (SMARTSpot pickup) and ORD-000813 (facility hold).
These results confirm status processing, not receipt of customer emails.

Follow-up monitoring hardening uses revision carrier-parser-20260918-v4,
deployment `ded4f6d3-9c9f-4e9c-b744-977cddf3183b`. Completed cycles count
unresolved active carrier failures even when their retry is not yet due. Cycle
failure sets a separate quality warning rather than presenting an old successful
report as current healthy tracking. The private endpoint separates liveness from
STARTING/OK/DEGRADED quality and includes the last completed cycle time.
All 636 shared tests, 52 packaged worker tests and the access-control audit
passed. Hosted negative health checks passed and the worker SHA256 matched the
tested package (`5a2da2e06f5be7bf04f379b3178ac49d9a66b3af70386b1674f9286724c1372c`).
No main-site or schema change was deployed. Durable incident learning and
future review rules are recorded in `CARRIER_TRACKING_INCIDENT_20260918.md`.
The v4 completed live cycle at 2026-09-18T13:25:03Z reported quality OK,
47 accepted checks, zero failures and zero unresolved active carrier errors.

Final live revision carrier-parser-20260918-v5 additionally preserves
existing next_poll_at, attempts and last_error during fulfillment rediscovery.
Previously discovery could force an immediate check and reset attempts, bypassing
the intended retry backoff. New enrollment still schedules a missing poll;
delivered, manually closed, claimed and foreign-binding guards remain unchanged.
All 638 shared tests and 53 packaged worker tests passed before deployment
`bc4941fb-bf76-493c-910b-5f8f2318125d`.
Hosted source hashes matched the tested package. PostgreSQL accepted the exact
scheduling query through EXPLAIN in a read-only transaction (no ANALYZE or write
execution). The final worker completed its first cycle at
2026-09-18T13:30:07Z: quality OK, zero rejected checks, zero Shopify failures and
zero unresolved active errors. It correctly checked zero packages because their
existing future poll times were preserved rather than reset by discovery.

The main-website notification controls and correction UI remain local candidates,
default-off and not externally accepted or deployed. A separate restricted carrier
worker was deployed on 2026-09-17 (deployment
`1d77728f-e734-4685-bc88-2f688fb4f6c8`) for integration 4 only. It has no inventory,
sales-order, inbound or billing write permission. Other stores remain unenrolled.
The configured production service did not have an AfterShip tracking API key
when checked on 2026-09-17. Tracking activation fails with an actionable warning
without that key. The separate public-carrier worker does not require AfterShip.
Its reviewed GLS HTTP reader verifies offset-bearing machine scans against the
rendered scan table and every declared piece. Canpar uses its public read-only
trackByBarcodeV2 endpoint, validating the exact barcode and physical scan code.
ICS and Canpar readers confirm carrier status. On 2026-09-17 the owner explicitly
approved OBSERVED recording-time publication for integration 4. The approval was
persisted at `2026-09-17T21:19:04.423Z`; 131 unclaimed pending Canpar/ICS checks were
expedited. Each event retains the original carrier-local scan time and explains
in Shopify's message that happenedAt is recording time, not actual delivery time.
Other stores retain their current policy. Hosted Chromium sandbox startup failed acceptance on Railway, so the
browser fallback is disabled there. The API/HTTP readers retain strict HTTPS,
response limits, exact identities, time validation and fail-closed scan mappings.
Email sending is configured, but no approved Shopify development store or test
recipient has been supplied for real inbox acceptance. SMS is visibly disabled
and activation is rejected until an actual provider is integrated.

Local verification: 626 shared automated tests, 42 isolated worker tests and two desktop/mobile Chromium
workflow checks passed on 2026-09-17. These include three-carrier mocked status
flows, notification deduplication, recipient/tenant/warehouse isolation, uncertain
send outcomes, invalidated delivery, manual closure and repeatable schema upgrades.
They do not prove actual carrier connectivity or delivery to a real customer inbox.

## Tracking Correction Scope

The admin correction endpoint is wired to a dedicated-connection two-phase
service. It commits an audited pause before a remote change, reads Shopify before
and after one mutation, and creates a new local tracker only when remote ownership
and tracking are confirmed. An uncertain outcome requires manual reconciliation;
it is never automatically retried. Prior tracking evidence is retained, never
copied to the new identity, and does not govern its new status watermark.

The initial scope is an undelivered, single-parcel shipment with one fulfillment.
Multiple packages/bindings/shipments, delivered records, active carrier claims,
pending or uncertain notifications, and same-number carrier-only corrections are
rejected for manual review. These restrictions must be resolved or explicitly
accepted before calling unrestricted tracking correction complete.

## Carrier Routing

| Carrier | Shopify carrier | AfterShip slug | Browser fallback |
| --- | --- | --- | --- |
| Canpar | Canpar with explicit URL | canpar | Opt-in reviewed layout |
| ICS Courier | ICS with explicit URL | icscourier | Opt-in reviewed layout |
| GLS Canada | GLS | dicom | Opt-in reviewed layout |

Browser parsing fails closed for unverified layouts or absent delivery evidence.
It requires a separate, unprivileged worker, installed Chromium, reviewed
selectors/timezones, restricted egress and privately retained diagnostics. Do not
enable it with a guessed selector, a broad page-text parser or an ETA heuristic.
Carrier API authentication and permitted usage must be verified before enabling
direct adapters. An adapter interface is not proof of a working carrier account.

## External Acceptance Gates

- Use only CODEX PORTAL SYSTEM TEST, owner account 1510, for WMS transaction tests.
- Use a dedicated Shopify development store and explicitly approved test inbox.
- Obtain configured tracking-provider access for Canpar, ICS and GLS Canada.
- Verify write_fulfillments and fulfill-and-ship permission for the Shopify app.
- Check Settings > Notifications > Customer notifications > Shipping in Shopify.
- Confirm initial shipping, out-for-delivery and delivered emails in the inbox;
  verify the same statuses on the Shopify order-status page.
- Verify repeated scans, duplicate webhooks, timeouts and concurrent workers do
  not duplicate Shopify events or messages.
- Verify mixed delivered/active packages do not close a shared fulfillment.
- Verify guessed IDs, other customers, warehouses, stores and role changes fail
  closed without exposing notification recipients or screenshots.
- Verify tracking corrections preserve immutable history and cannot replay old
  delivery evidence under a new tracking number.
- Verify delivery, manual closure and tracking age stop polling.
- Run the full shared regression suite and browser checks before deployment.
- Deploy only reviewed files; preserve unrelated dirty-worktree changes. Use
  additive migrations, default-off enrollment and disable enrollment for rollback.
- Verify the actual deployed version and genuine tracking events after rollout.

No simulated carrier delivery event may be sent to a live customer fulfillment.
Local fixture tests do not satisfy the external inbox/carrier acceptance gates.

### Authorized Existing-Shipment Acceptance

The owner approved genuine Rancher's shipments with confirmed carrier delivery
but a stale Shopify fulfillment status as the production acceptance set on
2026-09-17. This supplements isolated test-company coverage; it does not permit
synthetic events, test transactions in a customer company, or replaying historic
shipping confirmations and intermediate-status emails to real buyers.

Use `scripts/audit-ranchers-delivery-status-readonly.js` for a read-only WMS and
Shopify snapshot, then `scripts/audit-ranchers-carrier-deliveries-readonly.js` for
rate-limited official carrier-page evidence. Reports stay in private local
`.codex-tmp` files. The carrier audit intentionally preserves carrier-local scan
timestamps with `timezoneVerified: false`; those timestamps are not ready-made
Shopify `happenedAt` values. Verify carrier timezone semantics before converting
or writing events. Never substitute an estimated delivery date or guessed UTC.

Include Shopify `FULFILLED` as well as `IN_TRANSIT` in the mismatch audit: carriers
without recognized native tracking can remain `FULFILLED` after actual delivery.
Every tracking number on a shared fulfillment needs its own positive scan.
GLS Canadian numbers must be checked at `ship.gls-canada.com`, not the international
GLS tracking page. Verify the final Canadian URL in Shopify after any correction.

Historical delivery uses an explicit audited REPLAY_EVENTS approval, retaining
enrollment dates and original offset-bearing scan timestamps. Each expected
package needs fresh verified evidence recorded after approval. Newer non-delivery
scans block stale delivery proof. Remote events are reconciled before mutation and
retry. No historical intermediate-status or direct WMS buyer email is replayed.

Live acceptance: ORD-000694 was confirmed delivered by GLS and Shopify read-back
showed DELIVERED with deliveredAt `2026-09-16T16:00:15Z`. Exactly one DELIVERED
outbox event was marked SENT. The hosted worker subsequently published ten more
DELIVERED events. Shopify read-back verified all 11 corrected fulfillments were
DELIVERED with deliveredAt present and zero mismatches. This is not completion of
every audited shipment or native email delivery. The hosted worker's first
complete cycle and remaining correction counts require live verification.
Live OBSERVED acceptance: one genuine Canpar and one genuine ICS delivered
shipment were corrected and read back as DELIVERED in Shopify at recorded times
`2026-09-17T21:20:11Z` and `2026-09-17T21:20:14Z`. Both messages contained the
recording-time disclaimer and original local scan time. The WMS tracker's actual
delivered_at remains null when actual delivery UTC is unverified. Repeat readings
of the same status/local scan have a stable event identity and retain the first
recording timestamp. Remote DELIVERED events are reconciled rather than recreated.
No direct WMS buyer email was sent. The remaining reconciliation continues in the
hosted worker. Notification settings and actual inbox acceptance remain unverified.

## Primary Sources

- Shopify fulfillment events:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentEventCreate
- Shopify tracking company values and explicit tracking URLs:
  https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentTrackingInfo
- Shopify notification triggers and settings:
  https://help.shopify.com/en/manual/fulfillment/setup/notifications/customer-notifications
- AfterShip Canadian carrier routing:
  https://www.aftership.com/docs/tracking/others/supported-couriers
- Canpar tracking operation and authentication:
  https://sandbox.canpar.com/download/CanparWebServices-SupplementalUpdate-August2023.pdf
- GLS Canada API entry point:
  https://gls-group.com/CA/downloads/GLS-Canada_API_EN.pdf

Sources reviewed 2026-09-17 using public feature metadata only.
