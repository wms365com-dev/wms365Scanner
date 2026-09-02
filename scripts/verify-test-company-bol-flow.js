const { Client } = require("pg");
const {
    APP_USER_ROLES,
    upsertInventoryLine,
    savePortalOrderDraftForAccount,
    releasePortalOrderForAccount,
    updateAdminPortalOrderStatus,
    preparePortalOrderBillOfLading,
    getPortalOrderBillOfLadingReadiness,
    buildPortalOrderBillOfLadingPdfAttachment
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
        if (!accountName) throw new Error("No WMS365 test company is configured.");
        const warehouseResult = await client.query(
            `select fl.* from fulfillment_locations fl
             join company_fulfillment_locations cfl on cfl.fulfillment_location_id=fl.id
             where cfl.account_name=$1 and cfl.allow_outbound=true
             order by cfl.is_primary desc, fl.id limit 1`,
            [accountName]
        );
        const warehouse = warehouseResult.rows[0];
        if (!warehouse) throw new Error("The WMS365 test company has no outbound warehouse.");
        const suffix = Date.now().toString(36).toUpperCase();
        const sku = `BOL-${suffix}`;
        const binCode = `${warehouse.code}-BOL-${suffix.slice(-5)}`.slice(0, 80);
        await client.query(
            `insert into bin_locations (code, note, location_type, is_pickable)
             values ($1, 'Rolled-back BOL verification', 'STORAGE', true)`,
            [binCode]
        );
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level, unit_uom)
             values ($1, $2, 'Rolled-back BOL verification item', 'CASE', 'CASE')`,
            [accountName, sku]
        );
        const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "platform-verifier@wms365.co", full_name: "Platform Verifier" };
        await upsertInventoryLine(client, {
            accountName,
            location: binCode,
            sku,
            quantity: 10,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "BOL_PLATFORM_VERIFY",
            sourceId: suffix,
            appUser: actor,
            idempotencyKey: `${suffix}-receive`
        });
        const requestedShipDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
        let order = await savePortalOrderDraftForAccount(client, accountName, {
            poNumber: `BOL-${suffix}`,
            shippingReference: `BOL-${suffix}`,
            contactName: "Test Receiver",
            contactPhone: "905-555-0100",
            requestedShipDate,
            orderType: "RETAIL_WHOLESALE",
            shipmentMethod: "LTL_FREIGHT",
            fulfillmentLocationId: warehouse.id,
            shipToName: "WMS365 Test Receiver",
            shipToAddress1: "100 Test Street",
            shipToCity: "Mississauga",
            shipToState: "ON",
            shipToPostalCode: "L5T 1V6",
            shipToCountry: "Canada",
            lines: [{ sku, quantity: 2 }]
        }, null, {
            enforceInventoryAvailability: true,
            activityTitlePrefix: "test-company BOL verification",
            activityActor: actor.email
        });
        order = await releasePortalOrderForAccount(client, accountName, order.id, { activityActor: actor.email });
        order = await updateAdminPortalOrderStatus(client, order.id, "PICKED", { idempotencyKey: `${suffix}-picked` }, actor);
        order = await updateAdminPortalOrderStatus(client, order.id, "STAGED", { idempotencyKey: `${suffix}-staged` }, actor);
        const shipment = order.warehouseShipments?.[0];
        if (!shipment?.id) throw new Error("The staged test order did not create a warehouse shipment.");
        await preparePortalOrderBillOfLading(client, order, order, {
            shipments: [{
                shipmentId: shipment.id,
                shipmentMethod: "LTL_FREIGHT",
                carrier: "Day & Ross",
                trackingReference: `PRO-${suffix}`,
                totalPallets: 2,
                totalWeight: 1250,
                weightUom: "LB",
                deliveryDate: requestedShipDate
            }]
        }, actor);
        const saved = await client.query("select * from warehouse_shipments where id=$1", [shipment.id]);
        const savedShipment = saved.rows[0];
        if (savedShipment.carrier_name !== "Day & Ross") throw new Error("BOL carrier was not saved.");
        if (Number(savedShipment.total_pallets) !== 2) throw new Error("BOL pallet count was not saved.");
        if (Number(savedShipment.total_weight) !== 1250) throw new Error("BOL shipment weight was not saved.");
        order.warehouseShipments = [{
            ...shipment,
            carrier: savedShipment.carrier_name,
            trackingReference: savedShipment.tracking_reference,
            bolReference: savedShipment.bol_reference,
            shipmentMethod: savedShipment.shipment_method,
            pallets: { total: Number(savedShipment.total_pallets) },
            totalWeight: Number(savedShipment.total_weight),
            weightUom: savedShipment.weight_uom,
            deliveryDate: String(savedShipment.delivery_date).slice(0, 10)
        }];
        const readiness = getPortalOrderBillOfLadingReadiness(order);
        if (!readiness.ready) throw new Error(`BOL remained incomplete: ${readiness.missingFields.join(", ")}`);
        const pdf = buildPortalOrderBillOfLadingPdfAttachment(order);
        if (pdf.content.subarray(0, 4).toString() !== "%PDF") throw new Error("The BOL PDF was not generated.");
        console.log(JSON.stringify({
            accountName,
            orderStatus: order.status,
            shipmentStatus: savedShipment.status,
            carrier: savedShipment.carrier_name,
            pallets: Number(savedShipment.total_pallets),
            weight: Number(savedShipment.total_weight),
            weightUom: savedShipment.weight_uom,
            pdfBytes: pdf.content.length,
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
