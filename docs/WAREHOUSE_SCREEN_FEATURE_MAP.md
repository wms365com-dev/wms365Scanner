# WMS365 Screen Feature Map

Last reviewed: 2026-05-11

Purpose:
- Screen-by-screen ownership map for the warehouse desktop, customer portal, and mobile worker views.
- Use this before moving UI so each feature has one obvious home.
- Keep this aligned with `C:\WMS365Scanner\docs\WAREHOUSE_WORKSPACE_TOC.md`, `C:\WMS365Scanner\docs\WAREHOUSE_FEATURE_REGISTRY.md`, and the runtime `WAREHOUSE_WORKSPACE_TOC` in `C:\WMS365Scanner\index.html`.

Latest desktop layout audit:
- `C:\WMS365Scanner\docs\DYNAMICS_COMPARISON_AUDIT_2026-05-11.md`
- Key result: Sales Orders and Purchase Orders are close to the desired list-first/drill-in pattern, and Customers, Vendors, and Items now open focused list hosts instead of landing users in the full Master Data workspace.
- Follow-up result: Home now hides document-only command actions, and focused item/customer/vendor lists no longer drag the Inventory Index below the primary list view.
- Item result: Items now follow a list-first/card-second ERP flow. The list shows inventory, available, reserved, locations, traceability, and mapping status; the item card keeps users in the record after save and shows related inventory by location, lot, and expiration.
- Remaining gap: Purchase Order list columns, document fasttabs, and selected-record command states still need tightening to match the Dynamics-style workflow.

## Placement Standard

| Rule | Meaning |
| --- | --- |
| One feature, one primary home | A feature can have quick links from other pages, but its full setup/workspace should live in one section. |
| List first, document second | Sales Orders, Purchase Orders, Items, Customers, and Vendors should open to a list first, then drill into a card/document page. |
| Daily work stays on Home | Home should summarize open work and launch into sections, not become the place to edit records. |
| Setup stays in Setup | Company setup, items, customers, vendors, BINs, portal users, warehouses, and marketplace connections belong under Setup. |
| Execution stays in workflow pages | Picking, receiving, transfers, labels, shipping, and status changes belong in their operational workflow. |
| Customer portal is company scoped | Portal users never choose a company. All records and exports come from the authenticated customer company. |
| Mobile is floor-only | Mobile keeps Receive, Lookup, Adjust/Move, Labels, and Picking. No setup, integrations, billing, or admin. |

## Current Screen Map

| Surface | Screen | What belongs here | Current status | Action |
| --- | --- | --- | --- | --- |
| Warehouse desktop | Top black bar | Build, support, company switcher, global find, notifications, settings/help | Good | Keep company switching only here. |
| Warehouse desktop | Module menu bar | Finance, Cash Management, Sales, Purchasing, Inventory, Shopify/Marketplace, All Reports, Menu | Good | Keep as main desktop entry method. |
| Warehouse desktop | Command bar | Current page actions such as New, Delete, Refresh, Print/Send, Release, Post | Needs cleanup | Make actions page-aware so invalid commands are hidden or disabled outside the right list/document. |
| Warehouse desktop | FactBox | Page info, sync, counts, related actions | Good | Keep context-only, not data entry. |
| Home | Warehouse Dashboard | Day planning, open inbound/outbound counts, SLA aging, assigned worker/warehouse columns, planning notes, drill-in popouts | Good | Keep dashboard as planning and launch page. |
| Inbound | Purchase Orders | PO list, new PO, PO document drill-in, lines, receive/post actions | Good | Keep paperwork and PO management here. |
| Inbound | Receiving | Scan receive, current batch, lot/expiration capture, save batch | Good | Keep physical receiving here; avoid PO setup forms here. |
| Inventory | Inventory Lookup | SKU/UPC, location, multi-item search, lot/expiration visibility | Needs cleanup | Lookup should not show setup/admin workspaces. |
| Inventory | Adjust & Move | Remove, delete line, transfer, put-away, convert, move BIN, recent activity | Good | Keep all stock correction tools here; put-away uses the transfer safety rules but has its own receiving/staging-to-BIN task. |
| Inventory | Labels | Location labels, pallet labels, pallet reprint | Good | Keep label building here and on mobile. |
| Outbound | Sales Orders | SO list, drill-in document, pick ticket, packing slip, release/reopen/delete, status movement | Good | Keep active outbound work here. |
| Outbound | Quote & Ship | Package type, ship from/to, package details, rates, labels, cost capture | Planned | Add as its own Outbound section when built. |
| Outbound | Shipped Orders | Shipped list, tracking, carrier, documents, customer-visible detail | Good | Keep separate from active Sales Orders. |
| Setup | Master Data | Company setup, customers, vendors, items, BINs, portal users, welcome/access emails, warehouses/3PL, assignments, inventory worksheet | Improving | Customers, Vendors, and Items now open focused list views. Items now drill into a Dynamics-style item card with related inventory and store SKU mapping. |
| Setup | Marketplace Connections | Shopify, SFTP, Best Buy, Amazon, Woo, schedules, import/export lanes | Good but naming inconsistent | Rename visible labels to Marketplace Connections or Storefront & Marketplace Connections consistently. |
| Reporting | Reports & Counts | Inventory exports, item/location reports, counts, utilization | Good | Keep read/export reporting here. |
| Commercial | Billing | Billing dashboard, warehouse progress rollups, company billing profile, fees, manual charges, storage billing, billable activity review, invoice batches, Zoho sync | Good but needs invoice batching | Keep invoices company-owned while super admins can roll up progress billing by warehouse/3PL location and assigned accounts. |
| System | Admin & System | Feature access, warehouse users, email flow test, system email test, email delivery log, feedback queue, backup/import/export, build/version | Good but order can improve | Put daily admin/support checks before backup tools. |
| Customer portal | Customer home | Company-scoped stats, order filters, inventory, items, new SO, new PO, shipped orders, feedback | Good | Keep no company selector. |
| Customer portal | New Sales Order | Ship-to address book, lines, label/document uploads, draft/release | Good | Keep ship-to saving company-scoped. |
| Customer portal | My Sales Orders | Draft/released/picked/staged views, archive/delete drafts, upload docs | Good | Status metric cards should remain clickable filters. |
| Customer portal | Shipped Orders | Shipped list, carrier/tracking, documents, drill-in detail | Good | Keep as a separate customer-facing screen/filter. |
| Customer portal | Purchase Orders | New inbound, PO history, PO document uploads | Good | Keep customer inbound submission here. |
| Mobile worker | Mobile home | Receive, Lookup, Adjust/Move, Labels, Picking, open task queue | Good | Keep mobile locked to floor tasks, including rotated phones. |
| Public site | Marketing website | SEO pages, pricing, demo request, Stripe trial/signup | Separate product | Keep outside warehouse app navigation. |
| App domain | Access Center | Sign-in gateway for warehouse users, customer portal users, support, and marketing return path | Good | Keep noindex and route app-domain root here before login. |

