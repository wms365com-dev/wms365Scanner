"use strict";

const {
  APP_USER_ROLES,
  getPortalOrderById,
  getShipmentMethodTrackingConflict,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const ORDER_CODE = String(process.env.TARGET_ORDER_CODE || "S-ORD101159").trim();
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const CARRIER = String(process.env.TARGET_CARRIER || "Purolator").trim();
const TRACKING = String(process.env.TARGET_TRACKING || "520762278809").trim();
const PRIOR_TRACKING = String(process.env.TARGET_PRIOR_TRACKING || "").trim();
const APPLY = process.argv.includes("--apply");
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Shipment",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function facts(client, lock = false) {
  const orderResult = await client.query(
    `select o.id, o.order_code, o.account_name, o.status, o.po_number,
            o.shipping_reference, o.requested_ship_date::text,
            o.confirmed_ship_date::text, o.shipment_method,
            o.shipped_carrier_name, o.shipped_tracking_reference,
            o.shipment_email_status, o.shipped_at, o.fulfillment_location_id,
            fl.code warehouse_code
       from portal_orders o
       join fulfillment_locations fl on fl.id = o.fulfillment_location_id
      where o.order_code = $1${lock ? " for update of o" : ""}`,
    [ORDER_CODE]
  );
  if (orderResult.rowCount !== 1) throw new Error(`Expected one exact ${ORDER_CODE}.`);
  const order = orderResult.rows[0];
  const lines = (await client.query(
    `select l.id, l.line_number, l.sku, l.requested_quantity,
            coalesce(sum(a.allocated_quantity), 0)::integer allocated_quantity,
            array_remove(array_agg(distinct fl.code), null) warehouse_codes
       from portal_order_lines l
       left join portal_order_allocations a on a.order_line_id = l.id
       left join bin_locations b on b.code = a.location
        and b.account_name = $2 and b.fulfillment_location_id = $3
       left join fulfillment_locations fl on fl.id = b.fulfillment_location_id
      where l.order_id = $1
      group by l.id, l.line_number, l.sku, l.requested_quantity
      order by l.line_number, l.id`,
    [order.id, ACCOUNT, order.fulfillment_location_id]
  )).rows;
  const trackingOwners = (await client.query(
    `select order_code from portal_orders
      where upper(btrim(coalesce(shipped_tracking_reference, ''))) = upper($1)
        and id <> $2
      union all
     select o.order_code from warehouse_shipments s
       join portal_orders o on o.id = s.order_id
      where upper(btrim(coalesce(s.tracking_reference, ''))) = upper($1)
        and o.id <> $2`,
    [TRACKING, order.id]
  )).rows;
  const shipments = (await client.query(
    `select id, status, carrier_name, tracking_reference, shipped_at
       from warehouse_shipments where order_id = $1 order by id`,
    [order.id]
  )).rows;
  return { order, lines, trackingOwners, shipments };
}

