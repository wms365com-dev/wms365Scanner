"use strict";

const { Client } = require("pg");
const { getPortalInventorySummary } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "ALCONA TRADING LTD";
const ACCOUNT_ID = "2920";
const WAREHOUSE_ID = 143;
const SKU = "MS26062403";
const LOCATION = "WHS01-REC";
const EXPECTED_QUANTITY = 43;
const EXPECTED_RESERVED = 8;
const CHANGE_KEY = "ALCONA-WHS01-REC-RESTORE-PICKABLE-20261112";

async function inspect(db, lock = false) {
    const account = await db.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) throw new Error("Alcona identity mismatch.");
    const bin = await db.query(`select * from bin_locations where code=$1 ${lock ? "for update" : ""}`, [LOCATION]);
    if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT || Number(bin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID) throw new Error("Alcona bin scope mismatch.");
    const inventory = await db.query(`select * from inventory_lines where account_name=$1 and sku=$2 and location=$3 ${lock ? "for update" : ""}`, [ACCOUNT, SKU, LOCATION]);
    if (inventory.rowCount !== 1 || Number(inventory.rows[0].quantity) !== EXPECTED_QUANTITY) throw new Error("Alcona tote quantity changed; correction stopped.");
    const completed = await db.query(`select count(*)::integer count from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id where i.account_name=$1 and l.sku=$2 and i.status='PUTAWAY_COMPLETE'`, [ACCOUNT, SKU]);
    if (Number(completed.rows[0].count) < 1) throw new Error("No completed Alcona putaway supports this correction.");
    const reserved = await db.query(`select coalesce(sum(a.allocated_quantity),0)::integer quantity from portal_order_allocations a join portal_orders o on o.id=a.order_id where o.account_name=$1 and o.fulfillment_location_id=$2 and a.sku=$3 and o.status in ('RELEASED','PICKING','PICKED','STAGED')`, [ACCOUNT, WAREHOUSE_ID, SKU]);
    if (Number(reserved.rows[0].quantity) !== EXPECTED_RESERVED) throw new Error("Alcona allocation changed; correction stopped.");
    const prior = await db.query("select id from activity_log where details like $1 limit 1", [`%${CHANGE_KEY}%`]);
    return { bin: bin.rows[0], inventory: inventory.rows[0], reserved: Number(reserved.rows[0].quantity), prior: prior.rowCount > 0 };
}

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin read only");
        const before = await inspect(db);
        await db.query("rollback");
        console.log(JSON.stringify({ phase: "preflight", quantity: Number(before.inventory.quantity), reserved: before.reserved, locationType: before.bin.location_type, pickable: before.bin.is_pickable, prior: before.prior }));
        if (!APPLY) return;
        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [CHANGE_KEY]);
        const current = await inspect(db, true);
        if (!current.prior) {
            await db.query(`update bin_locations set location_type='STORAGE',is_pickable=true,note=$2,updated_at=now() where code=$1`, [LOCATION, "Alcona completed-putaway tote storage restored after the bin was incorrectly reset to receiving stage on 2026-11-11."]);
            await db.query("insert into activity_log(type,title,details) values('inventory',$1,$2)", ["Restored Alcona tote availability", `${CHANGE_KEY} | ${ACCOUNT} | ${SKU} | ${LOCATION} | ${EXPECTED_QUANTITY} totes | ${EXPECTED_RESERVED} reserved`]);
        }
        await db.query("commit");
        await db.query("begin read only");
        const after = await inspect(db);
        const portal = await getPortalInventorySummary(ACCOUNT, db, { fulfillmentLocationId: WAREHOUSE_ID });
        await db.query("rollback");
        const item = portal.find((row) => row.sku === SKU);
        if (!after.bin.is_pickable || after.bin.location_type !== "STORAGE" || !item || Number(item.onHandQuantity) !== 44 || Number(item.reservedQuantity) !== 8 || Number(item.availableQuantity) !== 36) throw new Error("Post-correction portal verification failed.");
        console.log(JSON.stringify({ phase: "verified", sku: SKU, onHand: 44, reserved: 8, available: 36, damagedExcluded: 8, location: LOCATION, pickable: true }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
