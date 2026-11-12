"use strict";

const {
  APP_USER_ROLES,
  getPortalOrderById,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const CODE = "S-ORD101212";
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const CARRIER = "JBF Express";
const SHIP_DATE = "2026-10-13";
const REFERENCE = "WF-GW/1322";
const PRIOR_LABEL_CARRIER = "FedEx";
const PRIOR_LABEL_REFERENCE = "20261007184043";
const APPLY = process.argv.includes("--apply");
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Freight Closeout",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function facts(client, lock = false) {
  const result = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.requested_ship_date::text,
            o.confirmed_ship_date::text,o.shipment_method,o.shipped_carrier_name,
            o.shipped_tracking_reference,o.shipped_at,o.fulfillment_location_id,
            o.po_number,fl.code warehouse_code
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
      where l.order_id=$1
      group by l.id,l.line_number,l.sku,l.requested_quantity
      order by l.line_number,l.id`,
    [order.id, ACCOUNT, order.fulfillment_location_id]
  )).rows;
  const shipments = (await client.query(
    `select id,status,carrier_name,tracking_reference,shipped_at
       from warehouse_shipments where order_id=$1 order by id`, [order.id]
  )).rows;
  const documents = (await client.query(
    `select document_category,file_name from portal_order_documents
      where order_id=$1 order by id`, [order.id]
  )).rows;
  return { order, lines, shipments, documents };
}

function validate(state) {
  const errors = [];
  const expected = new Map([["SHAVESTACK_30", 3], ["SHAVESTACK_90", 10], ["DC80", 27]]);
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE || Number(state.order.fulfillment_location_id) !== 1) errors.push("Warehouse mismatch.");
  if (state.order.po_number !== REFERENCE) errors.push(`PO/reference mismatch: ${state.order.po_number}.`);
  if (!['RELEASED','PICKING','PICKED','STAGED','SHIPPED'].includes(state.order.status)) errors.push(`Status ${state.order.status} is not eligible.`);
  if (state.lines.length !== expected.size) errors.push(`Expected 3 lines; found ${state.lines.length}.`);
  for (const line of state.lines) {
    if (!expected.has(line.sku) || Number(line.requested_quantity) !== expected.get(line.sku)) errors.push(`Line mismatch for ${line.sku}.`);
    if (state.order.status !== "SHIPPED" && Number(line.allocated_quantity) !== Number(line.requested_quantity)) errors.push(`${line.sku} is not fully allocated.`);
    if ((line.warehouse_codes || []).some((code) => code !== WAREHOUSE)) errors.push(`${line.sku} is allocated outside ${WAREHOUSE}.`);
  }
  const carrier = state.order.shipped_carrier_name || "";
  const reference = state.order.shipped_tracking_reference || "";
  const allowedPriorLabel = state.order.status !== "SHIPPED"
    && carrier === PRIOR_LABEL_CARRIER && reference === PRIOR_LABEL_REFERENCE;
  if (carrier && carrier.toUpperCase() !== CARRIER.toUpperCase() && !allowedPriorLabel) errors.push("Existing carrier conflicts.");
  if (reference && reference !== REFERENCE && !allowedPriorLabel) errors.push("Existing tracking/reference conflicts.");
  return errors;
}

async function main() {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return facts(client);
  });
  const errors = validate(before);
  if (errors.length) {
    console.error(JSON.stringify({ order: CODE, status: before.order.status,
      existingCarrier: before.order.shipped_carrier_name,
      existingReference: before.order.shipped_tracking_reference,
      existingShipDate: before.order.confirmed_ship_date,
      errors }, null, 2));
    throw new Error(errors.join(" "));
  }
  if (!APPLY) {
    console.log(JSON.stringify({ mode: "preflight", order: CODE, status: before.order.status,
      requestedShipDate: before.order.requested_ship_date, po: before.order.po_number,
      lines: before.lines.map((line) => ({ sku: line.sku, quantity: Number(line.requested_quantity), allocated: Number(line.allocated_quantity) })),
      cases: before.lines.reduce((sum, line) => sum + Number(line.requested_quantity), 0),
      pallets: 2, carrier: CARRIER, shipDate: SHIP_DATE,
      missingLoadPhotoOverride: true }, null, 2));
    return;
  }
  if (before.order.status !== "SHIPPED") {
    await withTransaction(async (client) => {
      let current = await facts(client, true);
      const currentErrors = validate(current);
      if (currentErrors.length) throw new Error(currentErrors.join(" "));
      const key = "owner-wellforia-s-ord101212-jbf-20261013";
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
        trackingReference: REFERENCE,
        packingSlipQuantityConfirmed: true,
        missingShipmentProofOverride: true,
        missingShipmentProofOverrideReason: "Owner explicitly approved shipment closeout without a load photo. Reviewed signed JBF Express BOL showing delivery on 2026-10-13 and checked pick ticket for S-ORD101212.",
        outboundPallets: {
          totalPalletsOut: 2,
          existingPalletsOut: 2,
          newPalletsUsed: 0,
          mixedPalletsBuilt: 0,
          palletNote: "Two pallets, 40 cases total, verified from signed JBF Express BOL WF-GW/1322.",
        },
        note: "Owner confirmed JBF Express LTL shipment on 2026-10-13. Signed BOL and checked pick quantities reviewed; missing load photo explicitly waived. Prior staged parcel-label metadata preserved in audit note: FedEx reference 20261007184043; actual freight movement closed under JBF Express BOL WF-GW/1322.",
        shippedLines: current.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: Number(line.requested_quantity) })),
      }, ACTOR);
    });
  }

  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client);
    const detail = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const shipped = (await client.query(
      "select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku", [state.order.id]
    )).rows;
    const ledger = (await client.query(
      `select sku,sum(quantity_delta)::int quantity_delta from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER'
          and transaction_type='SHIPPING' group by sku order by sku`,
      [ACCOUNT, String(state.order.id)]
    )).rows;
    return { ...state, detail, shipped, ledger };
  });
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE
    || after.order.shipped_carrier_name !== CARRIER || after.order.shipped_tracking_reference !== REFERENCE) throw new Error("Order verification failed.");
  if (after.shipped.length !== after.lines.length || after.lines.some((line) => !after.shipped.some((row) => row.sku === line.sku && Number(row.shipped_quantity) === Number(line.requested_quantity)))) throw new Error("Shipped-line verification failed.");
  if (after.ledger.length !== after.lines.length || after.lines.some((line) => !after.ledger.some((row) => row.sku === line.sku && -Number(row.quantity_delta) === Number(line.requested_quantity)))) throw new Error("Inventory-ledger verification failed.");
  if (after.shipments.length !== 1 || after.shipments[0].status !== "SHIPPED" || after.shipments[0].carrier_name !== CARRIER) throw new Error("Warehouse-shipment verification failed.");
  console.log(JSON.stringify({ mode: "apply", order: CODE, status: after.order.status,
    shipDate: after.order.confirmed_ship_date, carrier: after.order.shipped_carrier_name,
    reference: after.order.shipped_tracking_reference, cases: 40, pallets: 2,
    shipmentStatus: after.shipments[0].status, inventoryVerified: true,
    emailStatus: after.detail.shipmentEmailStatus }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