function validate(state) {
  const errors = [];
  const { order, lines, trackingOwners } = state;
  if (order.account_name !== ACCOUNT) errors.push("Account identity mismatch.");
  if (order.warehouse_code !== WAREHOUSE) errors.push("Warehouse identity mismatch.");
  if (!order.requested_ship_date) errors.push("Requested ship date is blank.");
  if (!["RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) {
    errors.push(`Status ${order.status} cannot be shipped.`);
  }
  if (!lines.length || lines.some((line) => Number(line.requested_quantity) <= 0)) {
    errors.push("Order has no positive-quantity lines.");
  }
  if (order.status !== "SHIPPED" && lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) {
    errors.push("Order is not fully allocated.");
  }
  if (lines.some((line) => (line.warehouse_codes || []).some((code) => code !== WAREHOUSE))) {
    errors.push("An allocation is outside GW3PL-MISS.");
  }
  if (trackingOwners.length) errors.push(`Tracking is already assigned to ${trackingOwners.map((row) => row.order_code).join(", ")}.`);
  const trackingConflict = getShipmentMethodTrackingConflict({
    shipmentMethod: "PARCEL",
    carrierName: CARRIER,
    trackingReference: TRACKING,
  });
  if (trackingConflict) errors.push(trackingConflict.message || "Carrier and tracking do not match.");
  if (order.shipped_carrier_name && order.shipped_carrier_name.toUpperCase() !== CARRIER.toUpperCase()) errors.push("Existing carrier conflicts.");
  if (order.shipped_tracking_reference
    && order.shipped_tracking_reference.toUpperCase() !== TRACKING.toUpperCase()
    && order.shipped_tracking_reference !== PRIOR_TRACKING) errors.push("Existing tracking conflicts.");
  return errors;
}

function summarize(state) {
  return {
    order: state.order,
    lines: state.lines.map((line) => ({
      sku: line.sku,
      requested: Number(line.requested_quantity),
      allocated: Number(line.allocated_quantity),
      warehouses: line.warehouse_codes,
    })),
    trackingOwners: state.trackingOwners,
    shipments: state.shipments,
  };
}

async function main() {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return facts(client);
  });
  const errors = validate(before);
  console.log(JSON.stringify({ phase: "preflight", errors, ...summarize(before) }, null, 2));
  if (errors.length) throw new Error(errors.join(" "));
  if (!APPLY) return;
  if (before.order.status === "SHIPPED") {
    console.log(JSON.stringify({ phase: "no-op", reason: "already-shipped", ...summarize(before) }, null, 2));
    return;
  }

  await withTransaction(async (client) => {
    let current = await facts(client, true);
    const currentErrors = validate(current);
    if (currentErrors.length) throw new Error(currentErrors.join(" "));
    const key = `owner-wellforia-${ORDER_CODE.toLowerCase()}-${CARRIER.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${TRACKING}`;
    if (current.order.status === "RELEASED") {
      await updateAdminPortalOrderStatus(client, current.order.id, "PICKING", { idempotencyKey: `${key}-picking` }, ACTOR);
      current = await facts(client, true);
    }
    if (current.order.status === "PICKING") {
      await updateAdminPortalOrderStatus(client, current.order.id, "PICKED", { idempotencyKey: `${key}-picked` }, ACTOR);
      current = await facts(client, true);
    }
    if (current.order.status === "PICKED") {
      await updateAdminPortalOrderStatus(client, current.order.id, "STAGED", { idempotencyKey: `${key}-staged` }, ACTOR);
      current = await facts(client, true);
    }
    if (current.order.status !== "STAGED") throw new Error(`Expected STAGED; found ${current.order.status}.`);
    await updateAdminPortalOrderStatus(client, current.order.id, "SHIPPED", {
      idempotencyKey: `${key}-shipped`,
      confirmedShipDate: current.order.requested_ship_date,
      shipmentMethod: "PARCEL",
      carrierName: CARRIER,
      trackingReference: TRACKING,
      packingSlipQuantityConfirmed: true,
      note: `Owner confirmed shipment by ${CARRIER} on the requested ship date. Tracking ${TRACKING}.${PRIOR_TRACKING ? ` Prior staged label reference preserved in audit note: ${PRIOR_TRACKING}.` : ""}`,
      shippedLines: current.lines.map((line) => ({
        orderLineId: line.id,
        sku: line.sku,
        shippedQuantity: Number(line.requested_quantity),
      })),
    }, ACTOR);
  });

  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client);
    const detail = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const shippedLines = (await client.query(
      `select sku, shipped_quantity from portal_order_shipment_lines
        where order_id = $1 order by sku`,
      [state.order.id]
    )).rows;
    const ledger = (await client.query(
      `select sku, sum(quantity_delta)::integer quantity_delta
         from inventory_transactions
        where account_name = $1 and source_id = $2 and source_type = 'PORTAL_ORDER'
          and transaction_type = 'SHIPPING'
        group by sku order by sku`,
      [ACCOUNT, String(state.order.id)]
    )).rows;
    return { ...state, detail, shippedLines, ledger };
  });
  if (after.order.status !== "SHIPPED"
    || after.order.confirmed_ship_date !== after.order.requested_ship_date
    || String(after.order.shipped_carrier_name).toUpperCase() !== CARRIER.toUpperCase()
    || after.order.shipped_tracking_reference !== TRACKING) {
    throw new Error("Post-shipment order verification failed.");
  }
  if (after.shippedLines.length !== after.lines.length
    || after.lines.some((line) => !after.shippedLines.some((shipped) => shipped.sku === line.sku
      && Number(shipped.shipped_quantity) === Number(line.requested_quantity)))) {
    throw new Error("Post-shipment line verification failed.");
  }
  if (after.ledger.length !== after.lines.length
    || after.lines.some((line) => !after.ledger.some((entry) => entry.sku === line.sku
      && -Number(entry.quantity_delta) === Number(line.requested_quantity)))) {
    throw new Error("Inventory shipping ledger verification failed.");
  }
  if (after.shipments.length !== 1
    || after.shipments[0].status !== "SHIPPED"
    || String(after.shipments[0].carrier_name).toUpperCase() !== CARRIER.toUpperCase()
    || after.shipments[0].tracking_reference !== TRACKING) {
    throw new Error("Warehouse shipment verification failed.");
  }
  console.log(JSON.stringify({
    phase: "verified",
    shipmentEmailStatus: after.detail.shipmentEmailStatus,
    shippedLines: after.shippedLines,
    ledger: after.ledger,
    ...summarize(after),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