## Move / Cleanup Recommendations

| Priority | Change | Reason |
| --- | --- | --- |
| P1 | Finish Customers and Vendors as true list-first pages with card drill-in. | Items now have the stronger list/card baseline; next step is selected-row FactBox details and keyboard row selection across all three master record lists. |
| P1 | Remove visible setup/admin workspace content from Inventory Lookup. | Lookup should only answer "where is stock?" Users should not see Master Data while searching. |
| P1 | Tighten Master Data into a setup list: Companies, Customers, Vendors, Items, BINs, Portal Users, Warehouses/3PL, Assignments, Inventory Worksheet. | The current Inventory Index includes Adjust/Move, Integrations, Reports, and Admin shortcuts, which makes Master Data feel like a feature dump. |
| P1 | Compress Sales Orders and Purchase Orders list headers so the grid appears above the fold. | The current lists work, but large filter/snapshot sections slow down the ERP-style workflow. |
| P1 | Make the command bar contextual to the active page and selected record. | Page-level hiding is in place; next step is enabling/disabling actions based on the selected row or open document status. |
| P1 | Rename Integrations consistently to Marketplace Connections or Storefront & Marketplace Connections. | Users keep asking where Shopify is. The title should match the store/marketplace task. |
| P2 | Move Admin & System daily tools to the top: Email Flow Check, System Email Test, Feature Access, Warehouse Users, Feedback Queue, then Backup/Import/Export. | Super users need support checks before backup tools. |
| P2 | Add Quote & Ship as a real Outbound section when the shipment quoting workflow is built. | Shipping should not be hidden inside Sales Orders once rate shopping and label creation exist. |
| P2 | Make Home drill-in popouts available when All Companies is selected. | Super users need top-level activity without listing everything inline. |
| P2 | Add Billing invoice batches and Zoho sync review before direct accounting pushes. | WMS365 should approve and batch company-scoped charges before creating Zoho invoices. |
| P3 | Keep Billing connected to Shipped Orders and Quote & Ship with completeness indicators. | Month-end billing depends on picking, supplies, labels, and carrier costs being captured. |

## Section Ownership Rules

| Feature | Primary section | Allowed quick links |
| --- | --- | --- |
| Create company | Setup / Master Data | Top company switcher add popout, Admin & System related action |
| Assign company to warehouse/3PL | Setup / Master Data | Company switcher add popout |
| Assign warehouse user role/access to warehouse/3PL | System / Admin & System | Roles: Warehouse Worker, Warehouse Customer Service, Warehouse Admin, Super User |
| Customers | Setup / Master Data | Sales module quick link |
| Vendors | Setup / Master Data | Purchasing module quick link |
| Items | Setup / Master Data | Inventory module quick link, sales/purchase line selector |
| SKU mapping | Setup / Master Data / Item Card | Marketplace Connections reference only |
| Item related inventory | Setup / Master Data / Item Card | Inventory Lookup reference only |
| Marketplace/store setup | Setup / Marketplace Connections | Shopify module quick link |
| Sales order work | Outbound / Sales Orders | Home dashboard, customer portal |
| Shipped order history | Outbound / Shipped Orders | Customer portal shipped filter |
| Purchase order work | Inbound / Purchase Orders | Home dashboard, customer portal |
| Physical receiving | Inbound / Receiving | Mobile Receive |
| Stock lookup | Inventory / Inventory Lookup | Mobile Lookup |
| Stock movement/correction | Inventory / Adjust & Move | Mobile Adjust/Move |
| Labels | Inventory / Labels | Mobile Labels |
| Email tests and delivery log | System / Admin & System | Company Email Flow related action plus Email Queue / Delivery Log |
| Bug/feature requests | System / Admin & System | Customer portal and warehouse floating button |

## Next UI Pass

Recommended next build pass:
- Continue cleaning `inventoryPanel` so Master Data reads like a tight setup list instead of an all-purpose index.
- Keep `searchPanel` focused on inventory lookup and results only.
- Rename Integrations in menus and headers to `Marketplace Connections`.
- Reorder Admin & System so email flow, users, and feature access are easier to find.
- Add a planned `Quote & Ship` shell under Outbound only when we are ready to build the shipping rate workflow.
