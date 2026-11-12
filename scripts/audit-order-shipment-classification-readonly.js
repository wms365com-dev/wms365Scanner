const { Client } = require("pg");

const ORDER_CODE = String(process.argv[2] || "").trim().toUpperCase();

async function main() {
    if (!/^ORD-\d{6}$/.test(ORDER_CODE)) throw new Error("Provide an order code such as ORD-000676.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const orderResult = await client.query(
            `select o.id, o.order_code, o.account_name, o.status, o.shipment_method,
                    o.shipped_carrier_name, o.shipped_tracking_reference,
                    fl.code as warehouse_code
             from portal_orders o
             left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             where o.order_code = $1`,
            [ORDER_CODE]
        );
        if (orderResult.rowCount !== 1) throw new Error(`${ORDER_CODE} was not found.`);
        const order = orderResult.rows[0];
        const [shipmentResult, trackerResult] = await Promise.all([
            client.query(
                `select ws.shipment_code, ws.status, ws.shipment_method, ws.carrier_name,
                        ws.tracking_reference, fl.code as warehouse_code
                 from warehouse_shipments ws
                 left join fulfillment_locations fl on fl.id = ws.fulfillment_location_id
                 where ws.order_id = $1 order by ws.id`,
                [order.id]
            ),
            client.query(
                `select carrier_name, tracking_number, tracking_url, status, is_active
                 from shipment_trackers where order_id = $1 order by id`,
                [order.id]
            )
        ]);
        await client.query("rollback");
        console.log(JSON.stringify({
            order: {
                orderCode: order.order_code,
                accountName: order.account_name,
                status: order.status,
                shipmentMethod: order.shipment_method,
                carrier: order.shipped_carrier_name,
                trackingReference: order.shipped_tracking_reference,
                warehouseCode: order.warehouse_code
            },
            shipments: shipmentResult.rows.map((row) => ({
                shipmentCode: row.shipment_code,
                status: row.status,
                shipmentMethod: row.shipment_method,
                carrier: row.carrier_name,
                trackingReference: row.tracking_reference,
                warehouseCode: row.warehouse_code
            })),
            trackers: trackerResult.rows.map((row) => ({
                carrier: row.carrier_name,
                trackingNumber: row.tracking_number,
                trackingUrl: row.tracking_url,
                status: row.status,
                active: row.is_active
            }))
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
