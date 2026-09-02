const assert = require("node:assert/strict");
const { Pool } = require("pg");
const {
    getOrderRoutingReadinessSchedule,
    buildOrderRoutingReadinessDeliveryKey,
    getOrderRoutingReadinessWarehouseRecipients
} = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const companyResult = await pool.query(
            `select name from owner_accounts
             where upper(name) like '%TEST%COMPANY%' or upper(name) = 'WMS365 TEST COMPANY'
             order by case when upper(name) = 'WMS365 TEST COMPANY' then 0 else 1 end, name
             limit 1`
        );
        assert.equal(companyResult.rowCount, 1, "The designated WMS365 test company is missing.");
        const accountName = companyResult.rows[0].name;
        const locationResult = await pool.query(
            `select fl.id, fl.code, fl.name, fl.state, fl.country, fl.contact_email
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id
             where cfl.account_name = $1 and cfl.allow_outbound = true and fl.is_active = true
             order by cfl.is_primary desc, fl.code
             limit 1`,
            [accountName]
        );
        assert.equal(locationResult.rowCount, 1, "The test company needs an active outbound warehouse.");
        const location = locationResult.rows[0];
        const order = {
            id: "999999",
            orderCode: "TEST-ROUTING-READINESS",
            accountName,
            status: "RELEASED",
            requestedShipDate: "2026-09-04",
            shipmentMethod: "LTL_FREIGHT",
            fulfillmentLocationId: String(location.id),
            routingEmail: "",
            outboundPallets: { totalPalletsOut: 0 },
            pickedPalletDetails: [],
            routingTotalWeight: null,
            routedAt: null
        };
        const schedule = getOrderRoutingReadinessSchedule(order, {
            now: new Date("2026-09-02T14:00:00.000Z"),
            location
        });
        assert.equal(schedule.eligible, true);
        assert.equal(schedule.reminderDate, "2026-09-02");
        assert.deepEqual(schedule.missing, [
            "Complete the physical pick and move the order to STAGED",
            "Routing email",
            "Total pallet count",
            "Pallet weights and total shipment weight"
        ]);
        const recipients = await getOrderRoutingReadinessWarehouseRecipients(pool, location.id);
        assert.ok(recipients.length > 0, "The test warehouse needs at least one warehouse-only reminder recipient.");
        const customerResult = await pool.query(
            "select lower(email) as email from portal_vendor_access where account_name=$1 and is_active=true",
            [accountName]
        );
        const customerEmails = new Set(customerResult.rows.map((row) => row.email));
        assert.equal(recipients.some((email) => customerEmails.has(email.toLowerCase())), false, "A customer portal address leaked into warehouse reminder recipients.");
        const deliveryKey = buildOrderRoutingReadinessDeliveryKey(order, location, schedule.deliveryDate);
        assert.equal(deliveryKey, `order-routing-readiness:999999:${location.id}:2026-09-04`);
        console.log(JSON.stringify({
            success: true,
            accountName,
            warehouse: location.name || location.code,
            reminderDate: schedule.reminderDate,
            deliveryDate: schedule.deliveryDate,
            warehouseRecipientCount: recipients.length,
            customerRecipientLeak: false,
            databaseWrites: 0
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
