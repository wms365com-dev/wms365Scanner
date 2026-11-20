const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    APP_USER_ROLES,
    savePortalOrderDraftForAccount,
    updateAdminPortalOrderStatus
} = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");

    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");

    try {
        const { name: accountName } = await requireDesignatedTestCompany(client);
        const suffix = Date.now().toString(36).toUpperCase().slice(-8);
        const warehouseCode = `TDC${suffix.slice(-5)}`;
        const sku = `TEST-DRAFT-CANCEL-${suffix}`;
        const idempotencyKey = `test-draft-cancel-${suffix}`;
        const warehouse = await client.query(
            `insert into fulfillment_locations
                (code, name, partner_name, location_type, address1, city, state, postal_code, country)
             values ($1, $2, 'WMS365 Test', 'OWN_WAREHOUSE', '1 Test Drive', 'Mississauga', 'ON', 'L5T 1V6', 'Canada')
             returning id`,
            [warehouseCode, `Test Draft Cancel ${suffix}`]
        );
        const warehouseId = warehouse.rows[0].id;
        await client.query(
            `insert into company_fulfillment_locations
                (account_name, fulfillment_location_id, is_primary, allow_inbound, allow_outbound, allow_storage)
             values ($1, $2, false, true, true, true)`,
            [accountName, warehouseId]
        );
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level)
             values ($1, $2, 'Zero-stock draft cancellation verification', 'CASE')`,
            [accountName, sku]
        );

        const actor = {
            role: APP_USER_ROLES.SUPER_ADMIN,
            email: "draft-cancel-verifier@invalid.example",
            full_name: "Draft Cancel Verifier"
        };
        const requestedShipDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        let order = await savePortalOrderDraftForAccount(client, accountName, {
            poNumber: `TEST-CANCEL-${suffix}`,
            shippingReference: `TEST-CANCEL-${suffix}`,
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
            lines: [{ sku, quantity: 999 }]
        }, null, {
            enforceInventoryAvailability: false,
            activityTitlePrefix: "test-company verification",
            activityActor: actor.email
        });

        const stockBefore = Number((await client.query(
            "select coalesce(sum(quantity), 0)::numeric as quantity from inventory_lines where account_name=$1 and sku=$2",
            [accountName, sku]
        )).rows[0]?.quantity || 0);
        if (stockBefore !== 0) throw new Error("The cancellation fixture unexpectedly has available inventory.");

        order = await updateAdminPortalOrderStatus(client, order.id, "CANCELLED", {
            idempotencyKey,
            cancelReason: "Rollback-only zero-stock draft cancellation verification"
        }, actor);
        if (order.status !== "CANCELLED") throw new Error("The zero-stock draft did not reach CANCELLED.");

        const repeated = await updateAdminPortalOrderStatus(client, order.id, "CANCELLED", {
            idempotencyKey,
            cancelReason: "Rollback-only zero-stock draft cancellation verification"
        }, actor);
        if (repeated.status !== "CANCELLED" || repeated.duplicateStatusAction !== true) {
            throw new Error("Repeating the cancellation did not return the idempotent cancelled result.");
        }

        const allocationCount = Number((await client.query(
            "select count(*)::integer as count from portal_order_allocations where order_id=$1",
            [order.id]
        )).rows[0]?.count || 0);
        const stockAfter = Number((await client.query(
            "select coalesce(sum(quantity), 0)::numeric as quantity from inventory_lines where account_name=$1 and sku=$2",
            [accountName, sku]
        )).rows[0]?.quantity || 0);
        const inventoryTransactionCount = Number((await client.query(
            "select count(*)::integer as count from inventory_transactions where account_name=$1 and sku=$2",
            [accountName, sku]
        )).rows[0]?.count || 0);
        if (allocationCount !== 0) throw new Error("The cancelled draft retained allocations.");
        if (stockAfter !== stockBefore) throw new Error("Cancelling the draft changed inventory quantity.");
        if (inventoryTransactionCount !== 0) throw new Error("Cancelling an unallocated draft wrote inventory transactions.");

        console.log(JSON.stringify({
            accountName,
            originalStatus: "DRAFT",
            finalStatus: order.status,
            zeroStockQuantityRequested: 999,
            allocationCount,
            inventoryQuantityBefore: stockBefore,
            inventoryQuantityAfter: stockAfter,
            inventoryTransactionCount,
            idempotentReplay: true,
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
