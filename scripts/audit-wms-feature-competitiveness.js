const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const registry = fs.readFileSync(path.join(root, "docs", "WAREHOUSE_FEATURE_REGISTRY.md"), "utf8").toLowerCase();
const sources = JSON.parse(fs.readFileSync(path.join(root, "product-intelligence-sources.json"), "utf8"));

const capabilities = [
    { key: "edi-readiness", priority: "critical", evidence: ["partner api", "external id", "idempotency", "gs1", "edi transaction"], value: "Allows retailers, customers, and EDI providers to exchange orders, acknowledgements, inventory, shipment notices, and invoices reliably.", acceptanceTest: "Test-company certification processes valid and invalid 850, 855, 856, 810, 940, 945, 846, and 997 messages; duplicate control numbers do not duplicate business records; acknowledgements, errors, retries, and the complete audit trail are visible.", recommendation: "Add an EDI gateway and trading-partner profiles with X12 mapping, ISA/GS control numbers, 997 acknowledgements, validation, retry and exception queues, document retention, and certification tests. Reuse the versioned partner API as the canonical business layer." },
    { key: "scan-to-pack", priority: "critical", evidence: ["scan-to-pack", "cartonization", "pack verification"], value: "Prevents packing errors and records exactly what shipped in each carton.", acceptanceTest: "A wrong SKU scan blocks packing; correct carton contents, weight, and dimensions persist through shipment.", recommendation: "Add scan-to-pack verification with cartons, package contents, weight, dimensions, and mis-pick blocking." },
    { key: "replenishment", priority: "critical", evidence: ["replenishment", "reorder level"], value: "Prevents released picks from stalling because the forward pick location is empty.", acceptanceTest: "Inventory below the configured minimum creates one warehouse-scoped replenishment task without duplicates.", recommendation: "Add min/max forward-pick replenishment rules and warehouse tasks before pick locations run empty." },
    { key: "wave-batch-picking", priority: "high", evidence: ["wave picking", "batch picking", "cross-customer pick"], value: "Reduces picker travel while maintaining strict customer and warehouse isolation.", acceptanceTest: "A worker can complete a multi-order batch and every scan posts only to its intended customer order.", recommendation: "Add controlled wave and batch picking with route optimization, tote/cart assignment, and customer isolation." },
    { key: "shipping-automation", priority: "high", evidence: ["address validation", "shipping method mapping", "automation rules"], recommendation: "Add address validation, shipping-method mapping, warehouse routing rules, and explainable automation history." },
    { key: "parcel-rate-labels", priority: "high", evidence: ["rate shopping", "carrier labels", "quote & ship"], recommendation: "Complete Quote & Ship with carrier rates, labels, manifests, voids, package templates, and tracking callbacks." },
    { key: "dock-scheduling", priority: "high", evidence: ["dock scheduling", "delivery appointment"], recommendation: "Expand appointments into dock doors, capacity calendars, carrier check-in, dwell time, and late-arrival alerts." },
    { key: "returns", priority: "high", evidence: ["returns", "return merchandise"], recommendation: "Create a full RMA workflow with disposition, inspection, quarantine, restock, disposal, and customer billing." },
    { key: "cycle-counting", priority: "medium", evidence: ["cycle count", "variance review"], recommendation: "Finish mobile count assignment, blind counts, recount thresholds, approvals, and accuracy trend reporting." },
    { key: "labor-analytics", priority: "medium", evidence: ["labor", "worker performance", "task timestamps"], recommendation: "Add privacy-conscious task productivity, queue aging, travel time, exception rate, and throughput dashboards." },
    { key: "billing-automation", priority: "medium", evidence: ["billing event", "automate billing", "invoice"], recommendation: "Resume billing automation with reviewable event queues, duplicate protection, approvals, invoice export, and audit reconciliation." }
];

const results = capabilities.map((capability) => {
    const matchedEvidence = capability.evidence.filter((term) => registry.includes(term));
    const coverage = matchedEvidence.length === 0 ? "gap" : matchedEvidence.length === capability.evidence.length ? "present" : "partial";
    return {
        ...capability,
        value: capability.value || "Improves warehouse reliability, customer visibility, or operating efficiency.",
        acceptanceTest: capability.acceptanceTest || `The ${capability.key.replace(/-/g, " ")} workflow passes test-company, permission, warehouse-isolation, and retry-safety checks.`,
        coverage,
        matchedEvidence,
        reviewStatus: "REVIEW"
    };
});

const summary = {
    generatedAt: new Date().toISOString(),
    sourceReviewDate: sources.reviewedAt,
    privacyMode: sources.privacyMode,
    vendors: sources.vendors.map((vendor) => vendor.name),
    primaryCompetitors: sources.vendors.filter((vendor) => vendor.comparisonTier === "primary").map((vendor) => ({
        name: vendor.name,
        focus: vendor.comparisonFocus
    })),
    secondaryReferences: sources.vendors.filter((vendor) => vendor.comparisonTier !== "primary").map((vendor) => ({
        name: vendor.name,
        focus: vendor.comparisonFocus
    })),
    counts: results.reduce((counts, item) => ({ ...counts, [item.coverage]: (counts[item.coverage] || 0) + 1 }), {}),
    recommendations: results.sort((a, b) => ["critical", "high", "medium", "watch"].indexOf(a.priority) - ["critical", "high", "medium", "watch"].indexOf(b.priority))
};

const outputDir = path.join(root, "outputs", "product-intelligence");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "wms-feature-gap-audit.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(root, "product-intelligence-report.json"), JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
