const fs = require("fs");
const { Client } = require("pg");
const { decryptStoreIntegrationRow, fetchShopifyOrderFulfillmentsForIntegration } = require("../server");

function text(value) { return String(value == null ? "" : value).trim(); }
function tokens(value) { return text(value).toUpperCase().split(/[\s,;]+/).filter(Boolean); }

async function main() {
    const source = JSON.parse(fs.readFileSync(process.env.RANCHERS_SHIPPING_SOURCE_PATH, "utf8"));
    const expected = new Map(source.rows.map(row => [row.orderCode, row]));
    if (expected.size === 0 || expected.size !== source.rows.length) throw new Error("Source orders are missing or duplicated");
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    let rows, integration, optedOut;
    try {
        await client.query("begin read only");
        const scope = await client.query(
            "select * from store_integrations where id=4 and account_name=$1 and store_identifier=$2 and provider='SHOPIFY' and is_active",
            ["RANCHER'S CHIPS", "f1acxk-dc.myshopify.com"]
        );
        if (scope.rowCount !== 1) throw new Error("Shopify integration scope mismatch");
        integration = decryptStoreIntegrationRow(scope.rows[0]);
        const pref = await client.query(
            "select is_subscribed from customer_email_preferences where account_name=$1 and email='*' and notification_type='SHIPMENT_CONFIRMATION'",
            ["RANCHER'S CHIPS"]
        );
        optedOut = pref.rowCount === 1 && pref.rows[0].is_subscribed === false;
        const result = await client.query(
            `select o.id,o.order_code,o.account_name,o.fulfillment_location_id,o.status,
                    o.shipped_carrier_name,o.shipped_tracking_reference,o.confirmed_ship_date,
                    o.shipped_at,o.shipment_email_status,so.external_order_id,
                    (select coalesce(sum(l.requested_quantity),0)::integer from portal_order_lines l where l.order_id=o.id) ordered_qty,
                    (select coalesce(sum(sl.shipped_quantity),0)::integer from warehouse_shipment_lines sl
                      join warehouse_shipments ws on ws.id=sl.shipment_id where ws.order_id=o.id) shipped_qty,
                    (select count(*)::integer from store_sync_exports e where e.integration_id=4
                      and e.entity_type='SHOPIFY_FULFILLMENT' and e.entity_ref=o.id::text) export_count,
                    (select count(*)::integer from shopify_tracking_fulfillments f where f.integration_id=4
                      and f.order_id=o.id and f.account_name=o.account_name) fulfillment_bindings,
                    ws.status shipment_status,ws.carrier_name shipment_carrier,ws.tracking_reference shipment_tracking
             from portal_orders o
             join store_order_imports so on so.portal_order_id=o.id and so.integration_id=4
             left join warehouse_shipments ws on ws.id=(select max(id) from warehouse_shipments where order_id=o.id)
             where o.account_name=$1 and o.order_code=any($2::text[])
             order by o.order_code`, ["RANCHER'S CHIPS", [...expected.keys()]]
        );
        rows = result.rows;
        const ledger = await client.query(
            `select source_id,coalesce(sum(quantity_delta),0)::integer shipping_delta
             from inventory_transactions
             where source_type='PORTAL_ORDER' and transaction_type='SHIPPING'
               and source_id=any($1::text[]) and account_name=$2
             group by source_id`, [rows.map(row => String(row.id)), "RANCHER'S CHIPS"]
        );
        const shippingDelta = new Map(ledger.rows.map(row => [String(row.source_id), Number(row.shipping_delta)]));
        for (const row of rows) row.shipping_delta = shippingDelta.get(String(row.id)) ?? 0;
        const activities = await client.query(
            `select title, details from activity_log
             where title=any($1::text[]) order by created_at desc`,
            [[...expected.keys()].map(code => `Shopify fulfillment skipped for portal order ${code}`)]
        );
        for (const row of rows) {
            const activity = activities.rows.find(entry => entry.title.endsWith(row.order_code));
            row.shopify_skip_reason = activity?.details || "";
        }
        await client.query("rollback");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
    const failures = [];
    let shopifyVerified = 0;
    for (const row of rows) {
        const sourceRow = expected.get(row.order_code);
        const issues = [];
        if (row.account_name !== "RANCHER'S CHIPS" || Number(row.fulfillment_location_id) !== 1) issues.push("identity");
        if (row.status !== "SHIPPED" || !row.shipped_at || row.shipment_status !== "SHIPPED") issues.push("WMS shipment status");
        if (row.shipped_carrier_name !== sourceRow.carrier || row.shipment_carrier !== sourceRow.carrier) issues.push("carrier");
        if (JSON.stringify(tokens(row.shipped_tracking_reference)) !== JSON.stringify(tokens(sourceRow.tracking))
            || JSON.stringify(tokens(row.shipment_tracking)) !== JSON.stringify(tokens(sourceRow.tracking))) issues.push("tracking");
        if (Number(row.ordered_qty) !== Number(sourceRow.itemQuantityEa)
            || Number(row.shipped_qty) !== Number(sourceRow.itemQuantityEa)) issues.push("shipped quantity");
        if (Number(row.shipping_delta) !== -Number(sourceRow.itemQuantityEa)) issues.push("inventory shipping ledger");
        if (Number(row.export_count) < 1 || Number(row.fulfillment_bindings) < 1) {
            issues.push(`Shopify export/binding (${row.export_count}/${row.fulfillment_bindings}; ${row.shopify_skip_reason || "no skip recorded"})`);
        }
        try {
            const remote = await fetchShopifyOrderFulfillmentsForIntegration(integration, row.external_order_id);
            const active = (remote.fulfillments || []).filter(f => text(f.status).toUpperCase() !== "CANCELLED");
            const remoteNumbers = active.flatMap(f => tokens(f.tracking_numbers).concat(tokens(f.tracking_number)));
            if (!active.length || !tokens(sourceRow.tracking).every(number => remoteNumbers.includes(number))) {
                issues.push("Shopify fulfillment/tracking");
            } else shopifyVerified += 1;
        } catch (error) { issues.push(`Shopify read: ${error.code || error.message}`); }
        if (issues.length) failures.push({ order: row.order_code, issues });
    }
    for (const code of expected.keys()) if (!rows.some(row => row.order_code === code)) failures.push({ order: code, issues: ["order missing"] });
    if (!optedOut) failures.push({ order: "POLICY", issues: ["company shipment-email opt-out missing"] });
    console.log(JSON.stringify({ audited: expected.size, wmsRows: rows.length, shopifyVerified,
        optedOut, failed: failures.length, failures }));
}

module.exports = { main };
