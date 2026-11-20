const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    APP_USER_ROLES,
    savePortalOrderDraftForAccount,
    duplicateWarehousePortalOrder
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
        const warehouseCode = `TOD${suffix.slice(-5)}`;
        const sku = `TEST-DUPLICATE-${suffix}`;
        const warehouse = await client.query(
            `insert into fulfillment_locations
                (code, name, partner_name, location_type, address1, city, state, postal_code, country)
             values ($1, $2, 'WMS365 Test', 'OWN_WAREHOUSE', '1 Test Drive', 'Mississauga', 'ON', 'L5T 1V6', 'Canada')
             returning id`,
            [warehouseCode, `Test Duplicate ${suffix}`]
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
             values ($1, $2, 'Order duplicate verification', 'CASE')`,
            [accountName, sku]
        );

        const actor = {
            role: APP_USER_ROLES.SUPER_ADMIN,
            email: "order-duplicate-verifier@invalid.example",
            full_name: "Order Duplicate Verifier"
        };
        const requestedShipDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        const source = await savePortalOrderDraftForAccount(client, accountName, {
            poNumber: `TEST-DUP-${suffix}`,
            shippingReference: `TEST-DUP-${suffix}`,
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
            lines: [{ sku, quantity: 7 }]
        }, null, {
            enforceInventoryAvailability: false,
            activityTitlePrefix: "test-company verification",
            activityActor: actor.email
        });

        const first = await duplicateWarehousePortalOrder(client, source.id, actor);
        const second = await duplicateWarehousePortalOrder(client, source.id, actor);
        const duplicate = first.order;
        if (first.alreadyExists !== false || second.alreadyExists !== true) {
            throw new Error("Duplicate retry did not preserve the one-draft idempotency contract.");
        }
        if (!duplicate?.id || String(second.order?.id) !== String(duplicate.id)) {
            throw new Error("Duplicate retry did not return the original duplicate draft.");
        }
        if (duplicate.status !== "DRAFT" || duplicate.accountName !== accountName) {
            throw new Error("Duplicate changed the source company or did not remain a draft.");
        }
        if (String(duplicate.fulfillmentLocationId) !== String(warehouseId)) {
            throw new Error("Duplicate changed the source warehouse.");
        }
        if (duplicate.lines?.length !== 1 || duplicate.lines[0].sku !== sku || Number(duplicate.lines[0].quantity) !== 7) {
            throw new Error("Duplicate changed the source line or quantity.");
        }
        if (!String(duplicate.orderCode || "").endsWith("-R")) {
            throw new Error("Duplicate did not use the required review-draft reference.");
        }

        const duplicateFacts = (await client.query(
            `select
                (select count(*) from portal_orders where duplicated_from_order_id=$1)::integer as duplicate_count,
                (select count(*) from portal_order_allocations where order_id=$2)::integer as allocation_count,
                (select count(*) from warehouse_shipments where order_id=$2)::integer as shipment_count`,
            [source.id, duplicate.id]
        )).rows[0];
        if (Number(duplicateFacts.duplicate_count) !== 1) throw new Error("More than one duplicate draft was created.");
        if (Number(duplicateFacts.allocation_count) !== 0) throw new Error("Duplicate copied allocation history.");
        if (Number(duplicateFacts.shipment_count) !== 0) throw new Error("Duplicate copied shipment history.");

        console.log(JSON.stringify({
            accountName,
            sourceStatus: source.status,
            duplicateStatus: duplicate.status,
            sameCompany: duplicate.accountName === accountName,
            sameWarehouse: String(duplicate.fulfillmentLocationId) === String(warehouseId),
            lineQuantity: Number(duplicate.lines[0].quantity),
            duplicateCount: Number(duplicateFacts.duplicate_count),
            allocationCount: Number(duplicateFacts.allocation_count),
            shipmentCount: Number(duplicateFacts.shipment_count),
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
