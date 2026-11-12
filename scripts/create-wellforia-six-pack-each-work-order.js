const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const SOURCE_SKU = "TP-WW-6PK-UPC";
const TARGET_SKU = "WW-6PK-EA";
const REFERENCE = "WF-REWORK-6PK-EACH-20261007-A643D570";

async function loadState(client) {
    const [warehouse, items, duplicate, source] = await Promise.all([
        client.query(
            `select fl.id,fl.code,fl.name,fl.is_active,cfl.allow_storage
             from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and fl.code=$2`,
            [ACCOUNT, WAREHOUSE]
        ),
        client.query(
            `select sku,description,tracking_level,unit_uom,units_per_case,blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
        ),
        client.query(
            `select id,request_code,status,source_sku,source_quantity,target_sku,target_quantity
             from portal_kitting_requests where account_name=$1 and purchase_order_reference=$2 limit 1`,
            [ACCOUNT, REFERENCE]
        ),
        client.query(
            `select i.id,i.location,i.quantity,i.lot_number,i.expiration_date,i.tracking_level,
                    b.is_pickable,b.location_type,b.fulfillment_location_id,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                              join portal_orders o on o.id=a.order_id
                              where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKED','STAGED')),0)::int
                    + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a
                                join portal_kitting_requests k on k.id=a.kitting_request_id
                                where a.inventory_line_id=i.id and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as committed_quantity
             from inventory_lines i
             join bin_locations b on b.code=i.location
             join fulfillment_locations fl on fl.id=b.fulfillment_location_id
             where i.account_name=$1 and i.sku=$2 and fl.code=$3 and b.is_pickable=true
             order by (i.quantity - (
                coalesce((select sum(a.allocated_quantity) from portal_order_allocations a join portal_orders o on o.id=a.order_id
                          where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKED','STAGED')),0)
                + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a join portal_kitting_requests k on k.id=a.kitting_request_id
                            where a.inventory_line_id=i.id and k.status in ('SUBMITTED','IN_PROGRESS')),0)
             )) desc,i.id
             limit 1`,
            [ACCOUNT, SOURCE_SKU, WAREHOUSE]
        )
    ]);
    return { warehouse: warehouse.rows[0], items: items.rows, duplicate: duplicate.rows[0], source: source.rows[0] };
}

function assertState(state) {
    if (!state.warehouse || state.warehouse.is_active !== true || state.warehouse.allow_storage !== true) throw new Error("Exact active Mississauga warehouse verification failed.");
    if (state.items.length !== 2 || state.items.some((item) => item.blocked)) throw new Error("Required Wellforia item verification failed.");
    const sourceItem = state.items.find((item) => item.sku === SOURCE_SKU);
    const targetItem = state.items.find((item) => item.sku === TARGET_SKU);
    if (sourceItem.tracking_level !== "CASE" || Number(sourceItem.units_per_case) !== 8) throw new Error("Source master-case setup is not 8 six-packs per case.");
    if (targetItem.tracking_level !== "UNIT" || targetItem.unit_uom !== "EA" || Number(targetItem.units_per_case) !== 1) throw new Error("Target each-level SKU setup is invalid.");
    if (!state.source || Number(state.source.quantity) - Number(state.source.committed_quantity) < 1) throw new Error("No uncommitted pickable source case is available.");
    if (String(state.source.fulfillment_location_id) !== String(state.warehouse.id)) throw new Error("Source stock is outside the Mississauga warehouse.");
}

async function main({ apply = false } = {}) {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [REFERENCE]);
        const state = await loadState(client);
        assertState(state);
        if (state.duplicate) {
            await client.query("rollback");
            const result = { mode: apply ? "APPLY" : "PREFLIGHT", alreadyExists: true, request: state.duplicate };
            console.log(JSON.stringify(result, null, 2));
            return result;
        }
        const summary = {
            mode: apply ? "APPLY" : "PREFLIGHT",
            account: ACCOUNT,
            warehouse: state.warehouse,
            source: { sku: SOURCE_SKU, quantity: 1, location: state.source.location, availableBefore: Number(state.source.quantity) - Number(state.source.committed_quantity) },
            target: { sku: TARGET_SKU, quantity: 8 },
            reference: REFERENCE
        };
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return summary;
        }
        const notes = "Pull 1 master case of TP-WW-6PK-UPC. Open and separate the 8 individual Whoopsie Wipes 6-packs. Receive all 8 finished units as WW-6PK-EA. Five units are required for the current consumer-order batch; return the remaining 3 units to pickable each inventory.";
        const inserted = await client.query(
            `insert into portal_kitting_requests (
                account_name,portal_access_id,status,sales_order_reference,purchase_order_reference,
                source_sku,source_quantity,components_json,target_sku,target_quantity,
                requested_completion_date,requested_by_name,requested_by_email,notes,
                fulfillment_location_id,processing_business_days,earliest_completion_date,holiday_closures_json
             ) values ($1,null,'SUBMITTED',$2,$3,$4,1,$5::jsonb,$6,8,current_date,$7,'',$8,$9,1,current_date,'[]'::jsonb)
             returning id`,
            [ACCOUNT, "S-ORD101186,S-ORD101188,S-ORD101206,S-ORD101209,S-ORD101210", REFERENCE, SOURCE_SKU,
                JSON.stringify([{ sku: SOURCE_SKU, totalQuantity: 1, quantityPerUnit: 8, description: "Whoopsie Wipes 6 Pack master case" }]),
                TARGET_SKU, "Warehouse operations", notes, state.warehouse.id]
        );
        const id = inserted.rows[0].id;
        const requestCode = `KIT-${String(id).padStart(6, "0")}`;
        await client.query("update portal_kitting_requests set request_code=$2,updated_at=now() where id=$1", [id, requestCode]);
        await client.query(
            `insert into portal_kitting_allocations (
                kitting_request_id,inventory_line_id,sku,location,lot_number,expiration_date,tracking_level,allocated_quantity
             ) values ($1,$2,$3,$4,$5,$6,'CASE',1)`,
            [id, state.source.id, SOURCE_SKU, state.source.location, state.source.lot_number || "", state.source.expiration_date || ""]
        );
        await client.query(
            `insert into activity_log (type,title,details) values ('kitting',$1,$2)`,
            [`Submitted kitting request ${requestCode}`, `${ACCOUNT} | 1 case ${SOURCE_SKU} reserved at ${state.source.location} -> 8 each ${TARGET_SKU} | ${REFERENCE}`]
        );
        await client.query("commit");
        const verification = await pool.query(
            `select k.request_code,k.status,k.source_sku,k.source_quantity,k.target_sku,k.target_quantity,
                    k.notes,k.fulfillment_location_id,a.location,a.allocated_quantity
             from portal_kitting_requests k join portal_kitting_allocations a on a.kitting_request_id=k.id
             where k.id=$1`,
            [id]
        );
        const row = verification.rows[0];
        if (!row || row.status !== "SUBMITTED" || row.source_sku !== SOURCE_SKU || Number(row.source_quantity) !== 1 || row.target_sku !== TARGET_SKU || Number(row.target_quantity) !== 8 || Number(row.allocated_quantity) !== 1) throw new Error("Post-commit work-order verification failed.");
        const result = { ...summary, requestCode, verified: row, sideEffects: { inventoryMoved: 0, ordersReleased: 0, emailed: 0, printed: 0 } };
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
