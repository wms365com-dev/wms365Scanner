const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    getPortalOrderById,
    savePortalOrderDraftForAccount
} = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("DATABASE_URL is required.");

    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    await client.query("begin");

    try {
        const { id: companyId, name: accountName } = await requireDesignatedTestCompany(client);
        const locationResult = await client.query(
            `select fl.id, fl.code
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id
             where cfl.account_name = $1
               and cfl.allow_outbound = true
               and fl.is_active = true
             order by cfl.is_primary desc, fl.code
             limit 1`,
            [accountName]
        );
        if (locationResult.rowCount !== 1) throw new Error("The designated test company needs an active outbound warehouse.");
        const location = locationResult.rows[0];
        const suffix = Date.now().toString(36).toUpperCase().slice(-8);
        const basePayload = {
            poNumber: `TEST-PALLET-${suffix}`,
            shippingReference: `TEST-PALLET-${suffix}`,
            contactName: "Test Receiver",
            contactPhone: "905-555-0100",
            requestedShipDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            orderType: "RETAIL_WHOLESALE",
            shipmentMethod: "LTL_FREIGHT",
            fulfillmentLocationId: location.id,
            shipToName: "WMS365 Test Receiver",
            shipToAddress1: "100 Test Street",
            shipToCity: "Mississauga",
            shipToState: "ON",
            shipToPostalCode: "L5T 1V6",
            shipToCountry: "Canada",
            lines: [{ sku: `TEST-PALLET-${suffix}`, quantity: 1 }]
        };
        const options = {
            enforceInventoryAvailability: false,
            activityTitlePrefix: "test-company verification",
            activityActor: "pallet-persistence-verifier@invalid.example"
        };

        let order = await savePortalOrderDraftForAccount(client, accountName, {
            ...basePayload,
            outboundPallets: { totalPalletsOut: 5 }
        }, null, options);
        if (order.status !== "DRAFT" || order.outboundPallets.totalPalletsOut !== 5) {
            throw new Error("The created LTL draft did not persist five pallets.");
        }
        order = await getPortalOrderById(client, order.id, accountName);
        if (order.outboundPallets.totalPalletsOut !== 5) throw new Error("The reloaded LTL draft lost its pallet total.");

        order = await savePortalOrderDraftForAccount(client, accountName, {
            ...basePayload,
            outboundPallets: { totalPalletsOut: 7 }
        }, order.id, options);
        order = await getPortalOrderById(client, order.id, accountName);
        if (order.outboundPallets.totalPalletsOut !== 7) throw new Error("The updated LTL draft did not persist seven pallets.");

        order = await savePortalOrderDraftForAccount(client, accountName, {
            ...basePayload,
            shipmentMethod: "PARCEL",
            outboundPallets: { totalPalletsOut: 9 }
        }, order.id, options);
        order = await getPortalOrderById(client, order.id, accountName);
        if (order.outboundPallets.totalPalletsOut !== 0) throw new Error("A parcel draft retained an invalid pallet total.");

        console.log(JSON.stringify({
            success: true,
            companyId,
            accountName,
            warehouseCode: location.code,
            createdPallets: 5,
            updatedPallets: 7,
            parcelPallets: 0,
            status: order.status,
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
