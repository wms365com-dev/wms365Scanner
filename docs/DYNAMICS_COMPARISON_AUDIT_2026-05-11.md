# WMS365 / Business Central Layout Comparison Audit

Captured: 2026-05-11

Purpose:
- Capture differences between WMS365 Warehouse Central and Microsoft Dynamics 365 Business Central so the WMS365 desktop can keep moving toward a tighter, list-first, drill-in ERP workflow.
- This is a usability benchmark only. WMS365 must keep its own branding, warehouse terminology, and product identity.

Capture evidence:
- Dynamics role center and attempted workflow set: `C:\Users\T470\Downloads\wms365-dynamics-compare\workflow-2026-05-11T01-05-47-403Z`
- Dynamics keyboard/Tell Me workflow set: `C:\Users\T470\Downloads\wms365-dynamics-compare\dynamics-keyboard-2026-05-11T01-21-34-574Z`
- Dynamics list/item drill set: `C:\Users\T470\Downloads\wms365-dynamics-compare\dynamics-drill-2026-05-11T01-32-31-982Z`
- WMS365 HEALTEA workflow set: `C:\Users\T470\Downloads\wms365-dynamics-compare\wms-company-workflow-2026-05-11T01-28-39-404Z`
- WMS365 visible shortcut audit: `C:\Users\T470\Downloads\wms365-dynamics-compare\wms-visible-nav-audit-2026-05-11T01-51-44-193Z`
- WMS365 item-card drill capture: `C:\Users\T470\Downloads\wms365-dynamics-compare\wms-item-card-2026-05-11T01-42-12-049Z`

## High-Level Result

WMS365 is now structurally close in the major shell areas:
- black top app bar
- module menu row
- command ribbon
- list-first Sales Orders and Purchase Orders
- right-side FactBox
- document drill-in overlays for Sales Orders and Purchase Orders

The biggest remaining gaps are not branding. They are information architecture and density:
- Items, Customers, and Vendors are still buried inside a large Master Data workspace instead of opening as clean list pages.
- Sales Orders and Purchase Orders start with too much filter/card space before the grid.
- The command bar is still too global, so commands appear on pages where they are not truly contextual.
- The home/dashboard has useful warehouse planning, but the role-center concept needs tighter activity tiles for email, integrations, billing, rush work, and job/sync status.

## Confirmed Gaps

| Priority | Area | Dynamics pattern observed | WMS365 current behavior | Fix direction |
| --- | --- | --- | --- | --- |
| P1 | Items | Top `Items` link opens an item list immediately, then users drill into an item card. | `Items` lands in Master Data and the Saved Items grid is far down the page after company setup, location assignment, portal access, BINs, inventory snapshot, and worksheet. | Make Items a first-class list page or popout. Put item grid at the top, then drill into item card. |
| P1 | Customers / Vendors | Customers and Vendors open list pages with right-side details and command actions. | Customer and Vendor links route to Master Data partner cards, mixed with other setup work. | Add clean Customers and Vendors list-first views with card drill-in. |
| P1 | Visible shortcut behavior | Visible shortcuts move users directly to the requested list. | The visible `Customers`, `Vendors`, and `Items` shortcuts set the command context to Master Data, but the viewport remains on the Inventory Index/top setup area. | Either open focused list pages or immediately render the requested list as the primary content above the fold. |
| P1 | Command bar | Commands are page-contextual. | `+ New`, `Delete`, `Release`, `Post...`, `Print/Send`, and `Order` stay visible across pages, even when some actions are not valid. | Hide or disable commands unless valid for the active page and selected row/document. |
| P1 | Sales Orders list density | Command ribbon and grid appear quickly, with FactBox on the right. | Sales Orders has a large filter card and Order Snapshot before the grid. | Compress filters into a single toolbar row and move counts to compact clickable chips. Keep the grid visible higher. |
| P1 | Purchase Orders list density | List grid shows vendor, document, date, status, assigned user, and location-style columns. | WMS365 PO list is clean but sparse: No., Reference, Expected Date, Lines, Docs, Status. | Add useful warehouse columns such as company, vendor/contact, carrier, expected date, lines, docs, status, assigned user/warehouse, and receiving state. |
| P1 | Master Data workspace | Setup is separated from daily list pages. | Master Data still feels like a feature dump because many unrelated cards are visible together. | Split visible entry points: Companies, Customers, Vendors, Items, BINs, Warehouses, Portal Users, Bulk Worksheet. Each opens a focused list/card. |
| P2 | Sales Order document | Business Central document has sticky page header, action tabs, General fasttab, Lines grid, and document actions. | WMS365 drill-in is close, but the form is tall and pushes lines down. | Tighten field rows, keep Lines higher, use collapsible fasttabs, and keep actions sticky. |
| P2 | Purchase Order document | PO document uses the same document pattern as sales orders. | WMS365 PO drill-in is close, but receiving actions and documents are lower than ideal. | Use fasttabs: General, Lines, Receiving, Documents. Keep `Receive` action visible and contextual. |
| P2 | Home / Role Center | Dynamics uses compact activity sections: sales, purchases, payments, job queue, email status, approvals, documents. | WMS365 has good operational planning, but the Warehouse Directory takes a lot of space. | Replace or collapse the directory with compact activity tiles: open inbounds, open outbounds, staged, rush/SLA, failed sync, email health, billing ready, feedback. |
| P2 | FactBox | FactBox changes by page and selected record. | WMS365 FactBox exists but related actions are generic. | Make FactBox page-aware: order details on Sales Orders, vendor/receipt details on Purchase Orders, item stats on Items, company setup info on Master Data. |
| P2 | Company switcher | Dynamics company switcher is mostly selection/search, with a clean side panel. | WMS365 correctly supports Add Company, but the add flow can visually crowd the switcher. | Keep a compact `+ Add Company` action, open the full company setup as a modal, show a success dialog/toast, then return to clean company list. |
| P3 | Finance / Cash Management modules | Dynamics has fully built accounting functions behind those modules. | WMS365 shows Finance and Cash Management, but they mostly route to Billing/Reports. | Either rename to Commercial/Billing until Zoho workflow is fully built, or keep but ensure every item opens a useful Billing page. |
| P3 | Visual density | Dynamics uses thin rows, square-ish controls, fewer big rounded cards, and strong grid alignment. | WMS365 is much closer than before, but still has several large soft cards and extra vertical whitespace. | Continue moving to tight tables, smaller section headers, and rigid form rows. |

