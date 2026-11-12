# Rancher's Chips Shipment Email Opt-Out

Effective September 18, 2026. Logan requested that individual WMS shipment
confirmation emails to the company's contacts stop. The owner approved disabling
these messages. A daily company email summary has not been enabled.

## Live Configuration

- Exact account: `RANCHER'S CHIPS`.
- Existing `customer_email_preferences` record: `email='*'`,
  `notification_type='SHIPMENT_CONFIRMATION'`, `is_subscribed=false`.
- Migration: `migrations/20260918_customer_shipment_email_optout.sql`.
- Queue guard: `wms365_shipment_email_preference_guard` on `portal_orders`.
- Shipping writes persist normally, but opted-out email schedules become `SKIPPED`.
- Scheduler claims for opted-out emails return no row, preventing a send.
- Existing pending or failed confirmations are skipped by the configuration script.
- Already-sent emails cannot be recalled. Configuration stops for an in-progress
  send instead of claiming that it has been cancelled.

The guard is reusable and default-on for accounts without an explicit opt-out.
It checks exact account ownership and affects only the native WMS shipment email
queue. It does not suppress unrelated mail sent directly by another script or
provider; new shipment send paths must honor this preference too.

Shopify tracking, fulfillment events, buyer shipping/delivery notifications,
warehouse and billing messages, portal access and inventory remain unchanged.
The shipping-closeout/nightly-tracking automation explicitly preserves this opt-out
and must not introduce a daily company summary without new owner approval.

## Verification

Use `scripts/run-ranchers-shipment-email-optout-remote.ps1 -Mode verify`.
The runner targets the main production service explicitly, without deploying the
large local worktree. It keeps connection credentials private.

September 18 results:

- Temporary database fixtures with the exact designated test company
  `CODEX PORTAL SYSTEM TEST` (1510): six assertions passed, all changes rolled back,
  zero emails sent.
- Live apply at `2026-09-18T16:20:22.303Z`: individual shipment emails disabled,
  guard installed, zero queued messages needing cancellation.
- Independent live readback at `2026-09-18T16:20:31.482Z`: disabled, guard installed,
  no pending/failed/in-progress confirmations.
- Shopify `syncShipmentConfirmations`, `notifyCustomerOnFulfillment`,
  `carrierFulfillmentEventsEnabled` and `publicCarrierTrackingEnabled` all remained
  true. The apply script also verified the entire integration settings object
  remained unchanged within the transaction.
- Full shared suite: 655 passed, zero failed.

## Rollback

Only after a new explicit owner instruction, re-enable this account's wildcard
`SHIPMENT_CONFIRMATION` preference and audit the change. Do not automatically
reschedule old `SKIPPED` messages. Do not remove the shared guard as part of a
single-account opt-in: other accounts may also depend on it.

Before removing the migration globally, check every account's preferences and
replace its protection with a tested application-level guard. Removing this
trigger without a replacement would re-enable company shipment messages.
