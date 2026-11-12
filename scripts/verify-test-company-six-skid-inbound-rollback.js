const { Client } = require("pg");
const {
    savePortalInboundForAccount,
    updateAdminPortalInboundStatus,
    safeTransferInventoryQuantity,
    createInventoryMovementRecord,
    ensureReceivingDestinationLocation
} = require("../server");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    await client.query("begin");
    try {
        const company = await client.query(
            "select id::text, name, is_active from owner_accounts where id=1510 and name='CODEX PORTAL SYSTEM TEST' and is_active=true"
        );
        if (company.rowCount !== 1 || company.rows[0].id !== "1510") {
            throw new Error("Pinned test company is unavailable.");
        }
        const accountName = company.rows[0].name;
        const warehouse = await client.query(
            `select fl.id, fl.code from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and cfl.allow_inbound=true and fl.is_active=true
             order by cfl.is_primary desc, fl.id limit 1`,
            [accountName]
        );
        if (warehouse.rowCount !== 1 || !warehouse.rows[0].code) {
            throw new Error("Pinned test company has no active receiving warehouse.");
        }
        const reference = `TEST-SIX-SKID-${Date.now()}`;
        const skus = ["TEST-ESP72-47-WHT", "TEST-ESP72-47-WHT", "TEST-ESP72-36-WHT",
            "TEST-ESP72-47-BLK", "TEST-ESP72-36-BLK", "TEST-ESP72-36-BLK"];
        for (const sku of [...new Set(skus)]) {
            await client.query(
                `insert into item_catalog (account_name,sku,description,tracking_level,unit_uom)
                 values ($1,$2,'TEST six-skid receipt','UNIT','EA')
                 on conflict (account_name,sku) do nothing`,
                [accountName, sku]
            );
        }
        const inbound = await savePortalInboundForAccount(client, accountName, {
            fulfillmentLocationId: warehouse.rows[0].id,
            referenceNumber: reference,
            carrierName: "TEST CARRIER",
            expectedDate: "2026-09-23",
            contactName: "Test Warehouse",
            notes: "TEST- rollback-only six non-standard skid receipt",
            lines: skus.map((sku) => ({ sku, quantity: 100 }))
        }, { activityActor: "TEST-rollback-only" });
        if (inbound.lines.length !== 6) throw new Error("Test inbound did not retain six lines.");
        const receivingLocation = `${warehouse.rows[0].code}-CODEX1510-REC`;
        const received = await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", null, {
            receivingLocation,
            receivingLines: inbound.lines.map((line, index) => ({
                id: line.id,
                receivedQuantity: 100,
                receivedLocation: receivingLocation,
                palletReference: `${reference}-S${index + 1}`,
                palletSizeType: "NON_STANDARD",
                palletWeight: 2000,
                palletWeightUom: "LB"
            }))
        });
        const allocations = await client.query(
            `select count(*)::integer as skids, sum(quantity)::integer as pieces,
                    sum(pallet_weight)::numeric as weight_lb
             from portal_inbound_receipt_allocations where inbound_id=$1`,
            [inbound.id]
        );
        const result = allocations.rows[0];
        if (received.status !== "RECEIVED_PENDING_PUTAWAY" || result.skids !== 6
            || result.pieces !== 600 || Number(result.weight_lb) !== 12000) {
            throw new Error("Test-company six-skid receipt verification failed.");
        }
        const destination = `${warehouse.rows[0].code}-CODEX1510-BULK`;
        await ensureReceivingDestinationLocation(client, destination);
        for (const [index, sku] of skus.entries()) {
            const source = await client.query(
                `select * from inventory_lines where account_name=$1 and location=$2 and sku=$3 for update`,
                [accountName, receivingLocation, sku]
            );
            if (source.rowCount !== 1 || Number(source.rows[0].quantity) < 100) {
                throw new Error(`TEST- source stock missing for skid ${index + 1}`);
            }
            await safeTransferInventoryQuantity(client, source.rows[0], {
                accountName, location: destination, sku, trackingLevel: "UNIT"
            }, 100, {
                actionLabel: "put away TEST- skid",
                transactionType: "PUT_AWAY",
                sourceType: "PORTAL_INBOUND_PUTAWAY",
                sourceId: `${reference}-S${index + 1}`,
                fulfillmentLocationId: warehouse.rows[0].id
            });
            await createInventoryMovementRecord(client, {
                movementKey: `${reference}-MOVE-S${index + 1}`,
                accountName,
                fulfillmentLocationId: warehouse.rows[0].id,
                movementType: "TRANSFER",
                fromLocation: receivingLocation,
                toLocation: destination,
                line: source.rows[0],
                quantity: 100,
                reason: "TEST- inbound putaway rollback"
            });
        }
        const completed = await updateAdminPortalInboundStatus(client, inbound.id, "PUTAWAY_COMPLETE");
        const destinationStock = await client.query(
            `select sum(quantity)::integer as pieces from inventory_lines
             where account_name=$1 and location=$2 and sku=any($3)`,
            [accountName, destination, [...new Set(skus)]]
        );
        const sourceStock = await client.query(
            `select coalesce(sum(quantity),0)::integer as pieces from inventory_lines
             where account_name=$1 and location=$2 and sku=any($3)`,
            [accountName, receivingLocation, [...new Set(skus)]]
        );
        const bin = await client.query("select is_pickable from bin_locations where code=$1", [destination]);
        if (completed.status !== "PUTAWAY_COMPLETE" || destinationStock.rows[0].pieces !== 600
            || sourceStock.rows[0].pieces !== 0 || bin.rowCount !== 1 || !bin.rows[0].is_pickable) {
            throw new Error("TEST- six-skid putaway did not verify.");
        }
        await client.query("rollback");
        console.log(JSON.stringify({ testCompanyId: 1510, status: completed.status,
            skids: result.skids, pieces: destinationStock.rows[0].pieces,
            weightLb: Number(result.weight_lb), destinationPickable: true, rolledBack: true }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
