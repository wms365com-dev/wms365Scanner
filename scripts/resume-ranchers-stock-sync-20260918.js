const { Client } = require("pg");
const {
    claimStoreIntegrationSync, releaseStoreIntegrationSyncClaim,
    decryptStoreIntegrationRow, exportShopifyInventoryLevels,
    buildShopifyInventoryAvailabilityLookup
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const SHOP = "f1acxk-dc.myshopify.com";
const SKU = "RTC-4OZ-EA";
const LOCATION = "109659226413";
const EXPECTED = new Map([
    ["RANCHERS1", 1], ["6-PACK", 6], ["12-PACK", 12], ["18-PACK", 18],
    ["RC-WS-5C", 60], ["RC-WS-10C", 120], ["RC-WS-63C", 756]
]);

async function request(resource, token) {
    const response = await fetch(`https://${SHOP}/admin/api/2026-01${resource}`, {
        headers: { Accept: "application/json", "X-Shopify-Access-Token": token },
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Shopify read-back failed (${response.status}).`);
    return response.json();
}

async function main() {
    if (process.env.CONFIRM_RANCHERS_STOCK_SYNC !== "RESUME_AND_PUBLISH") throw new Error("Owner authorization is required.");
    const client = new Client({ connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    await client.connect();
    let claim;
    let enabled = false;
    try {
        const row = (await client.query("select * from store_integrations where id=4 and account_name=$1 and provider='SHOPIFY' and store_identifier=$2", [ACCOUNT, SHOP])).rows[0];
        if (!row || !row.is_active || row.sync_schedule !== "EVERY_5_MINUTES"
            || row.settings.shopifyLocationId !== LOCATION) throw new Error("Integration scope or schedule mismatch.");
        const owner = await client.query("select id from owner_accounts where id=5062 and name=$1", [ACCOUNT]);
        if (owner.rowCount !== 1) throw new Error("Company identity mismatch.");
        const mappings = (await client.query("select account_name,external_sku,local_sku,local_quantity_multiplier from store_sku_mappings where integration_id=4 order by id")).rows;
        if (mappings.length !== EXPECTED.size || mappings.some(m => m.account_name !== ACCOUNT
            || m.local_sku !== SKU || EXPECTED.get(m.external_sku.toUpperCase()) !== Number(m.local_quantity_multiplier))) {
            throw new Error("Shared-inventory mappings changed; stop for review.");
        }
        claim = await claimStoreIntegrationSync(client, 4);
        if (!claim) throw new Error("Shopify is already syncing; no changes made.");
        const integration = decryptStoreIntegrationRow(claim.row);
        const tokenResponse = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "client_credentials", client_id: integration.auth_client_id,
                client_secret: integration.auth_client_secret }), signal: AbortSignal.timeout(30000)
        });
        const auth = await tokenResponse.json();
        if (!tokenResponse.ok || !auth.access_token) throw new Error(`Shopify authentication failed (${tokenResponse.status}).`);
        const token = auth.access_token;
        const location = (await request(`/locations/${LOCATION}.json`, token)).location;
        if (!location || String(location.id) !== LOCATION || location.name !== "GreyWolf" || !location.active) throw new Error("Shopify location mismatch.");
        const variants = (await request("/variants.json?limit=250&fields=id,sku,inventory_item_id,inventory_policy,inventory_management", token)).variants || [];
        const variantBySku = new Map(variants.map(v => [String(v.sku).toUpperCase(), v]));
        if (mappings.some(m => !variantBySku.get(m.external_sku.toUpperCase())?.inventory_item_id)) throw new Error("A mapped Shopify variant is missing.");
        if (mappings.some(m => {
            const variant = variantBySku.get(m.external_sku.toUpperCase());
            return variant.inventory_policy !== "deny" || variant.inventory_management !== "shopify";
        })) throw new Error("Automatic inventory sync remains paused: disable Shopify continue-selling and enable Shopify inventory tracking first.");
        await client.query("update store_integrations set settings=jsonb_set(settings,'{syncInventory}','true'::jsonb),updated_at=now() where id=4 and sync_claim_token=$1", [claim.token]);
        enabled = true;
        integration.settings = { ...integration.settings, syncInventory: true };
        let updates;
        let summary;
        let availability;
        for (let attempt = 0; attempt < 2; attempt++) {
            summary = await exportShopifyInventoryLevels(client, integration);
            if (summary.failedCount) throw new Error(`Inventory export failed: ${summary.detailMessages.join(" | ")}`);
            availability = (await buildShopifyInventoryAvailabilityLookup(client, ACCOUNT)).get(SKU);
            const ids = mappings.map(m => variantBySku.get(m.external_sku.toUpperCase()).inventory_item_id).join(",");
            const levels = (await request(`/inventory_levels.json?location_ids=${LOCATION}&inventory_item_ids=${ids}&limit=250`, token)).inventory_levels || [];
            const byItem = new Map(levels.map(l => [String(l.inventory_item_id), l]));
            updates = mappings.map(m => {
                const variant = variantBySku.get(m.external_sku.toUpperCase());
                const level = byItem.get(String(variant.inventory_item_id));
                return { shopifySku: m.external_sku, bagsPerPack: Number(m.local_quantity_multiplier),
                    expected: Math.floor(availability.availableQuantity / Number(m.local_quantity_multiplier)),
                    actual: level ? Number(level.available) : null, locationId: level ? String(level.location_id) : null };
            });
            if (updates.every(u => u.actual === u.expected && u.locationId === LOCATION)) break;
            if (attempt === 1) throw new Error("Shopify quantities did not match current unreserved WMS inventory.");
        }
        const finalVariants = (await request("/variants.json?limit=250&fields=sku,inventory_policy,inventory_management", token)).variants || [];
        const policies = new Map(finalVariants.map(v => [String(v.sku).toUpperCase(), v]));
        const policyWarnings = mappings.filter(m => policies.get(m.external_sku.toUpperCase())?.inventory_policy !== "deny"
            || policies.get(m.external_sku.toUpperCase())?.inventory_management !== "shopify").map(m => m.external_sku);
        if (policyWarnings.length) throw new Error("Shopify oversell protection verification failed; automatic sync will remain paused.");
        const syncStatus = policyWarnings.length ? "WARNING" : "SUCCESS";
        await client.query(`update store_integrations set last_synced_at=now(),last_sync_status=$3,
            last_sync_message=$2,next_scheduled_sync_at=now()+interval '5 minutes',updated_at=now()
            where id=4 and sync_claim_token=$1`, [claim.token, `Inventory-only sync: ${updates.length} levels verified; ${availability.availableQuantity} bags available. Automatic sync resumed.${policyWarnings.length ? " Oversell protection requires Shopify write_products approval or manual deny settings." : ""}`, syncStatus]);
        await client.query("insert into activity_log(type,title,details) values('integration',$1,$2)", [
            "Resumed Rancher's Shopify inventory synchronization",
            `${SHOP} | GreyWolf ${LOCATION} | ${availability.onHandQuantity} bags on hand | ${availability.availableQuantity} available | 7 mapped pack sizes verified | every 5 minutes | owner request September 18, 2026`
        ]);
        const saved = (await client.query("select settings->>'syncInventory' inventory_sync,sync_schedule,last_sync_status from store_integrations where id=4")).rows[0];
        if (saved.inventory_sync !== "true" || saved.last_sync_status !== syncStatus) throw new Error("Saved sync configuration verification failed.");
        console.log(JSON.stringify({ outcome: "synced-and-verified", onHandBags: availability.onHandQuantity,
            availableBags: availability.availableQuantity, reservedBags: availability.onHandQuantity - availability.availableQuantity,
            schedule: saved.sync_schedule, updates, policyWarnings,
            oversellProtection: policyWarnings.length ? "merchant-action-required" : "deny", orderStatusesChanged: false }));
    } catch (error) {
        if (claim) {
            if (enabled) await client.query("update store_integrations set settings=jsonb_set(settings,'{syncInventory}','false'::jsonb),updated_at=now() where id=4 and sync_claim_token=$1", [claim.token]);
            await client.query("update store_integrations set last_sync_status='ERROR',last_sync_message=$2,updated_at=now() where id=4 and sync_claim_token=$1", [claim.token, error.message]);
        }
        throw error;
    } finally {
        if (claim) await releaseStoreIntegrationSyncClaim(client, 4, claim.token);
        await client.end();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