## Page-by-Page Notes

### Warehouse Dashboard

What works:
- The WMS365 dashboard is warehouse-focused and more useful for 3PL day planning than the default Dynamics role center.
- The right FactBox and top counts help supervisors see operational status.

What to improve:
- Reduce the Warehouse Directory footprint.
- Add role-center-style activity groups for system health: email status, failed integrations, rush orders, SLA risk, billing-ready work, and feedback queue.
- When `All Companies` is selected, show totals and drill-in buttons rather than empty-looking detail sections.

### Sales Orders

What works:
- HEALTEA Sales Orders now open as a true list first.
- The order number drills into a document overlay.
- Statuses are visible and separated: Draft, Released, Staged, Shipped.

What to improve:
- Grid should start higher on the page.
- Order Snapshot should become compact clickable filters, not a large card above the table.
- Add SLA/rush columns once turnaround rules are implemented.
- Command bar should only show actions that are valid for the selected row or open document.

### Sales Order Document

What works:
- Document overlay is close to the Business Central pattern.
- Action tabs and commands exist.
- Reopen to Draft, Print Pick Ticket, Print Packing Slip, and Select Items are visible.

What to improve:
- Lines are still too low because General fields take too much height.
- Add a compact document status area with Saved/Unsaved state, source integration, allocation state, rush/SLA, and documents count.
- Keep ship-to address suggestions integrated but visually lighter.

### Purchase Orders

What works:
- Purchase Orders now open as a list first.
- Drill-in PO document exists and is separate from physical receiving.

What to improve:
- PO list needs more operational columns.
- New PO and Receive actions should be contextual.
- Receiving status and documents should be visible on the list without opening the PO.

### Purchase Order Document

What works:
- WMS365 PO document uses the same document overlay pattern as Sales Orders.
- Lines and receiving actions are present.

What to improve:
- Use collapsible fasttabs so General, Lines, Receiving Actions, and Documents are clearly separated.
- Put uploaded documents in a tighter document strip or FactBox.
- Keep `Mark Received` sticky when a PO is eligible.

### Items

Confirmed issue:
- The top `Items` quick link does not feel like Dynamics because it does not open an item list as the primary screen.
- The item list appears far down inside Master Data, after unrelated company setup sections.
- A follow-up Playwright pass confirmed the item card opens through the saved-item rows, so the wiring exists. The remaining issue is that the item list/card path is buried in a long setup workspace instead of being a clean daily-work list page.
- The visible shortcut pass confirmed `Items` changes the command context to `Master Data`, but the viewport remains at the Inventory Index/top of Master Data instead of moving the saved item list above the fold.

Required fix:
- Create a focused Items list screen with columns: SKU, Description, UPC, Stock UOM, Tracking, Lot Required, Expiration Required, Pick Rule, Case Pack, Dims/Weight, Active/Blocked.
- Opening SKU should pop out an Item Card.
- The Item Card should contain fasttabs: General, Inventory Controls, Store SKU Mapping, Lot/Expiration, Dimensions & Packaging, Barcode/Photo, Related Inventory.

