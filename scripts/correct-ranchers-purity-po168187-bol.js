"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { buildPortalOrderBillOfLadingPdfAttachment, getPortalOrderById } = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const CODE = "ORD-001731";
const PO = "168187";
const FILE = `WMS365_BOL_${CODE}_PO${PO}.pdf`;
const OUT = path.resolve(__dirname, "..", "outputs", "ranchers-purity-po168187", FILE);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin");
    const row = (await db.query("select id,status,po_number from portal_orders where order_code=$1 and account_name=$2 for update", [CODE, ACCOUNT])).rows[0];
    if (!row || row.status !== "STAGED" || row.po_number !== PO) throw new Error("Order identity or status mismatch.");
    const order = await getPortalOrderById(db, row.id, ACCOUNT);
    if (order.lines.length !== 1 || order.lines[0].sku !== "RTC-4OZ-EA" || Number(order.lines[0].quantity) !== 1536) throw new Error("Order line mismatch.");
    const bolOrder = structuredClone(order);
    bolOrder.orderNotes = "128 CASES x 12 BAGS (1536 EACHES). 3 SKIDS. Customer pickup by Purity Life.";
    bolOrder.lines = bolOrder.lines.map((line) => ({ ...line, quantity: 128, trackingLevel: "CASE",
      description: "Rancher's Tallow Chips - 4 oz (Case of 12)",
      pickLocations: (line.pickLocations || []).map((pick) => ({ ...pick, quantity: 128, trackingLevel: "CASE" })) }));
    for (const shipment of bolOrder.warehouseShipments) {
      shipment.lines = bolOrder.lines.map((line) => ({ ...line }));
    }
    const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
    const updated = await db.query(`update portal_order_documents set file_size=$3,file_data=$4,uploaded_by=$5
      where order_id=$1 and file_name=$2 and document_category='SHIPMENT_BOL' returning id`,
      [row.id, FILE, pdf.content.length, pdf.content, "Owner-authorized BOL case display correction"]);
    if (updated.rowCount !== 1) throw new Error("Expected exactly one BOL document to update.");
    await db.query("commit");
    fs.writeFileSync(OUT, pdf.content);
    console.log(JSON.stringify({ orderCode: CODE, status: "STAGED", freightTableCases: 128, file: OUT,
      sha256: crypto.createHash("sha256").update(pdf.content).digest("hex") }));
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; }
  finally { db.release(); await pool.end(); }
}
main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
