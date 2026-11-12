const { Client } = require("pg");
let serverApi;
try {
    serverApi = require("../server");
} catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    serverApi = require("./server");
}
const { recordInventoryTransaction, upsertInventoryLine } = serverApi;

const ACCOUNT = "ALCONA TRADING LTD";
const ACCOUNT_ID = 2920;
const WAREHOUSE_ID = 143;
const DAMAGE_LOCATION = "WHS01-ALCONA-DMG";
const SOURCE_ID = "ALCONA-DAMAGE-MOVE-20261027-MS26053103-4-MS26062403-3";
const REQUESTS = [
    { sku: "MS26053103", quantity: 4, preferredLocations: ["WHS01-ALCONA-REC", "DJ42AA", "DJ42AB", "DJ44AA"] },
    { sku: "MS26062403", quantity: 3, preferredLocations: ["WHS01-REC"] }
];

function rankLocation(location, preferredLocations) {
    const rank = preferredLocations.indexOf(location);
    return rank === -1 ? preferredLocations.length : rank;
}

async function verifyScope(db) {
    const account = await db.query("select id,name,is_active from owner_accounts where id=$1 and name=$2", [ACCOUNT_ID, ACCOUNT]);
    if (account.rowCount !== 1 || account.rows[0].is_active !== true) throw new Error("Exact active Alcona account identity was not verified.");

    const warehouse = await db.query("select id,code,is_active from fulfillment_locations where id=$1", [WAREHOUSE_ID]);
    if (warehouse.rowCount !== 1 || warehouse.rows[0].is_active !== true || warehouse.rows[0].code !== "WHS01") {
        throw new Error("Exact active Edwards warehouse identity was not verified.");
    }

    const damage = await db.query(
        "select code,account_name,fulfillment_location_id,location_type,is_pickable from bin_locations where code=$1",
        [DAMAGE_LOCATION]
    );
    const row = damage.rows[0];
    if (damage.rowCount !== 1 || row.account_name !== ACCOUNT || Number(row.fulfillment_location_id) !== WAREHOUSE_ID
        || row.location_type !== "DAMAGED" || row.is_pickable !== false) {
        throw new Error("Exact Alcona non-pickable damaged location was not verified.");
    }
}

async function buildPlan(db, lockRows) {
    const plan = [];
    for (const request of REQUESTS) {
        const result = await db.query(
            `select i.*,b.location_type,b.is_pickable,b.fulfillment_location_id,
                    coalesce(a.allocated,0)::integer allocated
             from inventory_lines i
             join bin_locations b on b.code=i.location
             left join (
                 select pa.sku,pa.location,sum(pa.allocated_quantity)::integer allocated
                 from portal_order_allocations pa
                 join portal_orders po on po.id=pa.order_id
                 where po.account_name=$1 and po.status in ('RELEASED','PICKING','PICKED','STAGED')
                 group by pa.sku,pa.location
             ) a on a.sku=i.sku and a.location=i.location
             where i.account_name=$1 and i.sku=$2 and i.quantity>0
               and b.account_name=$1 and b.fulfillment_location_id=$3
               and b.is_pickable=true
               and b.location_type not in ('DAMAGED','HOLD','INVESTIGATION','QUARANTINE','QA_HOLD','RECEIVING_STAGE')
             order by i.location,i.id${lockRows ? " for update of i" : ""}`,
            [ACCOUNT, request.sku, WAREHOUSE_ID]
        );
        const candidates = result.rows
            .map((row) => ({ ...row, free: Number(row.quantity) - Number(row.allocated) }))
            .filter((row) => row.free > 0)
            .sort((left, right) => rankLocation(left.location, request.preferredLocations) - rankLocation(right.location, request.preferredLocations)
                || Number(left.id) - Number(right.id));
        let remaining = request.quantity;
        for (const row of candidates) {
            if (remaining <= 0) break;
            const quantity = Math.min(row.free, remaining);
            plan.push({ row, quantity });
            remaining -= quantity;
        }
        if (remaining !== 0) throw new Error(`Insufficient unallocated pickable stock for ${request.sku}; short ${remaining}.`);
    }
    return plan;
}

