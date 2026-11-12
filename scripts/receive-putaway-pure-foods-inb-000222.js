const { Client } = require("pg");
const {
    APP_USER_ROLES,
    createInventoryMovementRecord,
    safeTransferInventoryQuantity,
    updateAdminPortalInboundStatus,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "INB-000222";
const ACCOUNT = "PURE FOODS BY ESTEE";
const ACCOUNT_ID = "1";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const RECEIVING = "GW3PL-MISS-RECEIVING-STAGE";
const DESTINATION = "GW3PL-MISS-PUREFOODS-BULK";
const EXPECTED = new Map([["142", 100], ["144", 271], ["145", 300], ["146", 513]]);
const ACTOR = {
    id: null,
    email: "operations@wms365.co",
    full_name: "WMS365 Owner-Approved Inbound",
    role: APP_USER_ROLES.SUPER_ADMIN,
};

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    let committed = false;
    try {
        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-RECEIVE-PUTAWAY`]);
        const account = await db.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]);
        if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
            throw new Error("Pure Foods account identity mismatch.");
        }
        const warehouse = await db.query(
            `select fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
             from fulfillment_locations fl join company_fulfillment_locations cfl
             on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1 where fl.id=$2`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        const wh = warehouse.rows[0];
        if (warehouse.rowCount !== 1 || wh.code !== WAREHOUSE_CODE || !wh.is_active
            || !wh.allow_inbound || !wh.allow_outbound || !wh.allow_storage) {
            throw new Error("Pure Foods warehouse assignment mismatch.");
        }
        const inboundResult = await db.query(
            `select id,status,account_name,reference_number,fulfillment_location_id,received_at
             from portal_inbounds where inbound_code=$1 for update`,
            [CODE]
        );
        if (inboundResult.rowCount !== 1) throw new Error(`${CODE} was not found uniquely.`);
        const inbound = inboundResult.rows[0];
        if (inbound.account_name !== ACCOUNT || inbound.reference_number !== "54646766"
            || Number(inbound.fulfillment_location_id) !== WAREHOUSE_ID) throw new Error("Inbound scope changed.");
        if (inbound.status === "PUTAWAY_COMPLETE") {
            await db.query("rollback");
            return console.log(JSON.stringify({ outcome: "already_received", applied: false, inbound: CODE }));
        }
        if (inbound.status !== "ARRIVED" || inbound.received_at) throw new Error("Inbound is not in the expected arrived state.");
        const lines = await db.query(
            `select l.id,l.sku,l.expected_quantity,l.received_quantity,c.description,c.upc,c.tracking_level,
                    c.units_per_case,c.item_type,c.blocked,c.lot_tracked,c.expiration_tracked
             from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
             where l.inbound_id=$1 order by l.line_number for update of l`,
            [inbound.id, ACCOUNT]
        );
        if (lines.rowCount !== EXPECTED.size) throw new Error("Inbound line count changed.");
        for (const line of lines.rows) {
            if (!EXPECTED.has(line.sku) || Number(line.expected_quantity) !== EXPECTED.get(line.sku)
                || line.received_quantity != null || line.tracking_level !== "CASE"
                || Number(line.units_per_case) !== 12 || line.item_type !== "INVENTORY" || line.blocked
                || line.lot_tracked || line.expiration_tracked) throw new Error(`Inbound line ${line.sku} changed or is not receivable.`);
        }
        const docs = await db.query(
            `select count(*)::integer count from portal_inbound_documents
             where inbound_id=$1 and document_category='SHIPMENT_PACKING_SLIP'`,
            [inbound.id]
        );
        const prior = await db.query(
            `select count(*)::integer count from inventory_transactions
             where source_type='PORTAL_INBOUND' and source_id=$1::text`,
            [String(inbound.id)]
        );
        if (Number(docs.rows[0].count) !== 1 || Number(prior.rows[0].count) !== 0) {
            throw new Error("Inbound documents or prior receipt ledger require review.");
        }
        const bins = await db.query(
            `select code,account_name,fulfillment_location_id,location_type,is_pickable
             from bin_locations where code=any($1::text[]) order by code for update`,
            [[RECEIVING, DESTINATION]]
        );
        const receiving = bins.rows.find((row) => row.code === RECEIVING);
        const destination = bins.rows.find((row) => row.code === DESTINATION);
        if (!receiving || receiving.account_name !== ACCOUNT || Number(receiving.fulfillment_location_id) !== WAREHOUSE_ID
            || receiving.location_type !== "RECEIVING_STAGE" || receiving.is_pickable) throw new Error("Receiving stage mismatch.");
        if (!destination || destination.account_name !== ACCOUNT || Number(destination.fulfillment_location_id) !== WAREHOUSE_ID
            || destination.location_type !== "STORAGE" || !destination.is_pickable) throw new Error("Pickable bulk location mismatch.");
        const before = {};
        for (const line of lines.rows) {
            const result = await db.query(
                `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                 where account_name=$1 and location=$2 and sku=$3`,
                [ACCOUNT, DESTINATION, line.sku]
            );
            before[line.sku] = Number(result.rows[0].quantity);
        }
        let state = await updateAdminPortalInboundStatus(db, inbound.id, "RECEIVED", ACTOR, {
            receivingLocation: RECEIVING,
            receivingLines: lines.rows.map((line) => ({
                id: line.id,
                sku: line.sku,
                receivedQuantity: Number(line.expected_quantity),
                receivedLocation: RECEIVING,
            })),
            note: "Received in full per owner instruction and attached packing slip.",
        });
        if (state.status !== "RECEIVED_PENDING_PUTAWAY") throw new Error(`Receipt reached ${state.status}.`);
        for (const line of lines.rows) {
            const source = await db.query(
                `select * from inventory_lines where account_name=$1 and sku=$2 and location=$3 and quantity>0
                 order by id for update`,
                [ACCOUNT, line.sku, RECEIVING]
            );
            const expected = EXPECTED.get(line.sku);
            if (source.rows.reduce((sum, row) => sum + Number(row.quantity), 0) !== expected) {
                throw new Error(`Receiving-stage quantity mismatch for ${line.sku}.`);
            }
            let remaining = expected;
            for (const sourceLine of source.rows) {
                const quantity = Math.min(Number(sourceLine.quantity), remaining);
                await safeTransferInventoryQuantity(db, sourceLine, {
                    accountName: ACCOUNT,
                    location: DESTINATION,
                    sku: line.sku,
                    upc: sourceLine.upc || line.upc || "",
                    lotNumber: sourceLine.lot_number || "",
                    expirationDate: sourceLine.expiration_date || "",
                    trackingLevel: "CASE",
                }, quantity, {
                    actionLabel: `put away ${CODE} ${line.sku}`,
                    transactionType: "PUT_AWAY",
                    sourceType: "PORTAL_INBOUND_PUTAWAY",
                    sourceId: inbound.id,
                    fulfillmentLocationId: WAREHOUSE_ID,
                    appUser: ACTOR,
                    source: "web_admin",
                });
                remaining -= quantity;
            }
            if (remaining !== 0) throw new Error(`Not all ${line.sku} inventory was put away.`);
            await createInventoryMovementRecord(db, {
                movementKey: `${CODE}-PUTAWAY-${line.sku}`,
                accountName: ACCOUNT,
                fulfillmentLocationId: WAREHOUSE_ID,
                movementType: "TRANSFER",
                fromLocation: RECEIVING,
                toLocation: DESTINATION,
                line: source.rows[0],
                quantity: expected,
                reason: `${CODE} putaway: ${expected} cases of ${line.sku}`,
            });
        }
        state = await updateAdminPortalInboundStatus(db, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
            note: `All ${lines.rowCount} lines put away to ${DESTINATION}; inventory is pickable.`,
        });
        const finalLines = await db.query(
            `select sku,received_quantity,received_location from portal_inbound_lines where inbound_id=$1 order by line_number`,
            [inbound.id]
        );
        const results = [];
        for (const line of finalLines.rows) {
            const stage = await db.query(
                `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                 where account_name=$1 and location=$2 and sku=$3`,
                [ACCOUNT, RECEIVING, line.sku]
            );
            const bulk = await db.query(
                `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                 where account_name=$1 and location=$2 and sku=$3`,
                [ACCOUNT, DESTINATION, line.sku]
            );
            const expected = EXPECTED.get(line.sku);
            if (Number(line.received_quantity) !== expected || line.received_location !== RECEIVING
                || Number(stage.rows[0].quantity) !== 0 || Number(bulk.rows[0].quantity) - before[line.sku] !== expected) {
                throw new Error(`Post-receipt verification failed for ${line.sku}.`);
            }
            results.push({ sku: line.sku, receivedCases: expected, pickableTotal: Number(bulk.rows[0].quantity) });
        }
        if (state.status !== "PUTAWAY_COMPLETE") throw new Error("Inbound did not reach putaway complete.");
        const output = { outcome: APPLY ? "received_and_available" : "dry_run_rolled_back", applied: APPLY,
            inbound: CODE, account: ACCOUNT, warehouse: WAREHOUSE_CODE, status: state.status,
            receivingLocation: RECEIVING, pickableLocation: DESTINATION, lines: results };
        if (APPLY) {
            await db.query("commit");
            committed = true;
        } else {
            await db.query("rollback");
        }
        console.log(JSON.stringify(output));
    } catch (error) {
        if (!committed) await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
