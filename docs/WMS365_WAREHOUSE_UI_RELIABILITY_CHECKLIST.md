# WMS365 Warehouse UI Reliability Build Checklist

Use this checklist for warehouse status-action releases that affect picking, staging, shipping, or customer-facing shipment confirmation.

## Required Build Checks

- [ ] Desktop status actions show a strong confirmation with the order number, final status/action, and save timestamp.
- [ ] Desktop order/shipping panels show a full-panel saving state while picked, staged, cancelled, or shipped actions are in progress.
- [ ] Desktop sales order queue shows a visible last-updated timestamp after a successful order refresh.
- [ ] Desktop sales order queue shows a visible offline warning when the browser loses network connectivity.
- [ ] Mobile picking shows a visible last-updated timestamp after loading the work queue.
- [ ] Mobile picking shows a visible offline warning when the scanner/browser loses network connectivity.
- [ ] Mobile picked, staged, and shipped actions keep their card locked with a clear saving state until the server confirms.
- [ ] Mobile picked, staged, and shipped success messages include the order number and save timestamp.
- [ ] Mobile final-action buttons remain easy to reach on small screens using a sticky action area.
- [ ] Status transitions still force a fresh server refresh after the action completes.
- [ ] Status transitions still use idempotency keys so repeated taps do not duplicate the update.

## Verification Notes

Record the local checks, deployment id, live health result, and live build label in the release notes or task closeout.
