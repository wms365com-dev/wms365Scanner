import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "file:///C:/Users/T470/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const inputPath = "C:/Users/T470/Desktop/Ranchers_October_2026_Month_End_Freight_Report.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const result = await workbook.inspect({
  kind: "table",
  range: "'Freight Audit'!A1:M500",
  include: "values,formulas",
  tableMaxRows: 500,
  tableMaxCols: 13,
  maxChars: 250000,
});
const inspection = JSON.parse(String(result.ndjson || "").trim());
const rows = inspection.values || [];
const headers = rows[4] || [];
const expected = ["Purchase date", "Shopify order", "WMS order", "Recipient", "Units", "Carrier", "Tracking"];
if (expected.some((header, index) => headers[index] !== header)) {
  throw new Error("Freight Audit headers changed; no source JSON was written.");
}

const confirmedRows = rows.slice(5).filter((row) => String(row[6] || "").trim());
const unresolved = confirmedRows.filter((row) => !/^ORD-\d{6}$/.test(String(row[2] || "").trim())).map((row) => ({
  shopifyOrder: String(row[1] || "").trim(),
  wmsOrder: String(row[2] || "").trim(),
  purchaseDate: String(row[0] || "").trim(),
  units: Number(row[4] || 0),
  carrier: String(row[5] || "").trim(),
  tracking: String(row[6] || "").trim().toUpperCase().replace(/\s+/g, ""),
}));
const packages = confirmedRows.filter((row) => /^ORD-\d{6}$/.test(String(row[2] || "").trim()));
const byOrder = new Map();
const trackingOwners = new Map();
for (const row of packages) {
  const orderCode = String(row[2]).trim().toUpperCase();
  const tracking = String(row[6]).trim().toUpperCase().replace(/\s+/g, "");
  const entry = byOrder.get(orderCode) || {
    orderCode,
    shopifyOrders: new Set(),
    purchaseDates: new Set(),
    quantities: new Set(),
    carriers: new Set(),
    trackingNumbers: new Set(),
  };
  entry.shopifyOrders.add(String(row[1] || "").trim());
  entry.purchaseDates.add(String(row[0] || "").trim());
  entry.quantities.add(Number(row[4] || 0));
  entry.carriers.add(String(row[5] || "").trim());
  entry.trackingNumbers.add(tracking);
  byOrder.set(orderCode, entry);
  const prior = trackingOwners.get(tracking);
  if (prior && prior !== orderCode) throw new Error(`Tracking ${tracking} is assigned to multiple orders.`);
  trackingOwners.set(tracking, orderCode);
}

const conflicts = [];
const orders = [...byOrder.values()].sort((a, b) => a.orderCode.localeCompare(b.orderCode)).map((entry) => {
  if (entry.shopifyOrders.size !== 1 || entry.purchaseDates.size !== 1
      || entry.quantities.size !== 1 || entry.carriers.size !== 1) {
    conflicts.push({
      orderCode: entry.orderCode,
      shopifyOrderCount: entry.shopifyOrders.size,
      purchaseDateCount: entry.purchaseDates.size,
      quantityCount: entry.quantities.size,
      carrierCount: entry.carriers.size,
    });
  }
  return {
    orderCode: entry.orderCode,
    shopifyOrder: [...entry.shopifyOrders][0] || "",
    actualShipDate: [...entry.purchaseDates][0] || "",
    itemQuantityEa: [...entry.quantities][0] || 0,
    carrier: [...entry.carriers][0] || "",
    tracking: [...entry.trackingNumbers].join("\n"),
    trackingNumbers: [...entry.trackingNumbers],
  };
});
if (conflicts.length) throw new Error(`Workbook contains ${conflicts.length} conflicting order groups.`);

const outputPath = path.resolve("outputs/ranchers-october-2026-labels/source-orders.json");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify({
  source: {
    workbook: path.basename(inputPath),
    sheet: "Freight Audit",
    period: "2026-10-01 through 2026-10-31",
  },
  packageRows: packages.length,
  confirmedLabelRows: confirmedRows.length,
  unresolved,
  orderCount: orders.length,
  rows: orders,
  orders,
}, null, 2));
console.log(JSON.stringify({
  outputPath,
  packageRows: packages.length,
  confirmedLabelRows: confirmedRows.length,
  unresolvedCount: unresolved.length,
  unresolvedShopifyOrders: unresolved.map((row) => row.shopifyOrder),
  orderCount: orders.length,
  multiPackageOrders: orders.filter((order) => order.trackingNumbers.length > 1).length,
  uniqueTracking: trackingOwners.size,
}));
