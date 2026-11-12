const { Client } = require("pg");
const { savePortalInboundForAccount, updateAdminPortalInboundStatus } = require("../server");

const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const ACCOUNT_ID = "1566";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const SKU = "S624F";
const DESCRIPTION = "Terra Facial Cleansing Towel 20x6";
const UPC = "19421908626341";
const TRACKING = "877479752015";
const REFERENCE = `FEDEX-${TRACKING}`;
const RECEIPT_TIMESTAMP = "2026-09-25 10:42:00 America/New_York";
const RECEIPT_DATE = "2026-09-25";
const RECEIVING_LOCATION = "GW3PL-MISS-ZETA-REC";
const BOXES = 2;
const CASES_PER_BOX = 8;
const TOTAL_CASES = BOXES * CASES_PER_BOX;
const APPLY_CONFIRMATION = "APPROVED_ZETA_S624F_FEDEX_877479752015";

const actor = {
    id: null,
    email: "wms365-inbound-automation@wms365.co",
    full_name: "WMS365 Owner-Approved Inbound"
};

async function main({ apply = false } = {}) {
    if (apply && process.env.CONFIRM_ZETA_S624F_INBOUND !== APPLY_CONFIRMATION) {
        throw new Error(`Set CONFIRM_ZETA_S624F_INBOUND=${APPLY_CONFIRMATION} before applying.`);
    }
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("WMS365 production target mismatch");
    }
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    let committed = false;
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`zeta-inbound:${REFERENCE}`]);

        const account = await client.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]);
        if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
            throw new Error("ZETA account identity mismatch");
        }
        const warehouse = await client.query(
            `select fl.id,fl.code,fl.name,fl.is_active,cfl.allow_inbound,cfl.allow_storage
             from fulfillment_locations fl join company_fulfillment_locations cfl
               on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
             where fl.id=$2`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE
            || !warehouse.rows[0].is_active || !warehouse.rows[0].allow_inbound || !warehouse.rows[0].allow_storage) {
            throw new Error("ZETA Mississauga warehouse assignment mismatch");
        }
        const item = await client.query(
            `select description,upc,tracking_level,units_per_case,lot_tracked,expiration_tracked,blocked,item_type
             from item_catalog where account_name=$1 and sku=$2`,
            [ACCOUNT, SKU]
        );
        if (item.rowCount !== 1 || item.rows[0].description !== DESCRIPTION || item.rows[0].upc !== UPC
            || item.rows[0].tracking_level !== "CASE" || Number(item.rows[0].units_per_case) !== 6
            || item.rows[0].lot_tracked || item.rows[0].expiration_tracked || item.rows[0].blocked
            || item.rows[0].item_type !== "INVENTORY") {
            throw new Error("S624F item configuration mismatch");
        }
        const prior = await client.query(
            `select i.id,i.inbound_code,i.status,i.received_at::text,l.expected_quantity,l.received_quantity
             from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
             where i.account_name=$1 and i.reference_number=$2 and l.sku=$3`,
            [ACCOUNT, REFERENCE, SKU]
        );
        if (prior.rowCount) {
            const row = prior.rows[0];
            if (Number(row.expected_quantity) !== TOTAL_CASES || Number(row.received_quantity) !== TOTAL_CASES
                || !["RECEIVED_PENDING_PUTAWAY", "PARTIALLY_PUTAWAY", "PUTAWAY_COMPLETE"].includes(row.status)) {
                throw new Error("Existing tracking-matched inbound differs from this receipt");
            }
            await client.query("rollback");
            console.log(JSON.stringify({ outcome: "already_received", applied: false, inboundCode: row.inbound_code,
                status: row.status, cases: TOTAL_CASES, receiptDate: row.received_at }));
            return;
        }

        const before = await client.query(
            `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
             where account_name=$1 and sku=$2`,
            [ACCOUNT, SKU]
        );
        const notes = [
            `FedEx tracking ${TRACKING}; master shipment 1 of 2 pieces.`,
            `Physically delivered ${RECEIPT_DATE} at 10:42 AM Eastern; signed for by F.Frank.`,
            `${BOXES} boxes x ${CASES_PER_BOX} cases = ${TOTAL_CASES} cases (${TOTAL_CASES * 6} retail packs).`,
            `Product identity verified from shipment photos: ${DESCRIPTION}, GTIN ${UPC}.`,
            "Received into ZETA receiving stage; putaway remains pending."
        ].join(" ");
        const inbound = await savePortalInboundForAccount(client, ACCOUNT, {
            fulfillmentLocationId: WAREHOUSE_ID,
            referenceNumber: REFERENCE,
            carrierName: "FedEx",
            expectedDate: RECEIPT_DATE,
            contactName: "ZETA GROUP",
            notes,
            lines: [{ sku: SKU, quantity: TOTAL_CASES }]
        }, {
            activityTitlePrefix: "warehouse",
            activityActor: actor.full_name,
            creatorEmail: ""
        });
        if (inbound.lines.length !== 1 || inbound.lines[0].sku !== SKU || Number(inbound.lines[0].quantity) !== TOTAL_CASES) {
            throw new Error("Saved inbound line did not match the verified shipment");
        }
        await client.query("update portal_inbound_lines set pallet_count=$2 where inbound_id=$1", [inbound.id, BOXES]);
        const receivingLines = [1, 2].map((box) => ({
            id: inbound.lines[0].id,
            sku: SKU,
            receivedQuantity: CASES_PER_BOX,
            receivedLocation: RECEIVING_LOCATION,
            palletReference: `${REFERENCE}-BOX${box}`
        }));
        const received = await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", actor, {
            receivingLocation: RECEIVING_LOCATION,
            receivingLines,
            note: `FedEx delivered ${RECEIPT_DATE} at 10:42 AM Eastern; two boxes received.`
        });
        if (received.status !== "RECEIVED_PENDING_PUTAWAY") {
            throw new Error(`Inbound reached ${received.status}, not RECEIVED_PENDING_PUTAWAY`);
        }
        await client.query(
            `update portal_inbounds set arrived_at=$2::timestamptz,received_at=$2::timestamptz,updated_at=now()
             where id=$1`,
            [inbound.id, RECEIPT_TIMESTAMP]
        );
        const allocations = await client.query(
            `select allocation_number,quantity,location,pallet_reference
             from portal_inbound_receipt_allocations where inbound_id=$1 order by allocation_number`,
            [inbound.id]
        );
        if (allocations.rowCount !== BOXES
            || allocations.rows.some((row) => Number(row.quantity) !== CASES_PER_BOX
                || row.location !== RECEIVING_LOCATION
                || !row.pallet_reference.startsWith(`${REFERENCE}-BOX`))) {
            throw new Error("Receipt allocations did not preserve two eight-case boxes");
        }
        const line = await client.query(
            `select expected_quantity,received_quantity,received_location from portal_inbound_lines
             where inbound_id=$1 and sku=$2`,
            [inbound.id, SKU]
        );
        const after = await client.query(
            `select coalesce(sum(quantity),0)::integer quantity from inventory_lines
             where account_name=$1 and sku=$2`,
            [ACCOUNT, SKU]
        );
        if (line.rowCount !== 1 || Number(line.rows[0].expected_quantity) !== TOTAL_CASES
            || Number(line.rows[0].received_quantity) !== TOTAL_CASES
            || line.rows[0].received_location !== RECEIVING_LOCATION
            || Number(after.rows[0].quantity) - Number(before.rows[0].quantity) !== TOTAL_CASES) {
            throw new Error("Inbound or inventory totals failed verification");
        }
        const result = {
            outcome: apply ? "created_and_received" : "dry_run_rolled_back",
            applied: apply,
            inboundCode: received.inboundCode,
            status: received.status,
            account: ACCOUNT,
            warehouse: WAREHOUSE_CODE,
            sku: SKU,
            boxes: BOXES,
            casesPerBox: CASES_PER_BOX,
            totalCases: TOTAL_CASES,
            retailPacks: TOTAL_CASES * 6,
            receiptDate: RECEIPT_DATE,
            receivingLocation: RECEIVING_LOCATION,
            inventoryBefore: Number(before.rows[0].quantity),
            inventoryAfter: Number(after.rows[0].quantity),
            billingEventsCreated: Array.isArray(received.billingEventsCreated)
                ? received.billingEventsCreated.length : Number(received.billingEventsCreated || 0)
        };
        if (apply) {
            await client.query("commit");
            committed = true;
        } else {
            await client.query("rollback");
        }
        console.log(JSON.stringify(result));
    } catch (error) {
        if (!committed) await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
