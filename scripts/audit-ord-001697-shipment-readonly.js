const { Client } = require("pg");

const ORDER_CODE = process.argv.find((value) => /^ORD-\d{6}$/.test(value)) || "ORD-001697";

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin read only");
        const orderResult = await db.query(
            `select o.id,o.order_code,o.account_name,o.status,o.po_number,o.shipping_reference,
                    o.shipment_method,o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,
                    o.shipped_tracking_reference,o.outbound_total_pallets,o.routing_total_weight,
                    o.routing_weight_uom,o.fulfillment_location_id,fl.code warehouse_code,fl.name warehouse_name
             from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=$1`,
            [ORDER_CODE]
        );
        if (orderResult.rowCount !== 1) throw new Error(`Expected one ${ORDER_CODE}, found ${orderResult.rowCount}.`);
        const order = orderResult.rows[0];
        const [lines, allocations, documents, shipments] = await Promise.all([
            db.query("select id,line_number,sku,requested_quantity from portal_order_lines where order_id=$1 order by line_number,id", [order.id]),
            db.query(`select a.order_line_id,a.sku,a.location,a.lot_number,a.expiration_date,a.allocated_quantity,
                             i.quantity inventory_quantity,b.is_pickable,b.location_type
                      from portal_order_allocations a
                      left join inventory_lines i on i.account_name=$2 and i.location=a.location and i.sku=a.sku
                        and i.lot_number=a.lot_number and i.expiration_date=a.expiration_date
                      left join bin_locations b on b.code=a.location
                      where a.order_id=$1 order by a.order_line_id,a.location`, [order.id, order.account_name]),
            db.query("select id,file_name,file_type,document_category,created_at from portal_order_documents where order_id=$1 order by id", [order.id]),
            db.query("select id,shipment_code,status,carrier_name,tracking_reference,bol_reference,total_pallets,total_weight,weight_uom,shipped_at from warehouse_shipments where order_id=$1 order by id", [order.id])
        ]);
        await db.query("rollback");
        console.log(JSON.stringify({ order, lines: lines.rows, allocations: allocations.rows, documents: documents.rows, shipments: shipments.rows }));
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
