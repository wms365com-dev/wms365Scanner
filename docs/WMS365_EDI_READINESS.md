# WMS365 EDI Readiness

## Current assessment

WMS365 has a useful EDI foundation but is not yet ready to claim certified end-to-end EDI support. The versioned partner API, external identifiers, idempotency controls, separate warehouse shipments, inventory ledger, tracking, and GS1/UCC-128 labels should remain the canonical business layer behind an EDI gateway.

## Readiness matrix

| Transaction | Business purpose | Direction | Current readiness | Required completion gate |
| --- | --- | --- | --- | --- |
| X12 850 | Purchase order / customer sales order | Inbound | Partial | Trading-partner mapping creates one idempotent order and preserves PO, dates, addresses, UOM, qualifiers, and line references. |
| X12 855 | Purchase order acknowledgement | Outbound | Gap | Accept, reject, and change acknowledgements are generated from WMS365 status and quantity decisions. |
| X12 856 | Advance ship notice | Outbound | Partial | Shipment, pallet, carton, SSCC, item, lot, quantity, carrier, tracking, and ship date hierarchy validates against partner rules. |
| X12 810 | Invoice | Outbound | Gap | Approved billing events produce a balanced invoice with partner-required charges, allowances, and references. |
| X12 940 | Warehouse shipping order | Inbound | Partial | Creates or updates the canonical customer order without bypassing inventory, warehouse, or permission controls. |
| X12 945 | Warehouse shipping advice | Outbound | Partial | Reports actual shipped and short quantities, warehouse, carrier, tracking/BOL, pallets, and shipment date. |
| X12 846 | Inventory inquiry/advice | Outbound | Partial | Reports customer- and warehouse-scoped available inventory while excluding hold, damaged, and investigation stock. |
| X12 997 | Functional acknowledgement | Both | Gap | Every interchange is acknowledged; rejected groups and segments appear in an actionable exception queue. |

## Platform controls

- Trading-partner profiles with sender/receiver IDs, version, delimiters, test/production mode, document requirements, and contact escalation.
- Unique ISA, GS, ST, and partner document control numbers with duplicate detection and replay protection.
- Mapping versions with effective dates so partner changes do not alter historical documents.
- Validation before posting to WMS365, including SKU cross-references, UOM conversions, addresses, dates, quantities, and required qualifiers.
- Retry and exception queues with plain-language errors, ownership, timestamps, and safe reprocessing.
- Immutable raw interchange retention plus links to the resulting order, shipment, inventory advice, or invoice.
- Encryption in transit, least-privilege credentials, secret rotation, access logging, and customer isolation.
- Monitoring for missing acknowledgements, overdue ASNs, rejected documents, duplicates, and delivery failures.
- Certification suites per trading partner using a test company before production activation.

## Recommended architecture

1. Receive X12 through a managed EDI network or secure AS2/SFTP gateway.
2. Validate envelopes, control numbers, partner identity, and transaction syntax.
3. Convert X12 into a versioned canonical WMS365 message.
4. Post through `/api/v1` using an idempotency key derived from the partner and document control number.
5. Generate the required 997 and business response.
6. Keep status, retries, errors, and source-to-record links in an EDI operations console.

## Definition of EDI ready

WMS365 may be described as EDI ready only after the target partner's required transactions pass test-company mapping, duplicate, retry, rejection, security, warehouse-isolation, quantity reconciliation, and end-to-end certification tests. Readiness is certified per trading partner, not once for the entire platform.
