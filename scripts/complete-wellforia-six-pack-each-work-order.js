const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const REQUEST_CODE = "KIT-000020";
const SOURCE_SKU = "TP-WW-6PK-UPC";
const TARGET_SKU = "WW-6PK-EA";

async function main({ apply = false } = {}) {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [REQUEST_CODE]);
        const requestResult = await client.query(
            `select * from portal_kitting_requests where account_name=$1 and request_code=$2 limit 1 for update`,
            [ACCOUNT, REQUEST_CODE]
        );
        if (requestResult.rowCount !== 1) throw new Error(`${REQUEST_CODE} was not found for Wellforia.`);
        const request = requestResult.rows[0];
        if (request.source_sku !== SOURCE_SKU || Number(request.source_quantity) !== 1 || request.target_sku !== TARGET_SKU || Number(request.target_quantity) !== 8) throw new Error("The work-order conversion details changed.");
        if (request.status === "COMPLETED") {
            await client.query("rollback");
            const result = { mode: apply ? "APPLY" : "PREFLIGHT", alreadyCompleted: true, requestCode: REQUEST_CODE };
            console.log(JSON.stringify(result, null, 2));
            return result;
        }
        if (!['SUBMITTED','IN_PROGRESS'].includes(request.status)) throw new Error(`${REQUEST_CODE} cannot be completed from ${request.status}.`);
        const allocationResult = await client.query(
            `select a.*,i.quantity as on_hand,i.upc,b.is_pickable,b.location_type,b.fulfillment_location_id
             from portal_kitting_allocations a
             join inventory_lines i on i.id=a.inventory_line_id
             join bin_locations b on b.code=i.location
             where a.kitting_request_id=$1 for update of a,i`,
            [request.id]
        );
        if (allocationResult.rowCount !== 1) throw new Error("Expected one reserved source inventory line.");
        const allocation = allocationResult.rows[0];
        if (allocation.sku !== SOURCE_SKU || Number(allocation.allocated_quantity) !== 1 || Number(allocation.on_hand) < 1 || allocation.is_pickable !== true) throw new Error("Reserved source stock is no longer valid.");
        if (String(allocation.fulfillment_location_id) !== String(request.fulfillment_location_id)) throw new Error("Reserved source stock belongs to a different warehouse.");
        const targetItem = await client.query(
            `select sku,upc,tracking_level,unit_uom,units_per_case,blocked from item_catalog where account_name=$1 and sku=$2`,
            [ACCOUNT, TARGET_SKU]
        );
        if (targetItem.rowCount !== 1 || targetItem.rows[0].blocked || targetItem.rows[0].tracking_level !== 'UNIT' || targetItem.rows[0].unit_uom !== 'EA' || Number(targetItem.rows[0].units_per_case) !== 1) throw new Error("Target each-level item verification failed.");
        const beforeTargetResult = await client.query(
            `select * from inventory_lines where account_name=$1 and location=$2 and sku=$3 and lot_number='' and expiration_date='' limit 1 for update`,
            [ACCOUNT, allocation.location, TARGET_SKU]
        );
        const sourceBefore = Number(allocation.on_hand);
        const targetBefore = beforeTargetResult.rowCount ? Number(beforeTargetResult.rows[0].quantity) : 0;
        const summary = {
            mode: apply ? "APPLY" : "PREFLIGHT",
            requestCode: REQUEST_CODE,
            statusBefore: request.status,
            location: allocation.location,
            source: { sku: SOURCE_SKU, before: sourceBefore, deduct: 1, after: sourceBefore - 1 },
            target: { sku: TARGET_SKU, before: targetBefore, add: 8, after: targetBefore + 8 }
        };
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return summary;
        }
        await client.query("update inventory_lines set quantity=quantity-1,updated_at=now() where id=$1", [allocation.inventory_line_id]);
        const targetResult = await client.query(
            `insert into inventory_lines (account_name,location,sku,upc,lot_number,expiration_date,tracking_level,quantity)
             values ($1,$2,$3,$4,'','','UNIT',8)
             on conflict (account_name,location,sku,lot_number,expiration_date)
             do update set quantity=inventory_lines.quantity+8,tracking_level='UNIT',updated_at=now()
             returning id,quantity,upc`,
            [ACCOUNT, allocation.location, TARGET_SKU, targetItem.rows[0].upc || ""]
        );
        const targetAfter = Number(targetResult.rows[0].quantity);
        await client.query(
            `insert into inventory_transactions (
                account_name,warehouse_id,fulfillment_location_id,location,sku,upc,lot_number,expiration_date,
                transaction_type,quantity_delta,quantity_before,quantity_after,source_type,source_id,idempotency_key,source
             ) values
             ($1,'GW3PL-MISS',$2,$3,$4,$5,$6,$7,'CONVERSION',-1,$8,$9,'PORTAL_KITTING_REQUEST',$10,$11,'kitting_completion'),
             ($1,'GW3PL-MISS',$2,$3,$12,$13,'','','CONVERSION',8,$14,$15,'PORTAL_KITTING_REQUEST',$10,$16,'kitting_completion')`,
            [
                ACCOUNT,request.fulfillment_location_id,allocation.location,SOURCE_SKU,allocation.upc || "",allocation.lot_number || "",allocation.expiration_date || "",
                sourceBefore,sourceBefore - 1,REQUEST_CODE,`${REQUEST_CODE}-source`,TARGET_SKU,targetItem.rows[0].upc || "",targetBefore,targetAfter,`${REQUEST_CODE}-target`
            ]
        );
        await client.query("delete from portal_kitting_allocations where kitting_request_id=$1", [request.id]);
        const warehouseNote = `Inventory converted and finished stock placed in ${allocation.location}. One ${SOURCE_SKU} master case separated into 8 eaches of ${TARGET_SKU}.`;
        await client.query(
            `update portal_kitting_requests set status='COMPLETED',warehouse_note=$2,completed_at=now(),completed_by='Warehouse operations',updated_at=now() where id=$1`,
            [request.id, warehouseNote]
        );
        await client.query(
            `insert into activity_log (type,title,details) values ('kitting',$1,$2)`,
            [`Updated kitting request ${REQUEST_CODE} to COMPLETED`, `${ACCOUNT} | ${warehouseNote}`]
        );
        await client.query("commit");
        const [verifiedRequest, verifiedInventory, verifiedLedger, verifiedAllocation] = await Promise.all([
            pool.query(`select request_code,status,source_sku,source_quantity,target_sku,target_quantity,completed_at,completed_by,warehouse_note from portal_kitting_requests where id=$1`, [request.id]),
            pool.query(`select sku,quantity,tracking_level,location from inventory_lines where account_name=$1 and location=$2 and sku=any($3::text[]) order by sku`, [ACCOUNT, allocation.location, [SOURCE_SKU, TARGET_SKU]]),
            pool.query(`select sku,quantity_delta,quantity_before,quantity_after,transaction_type,source_type,source_id from inventory_transactions where account_name=$1 and source_type='PORTAL_KITTING_REQUEST' and source_id=$2 order by id`, [ACCOUNT, REQUEST_CODE]),
            pool.query(`select count(*)::int as count from portal_kitting_allocations where kitting_request_id=$1`, [request.id])
        ]);
        if (verifiedRequest.rows[0]?.status !== 'COMPLETED' || verifiedLedger.rowCount !== 2 || Number(verifiedAllocation.rows[0].count) !== 0) throw new Error("Post-commit completion verification failed.");
        const result = { ...summary, request: verifiedRequest.rows[0], inventory: verifiedInventory.rows, ledger: verifiedLedger.rows, reservationCount: verifiedAllocation.rows[0].count, sideEffects: { ordersReleased: 0, emailed: 0, printed: 0 } };
        console.log(JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        try { await client.query("rollback"); } catch {}
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

module.exports = { main };
if (require.main === module) main({ apply: process.argv.includes('--apply') }).catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
