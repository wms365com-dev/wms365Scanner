const { Client } = require("pg");
const {
    ensureReceivingDestinationLocation,
    safeTransferInventoryQuantity,
    createInventoryMovementRecord,
    updateAdminPortalInboundStatus
} = require("../server");

const ACCOUNT = "EVEROLL INDUSTRIES LTD";
const INBOUND = "INB-000195";
const RECEIVING = "WHS01-EVEROLL-REC";
const BULK = "WHS01-EVEROLL-BULK";
const SKIDS = ["ESP72-47-WHT", "ESP72-47-WHT", "ESP72-36-WHT", "ESP72-47-BLK", "ESP72-36-BLK", "ESP72-36-BLK"];

async function main() {
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("Production WMS365 identity mismatch.");
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    await client.query("begin");
    try {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [INBOUND + "-PUTAWAY"]);
        const inbound = await client.query(
            "select id, account_name, fulfillment_location_id, status from portal_inbounds where inbound_code=$1 for update",
            [INBOUND]
        );
        if (inbound.rowCount !== 1 || inbound.rows[0].account_name !== ACCOUNT
            || Number(inbound.rows[0].fulfillment_location_id) !== 143
            || inbound.rows[0].status !== "RECEIVED_PENDING_PUTAWAY") {
            throw new Error("Everoll inbound identity or putaway status mismatch.");
        }
        const warehouse = await client.query(
            `select fl.code, fl.name, fl.is_active, cfl.allow_storage, cfl.allow_outbound
             from fulfillment_locations fl join company_fulfillment_locations cfl
               on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1 where fl.id=143`, [ACCOUNT]
        );
        if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== "WHS01"
            || warehouse.rows[0].name !== "Grey Wolf Edwards Warehouse" || !warehouse.rows[0].is_active
            || !warehouse.rows[0].allow_storage || !warehouse.rows[0].allow_outbound) {
            throw new Error("Everoll Edwards warehouse assignment mismatch.");
        }
        const allocations = await client.query(
            `select a.pallet_reference, l.sku, a.quantity, a.pallet_size_type, a.pallet_weight, a.pallet_weight_uom
             from portal_inbound_receipt_allocations a join portal_inbound_lines l on l.id=a.line_id
             where a.inbound_id=$1 order by a.pallet_reference`,
            [inbound.rows[0].id]
        );
        if (allocations.rowCount !== 6) throw new Error("Expected six received skid allocations.");
        for (let i = 0; i < 6; i++) {
            const a = allocations.rows[i];
            if (a.pallet_reference !== `EVEROLL-IWF-KTS-20260918-6SKIDS-S${i + 1}`
                || a.sku !== SKIDS[i] || Number(a.quantity) !== 100
                || a.pallet_size_type !== "NON_STANDARD" || Number(a.pallet_weight) !== 2000
                || a.pallet_weight_uom !== "LB") throw new Error(`Skid ${i + 1} receipt mismatch.`);
        }
        const occupants = await client.query(
            "select count(*)::integer as n from inventory_lines where location=$1 and quantity>0", [BULK]
        );
        if (occupants.rows[0].n !== 0) throw new Error("Proposed Everoll bulk bin is already occupied.");
        const moves = await client.query(
            "select count(*)::integer as n from inventory_movements where movement_key like 'INB-000195-PUTAWAY-%'"
        );
        if (moves.rows[0].n !== 0) throw new Error("Putaway movements already exist; investigate before retrying.");
        const source = await client.query(
            `select sku, sum(quantity)::integer as quantity from inventory_lines
             where account_name=$1 and location=$2 group by sku`, [ACCOUNT, RECEIVING]
        );
        const expected = { "ESP72-47-WHT": 200, "ESP72-36-WHT": 100, "ESP72-47-BLK": 100, "ESP72-36-BLK": 200 };
        if (source.rowCount !== 4 || source.rows.some((r) => expected[r.sku] !== r.quantity)) {
            throw new Error("Everoll receiving inventory no longer matches six skids.");
        }
        await ensureReceivingDestinationLocation(client, BULK);
        const bin = await client.query("select location_type, is_pickable from bin_locations where code=$1", [BULK]);
        if (bin.rowCount !== 1 || bin.rows[0].location_type !== "STORAGE" || !bin.rows[0].is_pickable) {
            throw new Error("Bulk location is not pickable storage.");
        }
        for (let i = 0; i < 6; i++) {
            const sku = SKIDS[i];
            const line = await client.query(
                `select * from inventory_lines where account_name=$1 and location=$2 and sku=$3 and quantity>0 for update`,
                [ACCOUNT, RECEIVING, sku]
            );
            if (line.rowCount !== 1 || Number(line.rows[0].quantity) < 100) {
                throw new Error(`Insufficient uncommitted stock for skid ${i + 1}.`);
            }
            await safeTransferInventoryQuantity(client, line.rows[0], {
                accountName: ACCOUNT, location: BULK, sku, trackingLevel: "UNIT"
            }, 100, {
                actionLabel: "put away Everoll skid", transactionType: "PUT_AWAY",
                sourceType: "PORTAL_INBOUND_PUTAWAY", sourceId: allocations.rows[i].pallet_reference,
                fulfillmentLocationId: 143
            });
            await createInventoryMovementRecord(client, {
                movementKey: `INB-000195-PUTAWAY-S${i + 1}`, accountName: ACCOUNT,
                fulfillmentLocationId: 143, movementType: "TRANSFER", fromLocation: RECEIVING,
                toLocation: BULK, line: line.rows[0], quantity: 100,
                reason: `${INBOUND} skid ${i + 1}: 44 x 48 x 73 in; 2000 lb`
            });
        }
        const totals = await client.query(
            `select location, sku, sum(quantity)::integer as quantity from inventory_lines
             where account_name=$1 and location=any($2) group by location, sku`, [ACCOUNT, [RECEIVING, BULK]]
        );
        if (totals.rows.some((r) => r.location === RECEIVING && r.quantity !== 0)
            || totals.rows.filter((r) => r.location === BULK).length !== 4
            || totals.rows.some((r) => r.location === BULK && expected[r.sku] !== r.quantity)) {
            throw new Error("Post-transfer stock totals do not match the receipt.");
        }
        const completed = await updateAdminPortalInboundStatus(client, inbound.rows[0].id, "PUTAWAY_COMPLETE");
        if (completed.status !== "PUTAWAY_COMPLETE") throw new Error("Inbound did not complete putaway.");
        await client.query("commit");
        console.log(JSON.stringify({ inbound: INBOUND, status: completed.status, warehouse: "WHS01",
            pickableLocation: BULK, skids: 6, pieces: 600, inventoryBySku: expected }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
