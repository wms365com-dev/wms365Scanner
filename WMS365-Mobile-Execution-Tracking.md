# WMS365 Mobile Execution Tracking

## What Changed

- Mobile pick scans now post to `POST /api/mobile/pick-confirmations` as each scan is confirmed.
- The server validates order status, assigned mobile task, SKU, location, lot/expiry, quantity limits, and duplicate submissions.
- Offline mobile actions use a shared IndexedDB queue in `mobile-bridge.js` with idempotency keys.
- `mobile-pick.html` and `mobile-count.html` now use the shared queue/sync status pattern.
- Generic confirmation endpoints were added for receiving, put-away, and moves:
  - `POST /api/mobile/receiving-confirmations`
  - `POST /api/mobile/put-away-confirmations`
  - `POST /api/mobile/move-confirmations`

## Database

New migration:

- `migrations/20260523_mobile_execution_confirmations.sql`

New tables:

- `pick_confirmations`
- `mobile_execution_confirmations`

Both tables use unique `idempotency_key` indexes to prevent duplicate submissions during offline retry or reconnect.

## Worker Flow

For picking:

1. Worker scans/confirms location.
2. Worker scans/confirms SKU.
3. Worker confirms lot/expiry if required.
4. Worker confirms quantity.
5. Mobile sends the scan to the backend immediately.
6. If offline, the scan is saved locally as pending.
7. The worker cannot mark the order picked until pending pick confirmations sync.

## Audit And Protection

The backend records rejected mobile confirmations for:

- wrong SKU
- wrong location
- wrong lot/expiry
- quantity over allocation
- stale order status
- duplicate/idempotent submissions

Warehouse workers must have an assigned active mobile task before pick confirmations are accepted.

## Verification

Run:

```bash
npm run test:mobile-execution
npm run test:rbac
npm run test:inventory-locking
```

Syntax checks used during implementation:

```bash
node --check server.js
node --check mobile-bridge.js
```