async function summarize(db) {
    const result = await db.query(
        `select i.sku,
                coalesce(sum(i.quantity),0)::integer physical,
                coalesce(sum(case when b.location_type='DAMAGED' then i.quantity else 0 end),0)::integer damaged,
                coalesce(sum(case when b.is_pickable=true and b.location_type not in ('DAMAGED','HOLD','INVESTIGATION','QUARANTINE','QA_HOLD','RECEIVING_STAGE') then i.quantity else 0 end),0)::integer usable
         from inventory_lines i join bin_locations b on b.code=i.location
         where i.account_name=$1 and i.sku=any($2::text[])
         group by i.sku order by i.sku`,
        [ACCOUNT, REQUESTS.map((item) => item.sku)]
    );
    const allocations = await db.query(
        `select pa.sku,coalesce(sum(pa.allocated_quantity),0)::integer allocated
         from portal_order_allocations pa join portal_orders po on po.id=pa.order_id
         where po.account_name=$1 and pa.sku=any($2::text[])
           and po.status in ('RELEASED','PICKING','PICKED','STAGED')
         group by pa.sku order by pa.sku`,
        [ACCOUNT, REQUESTS.map((item) => item.sku)]
    );
    const allocatedBySku = new Map(allocations.rows.map((row) => [row.sku, Number(row.allocated)]));
    return result.rows.map((row) => ({
        sku: row.sku,
        physical: Number(row.physical),
        damaged: Number(row.damaged),
        usable: Number(row.usable),
        allocated: allocatedBySku.get(row.sku) || 0,
        available: Number(row.usable) - (allocatedBySku.get(row.sku) || 0)
    }));
}

async function main() {
    const apply = process.argv.includes("--apply");
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin");
        if (apply) await db.query("select pg_advisory_xact_lock(hashtext($1))", [SOURCE_ID]);
        await verifyScope(db);

        const existing = await db.query(
            "select count(*)::integer count from inventory_transactions where source_type='OWNER_APPROVED_DAMAGE_MOVE' and source_id=$1",
            [SOURCE_ID]
        );
        if (Number(existing.rows[0].count) > 0) {
            const summary = await summarize(db);
            await db.query("rollback");
            console.log(JSON.stringify({ status: "ALREADY_APPLIED", sourceId: SOURCE_ID, summary }));
            return;
        }

        const plan = await buildPlan(db, apply);
        if (!apply) {
            const before = await summarize(db);
            await db.query("rollback");
            console.log(JSON.stringify({ status: "PREFLIGHT_OK", sourceId: SOURCE_ID, plan: plan.map(({ row, quantity }) => ({ sku: row.sku, from: row.location, quantity, allocatedAtSource: Number(row.allocated) })), before }));
            return;
        }

        for (const { row, quantity } of plan) {
            const before = Number(row.quantity);
            const after = before - quantity;
            const updated = await db.query("update inventory_lines set quantity=$1,updated_at=now() where id=$2 and quantity=$3 returning *", [after, row.id, before]);
            if (updated.rowCount !== 1) throw new Error(`Inventory line ${row.id} changed during the move.`);
            await recordInventoryTransaction(db, {
                line: updated.rows[0], quantityBefore: before, quantityAfter: after,
                transactionType: "TRANSFER", sourceType: "OWNER_APPROVED_DAMAGE_MOVE", sourceId: SOURCE_ID,
                fulfillmentLocationId: WAREHOUSE_ID, idempotencyKey: `${SOURCE_ID}:FROM:${row.id}`, source: "SYSTEM"
            });
            await upsertInventoryLine(db, {
                accountName: ACCOUNT, location: DAMAGE_LOCATION, sku: row.sku, upc: row.upc || "",
                lotNumber: row.lot_number || "", expirationDate: row.expiration_date || "",
                trackingLevel: row.tracking_level || "PALLET", quantity
            }, {
                transactionType: "TRANSFER", sourceType: "OWNER_APPROVED_DAMAGE_MOVE", sourceId: SOURCE_ID,
                fulfillmentLocationId: WAREHOUSE_ID, idempotencyKey: `${SOURCE_ID}:TO:${row.id}`, source: "SYSTEM"
            });
        }

        const summary = await summarize(db);
        const bySku = new Map(summary.map((row) => [row.sku, row]));
        if (bySku.get("MS26053103")?.damaged !== 4 || bySku.get("MS26062403")?.damaged !== 8) {
            throw new Error("Post-move damaged quantities did not match the approved request.");
        }
        await db.query("commit");
        console.log(JSON.stringify({ status: "APPLIED", sourceId: SOURCE_ID, moved: plan.map(({ row, quantity }) => ({ sku: row.sku, from: row.location, to: DAMAGE_LOCATION, quantity })), summary }));
    } catch (error) {
        try { await db.query("rollback"); } catch {}
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
