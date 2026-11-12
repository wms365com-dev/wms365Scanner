const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    APP_USER_ROLES,
    upsertInventoryLine,
    savePortalOrderDraftForAccount,
    releasePortalOrderForAccount,
    updateAdminPortalOrderStatus,
    savePortalInboundForAccount,
    updateAdminPortalInboundStatus
} = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const { id: accountId, name: accountName } = await requireDesignatedTestCompany(client);
        const suffix = Date.now().toString(36).toUpperCase();
        const warehouseCode = `MOB${suffix.slice(-6)}`;
        const storageLocation = `${warehouseCode}-A01`;
        const receivingLocation = `${warehouseCode}-REC`;
        const sku = `TEST-MOBILE-${suffix}`;
        const actor = {
            role: APP_USER_ROLES.SUPER_ADMIN,
            email: "mobile-e2e@wms365.co",
            full_name: "Mobile E2E Verifier"
        };

        await client.query("begin");
        const warehouseResult = await client.query(
            `insert into fulfillment_locations
                (code, name, partner_name, location_type, address1, city, state, postal_code, country)
             values ($1, $2, 'WMS365 Test', 'OWN_WAREHOUSE', '1510 Test Drive',
                     'Mississauga', 'ON', 'L5T 1V6', 'Canada') returning id`,
            [warehouseCode, `Mobile E2E ${suffix}`]
        );
        const warehouseId = warehouseResult.rows[0].id;
        await client.query(
            `insert into company_fulfillment_locations
                (account_name, fulfillment_location_id, is_primary, allow_inbound, allow_outbound, allow_storage)
             values ($1, $2, false, true, true, true)`,
            [accountName, warehouseId]
        );
        for (const [code, type, pickable] of [
            [storageLocation, "STORAGE", true],
            [receivingLocation, "RECEIVING_STAGE", false]
        ]) {
            await client.query(
                `insert into bin_locations (code, note, location_type, is_pickable)
                 values ($1, 'Mobile E2E test fixture', $2, $3)`,
                [code, type, pickable]
            );
        }
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level)
             values ($1, $2, 'Mobile E2E test item', 'CASE')`,
            [accountName, sku]
        );
        await upsertInventoryLine(client, {
            accountName,
            location: storageLocation,
            sku,
            quantity: 10,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "MOBILE_E2E_FIXTURE",
            sourceId: suffix,
            appUser: actor,
            idempotencyKey: `${suffix}-seed`
        });

        const requestedShipDate = new Date().toISOString().slice(0, 10);
        let order = await savePortalOrderDraftForAccount(client, accountName, {
            poNumber: `TEST-MOBILE-SHIP-${suffix}`,
            shippingReference: `TEST-MOBILE-SHIP-${suffix}`,
            contactName: "Test Receiver",
            contactPhone: "905-555-0151",
            requestedShipDate,
            orderType: "RETAIL_WHOLESALE",
            shipmentMethod: "LTL",
            fulfillmentLocationId: warehouseId,
            shipToName: "WMS365 Test Receiver",
            shipToAddress1: "1510 Test Street",
            shipToCity: "Mississauga",
            shipToState: "ON",
            shipToPostalCode: "L5T 1V6",
            shipToCountry: "Canada",
            lines: [{ sku, quantity: 2 }]
        }, null, {
            enforceInventoryAvailability: true,
            activityTitlePrefix: "mobile E2E test",
            activityActor: actor.email
        });
        order = await releasePortalOrderForAccount(client, accountName, order.id, {
            activityActor: actor.email,
            rushExempt: true,
            rushExemptNote: "Designated test-company E2E verification; no customer billing."
        });
        order = await updateAdminPortalOrderStatus(client, order.id, "PICKED", {
            idempotencyKey: `${suffix}-picked`
        }, actor);
        order = await updateAdminPortalOrderStatus(client, order.id, "STAGED", {
            idempotencyKey: `${suffix}-staged`
        }, actor);

        let inbound = await savePortalInboundForAccount(client, accountName, {
            referenceNumber: `TEST-MOBILE-RECEIVE-${suffix}`,
            expectedDate: requestedShipDate,
            contactName: "Test Sender",
            carrierName: "Test Carrier",
            fulfillmentLocationId: warehouseId,
            lines: [{ sku, quantity: 3 }]
        }, {
            activityTitlePrefix: "mobile E2E test",
            activityActor: actor.email,
            creatorEmail: actor.email,
            taskAppUser: actor
        });
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "ARRIVED", actor, {
            note: "Mobile E2E fixture ready for receiving"
        });
        await client.query("commit");
        console.log(JSON.stringify({
            accountId,
            accountName,
            suffix,
            sku,
            warehouseId,
            warehouseCode,
            storageLocation,
            receivingLocation,
            orderId: order.id,
            orderCode: order.orderCode,
            orderStatus: order.status,
            inboundId: inbound.id,
            inboundCode: inbound.inboundCode,
            inboundStatus: inbound.status
        }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
