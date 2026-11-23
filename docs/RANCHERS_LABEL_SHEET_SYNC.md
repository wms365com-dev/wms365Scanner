# Rancher's label-sheet sync

The standalone worker reads WMS365 production orders for exact account `RANCHER'S CHIPS`, Shopify integration ID 4 (`f1acxk-dc.myshopify.com`), and warehouse `GW3PL-MISS` (ID 1). It adds eligible `RELEASED` or `STAGED` orders to the `WMS` tab of the Rancher's labels spreadsheet. It never releases orders, buys labels, changes inventory, or updates Shopify.

Each run checks both `WMS` and `Sheet1` for the exact WMS order number before appending. It uses the current 32-column sheet layout, the existing box rules and approved missing-phone fallback, and marks incomplete label data `CHECK`. Uploaded WMS labels and orders with tracking are excluded. A PostgreSQL advisory lock prevents two worker instances from planning an append at the same time. After a Google append, the worker reads the new rows back; after an uncertain failure, a later run rechecks the sheet before writing again.

## Google access

1. Create a dedicated Google Cloud service account and enable the Google Sheets API for its project. Do not grant domain-wide delegation. Share only the target spreadsheet with the service account's email as Editor.
2. Store the service-account JSON securely. On a local workstation, set `GOOGLE_APPLICATION_CREDENTIALS` to the private key file path. In a dedicated Railway worker, set `RANCHERS_SHEETS_SERVICE_ACCOUNT_JSON` as a secret variable. Never commit or paste the private key into source, logs, or chat.
3. Give the worker read-only WMS database credentials. It uses an advisory lock but does not write WMS business records. Restrict network egress to Google auth and Sheets endpoints where supported.

Run once with `npm run sync:ranchers-label-sheet`, or run continuously with `npm run sync:ranchers-label-sheet:watch` (one check per minute). The worker fails closed if credentials, the expected tabs, the exact WMS headers, or the pinned WMS/Shopify/warehouse identities are missing or changed. It prints only counts and WMS order codes, not recipients, addresses, email, or credentials.

The `--watch` mode belongs in a separately supervised worker service, not in the web process. Do not enable it in production until the service account can read/write the spreadsheet and a test-company sheet passes end-to-end. For rollback, stop the worker; existing label rows remain untouched. Check for duplicate WMS order numbers across both tabs before restarting after any manual bulk edit.
