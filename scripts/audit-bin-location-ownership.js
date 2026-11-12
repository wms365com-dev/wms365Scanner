const { Pool } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_PRIVATE_URL or DATABASE_URL is required.");
    const failOnFindings = process.argv.includes("--fail-on-findings");
    const summaryOnly = process.argv.includes("--summary-only");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const result = await pool.query(`
            with inventory_owners as (
                select location,
                       count(distinct account_name)::integer as inventory_owner_count,
                       min(account_name) as sole_inventory_owner,
                       sum(quantity)::integer as on_hand_quantity
                from inventory_lines
                where quantity <> 0
                group by location
            ), company_warehouse_counts as (
                select account_name, count(*)::integer as warehouse_count
                from company_fulfillment_locations
                group by account_name
            )
            select b.id, b.code, b.account_name, b.fulfillment_location_id,
                   io.sole_inventory_owner, io.inventory_owner_count, io.on_hand_quantity,
                   coalesce(cwc.warehouse_count, 0)::integer as company_warehouse_count,
                   case
                     when io.inventory_owner_count > 1 then 'MULTIPLE_INVENTORY_OWNERS'
                     when btrim(coalesce(b.account_name, '')) = '' then 'MISSING_COMPANY'
                     when b.account_name <> io.sole_inventory_owner then 'COMPANY_MISMATCH'
                     when coalesce(cwc.warehouse_count, 0) > 1 and b.fulfillment_location_id is null then 'MISSING_WAREHOUSE'
                     else 'OK'
                   end as finding
            from bin_locations b
            join inventory_owners io on io.location = b.code
            left join company_warehouse_counts cwc on cwc.account_name = io.sole_inventory_owner
            where io.inventory_owner_count > 1
               or btrim(coalesce(b.account_name, '')) = ''
               or b.account_name <> io.sole_inventory_owner
               or (coalesce(cwc.warehouse_count, 0) > 1 and b.fulfillment_location_id is null)
            order by finding, b.code
        `);
        const countsByFinding = result.rows.reduce((counts, row) => {
            counts[row.finding] = (counts[row.finding] || 0) + 1;
            return counts;
        }, {});
        const output = { findingCount: result.rowCount, countsByFinding };
        if (!summaryOnly) output.findings = result.rows;
        console.log(JSON.stringify(output, null, 2));
        if (failOnFindings && result.rowCount) process.exitCode = 2;
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
