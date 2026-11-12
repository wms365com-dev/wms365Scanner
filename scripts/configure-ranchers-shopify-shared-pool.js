const { Client } = require("pg");

const ACCOUNT_NAME = "RANCHER'S CHIPS";
const SHOP_DOMAIN = "f1acxk-dc.myshopify.com";
const LOCAL_SKU = "RTC-4OZ-12";
const SHOPIFY_LOCATION_ID = "109659226413";
const SHOPIFY_LOCATION_NAME = "GreyWolf";
const UNITS_PER_CASE = 12;
const EXPECTED_CASES = 192;
const EXPECTED_UNITS = EXPECTED_CASES * UNITS_PER_CASE;
const MAPPINGS = [
    ["Ranchers1", 1, "Single bag"],
    ["6-Pack", 6, "Six bags"],
    ["12-Pack", 12, "One 12-bag case"],
    ["18-Pack", 18, "Eighteen bags"],
    ["RC-WS-5C", 60, "Five 12-bag cases"],
    ["RC-WS-10C", 120, "Ten 12-bag cases"],
    ["RC-WS-63C", 756, "Sixty-three 12-bag cases"]
];

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const integrationResult = await client.query(
            `select * from store_integrations
             where account_name = $1 and provider = 'SHOPIFY' and lower(store_identifier) = $2
             for update`,
            [ACCOUNT_NAME, SHOP_DOMAIN]
        );
        if (integrationResult.rowCount !== 1) throw new Error(`Expected one Rancher's Shopify integration, found ${integrationResult.rowCount}.`);
        const integration = integrationResult.rows[0];

        const itemResult = await client.query(
            `select * from item_catalog where account_name = $1 and sku = $2 for update`,
            [ACCOUNT_NAME, LOCAL_SKU]
        );
        if (itemResult.rowCount !== 1) throw new Error(`Expected one ${LOCAL_SKU} item card, found ${itemResult.rowCount}.`);
        const item = itemResult.rows[0];
        if (Number(item.units_per_case) !== UNITS_PER_CASE || String(item.unit_uom || "").toUpperCase() !== "EA") {
            throw new Error(`${LOCAL_SKU} must have EA as its unit UOM and ${UNITS_PER_CASE} units per case before conversion.`);
        }

        const inventoryResult = await client.query(
            `select i.*, b.fulfillment_location_id, f.code as warehouse_code
             from inventory_lines i
             left join bin_locations b on b.code = i.location
             left join fulfillment_locations f on f.id = b.fulfillment_location_id
             where i.account_name = $1 and i.sku = $2
             order by i.id for update of i`,
            [ACCOUNT_NAME, LOCAL_SKU]
        );
        if (!inventoryResult.rowCount) throw new Error(`No live inventory exists for ${LOCAL_SKU}.`);
        const activeAllocationResult = await client.query(
            `select coalesce(sum(a.allocated_quantity), 0)::int as allocated
             from portal_order_allocations a
             join portal_orders o on o.id = a.order_id
             join inventory_lines i on i.id = a.inventory_line_id
             where o.account_name = $1 and o.status = any($2::text[]) and i.sku = $3`,
            [ACCOUNT_NAME, ["RELEASED", "PICKED", "STAGED"], LOCAL_SKU]
        );
        if (Number(activeAllocationResult.rows[0]?.allocated) !== 0) {
            throw new Error(`${LOCAL_SKU} has active order allocations. Convert only after those orders are closed or reopened.`);
        }

        const trackingLevels = new Set(inventoryResult.rows.map((row) => String(row.tracking_level || "").toUpperCase()));
        const onHandBefore = inventoryResult.rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        let converted = false;
        if (trackingLevels.size === 1 && trackingLevels.has("CASE")) {
            if (onHandBefore !== EXPECTED_CASES) throw new Error(`Expected ${EXPECTED_CASES} cases before conversion, found ${onHandBefore}.`);
            for (const line of inventoryResult.rows) {
                const before = Number(line.quantity);
                const after = before * UNITS_PER_CASE;
                await client.query(
                    `update inventory_lines set quantity = $2, tracking_level = 'UNIT', updated_at = now() where id = $1`,
                    [line.id, after]
                );
                await client.query(
                    `insert into inventory_transactions
                        (account_name, warehouse_id, fulfillment_location_id, location, sku, upc,
                         lot_number, expiration_date, transaction_type, quantity_delta, quantity_before,
                         quantity_after, source_type, source_id, idempotency_key, source)
                     values ($1,$2,$3,$4,$5,$6,$7,$8,'UOM_CONVERSION',$9,$10,$11,
                             'SHOPIFY_SHARED_POOL_SETUP',$12,$13,'wms365-shopify-shared-pool')`,
                    [
                        ACCOUNT_NAME,
                        line.warehouse_code || "",
                        line.fulfillment_location_id || null,
                        line.location,
                        LOCAL_SKU,
                        line.upc || "",
                        line.lot_number || "",
                        line.expiration_date || "",
                        after - before,
                        before,
                        after,
                        String(integration.id),
                        `ranchers-shopify-uom-${line.id}`
                    ]
                );
            }
            converted = true;
        } else if (!(trackingLevels.size === 1 && trackingLevels.has("UNIT") && onHandBefore === EXPECTED_UNITS)) {
            throw new Error(`Unexpected inventory state. Tracking ${[...trackingLevels].join(", ")}; quantity ${onHandBefore}.`);
        }

        await client.query(
            `update item_catalog
             set tracking_level = 'UNIT', unit_uom = 'EA', units_per_case = $3, updated_at = now()
             where account_name = $1 and sku = $2`,
            [ACCOUNT_NAME, LOCAL_SKU, UNITS_PER_CASE]
        );
        await client.query(
            `update pallet_records
             set inventory_tracking_level = 'UNIT',
                 inventory_quantity = cases_on_pallet * $3,
                 updated_at = now()
             where account_name = $1 and sku = $2`,
            [ACCOUNT_NAME, LOCAL_SKU, UNITS_PER_CASE]
        );

        for (const [externalSku, multiplier, note] of MAPPINGS) {
            await client.query(
                `insert into store_sku_mappings
                    (account_name, integration_id, local_sku, external_sku, local_quantity_multiplier, note)
                 values ($1,$2,$3,$4,$5,$6)
                 on conflict (integration_id, external_sku)
                 do update set account_name=excluded.account_name,
                               local_sku=excluded.local_sku,
                               local_quantity_multiplier=excluded.local_quantity_multiplier,
                               note=excluded.note,
                               updated_at=now()`,
                [ACCOUNT_NAME, integration.id, LOCAL_SKU, externalSku, multiplier, note]
            );
        }

        const settings = integration.settings && typeof integration.settings === "object" ? integration.settings : {};
        const updatedSettings = {
            ...settings,
            shopifyLocationId: SHOPIFY_LOCATION_ID,
            primaryLocationName: SHOPIFY_LOCATION_NAME,
            allowedShipCountries: ["CA"],
            syncOrders: true,
            syncInventory: true,
            syncShipmentConfirmations: true,
            notifyCustomerOnFulfillment: true,
            inventoryDisconnectIfNecessary: false
        };
        await client.query(
            `update store_integrations
             set settings = $2::jsonb, import_status = 'RELEASED', is_active = true,
                 sync_schedule = 'MANUAL', next_scheduled_sync_at = null, updated_at = now()
             where id = $1`,
            [integration.id, JSON.stringify(updatedSettings)]
        );
        await client.query(
            `insert into activity_log (type, title, details)
             values ('setup', $1, $2)`,
            [
                `Configured Shopify shared inventory for ${ACCOUNT_NAME}`,
                `${LOCAL_SKU} | ${EXPECTED_CASES} cases converted to ${EXPECTED_UNITS} EA | ${MAPPINGS.length} variants | Shopify location ${SHOPIFY_LOCATION_NAME}`
            ]
        );

        const afterResult = await client.query(
            `select coalesce(sum(quantity), 0)::int as on_hand
             from inventory_lines where account_name = $1 and sku = $2`,
            [ACCOUNT_NAME, LOCAL_SKU]
        );
        const availableUnits = Number(afterResult.rows[0]?.on_hand || 0);
        if (availableUnits !== EXPECTED_UNITS) throw new Error(`Expected ${EXPECTED_UNITS} units after conversion, found ${availableUnits}.`);
        await client.query("commit");

        console.log(JSON.stringify({
            ok: true,
            accountName: ACCOUNT_NAME,
            localSku: LOCAL_SKU,
            converted,
            onHandUnits: availableUnits,
            mappings: MAPPINGS.map(([externalSku, multiplier]) => ({
                externalSku,
                unitsPerStoreItem: multiplier,
                shopifyAvailable: Math.floor(availableUnits / multiplier)
            })),
            shopifyLocation: SHOPIFY_LOCATION_NAME,
            syncSchedule: "MANUAL"
        }, null, 2));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
