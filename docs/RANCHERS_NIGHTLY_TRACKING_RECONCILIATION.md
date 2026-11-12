# Ranchers Nightly Tracking Reconciliation

Created and verified: 2026-09-18.

## Schedule

The existing task heartbeat `ranchers-daily-shipping-closeout` now has two
separate Eastern-local-time branches:

- 02:00: independent carrier/Shopify delivery reconciliation.
- 18:00: the existing Drive intake shipping closeout, unchanged.

The delivery audit must never run the intake workflow or deduct stock. This is
a Codex task heartbeat, not a second deployed shipping worker; the existing
carrier service continues its regular due-polling work independently.

## Commands

From `C:\WMS365Scanner-shopify-scheduler-fix`:

```powershell
powershell -NoProfile -File scripts/run-ranchers-nightly-tracking-remote.ps1 -Step preflight
powershell -NoProfile -File scripts/run-ranchers-nightly-tracking-remote.ps1 -Step audit
powershell -NoProfile -File scripts/run-ranchers-nightly-tracking-remote.ps1 -Step apply
powershell -NoProfile -File scripts/run-ranchers-nightly-tracking-remote.ps1 -Step audit
```

The runner compiles trusted local script source inside the existing isolated
worker. It does not deploy the dirty main application worktree or persist remote
files. JSON reports are saved under `outputs/ranchers-nightly-tracking`.

## Guards

- Exact account `RANCHER'S CHIPS`, integration 4, store
  `f1acxk-dc.myshopify.com`, warehouse 1 / `GW3PL-MISS`.
- Corrections require restricted database role `wms365_tracking_4`.
- Warehouse code/ID mapping independently verified read-only during setup; no
  database permissions were expanded.
- Shared production worker advisory lock; busy processing defers safely.
- Fresh scope check after acquiring the lock.
- Normal due schedules, carrier cooldowns, retry backoff, expiry and manual
  closure remain unchanged. No reset to force a poll.
- Reviewed carrier evidence and all-package delivery guards remain mandatory.
- Existing approved observation time remains distinct from actual delivery time.
- Independent Shopify readback is mandatory; local SENT/healthy is not proof of
  a remote fulfillment's delivered status or customer inbox notification.
- No order stage, quantity, inventory, billing, contact, stock-sync or
  notification-setting changes. No separate customer emails or label purchases.

## Initial Run

2026-09-18T15:36:30.571Z: approved normal reconciliation reviewed 226 shipped
Shopify-linked orders, rediscovered 52 eligible non-delivered fulfillments,
reported zero discovery failures, zero due carrier checks and zero publications.
No duplicate Shopify events were created. No unresolved active failures reported.

Independent Shopify audit checked all 226 orders/226 fulfillments with no read
failures. Current Shopify statuses:

| Status | Fulfillments |
| --- | ---: |
| Delivered | 174 |
| In transit | 24 |
| Fulfilled | 9 |
| Out for delivery | 9 |
| Delayed | 5 |
| Carrier picked up | 5 |

There were zero WMS-delivered -> Shopify-undelivered mismatches. Delivered WMS
package trackers: 169, comprising 139 carrier-confirmed and 30 owner-confirmed;
none lacked delivery evidence. Package counts differ from fulfillment counts.

Exceptions remain visible, not silently repaired:

- 24 fulfillments have unsupported/unknown carrier flags (not additional
  confirmed-delivery failures).
- 14 already-delivered Shopify fulfillments lack WMS binding/current delivered
  tracker alignment; these overlap the unsupported-carrier set. Do not infer a
  carrier scan from Shopify display status to manufacture WMS evidence.
- ORD-000840 has ten packages, nine Canpar delivered and one GLS in transit.
  Shopify lacks the GLS package carrier value. Do not mark the entire fulfillment
  delivered until every expected package is physically confirmed.

Read-only evidence: `outputs/ranchers-delivery-reconciliation/read-only-audit-20260918.json`
and `outputs/ranchers-delivery-reconciliation/read-only-evidence-20260918.json`.
The scoped preflight and apply reports are under the nightly output folder.

Acceptance tests include restricted-role and tenant/warehouse/store negative
guards, read-only/busy-worker no-ops, lock release on failure and independent
audit evidence checks. All tests use isolated fixtures, never live test data.

Full shared suite after adding the runner/audit guards: 653 passed, zero failed,
skipped or cancelled. The independent audit's ten guard assertions also passed.

The checked-in PowerShell runner's fresh post-reconciliation audit also checked
all 226 orders with the same 174-delivered result and no WMS-delivered ->
Shopify-undelivered mismatch or read failure. Evidence:
`outputs/ranchers-nightly-tracking/20260918-114200-audit.json`.
