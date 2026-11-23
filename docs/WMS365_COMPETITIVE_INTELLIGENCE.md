# WMS365 Competitive Intelligence

## Print Connector Authentication Review

Reviewed 2026-09-16 against primary security references: IETF RFC 9449 (https://www.rfc-editor.org/rfc/rfc9449.html), the official JOSE library (https://github.com/panva/jose), and OWASP REST guidance (https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html). Priority: high. Value: a copied workstation token alone cannot expose warehouse documents; users retain normal warehouse sign-in and scoped printing. Risk: key management, distributed replay protection, credential expiry and coordinated legacy re-enrollment. Dependencies: signed-release rollout, additive print-auth schema, synchronized clocks and secure Windows accounts. Acceptance: actual signed browser enrollment passes; wrong-device/replay/body/URI/token/role/warehouse/customer tests fail closed; restricted attempts audit without secrets; installer and rollback preserve protected identity. This print protocol uses DPoP checks plus a WMS-specific body-binding extension, not a claim of a full OAuth authorization server or hardware-key attestation.

## Print Connector Update Safety Review

Reviewed 2026-09-16: ShipStation's official Connect overview describes a background workstation bridge, normal-account registration and per-document printer defaults: https://help.shipstation.com/hc/en-us/articles/360026157851-Introduction-to-ShipStation-Connect. This source supports those workflow patterns, not a claim about ShipStation's update-signing implementation.

Priority: high. Customer value: fewer manual installations and consistent document output. Warehouse value: workstation fixes without interrupting active prints. Risk: a workstation updater is a software supply-chain boundary. Dependencies: pinned publisher public key, owner-protected private key/recovery, dedicated durable release hosting and backend deployment. Acceptance: reject altered/expired/off-host announcements, never downgrade, wait for active print jobs, preserve configuration/receipts, restart successfully or restore the previous release, and verify real letter/thermal printers on a pilot workstation before wider distribution. WMS365 1.3.0 implements this independently; live hosting, key recovery and physical printer rollout remain release gates.

Last reviewed: 2026-09-21

## Guardrails

Shopify delivery review 2026-09-17: Shopify's fulfillment-event mutation supports
carrier pickup, transit and confirmed delivery with `write_fulfillments` and the
fulfill-and-ship permission. Its notification guide says out-for-delivery and
delivered emails trigger from carrier or fulfillment-app tracking events. This
does not expose proof that an individual email reached the customer. AfterShip's
current supported-carrier table maps GLS Canada/Dicom to `dicom`, not generic
`gls`. Sources: https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentEventCreate ;
https://help.shopify.com/en/manual/fulfillment/setup/notifications/customer-notifications ;
https://www.aftership.com/docs/tracking/others/supported-couriers . Priority: high.
Customer value: accurate tracking and fewer duplicate messages. Warehouse value:
fewer delivery enquiries. Risk: false delivery, duplicate remote effects and
cross-store disclosure. Dependencies: provider access, Shopify development-store
verification and audited notification configuration. Acceptance: all three
Canadian carriers pass genuine scan-to-Shopify-to-inbox verification plus shared
package, retry and ownership negative tests. See `SHOPIFY_DELIVERY_TRACKING_ROLLOUT.md`.

- Research uses official public feature documentation only.
- Only WMS365 feature metadata and anonymized aggregate measures may be analyzed.
- Customer, user, order, inventory, document, credential, and billing data must never leave WMS365 for product research.
- Competitor patterns inform requirements; competitor code, copy, layouts, and assets must not be copied.

## Current Position

Android review 2026-09-16: ShipHero's official mobile and location-directed QR picking guides emphasize scanner-confirmed locations/items and task-directed work; Extensiv's official SmartScan page describes ASN receiving, picking and location/item counts. Sources: https://software-help.shiphero.com/hc/en-us/articles/8497107616269-User-Guide-ShipHero-iOS-Mobile-App ; https://software-help.shiphero.com/hc/en-us/articles/16985098558861-How-to-Use-Bulk-Ship-with-QR-Code-Picking ; https://www.extensiv.com/3pl/products/smartscan . These are workflow references, not verified competitor security/offline details. High-priority WMS365 work: protect trusted native interactions and recovery first, then validate scan-directed tasks, shared-device cache isolation, conflict-safe offline sync and upgrade distribution on the actual test device. Customer/warehouse value, risks, dependencies and acceptance checks are recorded in `docs/ANDROID_APP_UPGRADE_CHECKLIST.md`. Build 39 is an unshipped hosted-app candidate, not a native-prototype rollout.

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

Extensiv's Q3 2026 release notes provide verified market signals for multi-part GS1 scanning in receipt and pick workflows, retry of timed-out webhooks, richer item/replenishment configuration, normalized parcel tracking (open beta), and more complete billing/payment visibility. These reinforce WMS365 priorities for scan-directed execution, retry-safe integrations, replenishment, shipment visibility, and billing reconciliation; beta status is retained where Extensiv states it.

## Prioritized Gaps

| Priority | Capability | WMS365 direction |
| --- | --- | --- |
| Critical | Scan-to-pack and cartonization | Scan each packed line, assign contents to cartons, capture package weight/dimensions, and block mis-packs. |
| Critical | Customer portal global search | Permission-aware search across SKU, order, PO, inbound, tracking, and reference without broadening tenant or warehouse access. |
| Critical | Replenishment | Min/max forward-pick rules, reserve-to-pick tasks, urgency, and empty-pick-face prevention. |
| High | Wave and batch picking | Safe cross-order batches, tote/cart assignment, optimized routes, and strict customer/warehouse boundaries. |
| High | Shipping automation | Complete the provider rollout for the implemented customer address-verification gate, then add shipping-method mapping, explainable warehouse routing rules, and automation audit history. |
| High | Parcel rate shopping and labels | Complete carrier rating, labels, manifests, voids, package templates, and tracking callbacks. |
| High | Carrier visibility | The WMS365 carrier tracking hub now provides normalized, immutable shipment timelines, signed webhook ingestion, retry-safe polling, selected-warehouse portal visibility, and a partner API. Activate a broad provider for Canadian carrier coverage, then add direct adapters where volume or cost justifies them. |
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
- Extensiv's Q3 2026 release notes document multi-part GS1 receipt/pick scanning, automatic retry of timed-out webhooks, expanded replenishment controls, normalized parcel tracking in open beta, and billing/payment visibility improvements. Reviewed 2026-09-07: https://help.extensiv.com/en_US/2026/extensiv-2026-q3-release-notes
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
- Karrio demonstrates a provider-adapter model for normalized rates, labels, manifests, and tracking while keeping carrier differences behind one API. Reviewed 2026-09-13: https://github.com/karrioapi/karrio
- Karrio's community carrier repository includes Canada Post, Purolator, UPS, FedEx, Canpar, Dicom, and Freightcom adapters; it does not provide the full Canadian carrier set WMS365 needs. Reviewed 2026-09-13: https://github.com/karrioapi/community
- AfterShip documents broad carrier tracking coverage including ICS Courier and Day & Ross plus signed tracking webhooks. Reviewed 2026-09-13: https://www.aftership.com/docs/tracking/others/supported-couriers
- Canada Post and Purolator publish first-party tracking integration services, supporting a future direct-adapter path for high-volume Canadian accounts: https://www.canadapost-postescanada.ca/info/mc/business/productsservices/developers/services/tracking/default.jsf and https://www.purolator.com/en/services/technology-solutions/e-ship-web-services

## Local printer bridge review - 2026-09-16

Official source: https://help.shipstation.com/hc/en-us/articles/360026157851-Introduction-to-ShipStation-Connect (reviewed 2026-09-16).

ShipStation documents normal account sign-in, background print delivery, per-document default printers, and managed device visibility. Its stated USB support does not certify arbitrary network printers.

Recommendation: **high**. Extend WMS365's queue with same-login enrollment and local mappings. Customer value: fewer dialogs. Warehouse value: letter/thermal routing. Risks: tenant exposure, duplicate labels, drivers, unsigned distribution. Dependencies: current permissions, durable receipts, Windows runtime and printer drivers. Acceptance: authorized test-company worker prints letter and 4x6 PDFs to separate devices; other warehouses/customers cannot claim; acknowledgment outage never prints another copy. Physical printer certification remains a separate release gate. Learn workflow patterns only; do not copy competitor assets or interfaces.

## Agent Workflow

Run `npm run research:wms` to generate `outputs/product-intelligence/wms-feature-gap-audit.json`. The local agent should use that audit and this report when proposing features, and update the source review before treating time-sensitive competitor capabilities as current.

## Verified changes reviewed 2026-09-14

- Extensiv's September 9-10 releases add cancellation-fee automation, richer rate conditions and weight units, and a size fallback for invoice PDFs. They also report duplicate-shipping and multi-SKU replenishment fixes. Evaluate cancellation charge policy and bounded invoice exports; include repeated shipment submission and shared-bin replenishment in acceptance coverage. Source: https://help.extensiv.com/en_US/2026/extensiv-2026-q3-release-notes
- Date correction to the September 7 audit: the current Extensiv source places GS1 scanning, webhook timeout retries, and parcel tracking under July 8, with the stated July 9 redeployment (parcel tracking was unaffected). These were not September 3 launches. Parcel tracking retains the source's open-beta qualification.
- ShipHero's developer changelog adds work-order completion on September 7 and shipping-container deletion on September 9. Assembly completion requires all units created and a receiving location. This reinforces explicit completion prerequisites and auditable lifecycle APIs for WMS365 kitting and shipping containers; it does not establish a WMS365 defect. Source: https://developer.shiphero.com/changelog/

## Verified changes reviewed 2026-09-21

- ShipHero's September 15 changelog expands `data_exports` access to all customers. Its documentation describes weekly full and six-hour delta exports in account-scoped Parquet files, with expiring download URLs. Sources: https://developer.shiphero.com/changelog/ and https://developer.shiphero.com/data-exports/ (reviewed 2026-09-21). **Medium**: assess resumable, scoped reporting exports beyond existing CSV/PDF reports. Customer value: repeatable reconciliation; warehouse value: fewer manual exports. Dependencies: authorization, stable record identity, retention and job capacity. Risk: incomplete incremental reconstruction or exposed downloads. Acceptance: synthetic full-plus-delta replay reconciles, repeated windows do not duplicate records, incomplete exports are explicit, and other tenants/warehouses cannot retrieve files. This is a published capability comparison, not proof of a WMS365 data-loss defect.
- Extensiv's September 14 notes report a SmartScan fix for reopening integration ASNs after partial receipt (TW-39094). Source: https://help.extensiv.com/en_US/2026/extensiv-2026-q3-release-notes (reviewed 2026-09-21; page updated September 17). **High validation priority**: include partial-receipt resume across integration, desktop and mobile. Customer value: accurate inbound progress; warehouse value: uninterrupted receiving. Dependencies: inbound state, receipt ledger and billing idempotency. Risk: duplicate receipt or charge during retries. Acceptance: receive partially, reopen on mobile, finish the remainder, and reconcile ledger and charges exactly once with tenant/warehouse negative tests. This vendor fix is not evidence of the same WMS365 defect.
## Official competitive update — 2026-10-12

Reviewed 2026-10-12 against first-party sources only. Extensiv's Q4 notes record fixes for duplicate EDI-order imports, packed-order weights reported as zero, scanner line readability, and a purchase-order/customer reassignment defect. Its Integration Management notes also add optional shipping-cost pass-back after shipment. These are release signals—not claims of feature parity—and reinforce WMS365's needs for idempotent inbound documents, package-weight integrity, mobile scanner usability, immutable customer ownership, and reconcilable shipping-cost billing. ShipHero's current official guidance describes an account-enabled mobile-picking beta with optional location-scan enforcement and scan-confirmed pack-to-light completion before label printing. WMS365 should retain its own design and strict company/warehouse controls rather than copy these interfaces. Sources: https://help.extensiv.com/en_US/2026/extensiv-2026-q4-release-notes ; https://help.extensiv.com/en_US/integration-management-2026/integration-management-2026-q3-release-notes ; https://software-help.shiphero.com/hc/en-us/articles/46892350249997-Overview-Picking-Methods-in-ShipHero ; https://software-help.shiphero.com/hc/en-us/articles/40686618630285-How-to-Ship-with-a-Pack-to-Light-Station

## Official competitive update — 2026-10-19

Reviewed 2026-10-19 against first-party sources only. Extensiv's October 14 Q4 release notes add bulk import/export management for item tags and replenishment settings and report faster large-SKU customer-item/rate pages. This materially reinforces, but does not prove parity for, WMS365's warehouse-scoped min/max replenishment configuration and safe bulk administration needs. ShipHero's October 9 picking guide confirms that picking methods are configured per warehouse, documents tote-bound multi-item and single-item batches, and qualifies Wave Picking with location-aware picking plus pick-to-light hardware. This supports WMS365's existing priority for configuration-scoped batch picking, while making hardware-dependent wave execution a later validation rather than an assumed baseline. Deposco's official developer portal was reviewed; no material publicly documented workflow change was accessible. Sources: https://help.extensiv.com/en_US/2026/extensiv-2026-q4-release-notes ; https://software-help.shiphero.com/hc/en-us/articles/46892350249997-Overview-Picking-Methods-in-ShipHero ; https://developer.deposco.com/

## Official competitive update — 2026-10-26

Reviewed 2026-10-26 against first-party sources only. ShipHero's October 21 developer update adds SKU-level inventory-push controls, including an optional connected-store list and discovery of each store's eligibility. This is a material workflow signal for WMS365: shared-pool Shopify inventory exports need explicit, company/store/variant-scoped enablement, auditable eligibility failures, and fail-closed behavior when prerequisite policy enforcement cannot be completed. Separately, ShipHero states that dynamic slotting is now always enabled and that its replenishment/location fields are available to all accounts; this reinforces WMS365's warehouse-scoped replenishment priority but does not establish a parity or live defect. Extensiv's October 15 Q4 notes fix lot/expiration output on custom MU labels, which reinforces preserving lot/expiry data through WMS365 print templates and tests. Deposco's official developer portal and Bright Portal announcement were rechecked; no newer material public workflow change was verified. Sources: https://developer.shiphero.com/changelog/ ; https://help.extensiv.com/en_US/2026/extensiv-2026-q4-release-notes ; https://developer.deposco.com/ ; https://deposco.com/blog/deposco-launches-bright-portal/

## Official competitive update — 2026-11-02

Reviewed 2026-11-02 against first-party sources only. Extensiv's October 21 and 28 Q4 notes correct repeated multi-part barcode handling in SmartScan Standard Pack and a receipt-scan path that could increase a selected SKU quantity to two; they also add a fallback from blank/zero imported receipt weights to the configured packaging weight. These are material integrity signals for WMS365: scan-to-pack and receiving must have idempotent scan semantics, explicit quantity confirmation, and a reviewed import-weight fallback that never silently invents a customer-supplied value. ShipHero's October 29 changelog says cycle counting is enabled for every account and integrations should stop using a capability flag to decide availability. This reinforces WMS365's pending cycle-count maturity work, including warehouse-scoped mobile assignment, recount approvals, and aggregate accuracy reporting. These sources are comparison signals, not evidence of equivalent WMS365 defects or an instruction to copy their implementation. Deposco's official developer reference remained inaccessible to public review and its Bright Portal announcement showed no newer workflow change. Sources: https://help.extensiv.com/en_US/2026/extensiv-2026-q4-release-notes ; https://developer.shiphero.com/changelog/ ; https://developer.deposco.com/docs/reference ; https://deposco.com/blog/deposco-launches-bright-portal/

## Official competitive update — 2026-11-09

Reviewed 2026-11-09 against first-party sources only. Extensiv's November 4 Q4 notes expose pending Billing Manager order charges through the API and add item tags to item-summary responses, while reporting faster saved views for large warehouses. These are material comparison signals for WMS365's scoped billing/reconciliation APIs, item metadata exports, and performance testing; they do not prove a WMS365 billing or reporting defect. ShipHero's November 3 developer changelog adds active physical-warehouse creation with a default profile, and its November 6 changelog adds a packing-screen command barcode that resets packed boxes only before labels are printed. This reinforces explicit warehouse-configuration validation and scan-to-pack state-machine safeguards—especially preserving final label/shipment audit boundaries—without copying its workflow. Deposco's official public developer reference was again inaccessible and no newer official public workflow change was verified. Sources: https://help.extensiv.com/en_US/2026/extensiv-2026-q4-release-notes ; https://developer.shiphero.com/changelog/ ; https://www.shiphero.com/changelog ; https://developer.deposco.com/docs/reference
