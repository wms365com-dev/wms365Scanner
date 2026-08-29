# WMS365 Competitive Intelligence

Last reviewed: 2026-08-27

## Guardrails

- Research uses official public feature documentation only.
- Only WMS365 feature metadata and anonymized aggregate measures may be analyzed.
- Customer, user, order, inventory, document, credential, and billing data must never leave WMS365 for product research.
- Competitor patterns inform requirements; competitor code, copy, layouts, and assets must not be copied.

## Current Position

WMS365 is comparatively strong in customer and warehouse isolation, multi-location fulfillment, customer portal workflows, pallet-level receiving and outbound capture, inventory investigation holds, split-location shipments, kitting, lot/expiry controls, 3PL billing events, and detailed exception history.

## Primary Competitors

| Competitor | Primary comparison | WMS365 response |
| --- | --- | --- |
| Extensiv 3PL Warehouse Manager | 3PL billing, mobile scanning, receiving, customer visibility, reporting, integrations, dock/parcel workflows, and EDI/API support | Prioritize billing reconciliation, rapid mobile receiving, customer self-service, integration breadth, and complete charge capture. |
| ShipHero | Mobile pick/pack, tote-based batch picking, replenishment, multi-warehouse allocation, shipping automation, and e-commerce speed | Prioritize scan-to-pack, replenishment, wave/batch picking, cartonization, shipping automation, and fast mobile execution. |

Deposco remains a secondary architecture and API reference. It is not part of the primary commercial comparison set.

## Prioritized Gaps

| Priority | Capability | WMS365 direction |
| --- | --- | --- |
| Critical | Scan-to-pack and cartonization | Scan each packed line, assign contents to cartons, capture package weight/dimensions, and block mis-packs. |
| Critical | Replenishment | Min/max forward-pick rules, reserve-to-pick tasks, urgency, and empty-pick-face prevention. |
| High | Wave and batch picking | Safe cross-order batches, tote/cart assignment, optimized routes, and strict customer/warehouse boundaries. |
| High | Shipping automation | Address validation, shipping-method mapping, explainable warehouse routing rules, and automation audit history. |
| High | Parcel rate shopping and labels | Complete carrier rating, labels, manifests, voids, package templates, and tracking callbacks. |
| High | Dock scheduling | Door/capacity calendars, check-in, dwell time, carrier status, and late-arrival management. |
| High | Returns/RMA | Inspection, disposition, quarantine, restock, disposal, photos, reason codes, and billable events. |
| Medium | Cycle-count maturity | Blind counts, mobile assignment, recount thresholds, approvals, and inventory-accuracy trends. |
| Medium | Labor analytics | Task throughput, aging, exception rates, travel time, and worker-safe performance views. |
| Medium | Billing automation | Review queue, idempotent charges, approvals, invoice export, and reconciliation before emails resume. |

## Official Reference Signals

- ShipHero documents multi-warehouse allocation, receiving, replenishment levels, cycle counting, kitting, putaway, guided mobile picking, batch creation, routing rules, shipping-method mapping, and address validation: https://get.shiphero.com/ecommerce-wms/
- ShipHero's multi-item batch workflow assigns orders to totes and guides workers through sequenced pick locations: https://software-help.shiphero.com/hc/en-us/articles/4419336440333-How-to-Multi-Item-Batch-Pick-MIB
- ShipHero inventory documentation emphasizes sellable/non-sellable stock, continuous cycle counting, and replenishment controls: https://www.shiphero.com/software/inventory
- Extensiv documents 3PL billing, mobile scanning, customer visibility, reporting, carrier/marketplace integrations, assemblies, and custom labels: https://www.extensiv.com/solutions/3pls
- Extensiv 2026 release notes describe rapid receiving, replenishment controls, cross-customer pick jobs, and SmartScan improvements: https://help.extensiv.com/en_US/2026/extensiv-2026-q2-release-notes
- Deposco's developer reference reinforces separate orders, shipments, inventory transactions, receipts, billing, work, counts, replenishment, bulk imports, and OAuth integrations: https://developer.deposco.com/docs/reference

## Agent Workflow

Run `npm run research:wms` to generate `outputs/product-intelligence/wms-feature-gap-audit.json`. The local agent should use that audit and this report when proposing features, and update the source review before treating time-sensitive competitor capabilities as current.
