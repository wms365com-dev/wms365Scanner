# WMS365 Competitive Intelligence

Last reviewed: 2026-09-02

## Guardrails

- Research uses official public feature documentation only.
- Only WMS365 feature metadata and anonymized aggregate measures may be analyzed.
- Customer, user, order, inventory, document, credential, and billing data must never leave WMS365 for product research.
- Competitor patterns inform requirements; competitor code, copy, layouts, and assets must not be copied.

## Current Position

WMS365 is comparatively strong in customer and warehouse isolation, multi-location fulfillment, customer portal workflows, pallet-level receiving and outbound capture, inventory investigation holds, split-location shipments, kitting, lot/expiry controls, 3PL billing events, and detailed exception history. Customer-entered ship-to addresses now have saved-address, provider-backed verification, and explicitly audited manual-confirmation paths bound to the customer and exact physical destination.

## Customer Portal Benchmark

The September 2026 portal review covers 17 WMS products and product families. Direct 3PL customer-portal evidence was found for Extensiv, ShipHero, CartonCloud, Mintsoft, Logiwa, Deposco, Ongoing WMS, Mecalux, and SnapFulfil. Enterprise and execution references were also reviewed for Oracle, Manhattan, Blue Yonder, SAP, Hopstack, Infoplus, Peoplevox, and Korber.

The complete evidence matrix, confidence notes, repeated patterns, and WMS365 acceptance tests are maintained in `docs/WMS365_CUSTOMER_PORTAL_BENCHMARK.md`.

Repeated market patterns are persistent tenant/warehouse scope, an action-oriented home, self-service across the full order lifecycle, strong search, direct access to tracking/POD and receipt evidence, multiple order-entry paths, proactive exceptions, mobile continuity, and auditable account security.

## Primary Competitors

| Competitor | Primary comparison | WMS365 response |
| --- | --- | --- |
| Extensiv 3PL Warehouse Manager | 3PL billing, mobile scanning, receiving, customer visibility, reporting, integrations, dock/parcel workflows, and EDI/API support | Prioritize billing reconciliation, rapid mobile receiving, customer self-service, integration breadth, and complete charge capture. |
| ShipHero | Mobile pick/pack, tote-based batch picking, replenishment, multi-warehouse allocation, shipping automation, and e-commerce speed | Prioritize scan-to-pack, replenishment, wave/batch picking, cartonization, shipping automation, and fast mobile execution. |

Deposco is now both an architecture reference and a primary portal comparison following its official Bright Portal announcement. CartonCloud, Mintsoft, Logiwa, and Ongoing WMS are added as direct portal workflow references. Enterprise products remain architecture and visibility references rather than like-for-like WMS365 portal comparisons.

Current Extensiv public documentation is inconsistent on scan-to-pack and cross-customer picking availability. The June 30, 2026 release notes describe cross-customer pick jobs and SmartScan pack improvements, while the current Managing Warehouses help article still labels `SmartPack - Require Scan to Pack` and `Enable cross-customer pick jobs` as sandbox-only. Treat both as strong market signals, but do not assume uniform general availability without another official confirmation point.

## Prioritized Gaps

| Priority | Capability | WMS365 direction |
| --- | --- | --- |
| Critical | Scan-to-pack and cartonization | Scan each packed line, assign contents to cartons, capture package weight/dimensions, and block mis-packs. |
| Critical | Customer portal global search | Permission-aware search across SKU, order, PO, inbound, tracking, and reference without broadening tenant or warehouse access. |
| Critical | Replenishment | Min/max forward-pick rules, reserve-to-pick tasks, urgency, and empty-pick-face prevention. |
| High | Wave and batch picking | Safe cross-order batches, tote/cart assignment, optimized routes, and strict customer/warehouse boundaries. |
| High | Shipping automation | Complete the provider rollout for the implemented customer address-verification gate, then add shipping-method mapping, explainable warehouse routing rules, and automation audit history. |
| High | Parcel rate shopping and labels | Complete carrier rating, labels, manifests, voids, package templates, and tracking callbacks. |
| High | Dock scheduling | Door/capacity calendars, check-in, dwell time, carrier status, and late-arrival management. |
| High | Returns/RMA | Inspection, disposition, quarantine, restock, disposal, photos, reason codes, and billable events. |
| High | Customer notifications | Scoped, deduplicated in-app and email exceptions for shortages, arrivals, missing documents, appointments, shipments, and billing. |
| Medium | Cycle-count maturity | Blind counts, mobile assignment, recount thresholds, approvals, and inventory-accuracy trends. |
| Medium | Labor analytics | Task throughput, aging, exception rates, travel time, and worker-safe performance views. |
| Medium | Billing automation | Review queue, idempotent charges, approvals, invoice export, and reconciliation before emails resume. |

