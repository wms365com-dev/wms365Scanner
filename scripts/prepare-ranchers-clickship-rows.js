const fs = require("fs");
const FALLBACK_PHONE = "6477748030";

const PACKAGES = new Map([
    [2, { boxes: 1, each: 2, label: "2-unit carton", length: 9, width: 6, height: 6, pounds: 1 }],
    [6, { boxes: 1, each: 6, label: "6-unit carton", length: 16, width: 11, height: 7, pounds: 2 }],
    [10, { boxes: 1, each: 10, label: "10-unit carton", length: 18, width: 13, height: 11, pounds: 4 }],
    [12, { boxes: 1, each: 12, label: "12-unit carton", length: 18, width: 13, height: 11, pounds: 4 }],
    [18, { boxes: 1, each: 18, label: "18-unit carton", length: 18, width: 13, height: 11, pounds: 6 }],
    [60, { boxes: 5, each: 12, label: "5 x 12-unit cartons", length: 18, width: 13, height: 11, pounds: 4 }],
    [120, { boxes: 10, each: 12, label: "10 x 12-unit cartons", length: 18, width: 13, height: 11, pounds: 4 }]
]);

const HEADERS = [
    "Label Status", "WMS Order", "Shopify Order", "WMS Status", "Requested Ship",
    "Recipient", "Address 1", "Address 2", "City", "Province", "Postal Code", "Country",
    "Phone", "Email", "SKU", "Product", "UPC", "Units (EA)", "Box Count",
    "Units/Box", "Package", "Length (in)", "Width (in)", "Height (in)",
    "Weight/Box (lb)", "Total Weight (lb)", "Warehouse", "Shipment Method",
    "Shipping Reference", "Shopify Order ID", "Created (UTC)", "Data Check"
];

function text(value) { return String(value == null ? "" : value).trim(); }
function date(value) { return value ? String(value).slice(0, 10) : ""; }
function phone(value) {
    const digits = text(value).replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits[0] === "1") ? text(value) : "";
}
function email(order) {
    const recorded = text(order.recipient_email);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recorded)) return recorded;
    const match = text(order.order_notes).match(/\bCustomer\s+([^\s|]+@[^\s|]+\.[^\s|]+)\b/i);
    return match ? match[1] : "";
}

function build(snapshot) {
    if (snapshot.account !== "RANCHER'S CHIPS" || snapshot.store !== "f1acxk-dc.myshopify.com"
        || snapshot.warehouse !== "GW3PL-MISS" || snapshot.integrationId !== 4) {
        throw new Error("Ranchers identity mismatch");
    }
    const linesByOrder = new Map();
    for (const line of snapshot.lines) {
        const key = String(line.order_id);
        if (!linesByOrder.has(key)) linesByOrder.set(key, []);
        linesByOrder.get(key).push(line);
    }
    const rows = [];
    const excluded = { existingWmsLabel: [], trackingPresent: [] };
    for (const order of snapshot.orders) {
        if (order.uploaded_label_count > 0) { excluded.existingWmsLabel.push(order.order_code); continue; }
        if (text(order.shipped_tracking_reference) || text(order.shipment_tracking)) {
            excluded.trackingPresent.push(order.order_code); continue;
        }
        const lines = linesByOrder.get(String(order.id)) || [];
        const line = lines.length === 1 ? lines[0] : null;
        const qty = Number(line?.requested_quantity);
        const pack = Number.isInteger(qty) ? PACKAGES.get(qty) : null;
        const recordedPhone = phone(order.ship_to_phone) || phone(order.contact_phone);
        const shipPhone = recordedPhone || FALLBACK_PHONE;
        const shipEmail = email(order);
        const issues = [];
        if (lines.length !== 1) issues.push(`Expected one SKU; found ${lines.length}`);
        if (!text(order.ship_to_name)) issues.push("Missing recipient");
        if (!text(order.ship_to_address1)) issues.push("Missing address");
        if (!text(order.ship_to_city)) issues.push("Missing city");
        if (!text(order.ship_to_state)) issues.push("Missing province");
        if (text(order.ship_to_country).toUpperCase() !== "CA") issues.push("Non-Canadian destination");
        if (!/^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(text(order.ship_to_postal_code))) issues.push("Invalid Canadian postal code");
        if (/\b(?:P\.?O\.?\s*Box|Post\s*Office\s*Box)\b/i.test(text(order.ship_to_address1))) issues.push("PO Box: verify carrier service");
        if (!shipPhone) issues.push("Missing valid recipient/contact phone");
        if (!shipEmail) issues.push("Missing customer email");
        if (!line?.sku || !line?.description) issues.push("Missing SKU or product description");
        if (line && (line.tracking_level !== "UNIT" || line.unit_uom !== "EA")) issues.push("Item is not configured as EA");
        if (!Number.isInteger(qty) || qty <= 0) issues.push("Invalid each quantity");
        if (line && Number(order.allocated_qty) < qty) issues.push("Order allocation is short");
        if (!pack) issues.push("No confirmed box rule for this quantity");
        rows.push([
            issues.length ? "CHECK" : "READY", text(order.order_code),
            text(order.shopify_order_number) || text(order.po_number), text(order.status),
            date(order.requested_ship_date), text(order.ship_to_name), text(order.ship_to_address1),
            text(order.ship_to_address2), text(order.ship_to_city), text(order.ship_to_state),
            text(order.ship_to_postal_code), text(order.ship_to_country), shipPhone, shipEmail,
            text(line?.sku), text(line?.description), text(line?.upc),
            Number.isInteger(qty) ? qty : "", pack?.boxes ?? "", pack?.each ?? "",
            pack?.label ?? "", pack?.length ?? "", pack?.width ?? "", pack?.height ?? "",
            pack?.pounds ?? "", pack ? pack.pounds * pack.boxes : "", "GW3PL-MISS",
            text(order.shipment_method), text(order.shipping_reference), text(order.external_order_id),
            text(order.created_at), issues.join("; ") || (recordedPhone ? "OK" : "Rancher's fallback phone")
        ]);
    }
    if (new Set(rows.map(row => row[1])).size !== rows.length) throw new Error("Duplicate WMS order in queue");
    return { headers: HEADERS, rows, excluded };
}

if (require.main === module) {
    const snapshotPath = process.argv[2];
    if (!snapshotPath) throw new Error("Snapshot path required");
    const result = build(JSON.parse(fs.readFileSync(snapshotPath, "utf8")));
    const page = Number(process.argv[3] || 0);
    const pageSize = 25;
    if (page === 0) {
        const counts = new Map();
        for (const row of result.rows) counts.set(row[17], (counts.get(row[17]) || 0) + 1);
        console.log(JSON.stringify({ headers: result.headers, candidateCount: result.rows.length,
            ready: result.rows.filter(row => row[0] === "READY").length,
            check: result.rows.filter(row => row[0] === "CHECK").length,
            byQuantity: Object.fromEntries(counts), excluded: result.excluded }));
    } else {
        console.log(JSON.stringify({ page, rows: result.rows.slice((page - 1) * pageSize, page * pageSize) }));
    }
}

module.exports = { build, HEADERS };
