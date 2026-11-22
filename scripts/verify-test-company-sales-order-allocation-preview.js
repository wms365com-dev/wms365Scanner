const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    APP_USER_ROLES,
    getServerState,
    upsertInventoryLine,
    savePortalOrderDraftForAccount,
    releasePortalOrderForAccount
} = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("DATABASE_URL is required.");

    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    await client.query("begin");

    try {
        const { id: companyId, name: accountName } = await requireDesignatedTestCompany(client);
        const suffix = Date.now().toString(36).toUpperCase().slice(-8);
        const warehouseCodes = [`TAPA${suffix}`, `TAPB${suffix}`];
        const warehouseIds = [];
        for (const [index, code] of warehouseCodes.entries()) {
            const locationResult = await client.query(
                `insert into fulfillment_locations (code, name, partner_name, location_type, address1, city, state, postal_code, country)
                 values ($1, $2, 'WMS365 Test', 'OWN_WAREHOUSE', $3, 'Mississauga', 'ON', 'L5T 1V6', 'Canada')
                 returning id`,
                [code, `Allocation Preview Warehouse ${index + 1}`, `${index + 1} Preview Drive`]
            );
            const warehouseId = locationResult.rows[0].id;
            warehouseIds.push(warehouseId);
            await client.query(
                `insert into company_fulfillment_locations (
                    account_name, fulfillment_location_id, is_primary,
                    allow_inbound, allow_outbound, allow_storage
                 ) values ($1, $2, $3, true, true, true)`,
                [accountName, warehouseId, index === 0]
            );
            await client.query(
                `insert into bin_locations (
                    code, fulfillment_location_id, note, location_type, is_pickable
                 ) values ($1, $2, 'Allocation preview verification', 'STORAGE', true)`,
                [`${code}-A01`, warehouseId]
            );
        }

        const sku = `TEST-ALLOC-${suffix}`;
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level)
             values ($1, $2, 'Allocation preview verification item', 'CASE')`,
            [accountName, sku]
        );
        const actor = {
            role: APP_USER_ROLES.SUPER_ADMIN,
            email: "allocation-preview-verifier@invalid.example",
            full_name: "Allocation Preview Verifier"
        };
        await upsertInventoryLine(client, {
            accountName,
            location: `${warehouseCodes[0]}-A01`,
            sku,
            quantity: 2,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "ALLOCATION_PREVIEW_VERIFY",
            sourceId: suffix,
            appUser: actor,
            idempotencyKey: `${suffix}-warehouse-a`
        });
        await upsertInventoryLine(client, {
            accountName,
            location: `${warehouseCodes[1]}-A01`,
            sku,
            quantity: 20,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "ALLOCATION_PREVIEW_VERIFY",
            sourceId: suffix,
            appUser: actor,
            idempotencyKey: `${suffix}-warehouse-b`
        });

        const requestedShipDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const payload = (reference) => ({
            poNumber: reference,
            shippingReference: reference,
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
            lines: [{ sku, quantity: 1 }]
        });
        const options = {
            enforceInventoryAvailability: true,
            activityTitlePrefix: "test-company verification",
            activityActor: actor.email
        };

        let firstOrder = await savePortalOrderDraftForAccount(client, accountName, payload(`ALLOC-A-${suffix}`), null, options);
        firstOrder = await releasePortalOrderForAccount(client, accountName, firstOrder.id, { activityActor: actor.email });
        const stateAfterFirstRelease = await getServerState(client, { billingEventLimit: 1, appUser: actor });
        const selectedWarehouseLine = stateAfterFirstRelease.inventory.find((line) =>
            line.accountName === accountName && line.sku === sku && line.location === `${warehouseCodes[0]}-A01`
        );
        const otherWarehouseLine = stateAfterFirstRelease.inventory.find((line) =>
            line.accountName === accountName && line.sku === sku && line.location === `${warehouseCodes[1]}-A01`
        );
        if (!selectedWarehouseLine || selectedWarehouseLine.onHandQuantity !== 2
            || selectedWarehouseLine.reservedQuantity !== 1 || selectedWarehouseLine.availableQuantity !== 1) {
            throw new Error("Authoritative state did not report 2 on hand, 1 committed, and 1 allocatable in the selected warehouse.");
        }
        if (!otherWarehouseLine || otherWarehouseLine.availableQuantity !== 20) {
            throw new Error("The other warehouse fixture was not isolated from the selected warehouse commitment.");
        }

        let secondOrder = await savePortalOrderDraftForAccount(client, accountName, payload(`ALLOC-B-${suffix}`), null, options);
        secondOrder = await releasePortalOrderForAccount(client, accountName, secondOrder.id, { activityActor: actor.email });
        const allocations = await client.query(
            `select a.allocated_quantity, i.location
             from portal_order_allocations a
             join inventory_lines i on i.id = a.inventory_line_id
             where a.order_id = $1`,
            [secondOrder.id]
        );
        if (allocations.rowCount !== 1 || Number(allocations.rows[0].allocated_quantity) !== 1
            || allocations.rows[0].location !== `${warehouseCodes[0]}-A01`) {
            throw new Error("The second order did not allocate exactly one case from the selected warehouse.");
        }

        console.log(JSON.stringify({
            success: true,
            companyId,
            accountName,
            selectedWarehouse: warehouseCodes[0],
            otherWarehouse: warehouseCodes[1],
            onHand: selectedWarehouseLine.onHandQuantity,
            committed: selectedWarehouseLine.reservedQuantity,
            allocatable: selectedWarehouseLine.availableQuantity,
            secondAllocation: Number(allocations.rows[0].allocated_quantity),
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
