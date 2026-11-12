const { Client } = require("pg");
const { getPortalInventorySummary } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "ALCONA TRADING LTD";
const ACCOUNT_ID = "2920";
const SKU = "MS26053103";
const WAREHOUSE_ID = 143;
const WAREHOUSE_CODE = "WHS01";
const LOCATION = "WHS01-ALCONA-REC";
const CHANGE_KEY = "ALCONA-MS26053103-WHS01-ALCONA-REC-PICKABLE-20261027";

async function inspect(db, lock = false) {
    const account = await db.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]);
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
        throw new Error("Alcona account identity mismatch.");
    }
    const warehouse = await db.query(
        `select fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage,cfl.customer_portal_visible
         from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and fl.id=$2 and fl.code=$3`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    const wh = warehouse.rows[0];
    if (warehouse.rowCount !== 1 || !wh.is_active || !wh.allow_outbound
        || !wh.allow_storage || !wh.customer_portal_visible) throw new Error("Alcona warehouse scope mismatch.");
    const bin = await db.query(`select * from bin_locations where code=$1 ${lock ? "for update" : ""}`, [LOCATION]);
    if (bin.rowCount !== 1 || bin.rows[0].account_name !== ACCOUNT
        || Number(bin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID) throw new Error("Alcona receiving bin scope mismatch.");
    const inventory = await db.query(`select * from inventory_lines where location=$1 ${lock ? "for update" : ""}`, [LOCATION]);
    const positive = inventory.rows.filter((row) => Number(row.quantity) > 0);
    if (positive.length !== 1 || positive[0].account_name !== ACCOUNT
        || positive[0].sku !== SKU || Number(positive[0].quantity) !== 1) {
        throw new Error("The remaining receiving stock no longer matches one Alcona pallet.");
    }
    const activity = await db.query(
        "select id from activity_log where title=$1 and details like $2 order by id desc limit 1",
        ["Made remaining Alcona pallet pickable", `%${CHANGE_KEY}%`]
    );
    const portal = await getPortalInventorySummary(ACCOUNT, db, { fulfillmentLocationId: WAREHOUSE_ID });
    return { bin: bin.rows[0], inventory: positive[0], priorChange: activity.rowCount > 0,
        portalItem: portal.find((row) => row.sku === SKU) || null };
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
        console.log(JSON.stringify({ phase: "preflight", account: ACCOUNT, sku: SKU,
            location: LOCATION, quantity: Number(before.inventory.quantity),
            locationType: before.bin.location_type, pickable: before.bin.is_pickable,
            portalAvailable: Number(before.portalItem?.availableQuantity || 0), priorChange: before.priorChange }));
        if (!APPLY) return;

        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [CHANGE_KEY]);
        const current = await inspect(db, true);
        if (!current.priorChange) {
            await db.query(
                `update bin_locations set location_type='STORAGE',is_pickable=true,
                     note=$2,updated_at=now() where code=$1`,
                [LOCATION, "Alcona storage inventory approved for allocation by owner on 2026-10-27; detailed physical bin assignment remains a warehouse putaway task."]
            );
            await db.query(
                "insert into activity_log(type,title,details) values('inventory',$1,$2)",
                ["Made remaining Alcona pallet pickable",
                    `${CHANGE_KEY} | ${ACCOUNT} | ${SKU} | ${WAREHOUSE_CODE} | ${LOCATION} | 1 pallet`]
            );
        }
        await db.query("commit");

        await db.query("begin read only");
        const after = await inspect(db);
        await db.query("rollback");
        if (after.bin.location_type !== "STORAGE" || !after.bin.is_pickable
            || !after.portalItem || Number(after.portalItem.onHandQuantity) !== 4
            || Number(after.portalItem.reservedQuantity) !== 0
            || Number(after.portalItem.availableQuantity) !== 4) {
            throw new Error("Post-change portal verification failed.");
        }
        console.log(JSON.stringify({ phase: "verified", account: ACCOUNT, sku: SKU,
            warehouse: WAREHOUSE_CODE, onHand: 4, reserved: 0, available: 4,
            sourceLocation: LOCATION, pickable: true }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
