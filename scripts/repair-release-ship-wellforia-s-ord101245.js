"use strict";

const {
  APP_USER_ROLES,
  createInventoryMovementRecord,
  getPortalOrderById,
  releasePortalOrderForAccount,
  safeTransferInventoryQuantity,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ORDER_CODE = "S-ORD101245";
const SOURCE_ORDER = "S-ORD101163";
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE_ID = 1;
const WAREHOUSE = "GW3PL-MISS";
const SOURCE_LOCATION = "GW3PL-MISS";
const DESTINATION = "GW3PL-MISS-WELLFORIA-BULK";
const SHIP_DATE = "2026-10-04";
const CARRIER = "Omar";
const PALLETS = 2;
const FREIGHT_COST = 175;
const KEY = "OWNER-WELLFORIA-S-ORD101245-20261004";
const REQUIRED = new Map([
  ["PKP50", 10],
  ["TP-WW-6PK-UPC", 6],
  ["TP-PKP-XL50", 5],
]);
const ACTOR = {
  id: null,
  email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Historical Shipment",
  role: APP_USER_ROLES.SUPER_ADMIN,
};

async function loadState(client, lock = false) {
  const orderResult = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.requested_ship_date::text,
            o.confirmed_ship_date::text,o.shipment_method,o.shipped_carrier_name,
            o.shipped_tracking_reference,o.outbound_total_pallets,o.outbound_freight_cost,
            o.fulfillment_location_id,fl.code warehouse_code
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`,
    [ORDER_CODE]
  );
  if (orderResult.rowCount !== 1) throw new Error(`Expected one exact ${ORDER_CODE}.`);
  const order = orderResult.rows[0];
  const lines = (await client.query(
    `select l.id,l.line_number,l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity,
            array_remove(array_agg(distinct a.location),null) locations
       from portal_order_lines l
       left join portal_order_allocations a on a.order_line_id=l.id
      where l.order_id=$1
      group by l.id,l.line_number,l.sku,l.requested_quantity
      order by l.line_number,l.id`,
    [order.id]
  )).rows;
  const stock = (await client.query(
    `select i.*,coalesce(s.allocated,0)::integer sales_allocated,
            coalesce(k.allocated,0)::integer kitting_allocated
       from inventory_lines i
       left join (
         select a.inventory_line_id,sum(a.allocated_quantity)::integer allocated
           from portal_order_allocations a join portal_orders o on o.id=a.order_id
          where o.status in ('RELEASED','PICKING','PICKED','STAGED') group by a.inventory_line_id
       ) s on s.inventory_line_id=i.id
       left join (
         select a.inventory_line_id,sum(a.allocated_quantity)::integer allocated
           from portal_kitting_allocations a join portal_kitting_requests k on k.id=a.kitting_request_id
          where k.status in ('SUBMITTED','IN_PROGRESS') group by a.inventory_line_id
       ) k on k.inventory_line_id=i.id
      where i.account_name=$1 and i.sku=any($2::text[]) and i.location=$3 and i.quantity>0
      order by i.sku,i.id${lock ? " for update of i" : ""}`,
    [ACCOUNT, [...REQUIRED.keys()], SOURCE_LOCATION]
  )).rows;
  const pickable = (await client.query(
    `select i.sku,coalesce(sum(i.quantity),0)::integer quantity
       from inventory_lines i join bin_locations b on b.code=i.location
      where i.account_name=$1 and i.sku=any($2::text[])
        and b.account_name=$1 and b.fulfillment_location_id=$3
        and b.location_type='STORAGE' and b.is_pickable=true
      group by i.sku order by i.sku`,
    [ACCOUNT, [...REQUIRED.keys()], WAREHOUSE_ID]
  )).rows;
  return { order, lines, stock, pickable };
}

async function verifyScope(client, state) {
  const account = await client.query("select id,name,is_active from owner_accounts where name=$1", [ACCOUNT]);
  if (account.rowCount !== 1 || account.rows[0].is_active !== true) throw new Error("Wellforia account identity mismatch.");
  const destination = await client.query(
    `select code,account_name,fulfillment_location_id,location_type,is_pickable
       from bin_locations where code=$1`, [DESTINATION]
  );
  const bin = destination.rows[0];
  if (destination.rowCount !== 1 || bin.account_name !== ACCOUNT
    || Number(bin.fulfillment_location_id) !== WAREHOUSE_ID
    || bin.location_type !== "STORAGE" || bin.is_pickable !== true) {
    throw new Error("Wellforia bulk destination is not valid pickable Mississauga storage.");
  }
  const order = state.order;
  if (order.account_name !== ACCOUNT || order.warehouse_code !== WAREHOUSE
    || Number(order.fulfillment_location_id) !== WAREHOUSE_ID) throw new Error("Order company or warehouse mismatch.");
  if (order.requested_ship_date !== SHIP_DATE || order.shipment_method !== "LTL_FREIGHT") throw new Error("Order date or shipment method changed.");
  if (!["DRAFT", "RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) throw new Error(`Status ${order.status} is not eligible.`);
  if (state.lines.length !== REQUIRED.size) throw new Error("Order line count changed.");
  for (const [sku, quantity] of REQUIRED) {
    const line = state.lines.find((candidate) => candidate.sku === sku);
    if (!line || Number(line.requested_quantity) !== quantity) throw new Error(`${sku} quantity changed.`);
  }
  const source = await client.query(
    `select status,shipment_method,shipped_carrier_name,shipped_tracking_reference,
            outbound_total_pallets from portal_orders where order_code=$1 and account_name=$2`,
    [SOURCE_ORDER, ACCOUNT]
  );
  const copiedFrom = source.rows[0];
  if (source.rowCount !== 1 || copiedFrom.status !== "SHIPPED"
    || copiedFrom.shipment_method !== "LTL_FREIGHT" || copiedFrom.shipped_carrier_name !== CARRIER
    || copiedFrom.shipped_tracking_reference || Number(copiedFrom.outbound_total_pallets) !== PALLETS) {
    throw new Error("Copied source order shipping details changed.");
  }
}

function freeQuantity(row) {
  return Math.max(Number(row.quantity) - Number(row.sales_allocated) - Number(row.kitting_allocated), 0);
}

async function transferFreeStock(client, state) {
  for (const sku of ["PKP50", "TP-PKP-XL50"]) {
    const pickableNow = Number(state.pickable.find((row) => row.sku === sku)?.quantity || 0);
    let remaining = Math.max(REQUIRED.get(sku) - pickableNow, 0);
    for (const line of state.stock.filter((candidate) => candidate.sku === sku)) {
      const quantity = Math.min(freeQuantity(line), remaining);
      if (quantity <= 0) continue;
      await safeTransferInventoryQuantity(client, line, {
        accountName: ACCOUNT,
        location: DESTINATION,
        sku,
        upc: line.upc || "",
        lotNumber: line.lot_number || "",
        expirationDate: line.expiration_date || "",
        trackingLevel: line.tracking_level || "CASE",
      }, quantity, {
        actionLabel: `repair Wellforia ${sku} pickable location`,
        transactionType: "MOVE_LOCATION",
        sourceType: "OWNER_APPROVED_LOCATION_REPAIR",
        sourceId: KEY,
        fulfillmentLocationId: WAREHOUSE_ID,
        idempotencyKey: `${KEY}:MOVE:${line.id}`,
        source: "SYSTEM",
      });
      await createInventoryMovementRecord(client, {
        movementKey: `${KEY}:MOVE:${line.id}`,
        accountName: ACCOUNT,
        fulfillmentLocationId: WAREHOUSE_ID,
        movementType: "TRANSFER",
        fromLocation: SOURCE_LOCATION,
        toLocation: DESTINATION,
        line,
        quantity,
        reason: `Move free ${sku} stock from warehouse placeholder to Wellforia pickable bulk storage.`,
      });
      remaining -= quantity;
    }
    if (remaining !== 0) throw new Error(`Insufficient movable stock for ${sku}; short ${remaining}.`);
  }
}

function plannedMoves(state) {
  const result = [];
  for (const sku of ["PKP50", "TP-PKP-XL50"]) {
    const pickableNow = Number(state.pickable.find((row) => row.sku === sku)?.quantity || 0);
    let remaining = Math.max(REQUIRED.get(sku) - pickableNow, 0);
    for (const line of state.stock.filter((candidate) => candidate.sku === sku)) {
      const quantity = Math.min(freeQuantity(line), remaining);
      if (quantity <= 0) continue;
      result.push({ sku, from: line.location, to: DESTINATION, quantity });
      remaining -= quantity;
    }
    if (remaining !== 0) throw new Error(`Insufficient movable stock for ${sku}; short ${remaining}.`);
  }
  return result;
}

async function main() {
  const result = await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [KEY]);
    let state = await loadState(client, APPLY);
    await verifyScope(client, state);
    if (state.order.status === "SHIPPED") return { outcome: "already-shipped", state };

    if (!APPLY) {
      return {
        outcome: "preflight",
        state,
        plannedMoves: plannedMoves(state),
      };
    }

    if (state.order.status === "DRAFT") {
      await transferFreeStock(client, state);
      await releasePortalOrderForAccount(client, ACCOUNT, state.order.id, {
        activityTitlePrefix: "warehouse sales",
        activityActor: ACTOR.full_name,
        rushExempt: true,
        rushExemptNote: "Owner-approved historical order correction and closeout.",
      });
      state = await loadState(client, true);
    }
    if (state.lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) {
      throw new Error("Released order is not fully allocated.");
    }
    if (state.order.status === "RELEASED") {
      await updateAdminPortalOrderStatus(client, state.order.id, "PICKING", { idempotencyKey: `${KEY}:PICKING` }, ACTOR);
      state = await loadState(client, true);
    }
    if (state.order.status === "PICKING") {
      await updateAdminPortalOrderStatus(client, state.order.id, "PICKED", { idempotencyKey: `${KEY}:PICKED` }, ACTOR);
      state = await loadState(client, true);
    }
    if (state.order.status === "PICKED") {
      await updateAdminPortalOrderStatus(client, state.order.id, "STAGED", { idempotencyKey: `${KEY}:STAGED` }, ACTOR);
      state = await loadState(client, true);
    }
    if (state.order.status !== "STAGED") throw new Error(`Expected STAGED; found ${state.order.status}.`);
    await updateAdminPortalOrderStatus(client, state.order.id, "SHIPPED", {
      idempotencyKey: `${KEY}:SHIPPED`,
      confirmedShipDate: SHIP_DATE,
      shipmentMethod: "LTL_FREIGHT",
      carrierName: CARRIER,
      trackingReference: "",
      packingSlipQuantityConfirmed: true,
      missingShipmentProofOverride: true,
      missingShipmentProofOverrideReason: "Owner directed immediate historical closeout of this copied local-delivery order. Carrier and two-pallet configuration verified from source order S-ORD101163.",
      outboundPallets: {
        totalPalletsOut: PALLETS,
        existingPalletsOut: PALLETS,
        newPalletsUsed: 0,
        mixedPalletsBuilt: 0,
        palletNote: `Two-pallet local delivery copied from ${SOURCE_ORDER}.`,
      },
      outboundFreightCost: FREIGHT_COST,
      note: `Owner confirmed historical shipment closeout on requested ship date ${SHIP_DATE}. Carrier ${CARRIER}; freight cost $${FREIGHT_COST}; quantities corrected before release.`,
      shippedLines: state.lines.map((line) => ({
        orderLineId: line.id,
        sku: line.sku,
        shippedQuantity: Number(line.requested_quantity),
      })),
    }, ACTOR);
    state = await loadState(client, false);
    return { outcome: "shipped", state };
  });

  const verified = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await loadState(client);
    const order = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const shippedLines = (await client.query(
      `select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku`,
      [state.order.id]
    )).rows;
    const ledger = (await client.query(
      `select sku,sum(quantity_delta)::integer quantity_delta from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER'
          and transaction_type='SHIPPING' group by sku order by sku`,
      [ACCOUNT, String(state.order.id)]
    )).rows;
    const shipment = (await client.query(
      `select status,carrier_name,tracking_reference,shipped_at from warehouse_shipments where order_id=$1`,
      [state.order.id]
    )).rows;
    return { state, order, shippedLines, ledger, shipment };
  });

  if (APPLY) {
    const { order } = verified.state;
    if (order.status !== "SHIPPED" || order.confirmed_ship_date !== SHIP_DATE
      || order.shipped_carrier_name !== CARRIER || order.shipped_tracking_reference
      || Number(order.outbound_total_pallets) !== PALLETS
      || Number(order.outbound_freight_cost) !== FREIGHT_COST) throw new Error("Final order verification failed.");
    for (const [sku, quantity] of REQUIRED) {
      if (!verified.shippedLines.some((line) => line.sku === sku && Number(line.shipped_quantity) === quantity)) throw new Error(`${sku} shipped-line verification failed.`);
      if (!verified.ledger.some((line) => line.sku === sku && -Number(line.quantity_delta) === quantity)) throw new Error(`${sku} inventory-ledger verification failed.`);
    }
    if (verified.shipment.length !== 1 || verified.shipment[0].status !== "SHIPPED"
      || verified.shipment[0].carrier_name !== CARRIER || verified.shipment[0].tracking_reference) throw new Error("Warehouse shipment verification failed.");
  }

  console.log(JSON.stringify({
    mode: APPLY ? "APPLIED" : "PREFLIGHT",
    outcome: result.outcome,
    order: verified.state.order,
    lines: verified.state.lines.map((line) => ({
      sku: line.sku,
      requested: Number(line.requested_quantity),
      allocated: Number(line.allocated_quantity),
      locations: line.locations,
    })),
    plannedMoves: result.plannedMoves || [],
    shipmentEmailStatus: verified.order.shipmentEmailStatus,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
