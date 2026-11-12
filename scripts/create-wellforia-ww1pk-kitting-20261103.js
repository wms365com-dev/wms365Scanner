const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const WAREHOUSE_ID = 1;
const SOURCE_SKU = "TP-WW-6PK-UPC";
const TARGET_SKU = "WW-1PK-UPC";
const SOURCE_CASES = 8;
const SOURCE_PACKS_PER_CASE = 8;
const UNITS_PER_SOURCE_PACK = 6;
const TARGET_CASES = 8;
const TARGET_PACKS_PER_CASE = 48;
const FINISHED_UNITS = 384;
const REFERENCE = "REWORK-TP-WW-6PK-TO-WW-1PK-20261103-08";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false, max: 2 });
    const client = await pool.connect();
    try {
        await client.query("begin");
        if (!APPLY) await client.query("set transaction read only");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [REFERENCE]);

        const account = await client.query("select name,is_active from owner_accounts where name=$1", [ACCOUNT]);
        const warehouse = await client.query(`
            select fl.id,fl.code,fl.is_active,cfl.allow_storage
            from company_fulfillment_locations cfl
            join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
            where cfl.account_name=$1 and fl.id=$2 and fl.code=$3
        `, [ACCOUNT, WAREHOUSE_ID, WAREHOUSE]);
        const items = await client.query(`
            select sku,description,tracking_level,unit_uom,units_per_case,blocked
            from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku
        `, [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]);
        const duplicate = await client.query(`
            select request_code,status from portal_kitting_requests
            where account_name=$1 and purchase_order_reference=$2
        `, [ACCOUNT, REFERENCE]);
        const sourceInventory = await client.query(`
            select i.id,i.location,i.quantity,i.lot_number,i.expiration_date,i.tracking_level,
                   b.is_pickable,b.fulfillment_location_id,
                   coalesce((select sum(a.allocated_quantity)
                             from portal_order_allocations a
                             join portal_orders o on o.id=a.order_id
                             where a.inventory_line_id=i.id
                               and o.status in ('RELEASED','PICKED','STAGED')),0)::int
                   + coalesce((select sum(a.allocated_quantity)
                               from portal_kitting_allocations a
                               join portal_kitting_requests k on k.id=a.kitting_request_id
                               where a.inventory_line_id=i.id
                                 and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as committed
            from inventory_lines i
            join bin_locations b on b.code=i.location
            where i.account_name=$1 and i.sku=$2
              and b.fulfillment_location_id=$3 and b.is_pickable=true
            order by i.expiration_date nulls last,i.id
            ${APPLY ? "for update of i" : ""}
        `, [ACCOUNT, SOURCE_SKU, WAREHOUSE_ID]);

        if (account.rowCount !== 1 || account.rows[0].is_active !== true) throw new Error("Exact active Wellforia tenant verification failed.");
        if (warehouse.rowCount !== 1 || warehouse.rows[0].is_active !== true || warehouse.rows[0].allow_storage !== true) {
            throw new Error("Exact active Mississauga warehouse verification failed.");
        }
        if (items.rowCount !== 2 || items.rows.some((row) => row.blocked)) throw new Error("Required Wellforia item verification failed.");
        const sourceItem = items.rows.find((row) => row.sku === SOURCE_SKU);
        const targetItem = items.rows.find((row) => row.sku === TARGET_SKU);
        if (sourceItem.tracking_level !== "CASE" || Number(sourceItem.units_per_case) !== SOURCE_PACKS_PER_CASE) {
            throw new Error("Source SKU is not configured as 8 six-packs per master carton.");
        }
        if (targetItem.tracking_level !== "CASE" || Number(targetItem.units_per_case) !== TARGET_PACKS_PER_CASE) {
            throw new Error("Target SKU is not configured as 48 one-packs per finished carton.");
        }
        if (SOURCE_CASES * SOURCE_PACKS_PER_CASE * UNITS_PER_SOURCE_PACK !== FINISHED_UNITS
            || TARGET_CASES * TARGET_PACKS_PER_CASE !== FINISHED_UNITS) {
            throw new Error("The requested 384-unit conversion does not balance.");
        }
        if (duplicate.rowCount) {
            await client.query("rollback");
            console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "PREFLIGHT", alreadyExists: true, request: duplicate.rows[0] }, null, 2));
            return;
        }
        const available = sourceInventory.rows.reduce(
            (sum, row) => sum + Math.max(0, Number(row.quantity) - Number(row.committed)), 0
        );
        if (available < SOURCE_CASES) throw new Error(`Only ${available} uncommitted source cartons are available; 8 are required.`);
        const summary = {
            mode: APPLY ? "APPLY" : "PREFLIGHT",
            account: ACCOUNT, warehouse: WAREHOUSE,
            source: { sku: SOURCE_SKU, masterCartons: SOURCE_CASES, sixPacksPerCarton: SOURCE_PACKS_PER_CASE, unitsPerPack: UNITS_PER_SOURCE_PACK },
            target: { sku: TARGET_SKU, finishedCartons: TARGET_CASES, onePacksPerCarton: TARGET_PACKS_PER_CASE },
            finishedUnits: FINISHED_UNITS, availableSourceCartons: available,
            packaging: "Use MAILERS and TP LABEL-WW-1PK-UPC.", reference: REFERENCE
        };
        if (!APPLY) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return;
        }

        const components = [{
            sku: SOURCE_SKU,
            totalQuantity: SOURCE_CASES,
            quantityPerUnit: SOURCE_PACKS_PER_CASE,
            description: "Whoopsie Wipes 6 Pack master carton"
        }];
        const notes = [
            "Pick 8 master cartons of TP-WW-6PK-UPC.",
            "Break 8 cartons x 8 six-packs x 6 units to produce 384 individual one-packs.",
            "Use MAILERS and apply TP LABEL-WW-1PK-UPC.",
            "Pack 48 one-packs per finished carton.",
            "Receive 8 finished cartons of WW-1PK-UPC only after physical completion."
        ].join(" ");
        const inserted = await client.query(`
            insert into portal_kitting_requests (
                account_name,portal_access_id,status,sales_order_reference,purchase_order_reference,
                source_sku,source_quantity,components_json,target_sku,target_quantity,
                requested_completion_date,requested_by_name,requested_by_email,notes,
                fulfillment_location_id,processing_business_days,earliest_completion_date,holiday_closures_json
            ) values ($1,null,'SUBMITTED','',$2,$3,$4,$5::jsonb,$6,$7,current_date,
                      'Warehouse operations','',$8,$9,4,current_date,'[]'::jsonb)
            returning id
        `, [ACCOUNT, REFERENCE, SOURCE_SKU, SOURCE_CASES, JSON.stringify(components),
            TARGET_SKU, TARGET_CASES, notes, WAREHOUSE_ID]);
        const requestId = inserted.rows[0].id;
        const requestCode = `KIT-${String(requestId).padStart(6, "0")}`;
        await client.query("update portal_kitting_requests set request_code=$2,updated_at=now() where id=$1", [requestId, requestCode]);

        let remaining = SOURCE_CASES;
        for (const line of sourceInventory.rows) {
            if (remaining <= 0) break;
            const lineAvailable = Math.max(0, Number(line.quantity) - Number(line.committed));
            const allocated = Math.min(remaining, lineAvailable);
            if (!allocated) continue;
            await client.query(`
                insert into portal_kitting_allocations (
                    kitting_request_id,inventory_line_id,sku,location,lot_number,
                    expiration_date,tracking_level,allocated_quantity
                ) values ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [requestId, line.id, SOURCE_SKU, line.location, line.lot_number || "",
                line.expiration_date || "", line.tracking_level, allocated]);
            remaining -= allocated;
        }
        if (remaining !== 0) throw new Error("Source reservation changed during request creation.");
        await client.query(`
            insert into activity_log(type,title,details) values('kitting',$1,$2)
        `, [
            `Submitted kitting request ${requestCode}`,
            `${ACCOUNT} | 8 ${SOURCE_SKU} cartons reserved -> 8 ${TARGET_SKU} cartons | 384 one-packs | MAILERS + TP LABEL-WW-1PK-UPC`
        ]);
        await client.query("commit");

        const verification = await pool.query(`
            select k.request_code,k.status,k.source_sku,k.source_quantity,k.target_sku,k.target_quantity,
                   k.notes,coalesce(sum(a.allocated_quantity),0)::int allocated
            from portal_kitting_requests k
            left join portal_kitting_allocations a on a.kitting_request_id=k.id
            where k.id=$1 group by k.id
        `, [requestId]);
        const row = verification.rows[0];
        if (!row || row.status !== "SUBMITTED" || row.source_sku !== SOURCE_SKU
            || Number(row.source_quantity) !== SOURCE_CASES || row.target_sku !== TARGET_SKU
            || Number(row.target_quantity) !== TARGET_CASES || Number(row.allocated) !== SOURCE_CASES) {
            throw new Error("Post-commit kitting-request verification failed.");
        }
        console.log(JSON.stringify({
            ...summary, requestCode, verified: row,
            sideEffects: { inventoryPosted: 0, emailsSent: 0, ordersReleased: 0 }
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
