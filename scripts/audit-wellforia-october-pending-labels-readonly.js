"use strict";

const { Client } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const START = "2026-10-01";
const END = "2026-11-01";

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin read only");
    const result = await db.query(
      `select o.id,o.order_code,o.status,o.requested_ship_date::text,o.created_at,
              o.shipment_method,o.shipped_carrier_name,o.shipped_tracking_reference,
              fl.code warehouse_code,
              coalesce((select sum(l.requested_quantity) from portal_order_lines l where l.order_id=o.id),0)::integer requested_quantity,
              coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_id=o.id),0)::integer allocated_quantity,
              coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',d.file_name,'category',d.document_category) order by d.id)
                          from portal_order_documents d where d.order_id=o.id),'[]'::jsonb) documents,
              coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'status',s.status,'carrier',s.carrier_name,'tracking',s.tracking_reference) order by s.id)
                          from warehouse_shipments s where s.order_id=o.id),'[]'::jsonb) shipments
         from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
        where o.account_name=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED')
          and o.requested_ship_date >= $2::date and o.requested_ship_date < $3::date
        order by o.requested_ship_date,o.order_code`,
      [ACCOUNT, START, END]
    );
    const duplicates = await db.query(
      `select upper(trim(shipped_tracking_reference)) tracking,count(*)::integer count,
              array_agg(order_code order by order_code) orders
         from portal_orders where nullif(trim(shipped_tracking_reference),'') is not null
        group by upper(trim(shipped_tracking_reference)) having count(*)>1`
    );
    await db.query("rollback");
    const duplicateMap = new Map(duplicates.rows.map((row) => [row.tracking, row]));
    const orders = result.rows.map((row) => ({
      ...row,
      fullyAllocated: Number(row.requested_quantity) > 0 && Number(row.requested_quantity) === Number(row.allocated_quantity),
      duplicateTracking: duplicateMap.get(String(row.shipped_tracking_reference || "").trim().toUpperCase()) || null,
    }));
    console.log(JSON.stringify({ account: ACCOUNT, period: { start: START, end: END }, count: orders.length, orders }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
