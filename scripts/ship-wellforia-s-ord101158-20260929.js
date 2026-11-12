"use strict";

const {
  APP_USER_ROLES,
  getPortalOrderById,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const CODE = "S-ORD101158";
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const CARRIER = "ILC Logistics";
const SHIP_DATE = "2026-09-29";
const BOL = "47664594";
const APPLY = process.argv.includes("--apply");
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Freight Closeout",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function facts(client, lock = false) {
  const result = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.po_number,o.shipping_reference,
            o.requested_ship_date::text,o.confirmed_ship_date::text,o.shipment_method,
            o.shipped_carrier_name,o.shipped_tracking_reference,o.shipped_at,
            o.fulfillment_location_id,fl.code warehouse_code
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [CODE]
  );
  if (result.rowCount !== 1) throw new Error(`Expected one exact ${CODE}.`);
  const order = result.rows[0];
  const lines = (await client.query(
    `select l.id,l.line_number,l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::int allocated_quantity,
            array_remove(array_agg(distinct fl.code),null) warehouse_codes
       from portal_order_lines l
       left join portal_order_allocations a on a.order_line_id=l.id
       left join bin_locations b on b.code=a.location and b.account_name=$2
        and b.fulfillment_location_id=$3
       left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
      where l.order_id=$1 group by l.id,l.line_number,l.sku,l.requested_quantity
      order by l.line_number,l.id`,
    [order.id, ACCOUNT, order.fulfillment_location_id]
  )).rows;
  const trackingOwners = (await client.query(
    `select order_code from portal_orders
      where upper(btrim(coalesce(shipped_tracking_reference,'')))=upper($1) and id<>$2
      union all
     select o.order_code from warehouse_shipments s join portal_orders o on o.id=s.order_id
      where upper(btrim(coalesce(s.tracking_reference,'')))=upper($1) and o.id<>$2`,
    [BOL, order.id]
  )).rows;
  const shipments = (await client.query(
    `select id,status,carrier_name,tracking_reference,shipped_at
       from warehouse_shipments where order_id=$1 order by id`, [order.id]
  )).rows;
  return { order, lines, trackingOwners, shipments };
}

function validate(state) {
  const errors = [];
  const total = state.lines.reduce((sum, line) => sum + Number(line.requested_quantity), 0);
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE || Number(state.order.fulfillment_location_id) !== 1) errors.push("Warehouse mismatch.");
  if (!['RELEASED','PICKING','PICKED','STAGED','SHIPPED'].includes(state.order.status)) errors.push(`Status ${state.order.status} is not eligible.`);
  if (total !== 234) errors.push(`Order total ${total} does not match the reviewed BOL pallet-row quantity 234.`);
  if (state.order.status !== "SHIPPED" && state.lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("Order is not fully allocated.");
  if (state.lines.some((line) => (line.warehouse_codes || []).some((code) => code !== WAREHOUSE))) errors.push("Allocation outside GW3PL-MISS.");
  if (state.trackingOwners.length) errors.push(`BOL is already assigned to ${state.trackingOwners.map((row) => row.order_code).join(', ')}.`);
  if (state.order.shipped_carrier_name && state.order.shipped_carrier_name.toUpperCase() !== CARRIER.toUpperCase()) errors.push("Existing carrier conflicts.");
  if (state.order.shipped_tracking_reference && state.order.shipped_tracking_reference !== BOL) errors.push("Existing tracking/reference conflicts.");
  return errors;
}

async function main() {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return facts(client);
  });
  const errors = validate(before);
  console.log(JSON.stringify({ phase: "preflight", errors, order: before.order,
    lines: before.lines.map((line) => ({ sku: line.sku, requested: Number(line.requested_quantity), allocated: Number(line.allocated_quantity), warehouses: line.warehouse_codes })),
    shipments: before.shipments, trackingOwners: before.trackingOwners,
    reviewedEvidence: { bol: BOL, carrier: CARRIER, bolPickupDate: "2026-09-18", ownerApprovedShipDate: SHIP_DATE, pallets: 11, weightLb: 8023, quantity: 234, loadPhotoPresent: false } }, null, 2));
  if (errors.length) throw new Error(errors.join(" "));
  if (!APPLY) return;
  if (before.order.status !== "SHIPPED") {
    await withTransaction(async (client) => {
      let current = await facts(client, true);
      const currentErrors = validate(current);
      if (currentErrors.length) throw new Error(currentErrors.join(" "));
      const key = "owner-wellforia-s-ord101158-ilc-47664594-20260929";
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
        confirmedShipDate: SHIP_DATE,
        shipmentMethod: "LTL_FREIGHT",
        carrierName: CARRIER,
        trackingReference: BOL,
        packingSlipQuantityConfirmed: true,
        missingShipmentProofOverride: true,
        missingShipmentProofOverrideReason: "Owner explicitly approved month-end shipment closeout without a load image and will add remaining documents later. Reviewed ILC Logistics BOL 47664594 for S-ORD101158.",
        outboundPallets: {
          totalPalletsOut: 11,
          existingPalletsOut: 11,
          newPalletsUsed: 0,
          mixedPalletsBuilt: 0,
          palletNote: "11 pallets, 8,023 lb, quantity 234 per reviewed ILC Logistics BOL 47664594.",
        },
        note: "Owner approved confirmed ship date 2026-09-29 for month-end closeout. Source ILC BOL 47664594 is dated 2026-09-18; date difference retained in audit note. Missing load image explicitly waived; additional documents to be uploaded later.",
        shippedLines: current.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: Number(line.requested_quantity) })),
      }, ACTOR);
    });
  }
  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client);
    const detail = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const shipped = (await client.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku", [state.order.id])).rows;
    const ledger = (await client.query(
      `select sku,sum(quantity_delta)::int quantity_delta from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER'
          and transaction_type='SHIPPING' group by sku order by sku`,
      [ACCOUNT, String(state.order.id)]
    )).rows;
    return { ...state, detail, shipped, ledger };
  });
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE
    || after.order.shipped_carrier_name !== CARRIER || after.order.shipped_tracking_reference !== BOL) throw new Error("Order verification failed.");
  if (after.shipped.length !== after.lines.length || after.lines.some((line) => !after.shipped.some((row) => row.sku === line.sku && Number(row.shipped_quantity) === Number(line.requested_quantity)))) throw new Error("Shipped-line verification failed.");
  if (after.ledger.length !== after.lines.length || after.lines.some((line) => !after.ledger.some((row) => row.sku === line.sku && -Number(row.quantity_delta) === Number(line.requested_quantity)))) throw new Error("Inventory-ledger verification failed.");
  if (after.shipments.length !== 1 || after.shipments[0].status !== "SHIPPED" || after.shipments[0].carrier_name !== CARRIER || after.shipments[0].tracking_reference !== BOL) throw new Error("Warehouse-shipment verification failed.");
  console.log(JSON.stringify({ phase: "verified", order: CODE, status: after.order.status,
    shipDate: after.order.confirmed_ship_date, carrier: after.order.shipped_carrier_name,
    bol: after.order.shipped_tracking_reference, pallets: 11, weightLb: 8023,
    quantity: 234, inventoryVerified: true, shipmentEmailStatus: after.detail.shipmentEmailStatus }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