### Customers and Vendors

Confirmed issue:
- Customers and Vendors should behave like list/card records, not just embedded setup panels.
- The visible shortcut pass confirmed `Customers` and `Vendors` also land users at the Master Data top/Inventory Index, not a focused customer/vendor list.

Required fix:
- Add customer list and vendor list views.
- Drill into Customer Card / Vendor Card.
- Keep company scoping strict so records never cross customer companies.

### Company Switcher

What works:
- The top building icon is the right place for company switching.
- Company scoping is visible in the top bar.

What to improve:
- Keep the switcher primarily as a picker.
- `+ Add Company` should open a full setup modal and close with a clear success state.
- Do not let inline add forms make the company list feel cramped.

## Recommended Fix Order

1. Build focused Items, Customers, and Vendors list/card screens.
2. Move Master Data from one long workspace into focused setup launchers and popouts.
3. Compress Sales Orders and Purchase Orders list headers so grids appear above the fold.
4. Make command bar actions contextual per page and per selected record.
5. Tighten Sales Order and Purchase Order documents with fasttabs and sticky command headers.
6. Add role-center activity tiles for email, sync jobs, rush/SLA, billing ready, and feedback.
7. Make the right FactBox page-aware and record-aware.
8. Revisit Finance/Cash Management naming once Billing/Zoho scope is implemented.

## Test Status

Captured successfully:
- Dynamics role center
- Dynamics Sales Orders list
- Dynamics Purchase Orders list
- Dynamics Items list
- Dynamics Customers list
- WMS365 HEALTEA dashboard
- WMS365 HEALTEA Sales Orders list
- WMS365 HEALTEA Sales Order document drill-in
- WMS365 HEALTEA Purchase Orders list
- WMS365 HEALTEA Purchase Order document drill-in
- WMS365 HEALTEA Master Data / Items path
- WMS365 HEALTEA Item Card drill-in from the buried Saved Items grid
- WMS365 visible shortcut routing for Customers, Vendors, Items, Inventory, Sales Orders, Purchase Orders, and Reports

Remaining to test after fixes:
- Item Card drill-in from a focused Items list after Items is promoted out of Master Data.
- Customer Card and Vendor Card drill-in.
- Context-aware command bar behavior.
- Company switcher add-company modal success flow.
- Mobile isolation after desktop layout changes.

## Follow-Up Pass After Current Layout Fixes

Captured: 2026-05-11, follow-up current WMS pass

Evidence:
- Current WMS captures: `C:\Users\T470\Downloads\wms365-dynamics-compare\followup-current-wms-2026-05-11T02-52-32-025Z`
- Dynamics reference remains: `C:\Users\T470\Downloads\wms365-dynamics-compare\dynamics-drill-2026-05-11T01-32-31-982Z`

Confirmed improved:
- Home command bar no longer exposes order/document actions such as Release, Post, Print/Send, or Order when the user is on the Warehouse Dashboard.
- Customers, Vendors, and Items now open a focused list host at the top of the Master Data panel.
- Items focused list no longer shows the Inventory Index and full Master Data workspace below it, which makes the page behave more like a Business Central list page.
- Sales Orders and Purchase Orders keep the list-first flow and page-specific command labels.

Remaining Dynamics-style gaps:
- The right FactBox is still page-level and generic. It should react to the selected row: order/customer statistics on Sales Orders, vendor/receipt details on Purchase Orders, and item inventory/handling details on Items.
- Home still has a large Warehouse Directory below the planning cards. Dynamics role centers use compact activity tiles and links instead of a long directory, so this should be collapsed or moved behind a `Menu`/`Explore` drill-in.
- Sales Orders still carries more header/filter height than Dynamics. The next pass should turn the filter and status counts into one tight toolbar row so the table starts higher.
- Purchase Orders remains sparse compared with Dynamics lists. Add operational columns for vendor/contact, carrier, expected date, warehouse/fulfillment location, receiving status, document count, and assigned user.
- Focused Customers/Vendors/Items lists need populated FactBox details and selected-row highlighting once a company is active.
- Document cards need a clearer saved/unsaved state and tighter fasttabs so General, Lines, Documents, and Processing fit more like a rigid ERP form.
- Finance/Cash Management still reads like full accounting modules while most behavior currently routes to Billing/Reports. Either complete those module pages or relabel them to avoid implying unfinished accounting features.

Recommended next build pass:
- Make the FactBox record-aware and add selected-row state to Sales Orders, Purchase Orders, Items, Customers, and Vendors.
- Collapse Warehouse Directory into a compact role-center activity group.
- Tighten Sales Orders and Purchase Orders filter rows.
- Add PO operational columns and receiving state.
- Continue converting large rounded cards into square, compact, grid-aligned ERP sections.
