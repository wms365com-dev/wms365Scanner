"use strict";

const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001782";
const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const EXPECTED = new Map([
  ["S044", 7], ["S158", 5], ["S160", 1], ["S162", 2],
  ["S163", 2], ["S164", 2], ["S165", 17], ["S166", 5],
]);

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("begin");
    if (!APPLY) await db.query("set transaction read only");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-shipment-metadata-repair`]);
    const found = await db.query(
      `select o.id, o.status, o.account_name, o.confirmed_ship_date::text,
              o.shipped_carrier_name, o.shipped_tracking_reference,
              o.shipment_email_status, o.outbound_total_pallets,
              o.routing_total_weight, o.routing_weight_uom,
              s.id shipment_id, s.status shipment_status, s.carrier_name,
              s.tracking_reference, s.bol_reference, s.total_pallets,
              s.total_weight, s.weight_uom
         from portal_orders o
         join warehouse_shipments s on s.order_id = o.id
        where o.order_code = $1 ${APPLY ? "for update of o, s" : ""}`,
      [CODE]
    );
    if (found.rowCount !== 1) throw new Error("Order or shipment identity is not unique.");
    const row = found.rows[0];
    if (row.account_name !== ACCOUNT || row.status !== "SHIPPED"
      || row.shipment_status !== "SHIPPED" || row.confirmed_ship_date !== "2026-10-28"
      || row.shipped_carrier_name !== "VITRAN" || row.carrier_name !== "VITRAN"
      || row.shipped_tracking_reference !== "SYYZOD511585"
      || row.tracking_reference !== "SYYZOD511585" || row.bol_reference !== "SYYZOD511585"
      || Number(row.outbound_total_pallets) !== 1 || Number(row.routing_total_weight) !== 450
      || Number(row.total_weight) !== 450 || row.routing_weight_uom !== "LB" || row.weight_uom !== "LB") {
      throw new Error("Committed shipment details changed.");
    }
    if (APPLY && Number(row.total_pallets) !== 1) {
      await db.query(
        "update warehouse_shipments set total_pallets = 1, existing_pallets = 1, new_pallets = 0, mixed_pallets = 1, updated_at = now() where id = $1",
        [row.shipment_id]
      );
    }
    const shippedLines = (await db.query(
      "select sku, shipped_quantity from portal_order_shipment_lines where order_id = $1 order by sku",
      [row.id]
    )).rows;
    const ledger = (await db.query(
      `select sku, sum(quantity_delta)::integer quantity_delta
         from inventory_transactions
        where account_name = $1 and source_id = $2 and source_type = 'PORTAL_ORDER'
          and transaction_type = 'SHIPPING'
        group by sku order by sku`,
      [ACCOUNT, String(row.id)]
    )).rows;
    const documents = (await db.query(
      "select document_category from portal_order_documents where order_id = $1",
      [row.id]
    )).rows;
    const emailLogs = (await db.query(
      `select status, to_addresses, cc_addresses, bcc_addresses
         from email_delivery_log
        where account_name = $1 and source_ref = $2
          and source_type in ('PORTAL_ORDER', 'PORTAL_ORDER_SHIPMENT', 'SHIPMENT_CONFIRMATION')
        order by id desc`,
      [ACCOUNT, CODE]
    )).rows;
    const shipment = (await db.query(
      "select status, total_pallets, existing_pallets, new_pallets, mixed_pallets from warehouse_shipments where id = $1",
      [row.shipment_id]
    )).rows[0];
    if (shippedLines.length !== EXPECTED.size
      || shippedLines.some((line) => Number(line.shipped_quantity) !== EXPECTED.get(line.sku))) {
      throw new Error("Shipped line verification failed.");
    }
    if (ledger.length !== EXPECTED.size
      || ledger.some((line) => -Number(line.quantity_delta) !== EXPECTED.get(line.sku))) {
      throw new Error("Inventory ledger verification failed.");
    }
    if (!documents.some((document) => document.document_category === "SHIPMENT_BOL")
      || !documents.some((document) => document.document_category === "SHIPMENT_LOAD_PHOTO")) {
      throw new Error("Shipment evidence verification failed.");
    }
    if (Number(shipment.total_pallets) !== (APPLY ? 1 : Number(row.total_pallets))) {
      throw new Error("Shipment pallet metadata verification failed.");
    }
    if (row.shipment_email_status === "SENT" && emailLogs.some((log) => log.status === "SENT"
      && JSON.stringify(log.cc_addresses || []) !== "[]")) {
      throw new Error("Shipment email CC privacy verification failed.");
    }
    if (APPLY) await db.query("commit"); else await db.query("rollback");
    console.log(JSON.stringify({ mode: APPLY ? "APPLIED" : "PREFLIGHT", order: CODE,
      status: row.status, shipmentStatus: shipment.status, totalPallets: Number(shipment.total_pallets),
      shippedLineCount: shippedLines.length, ledgerSkuCount: ledger.length,
      evidenceCount: documents.length, shipmentEmailStatus: row.shipment_email_status,
      emailLogCount: emailLogs.length }));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
