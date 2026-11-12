const fs = require("fs");
const { withTransaction } = require("../server");

const paths = [
    "outputs/ranchers-drive-shipping-20260914.json",
    "outputs/ranchers-drive-shipping-20260911.json"
];
const tokens = (value) => String(value || "").split(/[\s,;]+/).filter(Boolean).map((token) => token.toUpperCase());

async function main() {
    const rows = paths.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).rows)
        .filter((row) => row.carrier && row.tracking);
    await withTransaction(async (client) => {
        await client.query("set transaction read only");
        const result = await client.query(
            `select o.order_code,o.status,o.shipped_tracking_reference,fl.code warehouse_code
             from portal_orders o
             left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.account_name=$1 and o.order_code=any($2::text[])`,
            ["RANCHER'S CHIPS", rows.map((row) => row.orderCode)]
        );
        const orders = new Map(result.rows.map((row) => [row.order_code, row]));
        const differences = rows.map((row) => {
            const order = orders.get(row.orderCode);
            const source = tokens(row.tracking);
            const existing = tokens(order?.shipped_tracking_reference);
            return {
                order: row.orderCode,
                status: order?.status || "MISSING",
                warehouse: order?.warehouse_code || "MISSING",
                missingFromWms: source.filter((token) => !existing.includes(token)),
                extraInWms: existing.filter((token) => !source.includes(token))
            };
        }).filter((row) => row.status !== "SHIPPED" || row.warehouse !== "GW3PL-MISS"
            || row.missingFromWms.length || row.extraInWms.length);
        console.log(JSON.stringify({ checked: rows.length, exactMatches: rows.length - differences.length, differences }, null, 2));
    });
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
