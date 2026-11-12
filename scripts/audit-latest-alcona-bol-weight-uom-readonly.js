"use strict";

const { Pool } = require("pg");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const result = await pool.query(`
            select o.id, o.order_code, o.status, o.routing_total_weight, o.routing_weight_uom,
                   o.picked_pallet_details, o.updated_at,
                   ws.id as shipment_id, ws.total_weight as shipment_total_weight,
                   ws.weight_uom as shipment_weight_uom, ws.updated_at as shipment_updated_at,
                   d.id as document_id, d.file_name, d.created_at as document_created_at
            from portal_orders o
            left join lateral (
                select s.* from warehouse_shipments s
                where s.order_id = o.id
                order by s.updated_at desc, s.id desc limit 1
            ) ws on true
            left join lateral (
                select od.* from portal_order_documents od
                where od.order_id = o.id and upper(coalesce(od.document_category, '')) like '%BOL%'
                order by od.created_at desc, od.id desc limit 1
            ) d on true
            where o.account_name = 'ALCONA TRADING LTD'
              and (d.id is not null or ws.id is not null)
            order by coalesce(d.created_at, ws.updated_at, o.updated_at) desc
            limit 5
        `);
        console.log(JSON.stringify(result.rows, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
