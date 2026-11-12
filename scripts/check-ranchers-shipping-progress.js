const { Client } = require("pg");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    const result = await client.query(
        `select status, count(*)::integer as count
         from portal_orders where account_name=$1 group by status order by status`,
        ["RANCHER'S CHIPS"]
    );
    const latest = await client.query(
        `select order_code, status, shipped_carrier_name, shipped_tracking_reference, shipped_at
         from portal_orders where account_name=$1 and status='SHIPPED'
         order by shipped_at desc nulls last limit 5`,
        ["RANCHER'S CHIPS"]
    );
    console.log(JSON.stringify({ counts: result.rows, latest: latest.rows }, null, 2));
    await client.end();
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
