const fs = require("fs");
const path = require("path");

const snapshot = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "outputs", "ranchers-all-orders-20260928", "source-snapshot.json"), "utf8"));
const start = Number(process.argv[2] || 0);
const count = Number(process.argv[3] || 50);

function value(input) {
    return input == null ? "" : String(input).trim();
}

function day(input) {
    return input ? String(input).slice(0, 10) : "";
}

function timestamp(input) {
    return input ? new Date(input).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
}

const headers = [
    "WMS Order #", "Shopify Order #", "Shopify Order ID", "WMS Status", "Recipient Name",
    "SKU / Ordered Qty", "Total Ordered Qty", "Created (UTC)", "Requested Ship Date",
    "Confirmed Ship Date", "Shipped At (UTC)", "Warehouse", "Carrier", "Tracking Number",
    "Shipment Method", "Ship To City", "Province / State", "Postal Code", "Country",
    "WMS Shipping Reference"
];

const rows = snapshot.orders.slice(start, start + count).map((order) => {
    const shopifyNumber = value(order.shopify_order_number) || value(order.po_number);
    return [
        value(order.order_code), shopifyNumber, value(order.external_order_id), value(order.status),
        value(order.ship_to_name), value(order.sku_quantities), Number(order.total_requested_qty || 0),
        timestamp(order.created_at), day(order.requested_ship_date), day(order.confirmed_ship_date),
        timestamp(order.shipped_at), value(order.warehouse_code),
        value(order.shipped_carrier_name) || value(order.shipment_carriers),
        value(order.shipped_tracking_reference) || value(order.shipment_tracking),
        value(order.shipment_method), value(order.ship_to_city), value(order.ship_to_state),
        value(order.ship_to_postal_code), value(order.ship_to_country), value(order.shipping_reference)
    ];
});

if (new Set(snapshot.orders.map((order) => order.order_code)).size !== snapshot.orders.length) {
    throw new Error("Duplicate WMS order numbers in source snapshot");
}
if (start < 0 || count < 1 || start + rows.length > snapshot.orders.length) {
    throw new Error("Invalid batch range");
}
console.log(JSON.stringify({ readAt: snapshot.readAt, total: snapshot.orders.length, start, headers, rows }));
