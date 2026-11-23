const { Client } = require("pg");
const {
    APP_USER_ROLES,
    assertAppUserInventoryMoveAccess,
    moveInventoryToInvestigationHold,
    sanitizeInventoryMoveImages,
    upsertInventoryLine
} = require("../server");

function imageInput(index) {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return {
        fileName: `test-move-proof-${index}.png`,
        fileType: "image/png",
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`
    };
}

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const companyResult = await client.query(
            `select name from owner_accounts where upper(name) like '%TEST%COMPANY%'
             order by case when upper(name)='WMS365 TEST COMPANY' then 0 else 1 end, name limit 1`
        );
        const accountName = companyResult.rows[0]?.name;
        if (!accountName) throw new Error("No WMS365 test company is configured.");

        const suffix = Date.now().toString(36).toUpperCase().slice(-6);
        const warehouseCodes = [`TMVA${suffix}`, `TMVB${suffix}`];
        const warehouseIds = [];
        for (const [index, code] of warehouseCodes.entries()) {
            const warehouse = await client.query(
                `insert into fulfillment_locations (code, name, partner_name, location_type, address1, city, state, postal_code, country)
                 values ($1, $2, 'WMS365 Test', 'OWN_WAREHOUSE', $3, 'Mississauga', 'ON', 'L5T 1V6', 'Canada') returning id`,
                [code, `Test Inventory Move Warehouse ${index + 1}`, `${index + 1} Test Move Drive`]
            );
            warehouseIds.push(Number(warehouse.rows[0].id));
            await client.query(
                `insert into company_fulfillment_locations (account_name, fulfillment_location_id, is_primary, allow_inbound, allow_outbound, allow_storage)
                 values ($1, $2, $3, true, true, true)`,
                [accountName, warehouse.rows[0].id, index === 0]
            );
        }

        const userResult = await client.query(
            `insert into app_users (email, password_hash, full_name, role, is_active)
             values ($1, 'TEST-NOT-AUTHENTICATABLE', 'Test Inventory Move Worker', $2, true) returning id`,
            [`test-inventory-move-${suffix.toLowerCase()}@example.invalid`, APP_USER_ROLES.WAREHOUSE_WORKER]
        );
        const userId = Number(userResult.rows[0].id);
        await client.query("insert into app_user_company_access (app_user_id, account_name) values ($1,$2)", [userId, accountName]);
        await client.query(
            "insert into app_user_fulfillment_location_access (app_user_id, fulfillment_location_id) values ($1,$2)",
            [userId, warehouseIds[0]]
        );
        const worker = { id: userId, role: APP_USER_ROLES.WAREHOUSE_WORKER, email: `test-inventory-move-${suffix.toLowerCase()}@example.invalid` };

        const sourceLocation = `${warehouseCodes[0]}-A01`;
        const sameWarehouseLocation = `${warehouseCodes[0]}-A02`;
        const otherWarehouseLocation = `${warehouseCodes[1]}-A01`;
        for (const [code, fulfillmentLocationId] of [
            [sourceLocation, warehouseIds[0]],
            [sameWarehouseLocation, warehouseIds[0]],
            [otherWarehouseLocation, warehouseIds[1]]
        ]) {
            await client.query(
                `insert into bin_locations (code, note, location_type, is_pickable, account_name, fulfillment_location_id)
                 values ($1, 'Test-company move verification', 'STORAGE', true, $2, $3)`,
                [code, accountName, fulfillmentLocationId]
            );
        }

        const sku = `TEST-MOVE-${suffix}`;
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level)
             values ($1,$2,'Test-company inventory move verification','CASE')`,
            [accountName, sku]
        );
        await upsertInventoryLine(client, {
            accountName,
            location: sourceLocation,
            sku,
            quantity: 6,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "TEST_COMPANY_MOVE_VERIFY",
            sourceId: suffix,
            appUser: worker,
            idempotencyKey: `${suffix}-receive`
        });

        await assertAppUserInventoryMoveAccess(client, worker, accountName, sourceLocation, sameWarehouseLocation);
        let crossWarehouseRejected = false;
        try {
            await assertAppUserInventoryMoveAccess(client, worker, accountName, sourceLocation, otherWarehouseLocation);
        } catch (error) {
            crossWarehouseRejected = error?.statusCode === 403 || error?.statusCode === 400;
        }
        if (!crossWarehouseRejected) throw new Error("Cross-warehouse movement was not rejected.");

        const images = Array.from({ length: 5 }, (_, index) => imageInput(index + 1));
        if (sanitizeInventoryMoveImages(images).length !== 5) throw new Error("Five-image validation failed.");
        const result = await moveInventoryToInvestigationHold(client, {
            accountName,
            fromLocation: sourceLocation,
            skuOrUpc: sku,
            quantity: 1,
            note: "Test-company QC image verification",
            images,
            idempotencyKey: `${suffix}-hold`,
            source: "test_company_verification"
        }, worker);
        const holdRow = await client.query(
            `select i.quantity, bl.is_pickable, bl.location_type
             from inventory_lines i join bin_locations bl on bl.code=i.location
             where i.account_name=$1 and i.location=$2 and i.sku=$3`,
            [accountName, result.holdLocation, sku]
        );
        if (Number(holdRow.rows[0]?.quantity) !== 1 || holdRow.rows[0]?.is_pickable !== false) {
            throw new Error("Investigation stock was not held as non-pickable.");
        }
        const attachmentCount = await client.query(
            "select count(*)::integer count from inventory_movement_attachments where movement_id=$1",
            [result.movement.id]
        );
        if (Number(attachmentCount.rows[0]?.count) !== 5) throw new Error("Five movement images were not stored.");
        const duplicate = await moveInventoryToInvestigationHold(client, {
            accountName,
            fromLocation: sourceLocation,
            skuOrUpc: sku,
            quantity: 1,
            idempotencyKey: `${suffix}-hold`
        }, worker);
        if (!duplicate.duplicate) throw new Error("Duplicate movement protection failed.");

        console.log(JSON.stringify({
            accountName,
            workerRole: worker.role,
            warehouseScoped: true,
            crossWarehouseRejected,
            holdLocation: result.holdLocation,
            holdPickable: false,
            imageCount: 5,
            duplicateProtected: true,
            rolledBack: true
        }));
    } finally {
        await client.query("rollback");
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
