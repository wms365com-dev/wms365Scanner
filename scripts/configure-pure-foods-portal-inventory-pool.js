const { Client } = require("pg");

const ACCOUNT = "PURE FOODS BY ESTEE";
const PORTAL_WAREHOUSE_CODE = "GW3PL-MISS";
const APPLY = process.argv.includes("--apply");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin");
        const assignments = (await client.query(
            `select cfl.*,fl.code,fl.name
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1
             order by fl.code
             for update of cfl`,
            [ACCOUNT]
        )).rows;
        const target = assignments.find((row) => row.code === PORTAL_WAREHOUSE_CODE);
        if (!target) throw new Error(`${ACCOUNT} is not assigned to ${PORTAL_WAREHOUSE_CODE}.`);
        if (assignments.length < 2) throw new Error(`${ACCOUNT} does not have another warehouse to roll into ${PORTAL_WAREHOUSE_CODE}.`);

        if (APPLY) {
            await client.query(
                `update company_fulfillment_locations
                 set is_primary=(fulfillment_location_id=$2),
                     customer_portal_visible=(fulfillment_location_id=$2),
                     portal_inventory_rollup_location_id=case
                         when fulfillment_location_id=$2 then null
                         else $2
                     end,
                     updated_at=now()
                 where account_name=$1`,
                [ACCOUNT, target.fulfillment_location_id]
            );
            await client.query(
                `insert into activity_log (type,title,details)
                 values ('inventory','Configured customer-facing inventory pool for Pure Foods',
                         $1)`,
                [`${ACCOUNT} | Portal warehouse ${PORTAL_WAREHOUSE_CODE} | ${assignments.length - 1} internal warehouse source(s) | Customer-visible stock is rolled up without changing physical inventory`]
            );
        }

        const result = (await client.query(
            `select cfl.account_name,cfl.fulfillment_location_id,cfl.is_primary,
                    cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage,
                    cfl.customer_portal_visible,cfl.portal_inventory_rollup_location_id,
                    fl.code,fl.name
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 order by cfl.is_primary desc,fl.code`,
            [ACCOUNT]
        )).rows;
        console.log(JSON.stringify({
            mode: APPLY ? "APPLIED" : "PREFLIGHT",
            account: ACCOUNT,
            portalWarehouse: PORTAL_WAREHOUSE_CODE,
            targetFulfillmentLocationId: String(target.fulfillment_location_id),
            assignments: result
        }, null, 2));
        if (APPLY) await client.query("commit");
        else await client.query("rollback");
    } catch (error) {
        try { await client.query("rollback"); } catch {}
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
