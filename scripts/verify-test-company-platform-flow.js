const { Client } = require("pg");
const {
    APP_USER_ROLES,
    upsertInventoryLine,
    safeTransferInventoryQuantity,
    findInventoryLine,
    savePortalOrderDraftForAccount,
    releasePortalOrderForAccount,
    updateAdminPortalOrderStatus,
    savePortalInboundForAccount,
    updateAdminPortalInboundStatus,
    submitInventoryCount,
    setInventoryCountStatus,
    postInventoryCountAdjustment
} = require("../server");

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
        if (!accountName) throw new Error("No test company is configured.");
        const suffix = Date.now().toString(36).toUpperCase();
        const warehouseCodes = [`TFA${suffix.slice(-5)}`, `TFB${suffix.slice(-5)}`];
        const warehouseIds = [];
        for (const [index, code] of warehouseCodes.entries()) {
            const result = await client.query(
                `insert into fulfillment_locations (code, name, partner_name, location_type, address1, city, state, postal_code, country)
                 values ($1, $2, 'WMS365 Test', 'OWN_WAREHOUSE', $3, 'Mississauga', 'ON', 'L5T 1V6', 'Canada') returning id`,
                [code, `Test Flow Warehouse ${index + 1}`, `${index + 1} Test Flow Drive`]
            );
            warehouseIds.push(result.rows[0].id);
            await client.query(
                `insert into company_fulfillment_locations (account_name, fulfillment_location_id, is_primary, allow_inbound, allow_outbound, allow_storage)
                 values ($1, $2, $3, true, true, true)`,
                [accountName, result.rows[0].id, index === 0]
            );
        }
        const locations = [`${warehouseCodes[0]}-A01`, `${warehouseCodes[1]}-A01`, `${warehouseCodes[0]}-REC`, `${warehouseCodes[0]}-B01`];
        for (const code of locations) {
            await client.query(
                `insert into bin_locations (code, note, location_type, is_pickable)
                 values ($1, 'Platform flow verification', $2, $3)
                 on conflict (code) do update set note=excluded.note, location_type=excluded.location_type, is_pickable=excluded.is_pickable`,
                [code, code.endsWith("-REC") ? "RECEIVING_STAGE" : "STORAGE", !code.endsWith("-REC")]
            );
        }
        const skus = [`FLOW-A-${suffix}`, `FLOW-B-${suffix}`, `FLOW-IN-${suffix}`];
        for (const sku of skus) {
            await client.query(
                `insert into item_catalog (account_name, sku, description, tracking_level)
                 values ($1, $2, 'Platform verification item', 'CASE')`,
                [accountName, sku]
            );
        }
        const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "platform-verifier@wms365.co", full_name: "Platform Verifier" };
        await upsertInventoryLine(client, { accountName, location: locations[0], sku: skus[0], quantity: 12, trackingLevel: "CASE" }, { transactionType: "RECEIVING", sourceType: "PLATFORM_VERIFY", sourceId: suffix, appUser: actor, idempotencyKey: `${suffix}-receive-a` });
        await upsertInventoryLine(client, { accountName, location: locations[1], sku: skus[1], quantity: 12, trackingLevel: "CASE" }, { transactionType: "RECEIVING", sourceType: "PLATFORM_VERIFY", sourceId: suffix, appUser: actor, idempotencyKey: `${suffix}-receive-b` });

        const requestedShipDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        let singleOrder = await savePortalOrderDraftForAccount(client, accountName, {
            poNumber: `SINGLE-${suffix}`, shippingReference: `SINGLE-${suffix}`, contactName: "Test Receiver",
            contactPhone: "905-555-0100", requestedShipDate, orderType: "RETAIL_WHOLESALE", shipmentMethod: "PARCEL",
            fulfillmentLocationId: warehouseIds[0], shipToName: "WMS365 Test Receiver", shipToAddress1: "100 Test Street",
            shipToCity: "Mississauga", shipToState: "ON", shipToPostalCode: "L5T 1V6", shipToCountry: "Canada",
            lines: [{ sku: skus[0], quantity: 1 }]
        }, null, { enforceInventoryAvailability: true, activityTitlePrefix: "test-company verification", activityActor: actor.email });
        singleOrder = await releasePortalOrderForAccount(client, accountName, singleOrder.id, { activityActor: actor.email });
        const singleShipmentCount = await client.query("select count(*)::integer count from warehouse_shipments where order_id=$1", [singleOrder.id]);
        if (Number(singleShipmentCount.rows[0]?.count) !== 1) throw new Error("Single-warehouse order did not create one warehouse shipment.");

        let order = await savePortalOrderDraftForAccount(client, accountName, {
            poNumber: `FLOW-${suffix}`,
            shippingReference: `FLOW-${suffix}`,
            contactName: "Test Receiver",
            contactPhone: "905-555-0100",
            requestedShipDate,
            orderType: "RETAIL_WHOLESALE",
            shipmentMethod: "PARCEL",
            fulfillmentLocationId: warehouseIds[0],
            shipToName: "WMS365 Test Receiver",
            shipToAddress1: "100 Test Street",
            shipToCity: "Mississauga",
            shipToState: "ON",
            shipToPostalCode: "L5T 1V6",
            shipToCountry: "Canada",
            lines: [{ sku: skus[0], quantity: 2 }, { sku: skus[1], quantity: 3 }]
        }, null, { enforceInventoryAvailability: true, activityTitlePrefix: "test-company verification", activityActor: actor.email });
        order = await releasePortalOrderForAccount(client, accountName, order.id, { splitFulfillmentApproved: true, splitFulfillmentApprovedBy: actor.email, activityActor: actor.email });
        const shipmentCount = await client.query("select count(*)::integer count from warehouse_shipments where order_id=$1", [order.id]);
        if (Number(shipmentCount.rows[0]?.count) !== 2) throw new Error("Split order did not create two warehouse shipments.");
        order = await updateAdminPortalOrderStatus(client, order.id, "PICKED", { idempotencyKey: `${suffix}-picked` }, actor);
        order = await updateAdminPortalOrderStatus(client, order.id, "STAGED", { idempotencyKey: `${suffix}-staged` }, actor);
        order = await updateAdminPortalOrderStatus(client, order.id, "SHIPPED", {
            idempotencyKey: `${suffix}-shipped`, shipmentMethod: "PARCEL", carrierName: "UPS",
            trackingReference: `1Z${suffix}`, packingSlipQuantityConfirmed: true,
            shippedLines: order.lines.map((line) => ({ orderLineId: line.id, shippedQuantity: line.quantity }))
        }, actor);
        if (order.status !== "SHIPPED") throw new Error("Test order did not reach SHIPPED.");

        let inbound = await savePortalInboundForAccount(client, accountName, {
            referenceNumber: `IN-${suffix}`, expectedDate: requestedShipDate, contactName: "Test Sender",
            carrierName: "Test Carrier", fulfillmentLocationId: warehouseIds[0], lines: [{ sku: skus[2], quantity: 5 }]
        }, { activityTitlePrefix: "test-company verification", activityActor: actor.email, creatorEmail: actor.email, taskAppUser: actor });
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "ARRIVED", actor, { note: "Verification arrival" });
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", actor, {
            lines: inbound.lines.map((line) => ({ id: line.id, receivedQuantity: 5, receivedLocation: locations[2] }))
        });
        const receivingLine = await findInventoryLine(client, accountName, locations[2], skus[2], { lock: true });
        await safeTransferInventoryQuantity(client, receivingLine, { accountName, location: locations[3], sku: skus[2], trackingLevel: "CASE" }, 5, { transactionType: "PUT_AWAY", sourceType: "PLATFORM_VERIFY", sourceId: inbound.id, appUser: actor, idempotencyKey: `${suffix}-putaway` });
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "PUTAWAY_COMPLETE", actor, { note: "Verification putaway" });
        if (inbound.status !== "PUTAWAY_COMPLETE") throw new Error("Test inbound did not complete putaway.");

        let count = await submitInventoryCount(client, { accountName, location: locations[3], sku: skus[2], countedCases: 4, evidenceNote: "Verification variance" }, actor);
        count = await setInventoryCountStatus(client, count.id, "APPROVED", { note: "Verification approval" }, actor);
        count = await postInventoryCountAdjustment(client, count.id, { moveToInvestigation: true, note: "Verification investigation" }, actor);
        if (count.status !== "POSTED") throw new Error("Test cycle count did not post.");

        console.log(JSON.stringify({ accountName, singleShipments: 1, splitShipments: 2, orderStatus: order.status, inboundStatus: inbound.status, countStatus: count.status, rolledBack: true }));
    } finally {
        await client.query("rollback");
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
