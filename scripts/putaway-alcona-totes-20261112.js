"use strict";

const { Client } = require("pg");
const {
    createInventoryMovementRecord,
    getPortalInventorySummary,
    safeTransferInventoryQuantity
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "ALCONA TRADING LTD";
const ACCOUNT_ID = "2920";
const WAREHOUSE_ID = 143;
const WAREHOUSE_CODE = "WHS01";
const SKU = "MS26062403";
const SOURCE = "WHS01-REC";
const DESTINATION = "WHS01-ALCONA-BULK";
const SOURCE_QUANTITY = 43;
const RESERVED_QUANTITY = 8;
const MOVE_QUANTITY = SOURCE_QUANTITY - RESERVED_QUANTITY;
const MOVEMENT_KEY = "ALCONA-MS26062403-WHS01-REC-TO-ALCONA-BULK-20261112";

function assertProductionTarget() {
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("WMS365 production target mismatch.");
    }
}

async function inspect(db, { lock = false } = {}) {
    const account = await db.query(
        "select id,is_active from owner_accounts where name=$1",
        [ACCOUNT]
    );
    if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
        throw new Error("Alcona account identity mismatch.");
    }
    const warehouse = await db.query(
        `select fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage
         from fulfillment_locations fl
         join company_fulfillment_locations cfl
           on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
         where fl.id=$2`,
        [ACCOUNT, WAREHOUSE_ID]
    );
    if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE
        || !warehouse.rows[0].is_active || !warehouse.rows[0].allow_outbound
        || !warehouse.rows[0].allow_storage) {
        throw new Error("Alcona warehouse assignment mismatch.");
    }
    const source = await db.query(
        `select * from inventory_lines
         where account_name=$1 and sku=$2 and location=$3
         ${lock ? "for update" : ""}`,
        [ACCOUNT, SKU, SOURCE]
    );
    const destination = await db.query(
        `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
         where account_name=$1 and sku=$2 and location=$3`,
        [ACCOUNT, SKU, DESTINATION]
    );
    const activeAllocations = await db.query(
        `select coalesce(sum(a.allocated_quantity),0)::integer quantity
         from portal_order_allocations a
         join portal_orders o on o.id=a.order_id
         where a.inventory_line_id=$1 and o.account_name=$2
           and o.fulfillment_location_id=$3
           and o.status in ('RELEASED','PICKING','PICKED','STAGED')`,
        [source.rows[0]?.id || null, ACCOUNT, WAREHOUSE_ID]
    );
    const movement = await db.query(
        "select id,quantity,from_location,to_location from inventory_movements where movement_key=$1",
        [MOVEMENT_KEY]
    );
    return {
        source: source.rows[0] || null,
        destinationQuantity: Number(destination.rows[0].quantity),
        reservedQuantity: Number(activeAllocations.rows[0].quantity),
        movement: movement.rows[0] || null
    };
}

