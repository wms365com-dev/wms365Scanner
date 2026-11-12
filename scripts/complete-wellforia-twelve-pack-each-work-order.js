const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const REQUEST_CODE = "KIT-000021";
const SOURCE_SKU = "WW-12PK";
const TARGET_SKU = "WW-12PK-EA";
const SOURCE_CASES = 6;
const PACKS_PER_CASE = 4;
const TARGET_PACKS = 24;

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
        if (request.source_sku !== SOURCE_SKU || Number(request.source_quantity) !== SOURCE_CASES
            || request.target_sku !== TARGET_SKU || Number(request.target_quantity) !== TARGET_PACKS) {
            throw new Error("The work-order conversion details changed.");
        }
        if (request.status === "COMPLETED") {
            await client.query("rollback");
            const result = { mode: apply ? "APPLY" : "PREFLIGHT", alreadyCompleted: true, requestCode: REQUEST_CODE };
            console.log(JSON.stringify(result, null, 2));
            return result;
        }
        if (!["SUBMITTED", "IN_PROGRESS"].includes(request.status)) throw new Error(`${REQUEST_CODE} cannot be completed from ${request.status}.`);
        const sourceItem = await client.query(
            `select sku,tracking_level,unit_uom,units_per_case,blocked from item_catalog where account_name=$1 and sku=$2`,
            [ACCOUNT, SOURCE_SKU]
        );
        const targetItem = await client.query(
            `select sku,upc,tracking_level,unit_uom,units_per_case,blocked from item_catalog where account_name=$1 and sku=$2`,
            [ACCOUNT, TARGET_SKU]
        );
        if (sourceItem.rowCount !== 1 || sourceItem.rows[0].blocked || sourceItem.rows[0].tracking_level !== "CASE"
            || Number(sourceItem.rows[0].units_per_case) !== PACKS_PER_CASE) throw new Error("Source case-pack verification failed.");
        if (targetItem.rowCount !== 1 || targetItem.rows[0].blocked || targetItem.rows[0].tracking_level !== "UNIT"
            || Number(targetItem.rows[0].units_per_case) !== 1) throw new Error("Target each-level item verification failed.");
        const allocationResult = await client.query(
            `select a.*,i.quantity as on_hand,i.upc,b.is_pickable,b.location_type,b.fulfillment_location_id
             from portal_kitting_allocations a join inventory_lines i on i.id=a.inventory_line_id
             join bin_locations b on b.code=i.location
             where a.kitting_request_id=$1 order by a.id for update of a,i`,
            [request.id]
        );
        const allocatedCases = allocationResult.rows.reduce((sum, row) => sum + Number(row.allocated_quantity), 0);
        if (allocatedCases !== SOURCE_CASES) throw new Error("The source reservation no longer totals six cases.");
        for (const allocation of allocationResult.rows) {
            if (allocation.sku !== SOURCE_SKU || Number(allocation.on_hand) < Number(allocation.allocated_quantity)
                || allocation.is_pickable !== true || String(allocation.fulfillment_location_id) !== String(request.fulfillment_location_id)) {
                throw new Error("Reserved source stock is no longer valid.");
            }
        }
        const locationSummaries = [];
        for (const allocation of allocationResult.rows) {
            const sourceBefore = Number(allocation.on_hand);
            const sourceDeduct = Number(allocation.allocated_quantity);
            const targetAdd = sourceDeduct * PACKS_PER_CASE;
            const targetBeforeResult = await client.query(
                `select id,quantity from inventory_lines
                 where account_name=$1 and location=$2 and sku=$3 and lot_number='' and expiration_date='' limit 1 for update`,
                [ACCOUNT, allocation.location, TARGET_SKU]
            );
            locationSummaries.push({
                allocation, sourceBefore, sourceDeduct, targetAdd,
                targetBefore: targetBeforeResult.rowCount ? Number(targetBeforeResult.rows[0].quantity) : 0
            });
        }
        const summary = {
            mode: apply ? "APPLY" : "PREFLIGHT", requestCode: REQUEST_CODE, statusBefore: request.status,
            source: { sku: SOURCE_SKU, deductCases: SOURCE_CASES, packsPerCase: PACKS_PER_CASE },
            target: { sku: TARGET_SKU, addPacks: TARGET_PACKS },
            locations: locationSummaries.map((entry) => ({ location: entry.allocation.location, sourceCases: entry.sourceDeduct, targetPacks: entry.targetAdd }))
        };
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return summary;
        }
        const ledgerKeys = [];
        for (let index = 0; index < locationSummaries.length; index += 1) {
            const entry = locationSummaries[index];
            const { allocation, sourceBefore, sourceDeduct, targetAdd, targetBefore } = entry;
            await client.query("update inventory_lines set quantity=quantity-$2,updated_at=now() where id=$1", [allocation.inventory_line_id, sourceDeduct]);
            const targetResult = await client.query(
                `insert into inventory_lines (account_name,location,sku,upc,lot_number,expiration_date,tracking_level,quantity)
                 values ($1,$2,$3,$4,'','','UNIT',$5)
                 on conflict (account_name,location,sku,lot_number,expiration_date)
                 do update set quantity=inventory_lines.quantity+$5,tracking_level='UNIT',updated_at=now()
                 returning quantity`,
                [ACCOUNT, allocation.location, TARGET_SKU, targetItem.rows[0].upc || "", targetAdd]
            );
            const targetAfter = Number(targetResult.rows[0].quantity);
            const sourceKey = `${REQUEST_CODE}-source-${index + 1}`;
            const targetKey = `${REQUEST_CODE}-target-${index + 1}`;
            ledgerKeys.push(sourceKey, targetKey);
            await client.query(
                `insert into inventory_transactions (
                    account_name,warehouse_id,fulfillment_location_id,location,sku,upc,lot_number,expiration_date,
                    transaction_type,quantity_delta,quantity_before,quantity_after,source_type,source_id,idempotency_key,source
                 ) values
                 ($1,'GW3PL-MISS',$2,$3,$4,$5,$6,$7,'CONVERSION',$8,$9,$10,'PORTAL_KITTING_REQUEST',$11,$12,'kitting_completion'),
                 ($1,'GW3PL-MISS',$2,$3,$13,$14,'','','CONVERSION',$15,$16,$17,'PORTAL_KITTING_REQUEST',$11,$18,'kitting_completion')`,
                [ACCOUNT, request.fulfillment_location_id, allocation.location, SOURCE_SKU, allocation.upc || "",
                    allocation.lot_number || "", allocation.expiration_date || "", -sourceDeduct, sourceBefore,
                    sourceBefore - sourceDeduct, REQUEST_CODE, sourceKey, TARGET_SKU, targetItem.rows[0].upc || "",
                    targetAdd, targetBefore, targetAfter, targetKey]
            );
        }
        await client.query("delete from portal_kitting_allocations where kitting_request_id=$1", [request.id]);
        const warehouseNote = `Inventory converted through the approved work order. Six ${SOURCE_SKU} master cases at four packs per case produced 24 eaches of ${TARGET_SKU}.`;
        await client.query(
            `update portal_kitting_requests set status='COMPLETED',warehouse_note=$2,completed_at=now(),
                    completed_by='Warehouse operations',updated_at=now() where id=$1`,
            [request.id, warehouseNote]
        );
        await client.query(
            `insert into activity_log (type,title,details) values ('kitting',$1,$2)`,
            [`Updated kitting request ${REQUEST_CODE} to COMPLETED`, `${ACCOUNT} | ${warehouseNote}`]
        );
        await client.query("commit");
        const [verifiedRequest, verifiedLedger, verifiedAllocation, availableTarget] = await Promise.all([
            pool.query(`select request_code,status,source_quantity,target_quantity,completed_at,completed_by,warehouse_note from portal_kitting_requests where id=$1`, [request.id]),
            pool.query(`select sku,quantity_delta,quantity_before,quantity_after,location,idempotency_key from inventory_transactions where account_name=$1 and source_type='PORTAL_KITTING_REQUEST' and source_id=$2 order by id`, [ACCOUNT, REQUEST_CODE]),
            pool.query(`select count(*)::int as count from portal_kitting_allocations where kitting_request_id=$1`, [request.id]),
            pool.query(
                `select coalesce(sum(i.quantity),0)::int as on_hand
                 from inventory_lines i join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=$3 and b.is_pickable=true`,
                [ACCOUNT, TARGET_SKU, request.fulfillment_location_id]
            )
        ]);
        const sourceDelta = verifiedLedger.rows.filter((row) => row.sku === SOURCE_SKU).reduce((sum, row) => sum + Number(row.quantity_delta), 0);
        const targetDelta = verifiedLedger.rows.filter((row) => row.sku === TARGET_SKU).reduce((sum, row) => sum + Number(row.quantity_delta), 0);
        if (verifiedRequest.rows[0]?.status !== "COMPLETED" || sourceDelta !== -SOURCE_CASES || targetDelta !== TARGET_PACKS
            || Number(verifiedAllocation.rows[0].count) !== 0) throw new Error("Post-commit completion verification failed.");
        const result = { ...summary, request: verifiedRequest.rows[0], ledger: verifiedLedger.rows,
            availableTargetPacks: Number(availableTarget.rows[0].on_hand), reservationCount: 0,
            sideEffects: { ordersReleased: 0, emailed: 0, printed: 0 } };
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
if (require.main === module) main({ apply: process.argv.includes("--apply") }).catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
