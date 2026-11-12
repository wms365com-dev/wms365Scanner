const { Client } = require("pg");
const { buildCarrierTrackingUrl } = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const APPLY = process.argv.includes("--apply")
    || String(process.env.APPLY_CHANGES || "").trim().toLowerCase() === "yes";
const ICS_DIRECT_PREFIX = "https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin");
        const result = await client.query(
            `select st.id, st.order_id, st.carrier_name, st.tracking_number, st.tracking_url,
                    o.order_code
             from shipment_trackers st
             join portal_orders o on o.id = st.order_id and o.account_name = st.account_name
             where st.account_name = $1 and o.status = 'SHIPPED'
             order by st.id
             for update of st`,
            [ACCOUNT]
        );
        const corrections = result.rows.map((row) => ({
            ...row,
            expectedUrl: buildCarrierTrackingUrl(row.carrier_name, row.tracking_number)
        })).filter((row) => row.expectedUrl.startsWith(ICS_DIRECT_PREFIX) && row.tracking_url !== row.expectedUrl);

        if (!APPLY) {
            await client.query("rollback");
            console.log(JSON.stringify({
                mode: "DRY_RUN",
                accountName: ACCOUNT,
                correctionCount: corrections.length,
                orders: corrections.map((row) => row.order_code)
            }, null, 2));
            return;
        }

        for (const row of corrections) {
            const updated = await client.query(
                `update shipment_trackers
                 set carrier_key = 'ICS_COURIER', tracking_url = $2, updated_at = now()
                 where id = $1 and account_name = $3 and tracking_number = $4`,
                [row.id, row.expectedUrl, ACCOUNT, row.tracking_number]
            );
            if (updated.rowCount !== 1) throw new Error(`Could not safely update tracker ${row.id}.`);
        }
        if (corrections.length) {
            await client.query(
                `insert into activity_log (type, title, details)
                 values ('shipment', $1, $2)`,
                [
                    "Repaired Rancher's Chips ICS tracking links",
                    `${corrections.length} shipped-order tracker URL(s) changed to the direct ICS parcel format. No order, shipment, inventory, or billing status was changed.`
                ]
            );
        }
        await client.query("commit");
        console.log(JSON.stringify({
            mode: "APPLIED",
            accountName: ACCOUNT,
            correctedCount: corrections.length,
            orders: corrections.map((row) => row.order_code)
        }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
