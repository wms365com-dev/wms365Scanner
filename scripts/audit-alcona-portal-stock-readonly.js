"use strict";

const { Client } = require("pg");
const { getPortalInventorySummary } = require("../server");

const ACCOUNT = "ALCONA TRADING LTD";

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin read only");
        const account = await db.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
        if (account.rowCount !== 1 || !account.rows[0].is_active) throw new Error("Exact active Alcona account verification failed.");
        const warehouses = await db.query(`
            select fl.id,fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage,cfl.customer_portal_visible
            from company_fulfillment_locations cfl
            join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
            where cfl.account_name=$1 order by fl.code`, [ACCOUNT]);
        const items = await db.query(`
            select sku,description,tracking_level,item_type,blocked
            from item_catalog where account_name=$1 order by sku`, [ACCOUNT]);
        const inventory = await db.query(`
            select i.sku,i.location,i.quantity,b.location_type,b.is_pickable,b.fulfillment_location_id,b.note,b.updated_at
            from inventory_lines i left join bin_locations b on b.code=i.location
            where i.account_name=$1 and i.quantity<>0 order by i.sku,i.location`, [ACCOUNT]);
        const allocations = await db.query(`
            select a.sku,o.fulfillment_location_id,o.status,sum(a.allocated_quantity)::integer allocated
            from portal_order_allocations a join portal_orders o on o.id=a.order_id
            where o.account_name=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED')
            group by a.sku,o.fulfillment_location_id,o.status order by a.sku,o.fulfillment_location_id,o.status`, [ACCOUNT]);
        const inbounds = await db.query(`
            select i.inbound_code,i.status,i.received_at,l.sku,l.expected_quantity,l.received_quantity,l.received_location
            from portal_inbounds i join portal_inbound_lines l on l.inbound_id=i.id
            where i.account_name=$1 and l.sku in ('MS26053103','MS26062403')
            order by i.created_at desc,i.id desc,l.line_number`, [ACCOUNT]);
        const ledger = await db.query(`
            select server_timestamp,transaction_type,source_type,source_id,sku,location,quantity_delta,quantity_before,quantity_after
            from inventory_transactions where account_name=$1 and sku in ('MS26053103','MS26062403')
            order by server_timestamp desc,id desc limit 40`, [ACCOUNT]);
        const activity = await db.query(`
            select type,title,details,created_at from activity_log
            where title ilike '%Alcona%pickable%' or details ilike '%ALCONA-MS26062403-WHS01-REC-PICKABLE%'
            order by created_at desc,id desc limit 20`);
        const portalUsers = await db.query(`
            select count(*)::integer total,
                   count(*) filter (where is_active=true)::integer active,
                   jsonb_agg(coalesce(portal_permissions,'{}'::jsonb)) filter (where is_active=true) active_permissions
            from portal_vendor_access where account_name=$1`, [ACCOUNT]);
        const portalByWarehouse = [];
        for (const warehouse of warehouses.rows.filter((row) => row.is_active && row.customer_portal_visible)) {
            const summary = await getPortalInventorySummary(ACCOUNT, db, { fulfillmentLocationId: Number(warehouse.id) });
            portalByWarehouse.push({ warehouseId: Number(warehouse.id), warehouseCode: warehouse.code,
                items: summary.map((row) => ({ sku: row.sku, onHand: Number(row.onHandQuantity || 0),
                    reserved: Number(row.reservedQuantity || 0), available: Number(row.availableQuantity || 0) })) });
        }
        console.log(JSON.stringify({ account: account.rows[0], warehouses: warehouses.rows, items: items.rows,
            inventory: inventory.rows, allocations: allocations.rows, inbounds: inbounds.rows,
            ledger: ledger.rows, activity: activity.rows, portalUsers: portalUsers.rows[0], portalByWarehouse }));
        await db.query("rollback");
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
