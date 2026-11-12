const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        const order = await client.query(
            `select id, order_code, account_name, status, fulfillment_location_id
             from portal_orders where order_code=$1`, ["ORD-001075"]
        );
        if (order.rowCount !== 1) throw new Error("ORD-001075 was not found uniquely.");
        const lines = await client.query(
            `select l.line_number, l.sku, l.requested_quantity, c.upc, c.description
             from portal_order_lines l left join item_catalog c
               on c.account_name=$1 and c.sku=l.sku
             where l.order_id=$2 order by l.line_number`,
            [order.rows[0].account_name, order.rows[0].id]
        );
        console.log(JSON.stringify({ order: order.rows[0], lines: lines.rows }));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
});
