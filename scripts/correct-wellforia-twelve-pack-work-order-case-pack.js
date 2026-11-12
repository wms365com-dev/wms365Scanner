const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const REQUEST_CODE = "KIT-000021";
const SOURCE_SKU = "WW-12PK";
const TARGET_SKU = "WW-12PK-EA";
const SOURCE_CASES = 6;
const PACKS_PER_CASE = 4;
const TARGET_PACKS = SOURCE_CASES * PACKS_PER_CASE;

async function main({ apply = false } = {}) {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`wellforia:${REQUEST_CODE}:case-pack-correction`]);
        const [requestResult, warehouseResult, itemResult, inventoryResult] = await Promise.all([
            client.query(
                `select id,request_code,status,source_sku,source_quantity,target_sku,target_quantity,completed_at
                 from portal_kitting_requests where account_name=$1 and request_code=$2 for update`,
                [ACCOUNT, REQUEST_CODE]
            ),
            client.query(
                `select fl.id,fl.code,fl.is_active,cfl.allow_storage
                 from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1 and fl.code=$2`,
                [ACCOUNT, WAREHOUSE]
            ),
            client.query(
                `select sku,tracking_level,units_per_case,blocked from item_catalog
                 where account_name=$1 and sku=any($2::text[]) order by sku`,
                [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
            ),
            client.query(
                `select i.id,i.location,i.quantity,i.lot_number,i.expiration_date,i.tracking_level,
                        b.fulfillment_location_id,b.is_pickable,
                        coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                                  join portal_orders o on o.id=a.order_id
                                  where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKED','STAGED')),0)::int
                        + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a
                                    join portal_kitting_requests k on k.id=a.kitting_request_id
                                    where a.inventory_line_id=i.id and k.status in ('SUBMITTED','IN_PROGRESS')
                                      and k.request_code<>$3),0)::int as other_committed
                 from inventory_lines i join bin_locations b on b.code=i.location
                 join fulfillment_locations fl on fl.id=b.fulfillment_location_id
                 where i.account_name=$1 and i.sku=$2 and fl.code=$4 and b.is_pickable=true
                 order by i.id for update of i`,
                [ACCOUNT, SOURCE_SKU, REQUEST_CODE, WAREHOUSE]
            )
        ]);
        const request = requestResult.rows[0];
        const warehouse = warehouseResult.rows[0];
        if (!request || request.status !== "SUBMITTED" || request.completed_at) throw new Error("The work order is not an uncompleted submitted request.");
        if (request.source_sku !== SOURCE_SKU || request.target_sku !== TARGET_SKU) throw new Error("The work-order SKUs do not match the approved correction.");
        if (!warehouse || warehouse.is_active !== true || warehouse.allow_storage !== true) throw new Error("Exact active Mississauga warehouse verification failed.");
        if (itemResult.rows.length !== 2 || itemResult.rows.some((item) => item.blocked)) throw new Error("Required item verification failed.");
        const available = inventoryResult.rows.reduce((sum, row) => sum + Math.max(0, Number(row.quantity) - Number(row.other_committed)), 0);
        if (available < SOURCE_CASES) throw new Error("Six uncommitted source cases are no longer available.");
        const summary = {
            mode: apply ? "APPLY" : "PREFLIGHT", requestCode: REQUEST_CODE,
            before: { sourceCases: Number(request.source_quantity), targetPacks: Number(request.target_quantity) },
            after: { sourceCases: SOURCE_CASES, packsPerCase: PACKS_PER_CASE, targetPacks: TARGET_PACKS, demandPacks: 22, excessPacks: 2 },
            availableSourceCases: available
        };
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return summary;
        }
        await client.query(
            `update item_catalog set units_per_case=$3,unit_uom='PACK',updated_at=now()
             where account_name=$1 and sku=$2`,
            [ACCOUNT, SOURCE_SKU, PACKS_PER_CASE]
        );
        await client.query(
            `update portal_kitting_requests
             set source_quantity=$2,target_quantity=$3,
                 components_json=$4::jsonb,
                 notes=$5,updated_at=now()
             where id=$1`,
            [request.id, SOURCE_CASES, TARGET_PACKS,
                JSON.stringify([{ sku: SOURCE_SKU, totalQuantity: SOURCE_CASES, quantityPerUnit: PACKS_PER_CASE, description: "Whoopsie Wipes 12 Pack master case" }]),
                `Pull and break ${SOURCE_CASES} master cases of ${SOURCE_SKU} at ${PACKS_PER_CASE} consumer 12-packs per case. Receive ${TARGET_PACKS} individually pickable ${TARGET_SKU}. Twenty-two packs cover the current verified shortage; return the remaining 2 packs to pickable each inventory. Complete through the normal work-order workflow before releasing orders.`]
        );
        await client.query("delete from portal_kitting_allocations where kitting_request_id=$1", [request.id]);
        let remaining = SOURCE_CASES;
        for (const line of inventoryResult.rows) {
            if (remaining <= 0) break;
            const lineAvailable = Math.max(0, Number(line.quantity) - Number(line.other_committed));
            const allocated = Math.min(remaining, lineAvailable);
            if (!allocated) continue;
            await client.query(
                `insert into portal_kitting_allocations
                    (kitting_request_id,inventory_line_id,sku,location,lot_number,expiration_date,tracking_level,allocated_quantity)
                 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [request.id, line.id, SOURCE_SKU, line.location, line.lot_number || "", line.expiration_date || "", line.tracking_level, allocated]
            );
            remaining -= allocated;
        }
        if (remaining !== 0) throw new Error("Source availability changed during correction.");
        await client.query(
            `insert into activity_log (type,title,details) values ('kitting',$1,$2)`,
            [`Corrected kitting request ${REQUEST_CODE}`, `${ACCOUNT} | approved case pack ${PACKS_PER_CASE} | ${SOURCE_CASES} ${SOURCE_SKU} -> ${TARGET_PACKS} ${TARGET_SKU}`]
        );
        await client.query("commit");
        const verification = await pool.query(
            `select k.status,k.source_quantity,k.target_quantity,
                    (select units_per_case from item_catalog where account_name=$2 and sku=$3) as units_per_case,
                    coalesce(sum(a.allocated_quantity),0)::int as allocated_quantity
             from portal_kitting_requests k left join portal_kitting_allocations a on a.kitting_request_id=k.id
             where k.id=$1 group by k.id`,
            [request.id, ACCOUNT, SOURCE_SKU]
        );
        const row = verification.rows[0];
        if (!row || row.status !== "SUBMITTED" || Number(row.source_quantity) !== SOURCE_CASES
            || Number(row.target_quantity) !== TARGET_PACKS || Number(row.units_per_case) !== PACKS_PER_CASE
            || Number(row.allocated_quantity) !== SOURCE_CASES) throw new Error("Post-correction verification failed.");
        const result = { ...summary, verified: row, sideEffects: { inventoryMoved: 0, ordersReleased: 0, emailed: 0, printed: 0 } };
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