## Official Reference Signals

- ShipHero documents multi-warehouse allocation, replenishment, returns rules, guided mobile picking, automatic batch creation, rate shopping, routing, shipping-method mapping, and address validation: https://get.shiphero.com/ecommerce-wms/
- ShipHero's current picking-methods documentation confirms tote-based multi-item batches, single-item batches, QR-code picking, and location-aware picking: https://software-help.shiphero.com/hc/en-us/articles/46892350249997-Overview-Picking-Methods-in-ShipHero
- ShipHero's batch-pack workflow confirms tote-first single-item batch packing, one-screen packing, box/weight capture, label printing, and bulk label management: https://software-help.shiphero.com/hc/en-us/articles/8492413204365-How-to-Single-Item-Batch-Pack-Using-the-ShipHero-Web-App
- ShipHero weight discrepancy detection blocks label printing until pack variance is resolved or overridden: https://software-help.shiphero.com/hc/en-us/articles/11801446343309-Setting-Up-Weight-Discrepancy-Detection
- Extensiv documents 3PL billing, mobile scanning, customer visibility, reporting, carrier/marketplace integrations, assemblies, and custom labels: https://www.extensiv.com/solutions/3pls
- Extensiv 2026 release notes describe rapid receiving, replenishment controls, cycle-count reporting, SmartScan move/pick/pack fixes, and cross-customer pick jobs: https://help.extensiv.com/en_US/2026/extensiv-2026-q2-release-notes
- Extensiv's current replenishment guidance documents quantity-driven allocation, pick-line minimum/maximum triggers, and SmartScan replenishment execution: https://help.extensiv.com/en_US/3pl-warehouse-manager-inventory-management/replenishments
- Extensiv's current warehouse-settings guide still labels `SmartPack - Require Scan to Pack` and `Enable cross-customer pick jobs` as sandbox-only controls: https://help.extensiv.com/warehouse-setup/managing-warehouses
- Deposco's official developer portal exposes first-party API reference, guides, and changelog resources for integration architecture review: https://developer.deposco.com/
- Extensiv's customer portal documents scoped inventory plus shipping, receiving, and work-order creation with permission controls: https://help.extensiv.com/wm-customer-portal-info/1619030-customer-portal-overview
- Ongoing WMS documents customer order and purchase-order creation, tracking, goods flow, inventory, statistics, configurable lists, password controls, and 2FA: https://docs.ongoingwarehouse.com/manuals/customer-manual
- CartonCloud presents live inventory, movements, orders, delivery status, PODs, invoices, reports, and customer isolation in its first-party portal overview: https://www.cartoncloud.com/en-us/platform/customer-portal
- Google documents address standardization and deliverability signals through Address Validation, with explicit accept, confirm, and fix outcomes: https://developers.google.com/maps/documentation/address-validation
- Google documents session-token continuity between Places Autocomplete and Address Validation: https://developers.google.com/maps/documentation/places/web-service/place-autocomplete
- Geoapify documents worldwide address autocomplete, confidence signals, storage-friendly results, and a 3,000-credit daily free tier with required attribution and limited commercial use: https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/ and https://www.geoapify.com/pricing/
- The public OpenStreetMap Nominatim policy expressly forbids client-side autocomplete, so WMS365 must not use that public endpoint for live order entry: https://operations.osmfoundation.org/policies/nominatim/

## Agent Workflow

Run `npm run research:wms` to generate `outputs/product-intelligence/wms-feature-gap-audit.json`. The local agent should use that audit and this report when proposing features, and update the source review before treating time-sensitive competitor capabilities as current.
