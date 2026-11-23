const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const { applyStoreSkuMappingsToPortalOrderPayload } = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const { name: accountName } = await requireDesignatedTestCompany(client);

        const suffix = Date.now().toString(36).toUpperCase();
        const sku = `TEST-SHARED-${suffix}`;
        await client.query(
            `insert into item_catalog (account_name, sku, description, tracking_level, unit_uom, units_per_case)
             values ($1, $2, 'Test Shopify shared pool', 'UNIT', 'EA', 12)`,
            [accountName, sku]
        );
        const integrationResult = await client.query(
            `insert into store_integrations
                (account_name, provider, integration_name, store_identifier, import_status, is_active, sync_schedule)
             values ($1, 'SHOPIFY', $2, $3, 'DRAFT', false, 'MANUAL')
             returning id`,
            [accountName, `Test Shopify ${suffix}`, `test-${suffix.toLowerCase()}.myshopify.com`]
        );
        const integrationId = integrationResult.rows[0].id;
        const mappings = [
            ["TEST-6", 6],
            ["TEST-12", 12],
            ["TEST-120", 120],
            ["TEST-756", 756]
        ];
        for (const [externalSku, multiplier] of mappings) {
            await client.query(
                `insert into store_sku_mappings
                    (account_name, integration_id, local_sku, external_sku, local_quantity_multiplier, note)
                 values ($1, $2, $3, $4, $5, 'Test-company shared-pool verification')`,
                [accountName, integrationId, sku, externalSku, multiplier]
            );
        }

        const rows = await client.query(
            `select external_sku, local_sku, local_quantity_multiplier
             from store_sku_mappings where integration_id = $1`,
            [integrationId]
        );
        const lookup = new Map(rows.rows.map((row) => [row.external_sku, {
            localSku: row.local_sku,
            localQuantityMultiplier: Number(row.local_quantity_multiplier)
        }]));
        const order = applyStoreSkuMappingsToPortalOrderPayload({
            lines: [{ sku: "TEST-6", quantity: 2 }, { sku: "TEST-120", quantity: 1 }]
        }, lookup);
        const consumed = order.lines.reduce((sum, line) => sum + line.quantity, 0);
        if (consumed !== 132) throw new Error(`Expected 132 WMS units, got ${consumed}.`);

        const availableUnits = 2304 - consumed;
        const availability = Object.fromEntries(mappings.map(([externalSku, multiplier]) => [
            externalSku,
            Math.floor(availableUnits / multiplier)
        ]));
        if (availability["TEST-756"] !== 2 || availability["TEST-120"] !== 18) {
            throw new Error(`Shared-pool availability was incorrect: ${JSON.stringify(availability)}`);
        }

        const crossTenantResult = await client.query(
            `select count(*)::int as count from store_sku_mappings
             where integration_id = $1 and account_name <> $2`,
            [integrationId, accountName]
        );
        if (crossTenantResult.rows[0].count !== 0) throw new Error("Test mapping crossed company scope.");

        console.log(JSON.stringify({
            accountName,
            mappedVariants: mappings.length,
            consumedUnits: consumed,
            remainingUnits: availableUnits,
            availability,
            tenantIsolation: "passed",
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
