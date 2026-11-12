const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const SOURCE_SKU = "WW-12PK";
const TARGET_SKU = "WW-12PK-EA";
const REFERENCE = "WF-REWORK-12PK-EACH-20261007";

async function loadState(client) {
    const [account, warehouse, items, duplicate, demand, inventory] = await Promise.all([
        client.query("select name,is_active from owner_accounts where name=$1", [ACCOUNT]),
        client.query(
            `select fl.id,fl.code,fl.name,fl.is_active,cfl.allow_storage
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and fl.code=$2`,
            [ACCOUNT, WAREHOUSE]
        ),
        client.query(
            `select sku,description,tracking_level,units_per_case,blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]
        ),
        client.query(
            `select id,request_code,status,source_sku,source_quantity,target_sku,target_quantity
             from portal_kitting_requests where account_name=$1 and purchase_order_reference=$2 limit 1`,
            [ACCOUNT, REFERENCE]
        ),
        client.query(
            `select count(distinct o.id)::int as order_count,
                    coalesce(sum(l.requested_quantity),0)::int as requested_quantity
             from portal_orders o join portal_order_lines l on l.order_id=o.id
             where o.account_name=$1 and o.status='DRAFT' and l.sku=$2`,
            [ACCOUNT, TARGET_SKU]
        ),
        client.query(
            `select i.id,i.sku,i.location,i.quantity,i.lot_number,i.expiration_date,i.tracking_level,
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
             where i.account_name=$1 and i.sku=any($2::text[]) and fl.code=$3 and b.is_pickable=true
             order by i.sku,i.id`,
            [ACCOUNT, [SOURCE_SKU, TARGET_SKU], WAREHOUSE]
        )
    ]);
    return {
        account: account.rows[0], warehouse: warehouse.rows[0], items: items.rows,
        duplicate: duplicate.rows[0], demand: demand.rows[0], inventory: inventory.rows
    };
}

function summarize(state) {
    const targetOnHand = state.inventory
        .filter((row) => row.sku === TARGET_SKU)
        .reduce((sum, row) => sum + Number(row.quantity), 0);
    const sourceLines = state.inventory.filter((row) => row.sku === SOURCE_SKU);
    const sourceAvailable = sourceLines.reduce(
        (sum, row) => sum + Math.max(0, Number(row.quantity) - Number(row.committed_quantity)), 0
    );
    const requested = Number(state.demand.requested_quantity);
    return {
        orderCount: Number(state.demand.order_count), requested, targetOnHand,
        shortage: Math.max(0, requested - targetOnHand), sourceAvailable, sourceLines
    };
}

function assertState(state, summary) {
    if (!state.account || state.account.is_active !== true) throw new Error("Exact active Wellforia tenant verification failed.");
    if (!state.warehouse || state.warehouse.is_active !== true || state.warehouse.allow_storage !== true) throw new Error("Exact active Mississauga warehouse verification failed.");
    if (state.items.length !== 2 || state.items.some((item) => item.blocked)) throw new Error("Required Wellforia item verification failed.");
    if (state.items.find((item) => item.sku === SOURCE_SKU)?.tracking_level !== "CASE") throw new Error("Source SKU is not case tracked.");
    const target = state.items.find((item) => item.sku === TARGET_SKU);
    if (target?.tracking_level !== "UNIT" || Number(target.units_per_case) !== 1) throw new Error("Target each SKU setup is invalid.");
    if (summary.orderCount !== 23 || summary.requested !== 25 || summary.targetOnHand !== 3 || summary.shortage !== 22) {
        throw new Error(`Live demand changed: ${summary.orderCount} orders, ${summary.requested} requested, ${summary.targetOnHand} on hand, ${summary.shortage} short.`);
    }
    if (summary.sourceAvailable < summary.shortage) throw new Error("Insufficient uncommitted source stock.");
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
        const summary = summarize(state);
        assertState(state, summary);
        if (state.duplicate) {
            await client.query("rollback");
            const result = { mode: apply ? "APPLY" : "PREFLIGHT", alreadyExists: true, request: state.duplicate };
            console.log(JSON.stringify(result, null, 2));
            return result;
        }
        const result = {
            mode: apply ? "APPLY" : "PREFLIGHT", account: ACCOUNT, warehouse: state.warehouse,
            source: { sku: SOURCE_SKU, quantity: summary.shortage, availableBefore: summary.sourceAvailable },
            target: { sku: TARGET_SKU, quantity: summary.shortage },
            demand: { draftOrders: summary.orderCount, requested: summary.requested, onHand: summary.targetOnHand, shortage: summary.shortage },
            reference: REFERENCE
        };
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify(result, null, 2));
            return result;
        }
        const inserted = await client.query(
            `insert into portal_kitting_requests (
                account_name,portal_access_id,status,sales_order_reference,purchase_order_reference,
                source_sku,source_quantity,components_json,target_sku,target_quantity,
                requested_completion_date,requested_by_name,requested_by_email,notes,
                fulfillment_location_id,processing_business_days,earliest_completion_date,holiday_closures_json
             ) values ($1,null,'SUBMITTED',$2,$3,$4,$5,$6::jsonb,$7,$8,current_date,$9,'',$10,$11,1,current_date,'[]'::jsonb)
             returning id`,
            [ACCOUNT, "S-ORD101184 through S-ORD101211 consumer batch", REFERENCE, SOURCE_SKU, summary.shortage,
                JSON.stringify([{ sku: SOURCE_SKU, totalQuantity: summary.shortage, quantityPerUnit: 1, description: "Whoopsie Wipes 12 Pack" }]),
                TARGET_SKU, summary.shortage, "Warehouse operations",
                `Pull ${summary.shortage} units of ${SOURCE_SKU} and prepare them as individually pickable ${TARGET_SKU}. This fills the verified 22-each shortfall for 23 draft consumer orders. Complete through the normal work-order workflow before releasing orders.`,
                state.warehouse.id]
        );
        const id = inserted.rows[0].id;
        const requestCode = `KIT-${String(id).padStart(6, "0")}`;
        await client.query("update portal_kitting_requests set request_code=$2,updated_at=now() where id=$1", [id, requestCode]);
        let remaining = summary.shortage;
        for (const line of summary.sourceLines) {
            if (remaining <= 0) break;
            const available = Math.max(0, Number(line.quantity) - Number(line.committed_quantity));
            const allocated = Math.min(remaining, available);
            if (!allocated) continue;
            await client.query(
                `insert into portal_kitting_allocations
                    (kitting_request_id,inventory_line_id,sku,location,lot_number,expiration_date,tracking_level,allocated_quantity)
                 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [id, line.id, SOURCE_SKU, line.location, line.lot_number || "", line.expiration_date || "", line.tracking_level, allocated]
            );
            remaining -= allocated;
        }
        if (remaining !== 0) throw new Error("Source allocation changed during work-order creation.");
        await client.query(
            `insert into activity_log (type,title,details) values ('kitting',$1,$2)`,
            [`Submitted kitting request ${requestCode}`, `${ACCOUNT} | ${summary.shortage} ${SOURCE_SKU} reserved -> ${summary.shortage} ${TARGET_SKU} | ${REFERENCE}`]
        );
        await client.query("commit");
        const verification = await pool.query(
            `select k.request_code,k.status,k.source_sku,k.source_quantity,k.target_sku,k.target_quantity,
                    coalesce(sum(a.allocated_quantity),0)::int as allocated_quantity
             from portal_kitting_requests k left join portal_kitting_allocations a on a.kitting_request_id=k.id
             where k.id=$1 group by k.id`,
            [id]
        );
        const row = verification.rows[0];
        if (!row || row.status !== "SUBMITTED" || row.source_sku !== SOURCE_SKU || Number(row.source_quantity) !== 22
            || row.target_sku !== TARGET_SKU || Number(row.target_quantity) !== 22 || Number(row.allocated_quantity) !== 22) {
            throw new Error("Post-commit work-order verification failed.");
        }
        const finalResult = { ...result, requestCode, verified: row, sideEffects: { inventoryMoved: 0, ordersReleased: 0, emailed: 0, printed: 0 } };
        console.log(JSON.stringify(finalResult, null, 2));
        return finalResult;
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
