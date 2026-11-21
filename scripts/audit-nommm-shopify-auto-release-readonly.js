"use strict";

const { Client } = require("pg");

const ACCOUNT = "NOMMM CANADA INC.";
const INTEGRATION_ID = 6;
const STORE = "fresh-canvas-studio-74lsu.myshopify.com";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection unavailable.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin read only");
        const integration = await client.query(
            `select id,is_active,settings,import_status,sync_schedule,next_scheduled_sync_at,
                    last_synced_at,last_sync_status,last_sync_message
               from store_integrations
              where id=$1 and account_name=$2 and provider='SHOPIFY'
                and lower(store_identifier)=$3`,
            [INTEGRATION_ID, ACCOUNT, STORE]
        );
        if (integration.rowCount !== 1) throw new Error("Exact NomNom integration was not found.");
        const imported = await client.query(
            `select o.order_code,o.status
               from store_order_imports i
               join portal_orders o on o.id=i.portal_order_id
              where i.integration_id=$1 and o.account_name=$2
              order by i.id`,
            [INTEGRATION_ID, ACCOUNT]
        );
        const kitRows = await client.query(
            `select parent_sku,component_sku,quantity_per_parent
               from item_kit_components
              where account_name=$1
              order by parent_sku,component_sku`,
            [ACCOUNT]
        );
        const orderLines = await client.query(
            `select o.order_code,l.line_number,l.sku,l.requested_quantity,
                    coalesce(sum(a.allocated_quantity),0)::integer as allocated_quantity,
                    count(distinct a.location)::integer as pick_location_count
               from store_order_imports i
               join portal_orders o on o.id=i.portal_order_id
               join portal_order_lines l on l.order_id=o.id
               left join portal_order_allocations a on a.order_line_id=l.id
              where i.integration_id=$1 and o.account_name=$2
              group by o.order_code,l.line_number,l.sku,l.requested_quantity
              order by o.order_code,l.line_number`,
            [INTEGRATION_ID, ACCOUNT]
        );
        await client.query("rollback");
        const statusCounts = {};
        for (const row of imported.rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
        const row = integration.rows[0];
        const settings = row.settings || {};
        console.log(JSON.stringify({
            readOnly: true,
            account: ACCOUNT,
            integrationId: INTEGRATION_ID,
            store: STORE,
            integration: {
                active: row.is_active === true,
                ordersEnabled: settings.syncOrders === true,
                inventoryExportDisabled: settings.syncInventory !== true,
                shipmentExportDisabled: settings.syncShipmentConfirmations !== true,
                buyerNotificationsDisabled: settings.notifyCustomerOnFulfillment !== true,
                importStatus: row.import_status,
                schedule: row.sync_schedule,
                nextScheduledSyncAt: row.next_scheduled_sync_at,
                lastSyncedAt: row.last_synced_at,
                lastSyncStatus: row.last_sync_status,
                lastSyncMessage: row.last_sync_message
            },
            importedOrders: imported.rowCount,
            statusCounts,
            orderCodes: imported.rows.map((entry) => entry.order_code),
            orderLines: orderLines.rows.map((entry) => ({
                orderCode: entry.order_code,
                lineNumber: entry.line_number,
                sku: entry.sku,
                requestedQuantity: entry.requested_quantity,
                allocatedQuantity: entry.allocated_quantity,
                pickLocationCount: entry.pick_location_count
            })),
            kitComponentRows: kitRows.rowCount,
            kitParents: [...new Set(kitRows.rows.map((entry) => entry.parent_sku))].sort()
        }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
});
