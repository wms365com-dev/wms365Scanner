const { Client } = require("pg");

async function main() {
    const reference = String(process.argv[2] || "").trim();
    if (!reference) throw new Error("Order reference is required");
    const client = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await client.connect();
    try {
        const result = await client.query(
            `select id, order_code, account_name, status,
                    po_number, shipping_reference, fulfillment_location_id, released_at
               from portal_orders
              where upper(coalesce(po_number, '')) = upper($1)
                 or upper(coalesce(shipping_reference, '')) = upper($1)
                 or upper(order_code) = upper($1)
              order by id desc`,
            [reference]
        );
        console.log(JSON.stringify({ reference, matches: result.rows }));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
