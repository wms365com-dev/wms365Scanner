"use strict";

const {
  APP_USER_ROLES,
  getPortalOrderById,
  updateAdminPortalOrderStatus,
  withTransaction,
} = require("../server");

const CODE = "S-ORD101244";
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const CARRIER = "LTL Truck";
const SHIP_DATE = "2026-11-06";
const PALLETS = 8;
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
    `select id,status,shipment_method,carrier_name,tracking_reference,total_pallets,
            existing_pallets,new_pallets,mixed_pallets,shipped_at
       from warehouse_shipments where order_id=$1 order by id`, [order.id]
  )).rows;
  return { order, lines, shipments };
}

function validate(state) {
  const errors = [];
  if (state.order.account_name !== ACCOUNT) errors.push("Account mismatch.");
  if (state.order.warehouse_code !== WAREHOUSE || Number(state.order.fulfillment_location_id) !== 1) errors.push("Warehouse mismatch.");
  if (!["RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(state.order.status)) errors.push(`Status ${state.order.status} is not eligible.`);
  if (state.lines.length !== 6) errors.push(`Expected 6 lines; found ${state.lines.length}.`);
  if (state.lines.some((line) => Number(line.requested_quantity) <= 0)) errors.push("A line has no positive quantity.");
  if (state.order.status !== "SHIPPED" && state.lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("Order is not fully allocated.");
  if (state.lines.some((line) => (line.warehouse_codes || []).some((code) => code !== WAREHOUSE))) errors.push("An allocation is outside GW3PL-MISS.");
  if (state.order.shipped_carrier_name && state.order.shipped_carrier_name.toUpperCase() !== CARRIER.toUpperCase()) errors.push("Existing carrier conflicts.");
  if (state.order.shipped_tracking_reference) errors.push("Existing tracking/reference conflicts.");
  return errors;
}

async function createShrinkWrapBillingEvent(client, order) {
  const feeResult = await client.query(
    `select c.code,c.category,c.name,c.unit_label,c.default_rate,c.is_active,
            r.rate owner_rate,r.is_enabled owner_enabled,r.unit_label owner_unit_label
       from billing_fee_catalog c
       left join owner_billing_rates r on r.fee_code=c.code and r.account_name=$1
      where c.code='SHRINK_WRAP' limit 1`,
    [ACCOUNT]
  );
  if (feeResult.rowCount !== 1) throw new Error("SHRINK_WRAP fee is missing from the billing catalog.");
  const fee = feeResult.rows[0];
  if (fee.is_active === false || fee.owner_enabled !== true) return { created: false, reason: "SHRINK_WRAP is not enabled for Wellforia." };
  const rate = Number(fee.owner_rate == null ? fee.default_rate : fee.owner_rate) || 0;
  const amount = Number((PALLETS * rate).toFixed(4));
  const eventKey = `ORDER:${order.id}:SHRINK_WRAP_PALLETS`;
  const result = await client.query(
    `insert into billing_events (
        event_key,account_name,fee_code,fee_category,fee_name,unit_label,
        quantity,rate,amount,currency_code,service_date,source_type,source_ref,
        reference,note,metadata
     ) values ($1,$2,'SHRINK_WRAP',$3,$4,$5,$6,$7,$8,'USD',$9,'OUTBOUND_ORDER',$10,$11,$12,$13::jsonb)
     on conflict (event_key) do update set
        quantity=excluded.quantity,rate=excluded.rate,amount=excluded.amount,
        service_date=excluded.service_date,note=excluded.note,metadata=excluded.metadata,updated_at=now()
     where billing_events.status='OPEN'
     returning id,quantity,rate,amount,status`,
    [eventKey,ACCOUNT,fee.category,fee.name,fee.owner_unit_label || fee.unit_label || "per pallet",
     PALLETS,rate,amount,SHIP_DATE,CODE,order.po_number || CODE,
     "Eight outbound pallets shrink wrapped for owner-approved LTL shipment closeout.",
     JSON.stringify({ pallets: PALLETS, ownerApproved: true, orderCode: CODE })]
  );
  return { created: result.rowCount === 1, event: result.rows[0] || null };
}

async function main() {
  const before = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    return facts(client);
  });
  const errors = validate(before);
  console.log(JSON.stringify({ phase: "preflight", errors, order: before.order,
    lines: before.lines.map((line) => ({ sku: line.sku, requested: Number(line.requested_quantity), allocated: Number(line.allocated_quantity), warehouses: line.warehouse_codes })),
    pallets: PALLETS, shrinkWrappedPallets: PALLETS, carrier: CARRIER, shipDate: SHIP_DATE }, null, 2));
  if (errors.length) throw new Error(errors.join(" "));
  if (!APPLY) return;

  if (before.order.status === "SHIPPED") {
    let repairBilling;
    await withTransaction(async (client) => {
      const locked = await facts(client, true);
      if (locked.order.status !== "SHIPPED" || locked.order.confirmed_ship_date !== SHIP_DATE
        || locked.order.shipped_carrier_name !== CARRIER) {
        throw new Error("The shipped order changed before pallet consistency repair.");
      }
      await client.query(
        `update warehouse_shipments
            set total_pallets=$2,existing_pallets=0,new_pallets=$2,mixed_pallets=0,updated_at=now()
          where order_id=$1 and status='SHIPPED'`,
        [locked.order.id, PALLETS]
      );
      await client.query(
        `insert into activity_log(type,title,details)
         values ('order',$1,$2)`,
        [
          `Corrected warehouse shipment pallet counts for ${CODE}`,
          `${ACCOUNT} | ${PALLETS} new pallets | ${PALLETS} shrink-wrapped pallets | Owner approved freight closeout consistency repair`
        ]
      );
      repairBilling = await createShrinkWrapBillingEvent(client, locked.order);
    });
    console.log(JSON.stringify({ phase: "repaired", order: CODE, pallets: PALLETS,
      newPallets: PALLETS, shrinkWrappedPallets: PALLETS, shrinkWrapBilling: repairBilling }, null, 2));
    return;
  } else {

  let shrinkWrapBilling;
  await withTransaction(async (client) => {
    let current = await facts(client, true);
    const currentErrors = validate(current);
    if (currentErrors.length) throw new Error(currentErrors.join(" "));
    const key = "owner-wellforia-s-ord101244-ltl-20261106";
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
    const shipped = await updateAdminPortalOrderStatus(client, current.order.id, "SHIPPED", {
      idempotencyKey: `${key}-shipped`,
      confirmedShipDate: SHIP_DATE,
      shipmentMethod: "LTL_FREIGHT",
      carrierName: CARRIER,
      trackingReference: "",
      packingSlipQuantityConfirmed: true,
      missingShipmentProofOverride: true,
      missingShipmentProofOverrideReason: "Owner explicitly confirmed shipment closeout without signed BOL, checked packing slip, or load photo. Actual movement was an LTL truck using eight new shrink-wrapped pallets.",
      outboundPallets: {
        totalPalletsOut: PALLETS,
        existingPalletsOut: 0,
        newPalletsUsed: PALLETS,
        mixedPalletsBuilt: 0,
        palletNote: "Eight new pallets; all eight pallets shrink wrapped.",
      },
      note: "Owner confirmed S-ORD101244 shipped by LTL truck on 2026-11-06 using eight new shrink-wrapped pallets. Amazon order moved as freight; missing freight proof explicitly waived by owner.",
      shippedLines: current.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: Number(line.requested_quantity) })),
    }, ACTOR);
    shrinkWrapBilling = await createShrinkWrapBillingEvent(client, shipped);
  });
  }

  const after = await withTransaction(async (client) => {
    await client.query("set transaction read only");
    const state = await facts(client);
    const detail = await getPortalOrderById(client, state.order.id, ACCOUNT);
    const shippedLines = (await client.query("select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku", [state.order.id])).rows;
    const ledger = (await client.query(
      `select sku,sum(quantity_delta)::int quantity_delta from inventory_transactions
        where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER'
          and transaction_type='SHIPPING' group by sku order by sku`,
      [ACCOUNT, String(state.order.id)]
    )).rows;
    const billing = (await client.query(
      `select fee_code,quantity,rate,amount,status from billing_events
        where account_name=$1 and source_ref=$2 order by fee_code`, [ACCOUNT,CODE]
    )).rows;
    return { ...state, detail, shippedLines, ledger, billing };
  });
  if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE || after.order.shipped_carrier_name !== CARRIER) throw new Error("Order verification failed.");
  if (after.shippedLines.length !== after.lines.length || after.lines.some((line) => !after.shippedLines.some((row) => row.sku === line.sku && Number(row.shipped_quantity) === Number(line.requested_quantity)))) throw new Error("Shipped-line verification failed.");
  if (after.ledger.length !== after.lines.length || after.lines.some((line) => !after.ledger.some((row) => row.sku === line.sku && -Number(row.quantity_delta) === Number(line.requested_quantity)))) throw new Error("Inventory-ledger verification failed.");
  if (after.shipments.length !== 1 || after.shipments[0].status !== "SHIPPED" || after.shipments[0].carrier_name !== CARRIER || Number(after.shipments[0].total_pallets) !== PALLETS || Number(after.shipments[0].new_pallets) !== PALLETS) throw new Error("Warehouse-shipment verification failed.");
  console.log(JSON.stringify({ phase: "verified", order: CODE, status: after.order.status,
    shipDate: after.order.confirmed_ship_date, carrier: after.order.shipped_carrier_name,
    pallets: PALLETS, newPallets: PALLETS, shrinkWrappedPallets: PALLETS,
    inventoryVerified: true, shipmentStatus: after.shipments[0].status,
    shipmentEmailStatus: after.detail.shipmentEmailStatus,
    shrinkWrapBilling, billing: after.billing }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
