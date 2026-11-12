const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const result = await client.query(
            `select o.id,o.order_code,o.account_name,o.status,o.po_number,o.shipping_reference,
                    o.requested_ship_date,o.shipment_method,o.fulfillment_location_id,o.rush_approved,
                    json_agg(json_build_object('sku',l.sku,'quantity',l.requested_quantity) order by l.line_number) lines
             from portal_orders o join portal_order_lines l on l.order_id=o.id
             where o.account_name='NORTH HIMALAYAN TRADERS'
               and (o.po_number='NHT-PICKUP-20260909' or o.shipping_reference='NHT-PICKUP-20260909')
             group by o.id order by o.id`,
        );
        console.log(JSON.stringify(result.rows, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
