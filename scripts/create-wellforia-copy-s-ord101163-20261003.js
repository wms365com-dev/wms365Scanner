"use strict";

const { APP_USER_ROLES, getPortalOrderById, savePortalOrderDraftForAccount, withTransaction } = require("../server");

const SOURCE_CODE = "S-ORD101163";
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE_ID = 1;
const WAREHOUSE = "GW3PL-MISS";
const ORDER_DATE = "2026-10-03";
const SHIP_DATE = "2026-10-04";
const REFERENCE = "COPY-S-ORD101163-20261003";
const APPLY = process.argv.includes("--apply");
const LINES = [
  { sku: "PKP50", quantity: 10, label: "Peekapoo 50 pack" },
  { sku: "TP-WW-6PK-UPC", quantity: 12, label: "Whoopsie Wipes 6 Pack" },
  { sku: "TP-PKP-XL50", quantity: 5, label: "Peekapoo Liners XL" },
];
const ACTOR = { id: null, email: "wms365-operations@wms365.co",
  full_name: "WMS365 Operations - Owner Approved Order Copy", role: APP_USER_ROLES.SUPER_ADMIN };

async function inspect(client, lock = false) {
  const sourceRow = await client.query(
    `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
            fl.code warehouse_code,fl.is_active warehouse_active
       from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
      where o.order_code=$1${lock ? " for update of o" : ""}`, [SOURCE_CODE]);
  if (sourceRow.rowCount !== 1) throw new Error(`Expected one exact ${SOURCE_CODE}.`);
  const identity = sourceRow.rows[0];
  if (identity.account_name !== ACCOUNT || Number(identity.fulfillment_location_id) !== WAREHOUSE_ID
    || identity.warehouse_code !== WAREHOUSE || !identity.warehouse_active) throw new Error("Source company or warehouse mismatch.");
  if (!['DRAFT','RELEASED','PICKING','PICKED','STAGED','SHIPPED'].includes(identity.status)) throw new Error(`Source status ${identity.status} cannot be copied.`);
  const source = await getPortalOrderById(client, identity.id, ACCOUNT);
  if (!source) throw new Error("Source order details are unavailable.");
  const items = (await client.query(
    `select sku,description,blocked,tracking_level,unit_uom,units_per_case
       from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
    [ACCOUNT, LINES.map((line) => line.sku)])).rows;
  if (items.length !== LINES.length) throw new Error("One or more requested SKUs are missing from Wellforia item master.");
  for (const line of LINES) {
    const item = items.find((row) => row.sku === line.sku);
    if (!item || item.blocked) throw new Error(`${line.sku} is unavailable or blocked.`);
  }
  const duplicate = await client.query(
    `select id,order_code,status,requested_ship_date::text from portal_orders
      where account_name=$1 and shipping_reference=$2 order by id`, [ACCOUNT, REFERENCE]);
  if (duplicate.rowCount > 1) throw new Error("More than one matching copied order exists.");
  const stock = (await client.query(
    `select sku,coalesce(sum(quantity),0)::int on_hand from inventory_lines
      where account_name=$1 and sku=any($2::text[]) group by sku order by sku`,
    [ACCOUNT, LINES.map((line) => line.sku)])).rows;
  return { identity, source, items, duplicate: duplicate.rows[0] || null, stock };
}

function verifyDraft(order, before) {
  if (!order || order.status !== "DRAFT" || order.accountName !== ACCOUNT
    || Number(order.fulfillmentLocationId) !== WAREHOUSE_ID) throw new Error("Copied draft identity verification failed.");
  if (order.requestedShipDate !== SHIP_DATE || order.shippingReference !== REFERENCE) throw new Error("Copied draft dates or reference verification failed.");
  const actual = (order.lines || []).map((line) => ({ sku: line.sku, quantity: Number(line.quantity) }));
  const expected = LINES.map((line) => ({ sku: line.sku, quantity: line.quantity }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Copied draft lines do not match: ${JSON.stringify(actual)}.`);
  if (order.shipToName !== before.source.shipToName || order.shipToAddress1 !== before.source.shipToAddress1
    || order.shipToCity !== before.source.shipToCity || order.shipToState !== before.source.shipToState
    || order.shipToPostalCode !== before.source.shipToPostalCode || order.shipToCountry !== before.source.shipToCountry) {
    throw new Error("Copied destination does not match the source order.");
  }
}

async function main() {
  const result = await withTransaction(async (client) => {
    if (!APPLY) await client.query("set transaction read only");
    const before = await inspect(client, APPLY);
    let order = before.duplicate ? await getPortalOrderById(client, before.duplicate.id, ACCOUNT) : null;
    if (order && order.status !== "DRAFT") throw new Error(`Matching copy already exists as ${order.orderCode} (${order.status}).`);
    if (APPLY && !order) {
      order = await savePortalOrderDraftForAccount(client, ACCOUNT, {
        fulfillmentLocationId: WAREHOUSE_ID,
        poNumber: `${before.source.poNumber || SOURCE_CODE}-COPY-20261003`,
        shippingReference: REFERENCE,
        contactName: before.source.contactName,
        contactPhone: before.source.contactPhone,
        requestedShipDate: SHIP_DATE,
        orderType: before.source.orderType,
        shipmentMethod: before.source.shipmentMethod,
        rushApproved: false,
        rushExempt: true,
        rushExemptNote: "Historical owner-requested draft copy; review before release.",
        orderNotes: `Owner-requested custom copy of ${SOURCE_CODE}. Business order date: ${ORDER_DATE}. Requested ship date: ${SHIP_DATE}. Created as DRAFT for review before release.`,
        shipToName: before.source.shipToName,
        shipToPhone: before.source.shipToPhone,
        shipToAddress1: before.source.shipToAddress1,
        shipToAddress2: before.source.shipToAddress2,
        shipToCity: before.source.shipToCity,
        shipToState: before.source.shipToState,
        shipToPostalCode: before.source.shipToPostalCode,
        shipToCountry: before.source.shipToCountry,
        lines: LINES.map(({ sku, quantity }) => ({ sku, quantity })),
      }, null, {
        activityTitlePrefix: "warehouse sales",
        activityActor: ACTOR.full_name,
        uploadedBy: ACTOR.email,
        enforceInventoryAvailability: false,
      });
    }
    if (order) verifyDraft(order, before);
    if (order) {
      const sideEffects = await client.query(
        `select (select count(*)::int from portal_order_allocations where order_id=$1) allocations,
                (select count(*)::int from warehouse_shipments where order_id=$1) shipments`, [order.id]);
      if (sideEffects.rows[0].allocations || sideEffects.rows[0].shipments) throw new Error("Draft unexpectedly created allocations or shipment records.");
    }
    return { mode: APPLY ? "APPLIED" : "PREFLIGHT", source: { orderCode: SOURCE_CODE,
      status: before.identity.status, warehouse: before.identity.warehouse_code },
      businessOrderDate: ORDER_DATE, requestedShipDate: SHIP_DATE,
      items: LINES.map((line) => ({ label: line.label, sku: line.sku, quantity: line.quantity,
        description: before.items.find((item) => item.sku === line.sku)?.description || "",
        onHand: Number(before.stock.find((row) => row.sku === line.sku)?.on_hand || 0) })),
      created: order ? { orderCode: order.orderCode, status: order.status,
        shippingReference: order.shippingReference, lineCount: order.lines.length } : null,
      existingMatch: !!before.duplicate };
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
