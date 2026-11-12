"use strict";

const { Client } = require("pg");

const USER_EMAIL = "gworders";
const ORDER_CODE = "ORD-001793";

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
  await db.connect();
  try {
    await db.query("begin read only");
    const users = await db.query(
      `select id,email,full_name,role,is_active
         from app_users
        where lower(email)=lower($1) or lower(split_part(email,'@',1))=lower($1)
        order by id`, [USER_EMAIL]
    );
    const order = await db.query(
      `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
              fl.code fulfillment_location_code,fl.name fulfillment_location_name
         from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
        where o.order_code=$1`, [ORDER_CODE]
    );
    if (order.rowCount !== 1) throw new Error(`Expected one exact ${ORDER_CODE}.`);
    const userDetails = [];
    for (const user of users.rows) {
      const warehouses = await db.query(
        `select fl.id,fl.code,fl.name,fl.is_active
           from app_user_fulfillment_location_access a
           join fulfillment_locations fl on fl.id=a.fulfillment_location_id
          where a.app_user_id=$1 order by fl.id`, [user.id]
      );
      const companies = await db.query(
        `select account_name from app_user_company_access where app_user_id=$1 order by account_name`, [user.id]
      ).catch(() => ({ rows: [] }));
      userDetails.push({ id: user.id, email: user.email, fullName: user.full_name, role: user.role,
        active: user.is_active, warehouseAssignments: warehouses.rows,
        companyAssignments: companies.rows.map((row) => row.account_name) });
    }
    const shipments = await db.query(
      `select ws.id,ws.status,ws.fulfillment_location_id,fl.code fulfillment_location_code,
              ws.carrier_name,ws.total_pallets,ws.updated_at
         from warehouse_shipments ws left join fulfillment_locations fl on fl.id=ws.fulfillment_location_id
        where ws.order_id=$1 order by ws.id`, [order.rows[0].id]
    );
    const activeShipmentWarehouseIds = [...new Set(shipments.rows.filter((row) => row.status !== "CANCELLED")
      .map((row) => Number(row.fulfillment_location_id)).filter(Boolean))];
    const accessEvents = await db.query(
      `select id,title,details,created_at from activity_log
        where type='security' and title='Access restricted'
          and (details ilike $1 or details ilike $2)
        order by created_at desc limit 20`, [`%${ORDER_CODE}%`, "%gworders%"]
    );
    const result = { phase: "read_only", users: userDetails, order: order.rows[0], shipments: shipments.rows,
      effectiveOrderWarehouseIds: activeShipmentWarehouseIds.length ? activeShipmentWarehouseIds : [Number(order.rows[0].fulfillment_location_id)],
      recentAccessEvents: accessEvents.rows };
    console.log(JSON.stringify(result, null, 2));
    await db.query("rollback");
  } finally { await db.end(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
