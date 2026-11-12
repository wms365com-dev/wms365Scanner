const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./scripts/designated-test-company");
const {
    APP_USER_ROLES,
    getPortalInventorySummary,
    upsertInventoryLine
} = require("./server");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const { name: accountName } = await requireDesignatedTestCompany(client);
        const companyResult = await client.query(
            `select fl.id::integer as sole_warehouse_id
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name = $1
               and coalesce(fl.is_active, true)=true
             order by cfl.is_primary desc, fl.id limit 1`,
            [accountName]
        );
        const fulfillmentLocationId = Number(companyResult.rows[0]?.sole_warehouse_id || 0);
        if (!fulfillmentLocationId) {
            throw new Error("The designated test company needs an active warehouse for this check. No fallback is allowed.");
        }

        // Simulate a sole-warehouse tenant only inside this rolled-back test transaction.
        await client.query(
            `delete from company_fulfillment_locations
             where account_name = $1 and fulfillment_location_id <> $2`,
            [accountName, fulfillmentLocationId]
        );

        const suffix = Date.now().toString(36).toUpperCase();
        const sku = `LEGACY-${suffix}`;
        const location = `LEGACY-${suffix}`;
        const actor = {
            role: APP_USER_ROLES.SUPER_ADMIN,
            email: "platform-verifier@wms365.co",
            full_name: "Platform Verifier"
        };
        await client.query(
            `insert into bin_locations (code, note, location_type, is_pickable)
             values ($1, 'Rolled-back sole-warehouse portal verification', 'STORAGE', true)`,
            [location]
        );
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level, unit_uom)
             values ($1, $2, 'Rolled-back legacy portal verification item', 'CASE', 'CASE')`,
            [accountName, sku]
        );
        await upsertInventoryLine(client, {
            accountName,
            location,
            sku,
            quantity: 7,
            trackingLevel: "CASE"
        }, {
            transactionType: "RECEIVING",
            sourceType: "PLATFORM_VERIFY",
            sourceId: suffix,
            appUser: actor,
            idempotencyKey: `${suffix}-legacy-receive`
        });

        const inventory = await getPortalInventorySummary(accountName, client, { fulfillmentLocationId });
        const line = inventory.find((entry) => entry.sku === sku);
        if (Number(line?.availableQuantity || 0) !== 7) {
            throw new Error("Sole-warehouse legacy stock was not visible in the selected portal warehouse.");
        }
        console.log(JSON.stringify({ accountName, fulfillmentLocationId, availableQuantity: 7, rolledBack: true }));
    } finally {
        await client.query("rollback");
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
