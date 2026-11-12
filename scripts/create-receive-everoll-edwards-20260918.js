const { Client } = require("pg");
const {
    savePortalInboundForAccount,
    updateAdminPortalInboundStatus
} = require("../server");

const ACCOUNT = "EVEROLL INDUSTRIES LTD";
const WAREHOUSE_ID = 143;
const WAREHOUSE_CODE = "WHS01";
const REFERENCE = "EVEROLL-IWF-KTS-20260918-6SKIDS";
const LOCATION = `${WAREHOUSE_CODE}-EVEROLL-REC`;
const SKIDS = [
    "ESP72-47-WHT",
    "ESP72-47-WHT",
    "ESP72-36-WHT",
    "ESP72-47-BLK",
    "ESP72-36-BLK",
    "ESP72-36-BLK"
];

async function main({ apply = false } = {}) {
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("Production Railway identity does not match the pinned WMS365 application.");
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    await client.query("begin");
    try {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [REFERENCE]);
        const warehouse = await client.query(
            "select id, code, name, is_active from fulfillment_locations where id=$1",
            [WAREHOUSE_ID]
        );
        if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE
            || warehouse.rows[0].name !== "Grey Wolf Edwards Warehouse" || !warehouse.rows[0].is_active) {
            throw new Error("Edwards warehouse identity failed verification.");
        }
        const original = await client.query(
            `select fl.code, cfl.is_primary from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and cfl.fulfillment_location_id=1`,
            [ACCOUNT]
        );
        if (original.rowCount !== 1 || original.rows[0].code !== "GW3PL-MISS" || !original.rows[0].is_primary) {
            throw new Error("Everoll's original warehouse assignment changed; stopping.");
        }
        const prior = await client.query(
            `select id, inbound_code, status from portal_inbounds
             where account_name=$1 and reference_number=$2`,
            [ACCOUNT, REFERENCE]
        );
        if (prior.rowCount) {
            console.log(JSON.stringify({ outcome: "already_exists", inbound: prior.rows[0], applied: false }));
            await client.query("rollback");
            return;
        }
        const priorInventory = await client.query(
            `select sku, sum(quantity)::integer as quantity from inventory_lines
             where account_name=$1 and sku=any($2) group by sku`,
            [ACCOUNT, [...new Set(SKIDS)]]
        );
        if (priorInventory.rows.some((row) => Number(row.quantity) !== 0)) {
            throw new Error("Everoll already has stock for one of these SKUs; investigate before receiving again.");
        }
        const assignment = await client.query(
            `select * from company_fulfillment_locations
             where account_name=$1 and fulfillment_location_id=$2`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        if (assignment.rowCount && (!assignment.rows[0].allow_inbound || !assignment.rows[0].allow_outbound
            || !assignment.rows[0].allow_storage || !assignment.rows[0].customer_portal_visible)) {
            throw new Error("Existing Edwards assignment has restricted permissions; review it before modifying.");
        }
        if (!assignment.rowCount) {
            await client.query(
                `insert into company_fulfillment_locations
                 (account_name, fulfillment_location_id, is_primary, allow_inbound, allow_outbound,
                  allow_storage, allow_returns, customer_portal_visible, note)
                 values ($1,$2,false,true,true,true,true,true,$3)`,
                [ACCOUNT, WAREHOUSE_ID, "Everoll also uses Grey Wolf Edwards Warehouse. Owner-requested 2026-09-23."]
            );
        }
        for (const sku of [...new Set(SKIDS)]) {
            const item = await client.query(
                `select tracking_level, unit_uom, blocked from item_catalog where account_name=$1 and sku=$2`,
                [ACCOUNT, sku]
            );
            if (item.rowCount) {
                if (item.rows[0].tracking_level !== "UNIT" || item.rows[0].unit_uom !== "EA" || item.rows[0].blocked) {
                    throw new Error(`Existing item ${sku} conflicts with the supplied piece quantities.`);
                }
            } else {
                await client.query(
                    `insert into item_catalog
                     (account_name, sku, description, tracking_level, unit_uom, lot_tracked, expiration_tracked)
                     values ($1,$2,$2,'UNIT','EA',false,false)`,
                    [ACCOUNT, sku]
                );
            }
        }
        const notes = [
            "Physically received at Grey Wolf Edwards from IWF by KTS on 2026-09-18; posted to WMS later.",
            "Six non-standard skids, each 44 x 48 x 73 inches, 2,000 lb, 100 pieces.",
            SKIDS.map((sku, index) => `Skid ${index + 1}: ${sku} x 100 pieces`).join("; "),
            "Received into warehouse receiving stage; putaway location must be confirmed before stock is pickable."
        ].join(" ");
        const inbound = await savePortalInboundForAccount(client, ACCOUNT, {
            fulfillmentLocationId: WAREHOUSE_ID,
            referenceNumber: REFERENCE,
            carrierName: "KTS",
            expectedDate: "2026-09-18",
            contactName: "Everoll Industries",
            notes,
            lines: SKIDS.map((sku) => ({ sku, quantity: 100 }))
        }, {
            activityTitlePrefix: "warehouse",
            activityActor: "WMS365 owner-requested inbound",
            creatorEmail: ""
        });
        if (inbound.lines.length !== 6 || inbound.lines.reduce((sum, line) => sum + line.quantity, 0) !== 600) {
            throw new Error("Saved inbound did not preserve all six 100-piece skid lines.");
        }
        await client.query(
            "update portal_inbound_lines set pallet_count=1 where inbound_id=$1",
            [inbound.id]
        );
        const receivingLines = inbound.lines.map((line, index) => ({
            id: line.id,
            sku: line.sku,
            receivedQuantity: 100,
            receivedLocation: LOCATION,
            palletReference: `${REFERENCE}-S${index + 1}`,
            palletSizeType: "NON_STANDARD",
            palletWeight: 2000,
            palletWeightUom: "LB"
        }));
        const received = await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", null, {
            receivingLocation: LOCATION,
            receivingLines,
            note: "Physical receipt 2026-09-18; WMS posting date is later; putaway pending."
        });
        if (received.status !== "RECEIVED_PENDING_PUTAWAY") {
            throw new Error("Inbound did not reach RECEIVED_PENDING_PUTAWAY.");
        }
        const allocations = await client.query(
            `select count(*)::integer as skids, sum(quantity)::integer as pieces,
                    sum(pallet_weight)::numeric as weight_lb,
                    count(distinct pallet_reference)::integer as references
             from portal_inbound_receipt_allocations where inbound_id=$1`,
            [inbound.id]
        );
        const totals = allocations.rows[0];
        if (totals.skids !== 6 || totals.pieces !== 600 || Number(totals.weight_lb) !== 12000 || totals.references !== 6) {
            throw new Error("Received skid allocations did not match the supplied manifest.");
        }
        const inventory = await client.query(
            `select sku, sum(quantity)::integer as quantity from inventory_lines
             where account_name=$1 and location=$2 and sku=any($3) group by sku order by sku`,
            [ACCOUNT, LOCATION, [...new Set(SKIDS)]]
        );
        if (inventory.rows.reduce((sum, row) => sum + row.quantity, 0) !== 600) {
            throw new Error("Receiving-stage inventory total did not reach 600 pieces.");
        }
        const result = {
            outcome: apply ? "created" : "dry_run_rolled_back",
            applied: apply,
            inboundCode: received.inboundCode,
            status: received.status,
            warehouseCode: WAREHOUSE_CODE,
            receivingLocation: LOCATION,
            skids: totals.skids,
            pieces: totals.pieces,
            weightLb: Number(totals.weight_lb),
            inventoryBySku: inventory.rows,
            billingEventsCreated: Array.isArray(received.billingEventsCreated)
                ? received.billingEventsCreated.length
                : Number(received.billingEventsCreated || 0)
        };
        if (apply) await client.query("commit");
        else await client.query("rollback");
        console.log(JSON.stringify(result));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
