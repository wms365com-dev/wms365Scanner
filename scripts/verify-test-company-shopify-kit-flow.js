"use strict";

const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const { applyStoreSkuMappingsToPortalOrderPayload, getItemKitComponentLookup } = require("../server");

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const { name: accountName } = await requireDesignatedTestCompany(client);
        const suffix = Date.now().toString(36).toUpperCase();
        const parentSku = `TEST-KIT-${suffix}`;
        const componentSkus = [1, 2, 3].map((number) => `TEST-KIT-${suffix}-C${number}`);
        for (const sku of [parentSku, ...componentSkus]) {
            await client.query(
                `insert into item_catalog (account_name,sku,description,tracking_level,unit_uom,item_type)
                 values ($1,$2,'Test Shopify kit','UNIT','EACH',$3)`,
                [accountName, sku, sku === parentSku ? "NON_INVENTORY" : "INVENTORY"]
            );
        }
        for (const componentSku of componentSkus) {
            await client.query(
                `insert into item_kit_components (account_name,parent_sku,component_sku,quantity_per_parent,note)
                 values ($1,$2,$3,2,'Rollback-only test-company verification')`,
                [accountName, parentSku, componentSku]
            );
        }

        const kitLookup = await getItemKitComponentLookup(client, accountName, [parentSku]);
        const mapped = applyStoreSkuMappingsToPortalOrderPayload({
            lines: [{ sku: parentSku, quantity: 3 }]
        }, new Map([[parentSku, { localSku: parentSku, localQuantityMultiplier: 1 }]]), kitLookup);
        if (mapped.lines.length !== 3 || mapped.lines.some((line) => line.quantity !== 6)) {
            throw new Error("Test-company kit did not expand to three components at six eaches.");
        }

        const foreignLookup = await getItemKitComponentLookup(client, `${accountName}-FOREIGN`, [parentSku]);
        if (foreignLookup.size !== 0) throw new Error("Kit component lookup crossed company scope.");

        console.log(JSON.stringify({
            accountName,
            parentSku,
            componentCount: mapped.lines.length,
            eachesPerComponent: mapped.lines[0].quantity,
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
