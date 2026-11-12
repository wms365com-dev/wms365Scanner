const { Client } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const result = await client.query(
            `select o.id, o.order_code, o.status, o.shipped_carrier_name,
                    o.shipped_tracking_reference, soi.external_order_id,
                    si.id as integration_id, si.store_identifier, si.is_active
             from portal_orders o
             join store_order_imports soi on soi.portal_order_id = o.id
             join store_integrations si on si.id = soi.integration_id
             where o.account_name = $1
               and o.status = 'SHIPPED'
               and upper(regexp_replace(coalesce(o.shipped_carrier_name, ''), '[^A-Z0-9]', '', 'g')) in ('ICS', 'ICSCOURIER')
             order by o.order_code`,
            ["RANCHER'S CHIPS"]
        );
        await client.query("commit");
        console.log(JSON.stringify({
            count: result.rows.length,
            activeIntegrationCount: new Set(result.rows.filter((row) => row.is_active).map((row) => row.integration_id)).size,
            orders: result.rows.map((row) => ({
                id: String(row.id),
                orderCode: row.order_code,
                carrier: row.shipped_carrier_name,
                tracking: row.shipped_tracking_reference,
                externalOrderId: row.external_order_id,
                store: row.store_identifier,
                integrationActive: row.is_active
            }))
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
