# WMS365 Change Impact Checklist

Use this before pushing any warehouse workflow change live.

## Always Ask
- Does this change affect desktop navigation?
- Does this change affect the home directory?
- Does this change affect the workspace drill path?
- Does this change affect company scoping or permissions?
- Does this change affect mobile?
- Does this change affect the customer portal?
- Does this change affect reports, exports, or billing?
- Does this change affect email, PDFs, or attachments?

## Navigation / UX
- Left nav section label
- Left nav grouping
- Home directory entry
- Section drill index / local workspace navigation
- In-app back / return behavior
- Workspace title
- Workspace helper text
- Drill path
- Quick actions / shortcuts

## Security / Scope
- company scoping
- warehouse user assigned-company access
- customer portal isolation
- feature flag gating

## Workflow State
- draft / released / picked / staged / shipped
- inbound submitted / received
- sync schedule status
- refresh / cache behavior

## Documents / Notifications
- pick ticket
- packing slip
- PDFs
- file attachments
- warehouse email
- customer shipment email

## Commercial / Billing
- billing event creation
- manual billing availability
- month-end export
- shipped-order cost capture

## Verification
- inline script parse
- `node --check` for server changes
- one real desktop click path
- one real portal click path if customer-facing
- verify build label after deploy
