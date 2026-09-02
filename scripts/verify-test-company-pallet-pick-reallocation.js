const { Client } = require("pg");
const { reallocatePortalOrderToActualPalletLocations } = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");

    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");

    try {
        const companyResult = await client.query(`
            select name
            from owner_accounts
            where upper(name) like '%TEST%COMPANY%'
            order by case when upper(name) = 'WMS365 TEST COMPANY' then 0 else 1 end, name
            limit 1
        `);
        const accountName = companyResult.rows[0]?.name;
        if (!accountName) throw new Error("No WMS365 test company is configured.");

        const suffix = Date.now().toString(36).toUpperCase().slice(-7);
        const primaryWarehouseCode = `TPA${suffix}`;
        const otherWarehouseCode = `TPB${suffix}`;
        const warehouses = [];
        for (const [index, code] of [primaryWarehouseCode, otherWarehouseCode].entries()) {
            const result = await client.query(
                `insert into fulfillment_locations (code, name, partner_name, location_type, address1, city, state, postal_code, country)
                 values ($1, $2, 'WMS365 Test', 'OWN_WAREHOUSE', $3, 'Mississauga', 'ON', 'L5T 1V6', 'Canada')
                 returning id`,
                [code, `Test Pallet Pick Warehouse ${index + 1}`, `${index + 1} Test Pallet Drive`]
            );
            const id = Number(result.rows[0].id);
            warehouses.push({ id, code });
            await client.query(
                `insert into company_fulfillment_locations
                    (account_name, fulfillment_location_id, is_primary, allow_inbound, allow_outbound, allow_storage)
                 values ($1, $2, $3, true, true, true)`,
                [accountName, id, index === 0]
            );
        }

        const sku = `TEST-PALLET-${suffix}`;
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level)
             values ($1, $2, 'Test pallet pick reallocation', 'PALLET')`,
            [accountName, sku]
        );

        const locations = {
            original: `${primaryWarehouseCode}-A01`,
            actual: `${primaryWarehouseCode}-A02`,
            hold: `${primaryWarehouseCode}-HOLD`,
            otherWarehouse: `${otherWarehouseCode}-A01`
        };
        for (const [name, code] of Object.entries(locations)) {
            const isHold = name === "hold";
            const fulfillmentLocationId = name === "otherWarehouse" ? warehouses[1].id : warehouses[0].id;
            await client.query(
                `insert into bin_locations
                    (code, note, location_type, is_pickable, account_name, fulfillment_location_id)
                 values ($1, 'Test-company pallet reallocation verification', $2, $3, $4, $5)`,
                [code, isHold ? "QA_HOLD" : "STORAGE", !isHold, accountName, fulfillmentLocationId]
            );
        }

        const inventoryByLocation = new Map();
        for (const location of Object.values(locations)) {
            const result = await client.query(
                `insert into inventory_lines
                    (account_name, location, sku, tracking_level, quantity)
                 values ($1, $2, $3, 'PALLET', 1)
                 returning id`,
                [accountName, location, sku]
            );
            inventoryByLocation.set(location, Number(result.rows[0].id));
        }

        const orderResult = await client.query(
            `insert into portal_orders
                (order_code, account_name, status, fulfillment_location_id, outbound_total_pallets)
             values ($1, $2, 'RELEASED', $3, 1)
             returning id`,
            [`TEST-PALLET-${suffix}`, accountName, warehouses[0].id]
        );
        const orderId = Number(orderResult.rows[0].id);
        const lineResult = await client.query(
            `insert into portal_order_lines (order_id, line_number, sku, requested_quantity)
             values ($1, 1, $2, 1)
             returning id`,
            [orderId, sku]
        );
        await client.query(
            `insert into portal_order_allocations
                (order_id, order_line_id, inventory_line_id, sku, location, tracking_level, allocated_quantity)
             values ($1, $2, $3, $4, $5, 'PALLET', 1)`,
            [orderId, lineResult.rows[0].id, inventoryByLocation.get(locations.original), sku, locations.original]
        );

        const order = {
            id: String(orderId),
            orderCode: `TEST-PALLET-${suffix}`,
            accountName,
            fulfillmentLocationId: String(warehouses[0].id)
        };
        const worker = { role: "WAREHOUSE_WORKER", email: "test-pallet-worker@example.invalid" };
        const changed = await reallocatePortalOrderToActualPalletLocations(client, order, [
            { palletNumber: 1, location: locations.actual, weight: 1000, weightUom: "LB" }
        ], worker);
        if (changed.length !== 1 || changed[0].toLocation !== locations.actual) {
            throw new Error("Valid same-warehouse actual-bin substitution did not complete.");
        }
        const savedAllocation = await client.query(
            "select inventory_line_id, location from portal_order_allocations where order_id = $1",
            [orderId]
        );
        if (savedAllocation.rows[0]?.location !== locations.actual
            || Number(savedAllocation.rows[0]?.inventory_line_id) !== inventoryByLocation.get(locations.actual)) {
            throw new Error("The allocation was not moved to the physical pick bin.");
        }

        let crossWarehouseRejected = false;
        try {
            await reallocatePortalOrderToActualPalletLocations(client, order, [
                { palletNumber: 1, location: locations.otherWarehouse, weight: 1000, weightUom: "LB" }
            ], worker);
        } catch (error) {
            crossWarehouseRejected = error?.statusCode === 400 || error?.statusCode === 403;
        }
        if (!crossWarehouseRejected) throw new Error("Cross-warehouse actual-bin substitution was not rejected.");

        let nonPickableRejected = false;
        try {
            await reallocatePortalOrderToActualPalletLocations(client, order, [
                { palletNumber: 1, location: locations.hold, weight: 1000, weightUom: "LB" }
            ], worker);
        } catch (error) {
            nonPickableRejected = error?.statusCode === 409;
        }
        if (!nonPickableRejected) throw new Error("Non-pickable actual-bin substitution was not rejected.");

        console.log(JSON.stringify({
            accountName,
            validSameWarehouseSubstitution: true,
            crossWarehouseRejected,
            nonPickableRejected,
            inventoryLedgerRows: Number((await client.query(
                "select count(*)::integer as count from inventory_transactions where source_type = 'PORTAL_ORDER_PALLET_REALLOCATION' and source_id = $1",
                [String(orderId)]
            )).rows[0]?.count || 0),
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