async function main() {
    assertProductionTarget();
    const db = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await db.connect();
    try {
        await db.query("begin read only");
        const before = await inspect(db);
        await db.query("rollback");

        if (before.movement) {
            if (before.source && Number(before.source.quantity) !== RESERVED_QUANTITY) {
                throw new Error("Prior transfer exists but the receiving balance is not the reserved quantity.");
            }
            console.log(JSON.stringify({
                phase: "already_applied",
                sourceQuantity: Number(before.source?.quantity || 0),
                destinationQuantity: before.destinationQuantity,
                reservedQuantity: before.reservedQuantity
            }));
            return;
        }
        if (!before.source || Number(before.source.quantity) !== SOURCE_QUANTITY
            || before.reservedQuantity !== RESERVED_QUANTITY
            || before.destinationQuantity !== 0) {
            throw new Error("Alcona inventory or allocations changed; transfer stopped for review.");
        }
        console.log(JSON.stringify({
            phase: "preflight",
            sourceQuantity: SOURCE_QUANTITY,
            reservedQuantity: RESERVED_QUANTITY,
            moveQuantity: MOVE_QUANTITY,
            destination: DESTINATION
        }));
        if (!APPLY) return;

        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [MOVEMENT_KEY]);
        const current = await inspect(db, { lock: true });
        if (current.movement || !current.source || Number(current.source.quantity) !== SOURCE_QUANTITY
            || current.reservedQuantity !== RESERVED_QUANTITY || current.destinationQuantity !== 0) {
            throw new Error("Alcona inventory changed after preflight; transfer stopped.");
        }
        await db.query(
            `insert into bin_locations
                (code,note,account_name,fulfillment_location_id,location_type,is_pickable)
             values ($1,$2,$3,$4,'STORAGE',true)
             on conflict (code) do update set
                note=excluded.note,
                updated_at=now()
             where bin_locations.account_name=excluded.account_name
               and bin_locations.fulfillment_location_id=excluded.fulfillment_location_id
               and bin_locations.location_type='STORAGE'
               and bin_locations.is_pickable=true
             returning code`,
            [DESTINATION, "Dedicated pickable Alcona tote storage.", ACCOUNT, WAREHOUSE_ID]
        ).then((result) => {
            if (result.rowCount !== 1) throw new Error("Dedicated Alcona storage location conflicts with another scope.");
        });
        await safeTransferInventoryQuantity(db, current.source, {
            accountName: ACCOUNT,
            location: DESTINATION,
            sku: SKU,
            trackingLevel: current.source.tracking_level || "PALLET"
        }, MOVE_QUANTITY, {
            actionLabel: "put away unreserved Alcona totes",
            transactionType: "PUT_AWAY",
            sourceType: "ALCONA_RECEIVING_CORRECTION",
            sourceId: current.source.id,
            fulfillmentLocationId: WAREHOUSE_ID
        });
        await createInventoryMovementRecord(db, {
            movementKey: MOVEMENT_KEY,
            accountName: ACCOUNT,
            fulfillmentLocationId: WAREHOUSE_ID,
            movementType: "TRANSFER",
            fromLocation: SOURCE,
            toLocation: DESTINATION,
            line: current.source,
            quantity: MOVE_QUANTITY,
            reason: "Moved completed-putaway, unreserved Alcona totes out of the shared receiving-stage bin."
        });
        await db.query(
            "insert into activity_log(type,title,details) values('inventory',$1,$2)",
            ["Put away Alcona tote stock", `${MOVEMENT_KEY} | ${MOVE_QUANTITY} totes | ${RESERVED_QUANTITY} reserved totes preserved at ${SOURCE}`]
        );
        await db.query("commit");

        await db.query("begin read only");
        const after = await inspect(db);
        const portal = await getPortalInventorySummary(ACCOUNT, db, { fulfillmentLocationId: WAREHOUSE_ID });
        const item = portal.find((row) => row.sku === SKU);
        const destinationBin = await db.query(
            "select account_name,fulfillment_location_id,location_type,is_pickable from bin_locations where code=$1",
            [DESTINATION]
        );
        await db.query("rollback");
        if (!after.source || Number(after.source.quantity) !== RESERVED_QUANTITY
            || after.destinationQuantity !== MOVE_QUANTITY || after.reservedQuantity !== RESERVED_QUANTITY
            || destinationBin.rowCount !== 1 || destinationBin.rows[0].account_name !== ACCOUNT
            || Number(destinationBin.rows[0].fulfillment_location_id) !== WAREHOUSE_ID
            || destinationBin.rows[0].location_type !== "STORAGE" || !destinationBin.rows[0].is_pickable
            || !item || Number(item.onHandQuantity) !== 44
            || Number(item.reservedQuantity) !== 8 || Number(item.availableQuantity) !== 36) {
            throw new Error("Post-transfer Alcona availability verification failed.");
        }
        console.log(JSON.stringify({
            phase: "verified",
            sourceReserved: RESERVED_QUANTITY,
            dedicatedStorage: MOVE_QUANTITY,
            onHand: 44,
            reserved: 8,
            available: 36
        }));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
