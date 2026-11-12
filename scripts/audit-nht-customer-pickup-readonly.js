const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const account = "NORTH HIMALAYAN TRADERS";
        const company = await client.query(`select id,name,legal_name,contact_name,email,phone,address1,address2,city,state,postal_code,country
                                             from owner_accounts where name=$1`, [account]);
        const warehouse = await client.query(`select fl.* from company_fulfillment_locations cfl
                                               join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                                               where cfl.account_name=$1 order by cfl.is_primary desc`, [account]);
        const stock = await client.query(`select sku,sum(quantity)::integer on_hand
                                           from inventory_lines where account_name=$1 and quantity>0
                                           group by sku order by sku`, [account]);
        const examples = await client.query(`select o.id,o.order_code,o.account_name,o.status,o.po_number,o.shipping_reference,
                                                    o.shipment_method,o.requested_ship_date,o.ship_to_name,o.ship_to_address1,
                                                    o.ship_to_city,o.ship_to_state,o.ship_to_postal_code,o.ship_to_country,o.contact_name,o.contact_phone
                                             from portal_orders o where o.shipment_method='CUSTOMER_PICKUP'
                                             order by o.id desc limit 5`);
        const duplicate = await client.query(`select id,order_code,status,po_number,shipping_reference,created_at
                                               from portal_orders where account_name=$1
                                               and (po_number='NHT-PICKUP-20260909' or shipping_reference='NHT-PICKUP-20260909')`, [account]);
        console.log(JSON.stringify({ company: company.rows, warehouse: warehouse.rows, stock: stock.rows, pickupExamples: examples.rows, duplicate: duplicate.rows }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
