const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const WAREHOUSE = "GW3PL-MISS";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection unavailable");
    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const integration = await client.query(
            "select id from store_integrations where id=4 and account_name=$1 and store_identifier=$2 and provider='SHOPIFY' and is_active",
            [ACCOUNT, STORE]
        );
        const warehouse = await client.query(
            "select id from fulfillment_locations where id=1 and code=$1", [WAREHOUSE]
        );
        if (integration.rowCount !== 1 || warehouse.rowCount !== 1) {
            throw new Error("Rancher's integration or warehouse identity mismatch");
        }

        const result = await client.query(
            `select o.id, o.order_code, o.status, o.po_number, o.shipping_reference,
                    o.created_at, o.requested_ship_date, o.confirmed_ship_date, o.shipped_at,
                    o.ship_to_name, o.ship_to_city, o.ship_to_state, o.ship_to_postal_code,
                    o.ship_to_country, o.shipment_method, o.shipped_carrier_name,
                    o.shipped_tracking_reference, fl.code as warehouse_code,
                    si.external_order_id, tc.shopify_order_number,
                    coalesce(sh.shipment_carriers, '') as shipment_carriers,
                    coalesce(sh.shipment_tracking, '') as shipment_tracking,
                    coalesce(lines.sku_quantities, '') as sku_quantities,
                    coalesce(lines.total_requested_qty, 0) as total_requested_qty,
                    coalesce(lines.line_count, 0) as line_count
             from portal_orders o
             join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             left join lateral (
                 select string_agg(distinct x.external_order_id::text, ', ') as external_order_id
                 from store_order_imports x
                 where x.portal_order_id=o.id and x.integration_id=4
             ) si on true
             left join lateral (
                 select string_agg(distinct x.shopify_order_number, ', ') as shopify_order_number
                 from shopify_tracking_order_contacts x
                 where x.order_id=o.id and x.integration_id=4
             ) tc on true
             left join lateral (
                 select string_agg(distinct nullif(trim(x.carrier_name), ''), ', ') as shipment_carriers,
                        string_agg(distinct nullif(trim(x.tracking_reference), ''), ', ') as shipment_tracking
                 from warehouse_shipments x where x.order_id=o.id
             ) sh on true
             left join lateral (
                 select count(*)::integer as line_count,
                        sum(x.requested_quantity)::numeric as total_requested_qty,
                        string_agg(x.sku || ' x ' || x.requested_quantity::text, '; ' order by x.line_number, x.id) as sku_quantities
                 from portal_order_lines x where x.order_id=o.id
             ) lines on true
             where o.account_name=$1
             order by o.created_at, o.id`,
            [ACCOUNT]
        );
        const counts = await client.query(
            `select status, count(*)::integer as count from portal_orders
             where account_name=$1 group by status order by status`,
            [ACCOUNT]
        );
        await client.query("rollback");
        const unique = new Set(result.rows.map((row) => row.order_code));
        const expected = counts.rows.reduce((sum, row) => sum + row.count, 0);
        if (unique.size !== result.rowCount || result.rowCount !== expected) {
            throw new Error(`Export reconciliation failed: rows=${result.rowCount}, unique=${unique.size}, expected=${expected}`);
        }
        const output = {
            readAt: new Date().toISOString(), account: ACCOUNT, store: STORE,
            warehouse: WAREHOUSE, integrationId: 4, counts: counts.rows, orders: result.rows
        };
        const outputPath = String(process.env.RANCHERS_ALL_ORDERS_OUTPUT || "").trim();
        if (outputPath) {
            const resolved = path.resolve(outputPath);
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, JSON.stringify(output, null, 2));
            console.log(JSON.stringify({ outputPath: resolved, readAt: output.readAt, orders: output.orders.length, counts: output.counts }));
        } else {
            console.log(JSON.stringify(output));
        }
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}
