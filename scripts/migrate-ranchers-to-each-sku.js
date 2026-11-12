const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const OLD_SKU = "RTC-4OZ-12";
const NEW_SKU = "RTC-4OZ-EA";
const NEW_DESCRIPTION = "Rancher's Tallow Chips - 4 oz";
const RETIRED_DESCRIPTION = "Rancher's Tallow Chips - 4 oz (Case of 12) - Retired";
const EXPECTED_ON_HAND_EA = 2304;

async function count(client, sql, params) {
    const result = await client.query(sql, params);
    return Number(result.rows[0]?.count || 0);
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");

    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    await client.query("begin isolation level serializable");

    try {
        await client.query(
            "select pg_advisory_xact_lock(hashtext($1))",
            [`sku-migration:${ACCOUNT}:${OLD_SKU}:${NEW_SKU}`]
        );

        const integrationResult = await client.query(
            `select id, integration_name, sync_claimed_at
             from store_integrations
             where account_name = $1 and provider = 'SHOPIFY'
             for update`,
            [ACCOUNT]
        );
        if (integrationResult.rowCount !== 1) {
            throw new Error(`Expected one Ranchers Shopify integration, found ${integrationResult.rowCount}.`);
        }
        if (integrationResult.rows[0].sync_claimed_at) {
            throw new Error("The Ranchers Shopify integration is currently syncing. No changes were made; retry shortly.");
        }

        const oldItemResult = await client.query(
            "select * from item_catalog where account_name = $1 and sku = $2 for update",
            [ACCOUNT, OLD_SKU]
        );
        if (oldItemResult.rowCount !== 1) {
            throw new Error(`Expected one ${OLD_SKU} item, found ${oldItemResult.rowCount}.`);
        }

        const newItemResult = await client.query(
            "select * from item_catalog where account_name = $1 and sku = $2 for update",
            [ACCOUNT, NEW_SKU]
        );
        if (newItemResult.rowCount !== 0) {
            throw new Error(`${NEW_SKU} already exists. No changes were made.`);
        }

        const inventoryResult = await client.query(
            `select i.*, b.fulfillment_location_id, fl.code as warehouse_code
             from inventory_lines i
             left join bin_locations b on b.code = i.location
             left join fulfillment_locations fl on fl.id = b.fulfillment_location_id
             where i.account_name = $1 and i.sku = $2
             order by i.id
             for update of i`,
            [ACCOUNT, OLD_SKU]
        );
        if (inventoryResult.rowCount !== 3) {
            throw new Error(`Expected three Ranchers inventory lines, found ${inventoryResult.rowCount}.`);
        }

        const onHand = inventoryResult.rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
        if (onHand !== EXPECTED_ON_HAND_EA) {
            throw new Error(`Expected ${EXPECTED_ON_HAND_EA.toLocaleString()} EA, found ${onHand.toLocaleString()} EA.`);
        }
        if (inventoryResult.rows.some((row) => String(row.tracking_level || "").toUpperCase() !== "UNIT")) {
            throw new Error("All Ranchers inventory must be tracked as UNIT before this correction.");
        }

        const activeStatuses = ["RELEASED", "PICKED", "STAGED"];
        const nonActiveOrderCount = await count(
            client,
            `select count(*)
             from portal_order_lines l
             join portal_orders o on o.id = l.order_id
             where o.account_name = $1 and l.sku = $2 and not (o.status = any($3::text[]))`,
            [ACCOUNT, OLD_SKU, activeStatuses]
        );
        if (nonActiveOrderCount !== 0) {
            throw new Error(`${nonActiveOrderCount} closed or historical order lines use ${OLD_SKU}; review is required.`);
        }

        const beforeCounts = {
            inventoryLines: inventoryResult.rowCount,
            orderLines: await count(
                client,
                `select count(*) from portal_order_lines l
                 join portal_orders o on o.id=l.order_id
                 where o.account_name=$1 and l.sku=$2`,
                [ACCOUNT, OLD_SKU]
            ),
            allocations: await count(
                client,
                `select count(*) from portal_order_allocations a
                 join portal_orders o on o.id=a.order_id
                 where o.account_name=$1 and a.sku=$2`,
                [ACCOUNT, OLD_SKU]
            ),
            shipmentLines: await count(
                client,
                `select count(*) from warehouse_shipment_lines wsl
                 join warehouse_shipments ws on ws.id=wsl.shipment_id
                 where ws.account_name=$1 and wsl.sku=$2`,
                [ACCOUNT, OLD_SKU]
            ),
            mappings: await count(
                client,
                "select count(*) from store_sku_mappings where account_name=$1 and local_sku=$2",
                [ACCOUNT, OLD_SKU]
            )
        };

        const snapshot = await client.query(
            `select jsonb_build_object(
                'account', $1::text,
                'oldSku', $2::text,
                'newSku', $3::text,
                'item', (select to_jsonb(c) from item_catalog c where c.account_name=$1 and c.sku=$2),
                'inventory', (select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb)
                    from inventory_lines i where i.account_name=$1 and i.sku=$2),
                'orderLines', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb)
                    from portal_order_lines l join portal_orders o on o.id=l.order_id
                    where o.account_name=$1 and l.sku=$2),
                'allocations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
                    from portal_order_allocations a join portal_orders o on o.id=a.order_id
                    where o.account_name=$1 and a.sku=$2),
                'shipmentLines', (select coalesce(jsonb_agg(to_jsonb(wsl) order by wsl.id), '[]'::jsonb)
                    from warehouse_shipment_lines wsl join warehouse_shipments ws on ws.id=wsl.shipment_id
                    where ws.account_name=$1 and wsl.sku=$2),
                'mappings', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)
                    from store_sku_mappings m where m.account_name=$1 and m.local_sku=$2)
            ) as payload`,
            [ACCOUNT, OLD_SKU, NEW_SKU]
        );
        const backupResult = await client.query(
            `insert into import_backups (backup_type, created_by, source_ip, backup_payload)
             values ('ITEM_SKU_CORRECTION', 'Codex approved live correction', 'local-agent', $1::jsonb)
             returning id`,
            [JSON.stringify(snapshot.rows[0].payload)]
        );

        const oldItem = oldItemResult.rows[0];
        await client.query(
            `insert into item_catalog (
                account_name, sku, upc, description, tracking_level, uom_label, unit_uom,
                units_per_case, each_length, each_width, each_height, case_length, case_width,
                case_height, image_url, lot_tracked, expiration_tracked, item_type, item_category,
                blocked, costing_method, unit_cost, unit_price, replenishment_system, vendor_no,
                vendor_item_no, lead_time_days, created_at, updated_at
             ) values (
                $1,$2,$3,$4,'UNIT','Each','EA',12,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                false,$16,$17,$18,$19,$20,$21,$22,now(),now()
             )`,
            [
                ACCOUNT, NEW_SKU, oldItem.upc || "", NEW_DESCRIPTION,
                oldItem.each_length, oldItem.each_width, oldItem.each_height,
                oldItem.case_length, oldItem.case_width, oldItem.case_height,
                oldItem.image_url || "", oldItem.lot_tracked === true, oldItem.expiration_tracked === true,
                oldItem.item_type || "INVENTORY", oldItem.item_category || "",
                oldItem.costing_method || "FIFO", oldItem.unit_cost, oldItem.unit_price,
                oldItem.replenishment_system || "PURCHASE", oldItem.vendor_no || "",
                oldItem.vendor_item_no || "", oldItem.lead_time_days
            ]
        );
        await client.query(
            `update item_catalog
             set description=$3, tracking_level='CASE', uom_label='Cases', unit_uom='EA',
                 units_per_case=12, blocked=true, updated_at=now()
             where account_name=$1 and sku=$2`,
            [ACCOUNT, OLD_SKU, RETIRED_DESCRIPTION]
        );

        const moved = {};
        moved.inventoryLines = (await client.query(
            "update inventory_lines set sku=$3, updated_at=now() where account_name=$1 and sku=$2",
            [ACCOUNT, OLD_SKU, NEW_SKU]
        )).rowCount;
        moved.orderLines = (await client.query(
            `update portal_order_lines l set sku=$3, updated_at=now()
             from portal_orders o where o.id=l.order_id and o.account_name=$1 and l.sku=$2`,
            [ACCOUNT, OLD_SKU, NEW_SKU]
        )).rowCount;
        moved.allocations = (await client.query(
            `update portal_order_allocations a set sku=$3, updated_at=now()
             from portal_orders o where o.id=a.order_id and o.account_name=$1 and a.sku=$2`,
            [ACCOUNT, OLD_SKU, NEW_SKU]
        )).rowCount;
        moved.shipmentLines = (await client.query(
            `update warehouse_shipment_lines wsl set sku=$3, updated_at=now()
             from warehouse_shipments ws where ws.id=wsl.shipment_id and ws.account_name=$1 and wsl.sku=$2`,
            [ACCOUNT, OLD_SKU, NEW_SKU]
        )).rowCount;
        moved.mappings = (await client.query(
            "update store_sku_mappings set local_sku=$3, updated_at=now() where account_name=$1 and local_sku=$2",
            [ACCOUNT, OLD_SKU, NEW_SKU]
        )).rowCount;

        for (const line of inventoryResult.rows) {
            await client.query(
                `insert into inventory_transactions (
                    account_name, warehouse_id, fulfillment_location_id, location, sku, upc,
                    lot_number, expiration_date, transaction_type, quantity_delta,
                    quantity_before, quantity_after, source_type, source_id,
                    idempotency_key, source
                 ) values ($1,$2,$3,$4,$5,$6,$7,$8,'SKU_RENAME',0,$9,$9,
                           'ITEM_MASTER_CORRECTION',$10,$11,'wms365-approved-sku-correction')`,
                [
                    ACCOUNT, line.warehouse_code || "GW3PL-MISS", line.fulfillment_location_id || null,
                    line.location, NEW_SKU, line.upc || oldItem.upc || "", line.lot_number || "",
                    line.expiration_date || "", Number(line.quantity), `${OLD_SKU}->${NEW_SKU}`,
                    `ranchers-sku-rename-${line.id}`
                ]
            );
        }

        await client.query(
            `insert into activity_log (type, title, details)
             values ('item', $1, $2)`,
            [
                `Corrected Ranchers base inventory SKU to ${NEW_SKU}`,
                `${OLD_SKU} retired and blocked | ${NEW_SKU} ${NEW_DESCRIPTION} | ${onHand} EA | rollback backup ${backupResult.rows[0].id}`
            ]
        );

        for (const key of Object.keys(beforeCounts)) {
            if (moved[key] !== beforeCounts[key]) {
                throw new Error(`Verification failed for ${key}: expected ${beforeCounts[key]}, moved ${moved[key]}.`);
            }
        }

        const remainingOperationalReferences =
            await count(client, "select count(*) from inventory_lines where account_name=$1 and sku=$2", [ACCOUNT, OLD_SKU]) +
            await count(client, `select count(*) from portal_order_lines l join portal_orders o on o.id=l.order_id where o.account_name=$1 and l.sku=$2`, [ACCOUNT, OLD_SKU]) +
            await count(client, `select count(*) from portal_order_allocations a join portal_orders o on o.id=a.order_id where o.account_name=$1 and a.sku=$2`, [ACCOUNT, OLD_SKU]) +
            await count(client, `select count(*) from warehouse_shipment_lines wsl join warehouse_shipments ws on ws.id=wsl.shipment_id where ws.account_name=$1 and wsl.sku=$2`, [ACCOUNT, OLD_SKU]) +
            await count(client, "select count(*) from store_sku_mappings where account_name=$1 and local_sku=$2", [ACCOUNT, OLD_SKU]);
        if (remainingOperationalReferences !== 0) {
            throw new Error(`${remainingOperationalReferences} operational references still use ${OLD_SKU}.`);
        }

        const newOnHand = await count(
            client,
            "select coalesce(sum(quantity),0) as count from inventory_lines where account_name=$1 and sku=$2",
            [ACCOUNT, NEW_SKU]
        );
        if (newOnHand !== EXPECTED_ON_HAND_EA) {
            throw new Error(`Post-migration stock is ${newOnHand}; expected ${EXPECTED_ON_HAND_EA}.`);
        }

        const itemVerification = await client.query(
            `select sku, description, tracking_level, unit_uom, units_per_case, blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [ACCOUNT, [OLD_SKU, NEW_SKU]]
        );

        await client.query("commit");
        console.log(JSON.stringify({
            success: true,
            account: ACCOUNT,
            oldSku: OLD_SKU,
            newSku: NEW_SKU,
            description: NEW_DESCRIPTION,
            onHandEa: newOnHand,
            rollbackBackupId: backupResult.rows[0].id,
            migrated: moved,
            items: itemVerification.rows
        }, null, 2));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
