"use strict";

const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const { requireSandboxConfiguration } = require("./verify-test-company-authenticated-task-scope");
const {
    APP_USER_ROLES,
    allocatePortalOrderInventory,
    getPortalOrderById,
    releasePortalOrderForAccount,
    savePortalOrderDraftForAccount,
    upsertInventoryLine
} = require("../server");
const { loadPlan, loadIntegritySnapshot, verifyOrder } = require("./reconcile-released-order-allocations");

async function main() {
    requireSandboxConfiguration(process.env);
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL, ssl: false });
    await client.connect();
    await client.query("begin transaction isolation level serializable");
    try {
        const { id: designatedCompanyId, name: accountName } = await requireDesignatedTestCompany(client);
        const suffix = Date.now().toString(36).toUpperCase();
        const warehouseCode = `AR${suffix.slice(-6)}`;
        const storageCode = `${warehouseCode}-A01`;
        const receivingCode = `${warehouseCode}-REC`;
        const sku = `ALLOC-${suffix}`;
        const actor = {
            role: APP_USER_ROLES.SUPER_ADMIN,
            email: "allocation-verifier@wms365.co",
            full_name: "Allocation Verifier"
        };
        const warehouse = await client.query(`
            insert into fulfillment_locations (
                code, name, partner_name, location_type, address1, city, state, postal_code, country
            ) values ($1, 'Allocation Reconciliation Test', 'WMS365 Test', 'OWN_WAREHOUSE',
                      '1 Test Drive', 'Mississauga', 'ON', 'L5T 1V6', 'Canada')
            returning id
        `, [warehouseCode]);
        const warehouseId = warehouse.rows[0].id;
        await client.query(`
            insert into company_fulfillment_locations (
                account_name, fulfillment_location_id, is_primary, allow_inbound, allow_outbound, allow_storage
            ) values ($1, $2, true, true, true, true)
        `, [accountName, warehouseId]);
        await client.query(`
            insert into bin_locations (code, account_name, fulfillment_location_id, note, location_type, is_pickable)
            values
                ($1, $3, $4, 'Allocation verification storage', 'STORAGE', true),
                ($2, $3, $4, 'Allocation verification receiving', 'RECEIVING_STAGE', false)
        `, [storageCode, receivingCode, accountName, warehouseId]);
        await client.query(`
            insert into item_catalog (account_name, sku, description, tracking_level)
            values ($1, $2, 'Allocation verification item', 'CASE')
        `, [accountName, sku]);
        const storage = await upsertInventoryLine(client, {
            accountName,
            location: storageCode,
            sku,
            quantity: 10,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "ALLOCATION_VERIFY",
            sourceId: suffix,
            appUser: actor,
            idempotencyKey: `${suffix}-storage`
        });
        const receiving = await upsertInventoryLine(client, {
            accountName,
            location: receivingCode,
            sku,
            quantity: 3,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "ALLOCATION_VERIFY",
            sourceId: suffix,
            appUser: actor,
            idempotencyKey: `${suffix}-receiving`
        });
        const requestedShipDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        let order = await savePortalOrderDraftForAccount(client, accountName, {
            poNumber: `ALLOC-${suffix}`,
            shippingReference: `ALLOC-${suffix}`,
            contactName: "Test Receiver",
            contactPhone: "905-555-0100",
            requestedShipDate,
            orderType: "RETAIL_WHOLESALE",
            shipmentMethod: "PARCEL",
            fulfillmentLocationId: warehouseId,
            shipToName: "WMS365 Test Receiver",
            shipToAddress1: "100 Test Street",
            shipToCity: "Mississauga",
            shipToState: "ON",
            shipToPostalCode: "L5T 1V6",
            shipToCountry: "Canada",
            lines: [{ sku, quantity: 5 }]
        }, null, {
            enforceInventoryAvailability: true,
            activityTitlePrefix: "allocation verification",
            activityActor: actor.email
        });
        order = await releasePortalOrderForAccount(client, accountName, order.id, { activityActor: actor.email });
        const allocation = await client.query(
            "select id from portal_order_allocations where order_id = $1 and inventory_line_id = $2",
            [order.id, storage.id]
        );
        if (allocation.rowCount !== 1) throw new Error("Fixture did not create the expected pickable allocation.");
        await client.query(`
            update portal_order_allocations
            set inventory_line_id = $2, location = $3, allocated_quantity = 3, updated_at = now()
            where id = $1
        `, [allocation.rows[0].id, receiving.id, receivingCode]);

        const plan = await loadPlan(client);
        const target = plan.rows.find((row) => row.id === String(order.id));
        if (!target || target.shortage !== 2 || target.nonPickableAllocationCount !== 1) {
            throw new Error("Fixture did not enter the expected guarded reconciliation plan.");
        }
        const before = await loadIntegritySnapshot(client, [String(order.id)]);
        order = await getPortalOrderById(client, order.id, accountName);
        await allocatePortalOrderInventory(client, order, { allowSplitFulfillment: false });
        await verifyOrder(client, order.id);
        const after = await loadIntegritySnapshot(client, [String(order.id)]);
        if (before.inventoryHash !== after.inventoryHash || before.orderHash !== after.orderHash) {
            throw new Error("Reconciliation changed inventory quantities or order facts.");
        }
        const finalAllocation = await client.query(`
            select count(*)::integer as rows, coalesce(sum(allocated_quantity), 0)::integer as quantity
            from portal_order_allocations
            where order_id = $1 and inventory_line_id = $2 and location = $3
        `, [order.id, storage.id, storageCode]);
        if (Number(finalAllocation.rows[0]?.rows) !== 1 || Number(finalAllocation.rows[0]?.quantity) !== 5) {
            throw new Error("Reconciliation did not restore the exact pickable reservation.");
        }
        console.log(JSON.stringify({
            verified: true,
            designatedCompanyId: String(designatedCompanyId),
            targetOrders: 1,
            shortageCorrected: 2,
            nonPickableAllocationsCorrected: 1,
            inventoryQuantityChanged: false,
            orderFactsChanged: false,
            rolledBack: true
        }));
    } finally {
        await client.query("rollback").catch(() => {});
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ verified: false, error: error.message }));
    process.exitCode = 1;
});
