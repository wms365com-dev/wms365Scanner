"use strict";

const { withTransaction } = require("../server");

const ORDER = "S-ORD101232";
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const OLD_TRACKING = "20261019165959";
const NEW_TRACKING = "533183101910";
const APPLY = process.argv.includes("--apply");

async function read(client, lock = false) {
  const result = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.requested_ship_date::text,
            o.shipped_carrier_name,o.shipped_tracking_reference,o.fulfillment_location_id,
            fl.code warehouse_code
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [ORDER]
  );
  if (result.rowCount !== 1) throw new Error(`Expected one exact ${ORDER}.`);
  const order = result.rows[0];
  const shipments = (await client.query(
    `select id,status,carrier_name,tracking_reference from warehouse_shipments
      where order_id=$1 order by id${lock ? " for update" : ""}`,
    [order.id]
  )).rows;
  const conflicts = (await client.query(
    `select order_code from portal_orders where shipped_tracking_reference=$1 and id<>$2
     union all
     select o.order_code from warehouse_shipments s join portal_orders o on o.id=s.order_id
      where s.tracking_reference=$1 and o.id<>$2`,
    [NEW_TRACKING, order.id]
  )).rows;
  return { order, shipments, conflicts };
}

function validate(state) {
  const errors = [];
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE || Number(state.order.fulfillment_location_id) !== 1) errors.push("Warehouse mismatch.");
  if (!state.order.requested_ship_date) errors.push("Requested ship date missing.");
  if (!["RELEASED", "PICKING", "PICKED", "STAGED"].includes(state.order.status)) errors.push(`Order status ${state.order.status} is not eligible.`);
  if (state.order.shipped_carrier_name !== "FedEx") errors.push("Carrier mismatch.");
  if (state.order.shipped_tracking_reference !== OLD_TRACKING) errors.push("Existing order tracking no longer matches the reviewed placeholder.");
  if (state.shipments.length !== 1 || state.shipments[0].tracking_reference !== OLD_TRACKING || state.shipments[0].carrier_name !== "FedEx") errors.push("Shipment tracking no longer matches the reviewed placeholder.");
  if (state.conflicts.length) errors.push(`New tracking belongs to ${state.conflicts.map((row) => row.order_code).join(", ")}.`);
  return errors;
}

async function main() {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return read(client);
  });
  const errors = validate(before);
  console.log(JSON.stringify({ phase: "preflight", errors, order: before.order, shipments: before.shipments }, null, 2));
  if (errors.length) throw new Error(errors.join(" "));
  if (!APPLY) return;
  await withTransaction(async (client) => {
    const current = await read(client, true);
    const currentErrors = validate(current);
    if (currentErrors.length) throw new Error(currentErrors.join(" "));
    await client.query(
      `update portal_orders set shipped_tracking_reference=$2,updated_at=now()
        where id=$1 and shipped_tracking_reference=$3`,
      [current.order.id, NEW_TRACKING, OLD_TRACKING]
    );
    await client.query(
      `update warehouse_shipments set tracking_reference=$2,updated_at=now()
        where order_id=$1 and tracking_reference=$3`,
      [current.order.id, NEW_TRACKING, OLD_TRACKING]
    );
    await client.query(
      `insert into activity_log(type,title,details) values('order',$1,$2)`,
      [`Corrected tracking for ${ORDER}`, `FedEx tracking corrected from label timestamp placeholder to ${NEW_TRACKING} before shipment.`]
    );
  });
  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return read(client);
  });
  if (after.order.shipped_tracking_reference !== NEW_TRACKING || after.shipments[0]?.tracking_reference !== NEW_TRACKING) {
    throw new Error("Tracking correction verification failed.");
  }
  console.log(JSON.stringify({ phase: "verified", order: after.order, shipments: after.shipments }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
