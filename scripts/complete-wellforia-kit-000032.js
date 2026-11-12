const { Pool } = require("pg");
const { completePortalKittingInventory } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const REQUEST_CODE = "KIT-000032";
const SOURCE_SKU = "TP-WW-6PK-UPC";
const TARGET_SKU = "WW-1PK-UPC";
const SOURCE_CASES = 8;
const TARGET_CASES = 8;
const DESTINATION = "GW3PL-MISS-WELLFORIA-BULK";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false, max: 2 });
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [REQUEST_CODE]);
        const requestResult = await client.query(
            "select * from portal_kitting_requests where account_name=$1 and request_code=$2 for update",
            [ACCOUNT, REQUEST_CODE]
        );
        if (requestResult.rowCount !== 1) throw new Error(`${REQUEST_CODE} was not found for Wellforia.`);
        const request = requestResult.rows[0];
        if (request.source_sku !== SOURCE_SKU || Number(request.source_quantity) !== SOURCE_CASES
            || request.target_sku !== TARGET_SKU || Number(request.target_quantity) !== TARGET_CASES
            || Number(request.fulfillment_location_id) !== 1) {
            throw new Error("The approved KIT-000032 conversion details changed.");
        }
        if (request.status === "COMPLETED") {
            await client.query("rollback");
            console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "PREFLIGHT", alreadyCompleted: true, requestCode: REQUEST_CODE }, null, 2));
            return;
        }
        if (!["SUBMITTED", "IN_PROGRESS"].includes(request.status)) {
            throw new Error(`${REQUEST_CODE} cannot be completed from ${request.status}.`);
        }
        const items = await client.query(
            `select sku,tracking_level,units_per_case,blocked from item_catalog
             where account_name=$1 and sku=any($2::text[]) order by sku`,
            [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
        );
        if (items.rowCount !== 2 || items.rows.some((row) => row.blocked)) throw new Error("Required Wellforia item verification failed.");
        const sourceItem = items.rows.find((row) => row.sku === SOURCE_SKU);
        const targetItem = items.rows.find((row) => row.sku === TARGET_SKU);
        if (sourceItem.tracking_level !== "CASE" || Number(sourceItem.units_per_case) !== 8) throw new Error("Source case configuration changed.");
        if (targetItem.tracking_level !== "CASE" || Number(targetItem.units_per_case) !== 48) throw new Error("Finished case configuration changed.");
        const allocations = await client.query(
            `select a.*,i.quantity as on_hand,b.is_pickable,b.fulfillment_location_id
             from portal_kitting_allocations a
             join inventory_lines i on i.id=a.inventory_line_id
             join bin_locations b on b.code=i.location
             where a.kitting_request_id=$1 order by a.id for update of a,i`,
            [request.id]
        );
        const allocated = allocations.rows.reduce((sum, row) => sum + Number(row.allocated_quantity), 0);
        if (allocated !== SOURCE_CASES) throw new Error("The source reservation no longer totals 8 cartons.");
        for (const row of allocations.rows) {
            if (row.sku !== SOURCE_SKU || Number(row.on_hand) < Number(row.allocated_quantity)
                || row.is_pickable !== true || Number(row.fulfillment_location_id) !== 1) {
                throw new Error("Reserved source stock is no longer valid.");
            }
        }
        const destination = await client.query(
            `select code,is_pickable,location_type,fulfillment_location_id,account_name
             from bin_locations where code=$1`,
            [DESTINATION]
        );
        const bin = destination.rows[0];
        if (destination.rowCount !== 1 || bin.is_pickable !== true
            || Number(bin.fulfillment_location_id) !== 1
            || (bin.account_name && bin.account_name !== ACCOUNT)) {
            throw new Error("The finished-stock destination is not a compatible pickable Wellforia location.");
        }
        const summary = {
            mode: APPLY ? "APPLY" : "PREFLIGHT",
            requestCode: REQUEST_CODE, statusBefore: request.status,
            source: { sku: SOURCE_SKU, deductCartons: SOURCE_CASES },
            conversion: { individualOnePacks: 384, onePacksPerFinishedCarton: 48 },
            target: { sku: TARGET_SKU, addCartons: TARGET_CASES },
            destination: DESTINATION
        };
        if (!APPLY) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return;
        }
        const completion = await completePortalKittingInventory(
            client, request, { destinationLocation: DESTINATION }, "Warehouse operations"
        );
        const note = [
            "Physical rework completed.",
            "Consumed 8 master cartons of TP-WW-6PK-UPC.",
            "Produced 384 individual one-packs and packed 48 per carton.",
            "Received 8 finished cartons of WW-1PK-UPC.",
            "MAILERS and TP LABEL-WW-1PK-UPC used as instructed.",
            `Finished stock posted to ${completion.destinationLocation}.`
        ].join(" ");
        await client.query(
            `update portal_kitting_requests
             set status='COMPLETED',warehouse_note=$2,completed_at=now(),
                 completed_by='Warehouse operations',updated_at=now()
             where id=$1`,
            [request.id, note]
        );
        await client.query(
            `insert into activity_log(type,title,details) values('kitting',$1,$2)`,
            [`Updated kitting request ${REQUEST_CODE} to COMPLETED`, `${ACCOUNT} | ${note}`]
        );
        await client.query("commit");

        const [verifiedRequest, ledger, remainingAllocations, targetStock] = await Promise.all([
            pool.query(
                `select request_code,status,source_sku,source_quantity,target_sku,target_quantity,
                        completed_at,completed_by,warehouse_note
                 from portal_kitting_requests where id=$1`,
                [request.id]
            ),
            pool.query(
                `select sku,location,transaction_type,quantity_delta,quantity_before,quantity_after
                 from inventory_transactions
                 where account_name=$1 and source_type='PORTAL_KITTING_REQUEST' and source_id=$2 order by id`,
                [ACCOUNT, REQUEST_CODE]
            ),
            pool.query("select count(*)::int count from portal_kitting_allocations where kitting_request_id=$1", [request.id]),
            pool.query(
                `select coalesce(sum(i.quantity),0)::int pickable_on_hand
                 from inventory_lines i join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=1 and b.is_pickable=true`,
                [ACCOUNT, TARGET_SKU]
            )
        ]);
        const sourceDelta = ledger.rows.filter((row) => row.sku === SOURCE_SKU).reduce((sum, row) => sum + Number(row.quantity_delta), 0);
        const targetDelta = ledger.rows.filter((row) => row.sku === TARGET_SKU).reduce((sum, row) => sum + Number(row.quantity_delta), 0);
        if (verifiedRequest.rows[0]?.status !== "COMPLETED"
            || sourceDelta !== -SOURCE_CASES || targetDelta !== TARGET_CASES
            || Number(remainingAllocations.rows[0].count) !== 0) {
            throw new Error("Post-commit completion verification failed.");
        }
        console.log(JSON.stringify({
            ...summary, request: verifiedRequest.rows[0], ledger: ledger.rows,
            pickableFinishedCartons: Number(targetStock.rows[0].pickable_on_hand),
            sideEffects: { emailsSent: 0, ordersReleased: 0, labelsCreated: 0 }
        }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
