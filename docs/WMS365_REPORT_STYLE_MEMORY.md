# WMS365 Report Style Memory

Use this as the current default for customer-facing receipt documents and similar operational confirmations.

## Receiving Confirmation Default

For now, receiving confirmation documents should match the professional layout used for:

- `reports/INB-000118_Zeta_Group_BC_Professional_Receipt_2026-06-01.pdf`
- `reports/INB-000118_Zeta_Group_BC_Professional_Receipt_2026-06-01.xlsx`
- `reports/INB-000118_Zeta_Group_BC_Professional_Receipt_2026-06-01.html`

Preferred presentation:

- Header band with WMS365 Receiving label, `Receipt Confirmation` title, and inbound number.
- Green confirmation badge when full expected quantity was received.
- Summary tiles for received quantity, expected quantity, line count, and received date.
- Clean information blocks for company, warehouse, status, reference, packing slip, and container.
- Received lines table with dark blue header row, alternating subtle row shading, right-aligned quantities, and visible receiving location.
- Customer-facing status labels should be human-readable, such as `Received Pending Putaway`, not raw enum text like `RECEIVED_PENDING_PUTAWAY`.
- Large quantities should use thousands separators, such as `8,810`.
- PDF should be generated from a styled HTML page, not from the plain text PDF helper, unless there is no browser renderer available.
- Excel should be styled with a title, summary area, frozen line-header row, column widths, filters, and the same core line data as the PDF.

When asked to create a receipt report, provide PDF and Excel by default if the user asks for a shareable document or report package.
