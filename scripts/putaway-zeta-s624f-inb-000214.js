const { Client } = require("pg");
const {
    safeTransferInventoryQuantity,
    createInventoryMovementRecord,
    updateAdminPortalInboundStatus
} = require("../server");

const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const ACCOUNT_ID = "1566";
const INBOUND = "INB-000214";
const SKU = "S624F";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const RECEIVING = "GW3PL-MISS-ZETA-REC";
const DESTINATION = "GW3PL-MISS-ZETA-BULK";
const QUANTITY = 16;
const MOVEMENT_KEY = "INB-000214-PUTAWAY-S624F";
const CONFIRMATION = "APPROVED_ZETA_S624F_INB_000214_PUTAWAY";

async function main({ apply = false } = {}) {
    if (apply && process.env.CONFIRM_ZETA_S624F_PUTAWAY !== CONFIRMATION) {
        throw new Error(`Set CONFIRM_ZETA_S624F_PUTAWAY=${CONFIRMATION} before applying.`);
    }
    if (process.env.RAILWAY_PROJECT_ID !== "3f4e7e7e-7eda-4275-8dd0-2c1c3f869698"
        || process.env.RAILWAY_ENVIRONMENT_ID !== "e1f5b77e-b935-4f41-9cc5-fccb28edbc57"
        || process.env.RAILWAY_SERVICE_ID !== "2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0") {
        throw new Error("WMS365 production target mismatch.");
    }

    const client = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await client.connect();
    let committed = false;
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${INBOUND}-PUTAWAY`]);

        const account = await client.query(
            "select id,name,is_active from owner_accounts where name=$1",
            [ACCOUNT]
        );
        if (account.rowCount !== 1 || String(account.rows[0].id) !== ACCOUNT_ID || !account.rows[0].is_active) {
            throw new Error("Zeta account identity mismatch.");
        }
        const warehouse = await client.query(
            `select fl.id,fl.code,fl.name,fl.is_active,cfl.allow_outbound,cfl.allow_storage
             from fulfillment_locations fl
             join company_fulfillment_locations cfl
               on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
             where fl.id=$2`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        if (warehouse.rowCount !== 1 || warehouse.rows[0].code !== WAREHOUSE_CODE
            || !warehouse.rows[0].is_active || !warehouse.rows[0].allow_outbound
            || !warehouse.rows[0].allow_storage) {
            throw new Error("Zeta Mississauga warehouse assignment mismatch.");
        }
        const inbound = await client.query(
            `select i.id,i.account_name,i.fulfillment_location_id,i.status,
                    l.id as line_id,l.sku,l.expected_quantity,l.received_quantity
             from portal_inbounds i
             join portal_inbound_lines l on l.inbound_id=i.id
             where i.inbound_code=$1
             for update of i,l`,
            [INBOUND]
        );
        if (inbound.rowCount !== 1 || inbound.rows[0].account_name !== ACCOUNT
            || Number(inbound.rows[0].fulfillment_location_id) !== WAREHOUSE_ID
            || inbound.rows[0].sku !== SKU
            || Number(inbound.rows[0].expected_quantity) !== QUANTITY
            || Number(inbound.rows[0].received_quantity) !== QUANTITY) {
            throw new Error("Zeta inbound identity or quantities changed.");
        }

        const bins = await client.query(
            `select code,account_name,fulfillment_location_id,location_type,is_pickable
             from bin_locations where code=any($1::text[]) order by code`,
            [[RECEIVING, DESTINATION]]
        );
        const sourceBin = bins.rows.find((row) => row.code === RECEIVING);
        const destinationBin = bins.rows.find((row) => row.code === DESTINATION);
        if (!sourceBin || sourceBin.account_name !== ACCOUNT
            || Number(sourceBin.fulfillment_location_id) !== WAREHOUSE_ID
            || sourceBin.location_type !== "RECEIVING_STAGE" || sourceBin.is_pickable !== false) {
            throw new Error("Zeta receiving location identity changed.");
        }
        if (!destinationBin || destinationBin.account_name !== ACCOUNT
            || Number(destinationBin.fulfillment_location_id) !== WAREHOUSE_ID
            || destinationBin.location_type !== "STORAGE" || destinationBin.is_pickable !== true) {
            throw new Error("Zeta bulk destination is not pickable Mississauga storage.");
        }

        const existingMovement = await client.query(
            "select id from inventory_movements where movement_key=$1",
            [MOVEMENT_KEY]
        );
        const source = await client.query(
            `select * from inventory_lines
             where account_name=$1 and sku=$2 and location=$3 and quantity>0
             order by id for update`,
            [ACCOUNT, SKU, RECEIVING]
        );
        const destinationBefore = await client.query(
            `select coalesce(sum(quantity),0)::integer as quantity from inventory_lines
             where account_name=$1 and sku=$2 and location=$3`,
            [ACCOUNT, SKU, DESTINATION]
        );

        if (inbound.rows[0].status === "PUTAWAY_COMPLETE") {
            const sourceTotal = source.rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
            if (sourceTotal !== 0 || Number(destinationBefore.rows[0].quantity) < QUANTITY || existingMovement.rowCount !== 1) {
                throw new Error("Completed inbound does not match the expected prior putaway result.");
            }
            await client.query("rollback");
            console.log(JSON.stringify({ outcome: "already_put_away", applied: false, inbound: INBOUND,
                sku: SKU, status: "PUTAWAY_COMPLETE", pickableLocation: DESTINATION,
                availableQuantity: Number(destinationBefore.rows[0].quantity) }));
            return;
        }
        if (inbound.rows[0].status !== "RECEIVED_PENDING_PUTAWAY" || existingMovement.rowCount !== 0) {
            throw new Error("Inbound status or movement history requires review before putaway.");
        }
        const sourceTotal = source.rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        if (sourceTotal !== QUANTITY) {
            throw new Error(`Expected ${QUANTITY} cases in the receiving stage; found ${sourceTotal}.`);
        }

        let remaining = QUANTITY;
        for (const line of source.rows) {
            const moveQuantity = Math.min(Number(line.quantity), remaining);
            if (moveQuantity <= 0) continue;
            await safeTransferInventoryQuantity(client, line, {
                accountName: ACCOUNT,
                location: DESTINATION,
                sku: SKU,
                trackingLevel: "CASE"
            }, moveQuantity, {
                actionLabel: "put away Zeta S624F receipt",
                transactionType: "PUT_AWAY",
                sourceType: "PORTAL_INBOUND_PUTAWAY",
                sourceId: inbound.rows[0].id,
                fulfillmentLocationId: WAREHOUSE_ID
            });
            remaining -= moveQuantity;
        }
        if (remaining !== 0) throw new Error("Not all S624F cases were transferred.");

        await createInventoryMovementRecord(client, {
            movementKey: MOVEMENT_KEY,
            accountName: ACCOUNT,
            fulfillmentLocationId: WAREHOUSE_ID,
            movementType: "TRANSFER",
            fromLocation: RECEIVING,
            toLocation: DESTINATION,
            line: source.rows[0],
            quantity: QUANTITY,
            reason: `${INBOUND} putaway: ${QUANTITY} cases of ${SKU}`
        });
        const completed = await updateAdminPortalInboundStatus(
            client,
            inbound.rows[0].id,
            "PUTAWAY_COMPLETE"
        );
        if (completed.status !== "PUTAWAY_COMPLETE") throw new Error("Inbound did not complete putaway.");

        const verification = await client.query(
            `select
                coalesce(sum(case when i.location=$3 then i.quantity else 0 end),0)::integer as source_quantity,
                coalesce(sum(case when i.location=$4 and b.is_pickable=true
                                  and coalesce(b.location_type,'STORAGE')='STORAGE'
                                  then i.quantity else 0 end),0)::integer as pickable_quantity
             from inventory_lines i
             left join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2`,
            [ACCOUNT, SKU, RECEIVING, DESTINATION]
        );
        const available = Number(verification.rows[0].pickable_quantity);
        if (Number(verification.rows[0].source_quantity) !== 0 || available < QUANTITY) {
            throw new Error("Post-putaway order-entry inventory verification failed.");
        }

        const result = {
            outcome: apply ? "putaway_completed" : "dry_run_rolled_back",
            applied: apply,
            inbound: INBOUND,
            status: completed.status,
            account: ACCOUNT,
            warehouse: WAREHOUSE_CODE,
            sku: SKU,
            quantity: QUANTITY,
            sourceLocation: RECEIVING,
            pickableLocation: DESTINATION,
            availableQuantity: available
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
