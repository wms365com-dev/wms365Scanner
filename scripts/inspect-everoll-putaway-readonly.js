const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const queries = [
            ["inbound", `select id, inbound_code, account_name, status, fulfillment_location_id
                from portal_inbounds where inbound_code='INB-000195'`],
            ["stock", `select id, account_name, location, sku, quantity, tracking_level, lot_number, expiration_date
                from inventory_lines where account_name='EVEROLL INDUSTRIES LTD'
                  and sku=any(array['ESP72-47-WHT','ESP72-36-WHT','ESP72-47-BLK','ESP72-36-BLK'])
                order by location, sku`],
            ["destination", `select code, location_type, is_pickable from bin_locations
                where code='WHS01-EVEROLL-BULK' or code='WHS01-EVEROLL-REC'`],
            ["destination_occupants", `select account_name, sum(quantity)::integer as quantity
                from inventory_lines where location='WHS01-EVEROLL-BULK' group by account_name`],
            ["prior_moves", `select movement_key, account_name, sku, quantity from inventory_movements
                where movement_key like 'INB-000195-PUTAWAY-%' order by movement_key`],
            ["commitments", `select il.sku, coalesce(sum(a.allocated_quantity),0)::integer as allocated
                from inventory_lines il left join portal_order_allocations a on a.inventory_line_id=il.id
                left join portal_orders o on o.id=a.order_id and o.status in ('RELEASED','PICKED','STAGED')
                where il.account_name='EVEROLL INDUSTRIES LTD' and il.location='WHS01-EVEROLL-REC'
                group by il.sku order by il.sku`]
        ];
        for (const [label, sql] of queries) {
            const result = await client.query(sql);
            console.log(JSON.stringify({ label, rows: result.rows }));
        }
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
});
