const { Client } = require("pg");
const {
    APP_USER_ROLES,
    createInventoryMovementRecord,
    safeTransferInventoryQuantity,
    updateAdminPortalInboundStatus,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "INB-000212";
const ACCOUNT = "PURE FOODS BY ESTEE";
const ACCOUNT_ID = "1";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const RECEIVING = "GW3PL-MISS-RECEIVING-STAGE";
const DESTINATION = "GW3PL-MISS-PUREFOODS-BULK";
const RECEIPTS = {
    "140": [97, 159],
    "150": [16, 50],
};
const EXPECTED = { "140": 1000, "150": 66 };
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
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-PARTIAL-CLOSE`]);
        const account = await db.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]);
        if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
            throw new Error("Pure Foods account identity mismatch.");
        }
        const membership = await db.query(
            `select fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage
             from fulfillment_locations fl join company_fulfillment_locations cfl
               on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1 where fl.id=$2`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        const wh = membership.rows[0];
        if (membership.rowCount !== 1 || wh.code !== WAREHOUSE_CODE || !wh.is_active
            || !wh.allow_inbound || !wh.allow_outbound || !wh.allow_storage) throw new Error("Warehouse scope mismatch.");
        const inboundResult = await db.query(
            `select id,status,account_name,reference_number,fulfillment_location_id,received_at
             from portal_inbounds where inbound_code=$1 for update`, [CODE]
        );
        if (inboundResult.rowCount !== 1) throw new Error(`${CODE} was not found uniquely.`);
        const inbound = inboundResult.rows[0];
        if (inbound.account_name !== ACCOUNT || inbound.reference_number !== "6504647"
            || Number(inbound.fulfillment_location_id) !== WAREHOUSE_ID) throw new Error("Inbound identity changed.");
        if (inbound.status === "PUTAWAY_COMPLETE") {
            await db.query("rollback");
            return console.log(JSON.stringify({ outcome: "already_closed", applied: false, inbound: CODE }));
        }
        if (inbound.status !== "ARRIVED" || inbound.received_at) throw new Error("Inbound is not in the expected arrived state.");
        const lines = await db.query(
            `select l.id,l.line_number,l.sku,l.expected_quantity,l.received_quantity,c.description,c.upc,
                    c.tracking_level,c.units_per_case,c.item_type,c.blocked,c.lot_tracked,c.expiration_tracked
             from portal_inbound_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
             where l.inbound_id=$1 order by l.line_number for update of l`, [inbound.id, ACCOUNT]
        );
        if (lines.rowCount !== 2) throw new Error("Inbound line count changed.");
        for (const line of lines.rows) {
            if (!RECEIPTS[line.sku] || Number(line.expected_quantity) !== EXPECTED[line.sku]
                || line.received_quantity != null || line.item_type !== "INVENTORY" || line.blocked
                || line.lot_tracked || line.expiration_tracked) throw new Error(`Inbound line ${line.sku} changed.`);
        }
        const sku140 = lines.rows.find((line) => line.sku === "140");
        const sku150 = lines.rows.find((line) => line.sku === "150");
        if (!sku140 || sku140.tracking_level !== "CASE" || Number(sku140.units_per_case) !== 12) throw new Error("SKU 140 case setup mismatch.");
        if (!sku150 || sku150.description !== "150 - Hanukkah - 12 Pack Case (12X5 OZ)") throw new Error("SKU 150 identity mismatch.");
        const sku150Use = await db.query(
            `select
               (select count(*) from inventory_lines where account_name=$1 and sku='150' and quantity<>0)::integer inventory_rows,
               (select count(*) from portal_order_allocations a join portal_orders o on o.id=a.order_id
                 where o.account_name=$1 and a.sku='150' and o.status in ('RELEASED','PICKING','PICKED','STAGED'))::integer allocations`,
            [ACCOUNT]
        );
        if (Number(sku150Use.rows[0].inventory_rows) !== 0 || Number(sku150Use.rows[0].allocations) !== 0) {
            throw new Error("SKU 150 has live inventory or allocations; its tracking setup cannot be corrected safely.");
        }
        await db.query(
            `update item_catalog set tracking_level='CASE',uom_label='Cases',unit_uom='EA',units_per_case=12,updated_at=now()
             where account_name=$1 and sku='150'`, [ACCOUNT]
        );
        const docs = await db.query(
            `select count(*)::integer count from portal_inbound_documents
             where inbound_id=$1 and document_category='SHIPMENT_PACKING_SLIP'`, [inbound.id]
        );
        const prior = await db.query(
            `select count(*)::integer count from inventory_transactions
             where source_type='PORTAL_INBOUND' and source_id=$1::text`, [String(inbound.id)]
        );
        if (Number(docs.rows[0].count) !== 1 || Number(prior.rows[0].count) !== 0) throw new Error("Inbound documents or ledger require review.");
        const bins = await db.query(
            `select code,account_name,fulfillment_location_id,location_type,is_pickable
             from bin_locations where code=any($1::text[]) order by code for update`, [[RECEIVING, DESTINATION]]
        );
        const receiving = bins.rows.find((row) => row.code === RECEIVING);
        const destination = bins.rows.find((row) => row.code === DESTINATION);
        if (!receiving || receiving.account_name !== ACCOUNT || Number(receiving.fulfillment_location_id) !== WAREHOUSE_ID
            || receiving.location_type !== "RECEIVING_STAGE" || receiving.is_pickable) throw new Error("Receiving stage mismatch.");
        if (!destination || destination.account_name !== ACCOUNT || Number(destination.fulfillment_location_id) !== WAREHOUSE_ID
            || destination.location_type !== "STORAGE" || !destination.is_pickable) throw new Error("Pickable destination mismatch.");
        const before = {};
        for (const line of lines.rows) {
            const quantity = await db.query(
                `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                 where account_name=$1 and location=$2 and sku=$3`, [ACCOUNT, DESTINATION, line.sku]
            );
            before[line.sku] = Number(quantity.rows[0].quantity);
        }
        const receivingLines = [];
        for (const line of lines.rows) {
            for (const quantity of RECEIPTS[line.sku]) {
                receivingLines.push({ id: line.id, sku: line.sku, receivedQuantity: quantity, receivedLocation: RECEIVING });
            }
        }
        let state = await updateAdminPortalInboundStatus(db, inbound.id, "RECEIVED", ACTOR, {
            receivingLocation: RECEIVING,
            receivingLines,
            note: "Partial final receipt per owner instruction. Remaining SKU 140 balance will require a new inbound.",
        });
        if (state.status !== "RECEIVED_PENDING_PUTAWAY") throw new Error(`Receipt reached ${state.status}.`);
        for (const line of lines.rows) {
            const received = RECEIPTS[line.sku].reduce((sum, quantity) => sum + quantity, 0);
            const source = await db.query(
                `select * from inventory_lines where account_name=$1 and sku=$2 and location=$3 and quantity>0
                 order by id for update`, [ACCOUNT, line.sku, RECEIVING]
            );
            if (source.rows.reduce((sum, row) => sum + Number(row.quantity), 0) !== received) {
                throw new Error(`Receiving-stage quantity mismatch for ${line.sku}.`);
            }
            let remaining = received;
            for (const sourceLine of source.rows) {
                const quantity = Math.min(Number(sourceLine.quantity), remaining);
                await safeTransferInventoryQuantity(db, sourceLine, {
                    accountName: ACCOUNT, location: DESTINATION, sku: line.sku, upc: sourceLine.upc || line.upc || "",
                    lotNumber: sourceLine.lot_number || "", expirationDate: sourceLine.expiration_date || "", trackingLevel: "CASE",
                }, quantity, {
                    actionLabel: `put away ${CODE} ${line.sku}`,
                    transactionType: "PUT_AWAY", sourceType: "PORTAL_INBOUND_PUTAWAY", sourceId: inbound.id,
                    fulfillmentLocationId: WAREHOUSE_ID, appUser: ACTOR, source: "web_admin",
                });
                remaining -= quantity;
            }
            if (remaining !== 0) throw new Error(`Not all ${line.sku} cases were put away.`);
            await createInventoryMovementRecord(db, {
                movementKey: `${CODE}-FINAL-PUTAWAY-${line.sku}`, accountName: ACCOUNT,
                fulfillmentLocationId: WAREHOUSE_ID, movementType: "TRANSFER", fromLocation: RECEIVING,
                toLocation: DESTINATION, line: source.rows[0], quantity: received,
                reason: `${CODE} final partial receipt putaway: ${received} cases of ${line.sku}`,
            });
        }
        state = await updateAdminPortalInboundStatus(db, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
            note: "Inbound closed after final partial receipt. Unreceived balance will not be received against this inbound and requires a new inbound.",
        });
        await db.query(
            `update portal_inbounds set notes=concat_ws(' | ',nullif(notes,''),$2::text),updated_at=now() where id=$1`,
            [inbound.id, "CLOSED FINAL PARTIAL: SKU 140 received 256 of 1000; remaining 744 will require a new inbound. SKU 150 received 66 of 66."]
        );
        const [savedLines, savedAllocations, savedLedger] = await Promise.all([
            db.query("select sku,expected_quantity,received_quantity,received_location from portal_inbound_lines where inbound_id=$1 order by line_number", [inbound.id]),
            db.query(
                `select line_id,quantity,location,allocation_number from portal_inbound_receipt_allocations
                 where inbound_id=$1 order by line_id,allocation_number`, [inbound.id]),
            db.query(
                `select sku,sum(quantity_delta)::integer quantity,count(*)::integer entries
                 from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text
                 group by sku order by sku`, [String(inbound.id)]),
        ]);
        const results = [];
        for (const line of savedLines.rows) {
            const received = RECEIPTS[line.sku].reduce((sum, quantity) => sum + quantity, 0);
            const stage = await db.query(
                `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                 where account_name=$1 and location=$2 and sku=$3`, [ACCOUNT, RECEIVING, line.sku]
            );
            const bulk = await db.query(
                `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
                 where account_name=$1 and location=$2 and sku=$3`, [ACCOUNT, DESTINATION, line.sku]
            );
            const allocations = savedAllocations.rows.filter((row) => String(row.line_id) === String(lines.rows.find((item) => item.sku === line.sku).id));
            const ledger = savedLedger.rows.find((row) => row.sku === line.sku);
            if (Number(line.received_quantity) !== received || line.received_location !== RECEIVING
                || allocations.length !== 2 || allocations.reduce((sum, row) => sum + Number(row.quantity), 0) !== received
                || Number(stage.rows[0].quantity) !== 0 || Number(bulk.rows[0].quantity) - before[line.sku] !== received
                || Number(ledger?.quantity) !== received) throw new Error(`Post-receipt verification failed for ${line.sku}.`);
            results.push({ sku: line.sku, expected: Number(line.expected_quantity), received,
                varianceClosed: Number(line.expected_quantity) - received, pickableTotal: Number(bulk.rows[0].quantity) });
        }
        const saved150 = await db.query(
            `select tracking_level,units_per_case from item_catalog where account_name=$1 and sku='150'`, [ACCOUNT]
        );
        if (state.status !== "PUTAWAY_COMPLETE" || savedAllocations.rowCount !== 4
            || saved150.rows[0].tracking_level !== "CASE" || Number(saved150.rows[0].units_per_case) !== 12) {
            throw new Error("Inbound closure verification failed.");
        }
        const output = { outcome: APPLY ? "received_and_closed" : "dry_run_rolled_back", applied: APPLY,
            inbound: CODE, account: ACCOUNT, warehouse: WAREHOUSE_CODE, status: state.status,
            receivingLocation: RECEIVING, pickableLocation: DESTINATION, receiptAllocations: RECEIPTS, lines: results,
            sku150TrackingCorrected: true };
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
