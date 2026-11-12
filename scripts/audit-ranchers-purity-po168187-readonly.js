"use strict";

const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const PO = "168187";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is unavailable.");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        await db.query("begin read only");
        const account = (await db.query(
            "select id,name,is_active from owner_accounts where name=$1",
            [ACCOUNT]
        )).rows;
        const warehouse = (await db.query(
            `select fl.id,fl.code,fl.name,fl.address1,fl.city,fl.state,fl.postal_code,
                    fl.is_active,cfl.allow_outbound,cfl.allow_storage
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and cfl.is_primary=true`,
            [ACCOUNT]
        )).rows;
        const items = (await db.query(
            `select id,sku,upc,description,tracking_level,uom_label,unit_uom,units_per_case,blocked
             from item_catalog
             where account_name=$1 order by sku`,
            [ACCOUNT]
        )).rows;
        const duplicatePo = (await db.query(
            `select order_code,status,po_number,shipping_reference,ship_to_name
             from portal_orders where account_name=$1
               and (regexp_replace(upper(coalesce(po_number,'')),'[^A-Z0-9]','','g')=$2
                 or regexp_replace(upper(coalesce(shipping_reference,'')),'[^A-Z0-9]','','g')=$2)`,
            [ACCOUNT, PO]
        )).rows;
        const purityHistory = (await db.query(
            `select o.order_code,o.status,o.po_number,o.ship_to_name,o.ship_to_address1,o.ship_to_address2,
                    o.ship_to_city,o.ship_to_state,o.ship_to_postal_code,o.ship_to_country,
                    o.confirmed_ship_date::text,ws.total_pallets,ws.total_weight,ws.weight_uom,
                    array_agg(jsonb_build_object('sku',l.sku,'qty',l.requested_quantity)
                              order by l.line_number) lines
             from portal_orders o
             join portal_order_lines l on l.order_id=o.id
             left join warehouse_shipments ws on ws.order_id=o.id
             where o.account_name=$1 and upper(coalesce(o.ship_to_name,'')) like '%PURITY%LIFE%'
             group by o.id,ws.id order by o.id desc limit 20`,
            [ACCOUNT]
        )).rows;
        const inventory = (await db.query(
            `select i.sku,sum(i.quantity)::numeric on_hand,
                    coalesce(sum((select coalesce(sum(a.allocated_quantity),0)
                                  from portal_order_allocations a
                                  join portal_order_lines l on l.id=a.order_line_id
                                  join portal_orders o on o.id=l.order_id
                                  where a.inventory_line_id=i.id
                                    and o.status in ('RELEASED','PICKING','PICKED','STAGED'))),0)::numeric allocated
             from inventory_lines i
             where i.account_name=$1
             group by i.sku order by i.sku`,
            [ACCOUNT]
        )).rows;
        console.log(JSON.stringify({ account, warehouse, items, inventory, duplicatePo, purityHistory }, null, 2));
        await db.query("rollback");
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
