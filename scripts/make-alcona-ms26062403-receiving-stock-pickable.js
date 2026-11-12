const { Client } = require("pg");
const { getPortalInventorySummary } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "ALCONA TRADING LTD";
const ACCOUNT_ID = "2920";
const SKU = "MS26062403";
const WAREHOUSE_ID = 143;
const WAREHOUSE_CODE = "WHS01";
const LOCATION = "WHS01-REC";
const EXPECTED_QUANTITY = 60;
const CHANGE_KEY = "ALCONA-MS26062403-WHS01-REC-PICKABLE-20261027";

async function inspect(db, lock = false) {
    const account = await db.query(
        "select id,name,is_active from owner_accounts where name=$1",
        [ACCOUNT]
    );
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
        throw new Error("Alcona account identity mismatch.");
    }
    const warehouse = await db.query(
        `select fl.id,fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage,cfl.customer_portal_visible
         from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and fl.id=$2 and fl.code=$3`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    const wh = warehouse.rows[0];
    if (warehouse.rowCount !== 1 || !wh.is_active || !wh.allow_outbound
        || !wh.allow_storage || !wh.customer_portal_visible) {
        throw new Error("Alcona Edwards warehouse assignment mismatch.");
    }
    const bin = await db.query(
        `select * from bin_locations where code=$1 ${lock ? "for update" : ""}`,
        [LOCATION]
    );
    if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT
        || Number(bin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID) {
        throw new Error("Alcona receiving bin scope mismatch.");
    }
    const inventory = await db.query(
        `select * from inventory_lines where location=$1 ${lock ? "for update" : ""}`,
        [LOCATION]
    );
    const positive = inventory.rows.filter((row) => Number(row.quantity) > 0);
    if (positive.length !== 1 || positive[0].account_name !== ACCOUNT
        || positive[0].sku !== SKU || Number(positive[0].quantity) !== EXPECTED_QUANTITY) {
        throw new Error("The receiving-bin inventory no longer matches the reviewed 60 Alcona pallets.");
    }
    const item = await db.query(
        `select sku,tracking_level,item_type,blocked from item_catalog
         where account_name=$1 and sku=$2`,
        [ACCOUNT, SKU]
    );
    if (item.rowCount !== 1 || item.rows[0].tracking_level !== "PALLET"
        || item.rows[0].item_type !== "INVENTORY" || item.rows[0].blocked) {
        throw new Error("Alcona pallet item setup mismatch.");
    }
    const allocations = await db.query(
        `select coalesce(sum(a.allocated_quantity),0)::integer reserved
         from portal_order_allocations a join portal_orders o on o.id=a.order_id
         where o.account_name=$1 and o.fulfillment_location_id=$2 and a.sku=$3
           and o.status in ('RELEASED','PICKING','PICKED','STAGED')`,
        [ACCOUNT, WAREHOUSE_ID, SKU]
    );
    const physical = await db.query(
        `select coalesce(sum(i.quantity),0)::integer on_hand
         from inventory_lines i join bin_locations b on b.code=i.location
         where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=$3`,
        [ACCOUNT, SKU, WAREHOUSE_ID]
    );
    const activity = await db.query(
        `select id from activity_log where title=$1 and details like $2 order by id desc limit 1`,
        ["Made 60 Alcona pallets pickable", `%${CHANGE_KEY}%`]
    );
    const portal = await getPortalInventorySummary(ACCOUNT, db, { fulfillmentLocationId: WAREHOUSE_ID });
    return {
        bin: bin.rows[0],
        inventory: positive[0],
        onHand: Number(physical.rows[0].on_hand),
        reserved: Number(allocations.rows[0].reserved),
        priorChange: activity.rowCount > 0,
        portalItem: portal.find((row) => row.sku === SKU) || null
    };
}

async function main() {
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin");
        await db.query("set transaction read only");
        const before = await inspect(db);
        await db.query("rollback");
        console.log(JSON.stringify({
            phase: "preflight", account: ACCOUNT, sku: SKU, warehouse: WAREHOUSE_CODE,
            location: LOCATION, quantity: Number(before.inventory.quantity),
            locationType: before.bin.location_type, pickable: before.bin.is_pickable,
            onHand: before.onHand, reserved: before.reserved,
            portalAvailable: Number(before.portalItem?.availableQuantity || 0),
            priorChange: before.priorChange
        }));
        if (!APPLY) return;

        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [CHANGE_KEY]);
        const current = await inspect(db, true);
        if (!current.priorChange) {
            await db.query(
                `update bin_locations
                 set location_type='STORAGE',is_pickable=true,
                     note=$2,updated_at=now()
                 where code=$1`,
                [LOCATION, "Alcona storage inventory approved for allocation by owner on 2026-10-27; detailed physical bin assignment remains a warehouse putaway task."]
            );
            await db.query(
                `insert into activity_log(type,title,details) values('inventory',$1,$2)`,
                ["Made 60 Alcona pallets pickable",
                    `${CHANGE_KEY} | ${ACCOUNT} | ${SKU} | ${WAREHOUSE_CODE} | ${LOCATION} | 60 pallets`]
            );
        }
        await db.query("commit");

        await db.query("begin read only");
        const after = await inspect(db);
        await db.query("rollback");
        const available = after.onHand - after.reserved;
        if (after.bin.location_type !== "STORAGE" || !after.bin.is_pickable
            || after.onHand !== 80 || after.reserved !== 12 || available !== 68
            || !after.portalItem || Number(after.portalItem.onHandQuantity) !== 75
            || Number(after.portalItem.reservedQuantity) !== 12
            || Number(after.portalItem.availableQuantity) !== 63) {
            throw new Error("Post-change portal availability verification failed.");
        }
        console.log(JSON.stringify({
            phase: "verified", account: ACCOUNT, sku: SKU, warehouse: WAREHOUSE_CODE,
            physicalOnHand: after.onHand, damaged: 5,
            customerUsableOnHand: Number(after.portalItem.onHandQuantity),
            reserved: after.reserved, available: Number(after.portalItem.availableQuantity),
            sourceLocation: LOCATION, locationType: after.bin.location_type,
            pickable: after.bin.is_pickable, damagedPalletsUnchanged: 5
        }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
