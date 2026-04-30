# WMS365 Change Impact Checklist

Last reviewed: 2026-04-26

Use this before pushing any warehouse workflow change live.

## Always Ask

- Does this change affect desktop navigation?
- Does this change affect the home directory or top quick actions?
- Does this change affect the workspace drill path?
- Does this change affect company scoping or permissions?
- Does this change affect customer portal isolation?
- Does this change affect mobile?
- Does this change affect reports, exports, or billing?
- Does this change affect email, PDFs, or attachments?
- Does this change affect integrations or scheduled sync?
- Does this change require updating the internal feature registry?

## Source Of Truth Updates

- Update `C:\WMS365Scanner\docs\WAREHOUSE_WORKSPACE_TOC.md` when a nav section changes.
- Update `C:\WMS365Scanner\docs\WAREHOUSE_FEATURE_REGISTRY.md` when a feature moves or gains dependencies.
- Update `const WAREHOUSE_WORKSPACE_TOC` in `C:\WMS365Scanner\index.html` when desktop navigation changes.
- Keep user-facing labels consistent across `index.html`, `portal.html`, and `server.js`.

## Navigation / UX

- Left nav section label
- Left nav grouping
- Top quick action
- Home directory entry
- Section drill index / local workspace navigation
- In-app back / return behavior
- Workspace title
- Workspace helper text
- Drill path
- Empty state text
- Button loading state
- Success/error feedback

## Security / Scope

- company scoping
- super user company setup flow
- warehouse user assigned-company access
- customer portal isolation
- feature flag gating
- fulfillment location / 3PL partner assignment
- export restrictions
- integration company ownership

## Workflow State

- sales order draft / released / picked / staged / shipped
- purchase order submitted / received
- receiving batch staged / saved
- sync schedule status
- refresh/cache behavior
- build/version label after deploy

## Documents / Notifications

- pick ticket
- packing slip
- sales order release PDF
- file attachments
- warehouse order email
- customer shipment email
- shipment quote
- carrier label
- tracking number
- return label
- address validation result
- receipt confirmation
- shipped confirmation
- daily admin summary email

## Commercial / Billing

- receiving charge capture
- picking charge capture
- labeling charge capture
- supplies charge capture
- shipping cost capture
- package material capture
- carrier surcharge/tax capture
- return label capture
- dangerous goods/special handling capture
- storage charge capture
- manual billing availability
- month-end export
- shipped-order billing completeness

## Integrations

- Shopify order import
- Shopify token/client credential behavior
- SFTP order import folder
- SFTP purchase order import folder
- SFTP shipment confirmation export folder
- SFTP receipt confirmation export folder
- SFTP inventory export folder
- marketplace provider catalog
- Best Buy marketplace connector
- ClickShip carrier connection
- direct UPS/FedEx/Canada Post carrier connections
- manual sync
- scheduled sync
- integration run log

## Verification

- inline script parse for `index.html`
- inline script parse for `portal.html` if portal-facing
- `node --check server.js` for server changes
- one real desktop click path
- one real portal click path if customer-facing
- one mobile path if floor-facing
- verify `wms365.co` routes to public site
- verify `app.wms365.co` routes to the app
- verify build label after deploy
