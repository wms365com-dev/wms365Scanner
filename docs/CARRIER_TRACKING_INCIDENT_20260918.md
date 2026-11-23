# Carrier Tracking Incident: September 18, 2026

## What Failed

The owner found delivered shipments still showing in transit in Shopify.
Reviewed official carrier responses reproduced three distinct failures:

- Canpar's no-signature NSR delivery code was not mapped.
- ICS repeated the latest timestamp on earlier progress rows; selecting by time
  alone could not establish the current status.
- GLS historical labels were mapped before selecting each piece's current scan.

The conservative reader rejected these cases, protecting against false delivery
but leaving downstream customer automations with stale status. Process liveness
alone did not make that data-quality problem visible enough.

## Permanent Rules

1. Keep reviewed, synthetic response fixtures for every incident. Test the
   original failure, the correction and negative near-matches before deployment.
2. Bind carrier identity and package membership before interpreting status.
   Select current evidence first; validate historical identities and timestamps
   without requiring every old description to be a known current status.
3. Resolve tied timestamps only with independently matching current-status
   evidence. Unknown or conflicting current scans still fail closed.
4. Never infer delivery from an ETA, pickup-point arrival, damage, hold, service
   alert or a partially delivered multi-package fulfillment.
5. Separate process liveness from tracking quality. Count rejected checks,
   unresolved active failures, Shopify publication failures and last completion.
   A quiet cycle or a later cycle failure must not hide unresolved problems.
6. Preserve confirmed scans, owner confirmations and observation timestamps as
   different evidence. Never invent a delivery date or silently rewrite history.
7. Verify the isolated deployed revision and source package, genuine read-only
   carrier responses, completed polling results and remote Shopify event IDs.
   An accepted Shopify event is not evidence that an email reached an inbox.
8. Keep store enrollment explicit. Shared negative tests must protect other
   customers, warehouses, roles, manually closed shipments and stopped tracking.
9. Rediscovery must preserve existing polling schedules, error evidence and
   failure counts. Only a missing initial schedule needs immediate enrollment;
   rediscovery is not a successful carrier check or permission to reset retries.
10. Do not bypass unknown layouts with broad text matching or automatic delivery.
   Review and add bounded mappings with regression coverage instead.
11. Isolate bad records: verify stored carrier identity, roll back rejected scans,
    and continue independent shipments. Reject foreign discovery responses without
    blocking existing bindings; report discovery failures separately.
12. Respect HTTP 429/503 and Retry-After with bounded per-carrier cooldowns.
    Browser fallback must never evade throttling, identity or payload checks.
13. Bound polling batches and release deferred claims by exact ownership. Progress
    liveness is not evidence that the cycle or Shopify publication succeeded.
14. Recheck active, undelivered state under lock so a stale worker cannot overwrite
    confirmed delivery or manual closure.
11. Isolate bad records: validate carrier identity before persistence, roll back
    rejected scans, and continue independent shipments. A foreign discovery
    response must remain rejected without blocking existing tracking bindings.
12. Respect HTTP 429/503 and Retry-After with per-carrier cooldowns. Never use
    browser fallback to evade throttling, identity conflicts or payload limits.
13. Bound polling batches and release deferred claims by exact ownership. Keep
    progress liveness separate from completed-cycle quality and discovery errors.
14. Recheck active/undelivered state while locking the tracker. Another worker's
    confirmed delivery or manual closure must not be overwritten by an old check.

## Regression Coverage

`carrier-public-http.spec.js` covers exact Canpar codes/descriptions and ICS
summary-layout binding. `carrier-public-tracking.spec.js` covers ICS ties, GLS
history/current selection, package completeness and non-delivery exceptions.
`shopify-tracking-worker.spec.js` covers rejected-check reporting, persistent
unresolved failures, failed-cycle health and exact store/warehouse scoping.
`shopify-tracking-sync.spec.js` additionally executes the rediscovery scheduling
expressions against isolated database fixtures, checking retry preservation,
initial enrollment, delivery, manual closure, active claims and unrelated bindings.

The fixtures contain no live customer identities or credentials. Transaction
tests, when needed, must use the pinned CODEX PORTAL SYSTEM TEST company 1510.
See `SHOPIFY_DELIVERY_TRACKING_ROLLOUT.md` for deployment acceptance and limits.
