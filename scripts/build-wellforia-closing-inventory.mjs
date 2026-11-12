import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "file:///C:/Users/T470/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const root = "C:/WMS365Scanner-shopify-scheduler-fix";
const period = process.argv[2] || "2026-09-30";
const reportDate = new Date(`${period}T12:00:00-04:00`);
const reportLabel = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(reportDate);
const cutoffDate = new Date(reportDate);
cutoffDate.setDate(cutoffDate.getDate() + 1);
const cutoffLabel = cutoffDate.toISOString().slice(0, 10);
const inputPath = `${root}/outputs/wellforia-month-end/wellforia-closing-inventory-${period}.json`;
const outputPath = `${root}/outputs/wellforia-month-end/Wellforia_Inventory_As_Of_${period}.xlsx`;
const data = JSON.parse(await fs.readFile(inputPath, "utf8"));
const n = (value) => Number(value) || 0;
const colors = { navy: "#17324D", teal: "#167D8D", pale: "#EAF4F5", blue: "#EEF4F8", line: "#CBD5E1", white: "#FFFFFF" };
const allocation = new Map(data.allocations.map((row) => [row.sku, n(row.allocated_quantity)]));
const locationMap = new Map();
for (const row of data.closingByLocation) {
  if (!locationMap.has(row.sku)) locationMap.set(row.sku, []);
  locationMap.get(row.sku).push(row);
}
const rows = data.catalog.map((item) => {
  const locations = locationMap.get(item.sku) || [];
  const onHand = locations.reduce((sum, row) => sum + n(row.closing_quantity), 0);
  const allocated = allocation.get(item.sku) || 0;
  return [item.sku, item.description, item.uom, onHand, allocated, onHand - allocated, locations.filter((row) => n(row.closing_quantity) !== 0).length];
});
const detailRows = data.closingByLocation.map((row) => [row.sku, row.location, row.lot_number, row.expiration_date || null, n(row.closing_quantity)]);
const totalOnHand = rows.reduce((sum, row) => sum + row[3], 0);
const totalAllocated = rows.reduce((sum, row) => sum + row[4], 0);
const totalAvailable = rows.reduce((sum, row) => sum + row[5], 0);
const skuWithInventory = rows.filter((row) => row[3] !== 0).length;
const wb = Workbook.create();
const summary = wb.worksheets.add("Inventory Summary");
summary.showGridLines = false;
summary.getRange("A1:G1").merge(); summary.getRange("A1").values = [["WMS365 | WELLFORIA HEALTH INC - INVENTORY REPORT"]];
summary.getRange("A2:G2").merge(); summary.getRange("A2").values = [[`Physical closing inventory as of ${reportLabel} at 11:59 PM Eastern`]];
summary.getRange("A1:G1").format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 16 }, verticalAlignment: "center" };
summary.getRange("A1:G1").format.rowHeight = 32;
summary.getRange("A2:G2").format = { fill: colors.blue, font: { color: colors.navy, italic: true } };
summary.getRange("A4:B8").values = [["Report Information","Value"],["Report date",reportDate],["Company",data.account],["SKUs with inventory",skuWithInventory],["Basis","Physical on hand less truly open allocations"]];
summary.getRange("D4:E8").values = [["Inventory Measure","Quantity"],["On hand",totalOnHand],["Open allocated",totalAllocated],["Available",totalAvailable],["Non-pickable",0]];
for (const range of ["A4:B4","D4:E4","A12:G12"]) summary.getRange(range).format = { fill: colors.teal, font: { bold: true, color: colors.white }, borders: { preset: "all", style: "thin", color: colors.line } };
summary.getRange("B5").format.numberFormat = "yyyy-mm-dd";
summary.getRange("E5:E8").format.numberFormat = "#,##0";
summary.getRange("A10:G10").merge(); summary.getRange("A10").values = [[`Physical cutoff reconstruction: current stock was rolled back for applicable inventory transactions posted on or after ${cutoffLabel}. Shipments confirmed before the cutoff remain deducted even when posted later in WMS. Open allocations exclude orders physically shipped before the cutoff.`]];
summary.getRange("A10:G10").format = { fill: colors.pale, font: { color: colors.navy }, wrapText: true };
summary.getRange("A12:G12").values = [["SKU","Description","UOM","On Hand","Open Allocated","Available","Storage Locations"]];
summary.getRangeByIndexes(12,0,rows.length,7).values = rows;
const totalRow = 13 + rows.length;
summary.getRange(`A${totalRow}:G${totalRow}`).values = [["TOTAL",null,null,totalOnHand,totalAllocated,totalAvailable,null]];
summary.getRange(`A${totalRow}:G${totalRow}`).format = { fill: colors.navy, font: { bold: true, color: colors.white }, borders: { preset: "all", style: "thin", color: colors.line } };
summary.getRange(`A12:G${totalRow}`).format.borders = { preset: "all", style: "thin", color: colors.line };
summary.getRange(`D13:G${totalRow}`).format.numberFormat = "#,##0";
summary.freezePanes.freezeRows(12);
for (const [range,width] of [["A:A",24],["B:B",39],["C:C",12],["D:F",16],["G:G",18]]) summary.getRange(range).format.columnWidth = width;

const detail = wb.worksheets.add("Inventory by Location");
detail.showGridLines = false;
detail.getRange("A1:E1").merge(); detail.getRange("A1").values = [[`WELLFORIA | ${reportLabel.toUpperCase()} PHYSICAL CLOSING INVENTORY BY LOCATION`]];
detail.getRange("A1:E1").format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 16 } };
detail.getRange("A3:E3").values = [["SKU","Location","Lot","Expiration","On Hand"]];
detail.getRange("A3:E3").format = { fill: colors.teal, font: { bold: true, color: colors.white }, borders: { preset: "all", style: "thin", color: colors.line } };
if (detailRows.length) {
  detail.getRangeByIndexes(3,0,detailRows.length,5).values = detailRows;
  const end = 3 + detailRows.length;
  detail.getRange(`A4:E${end}`).format.borders = { preset: "all", style: "thin", color: colors.line };
  detail.getRange(`D4:D${end}`).format.numberFormat = "yyyy-mm-dd";
  detail.getRange(`E4:E${end}`).format.numberFormat = "#,##0";
  detail.tables.add(`A3:E${end}`, true, "WellforiaClosingInventoryByLocation").style = "TableStyleMedium2";
}
detail.freezePanes.freezeRows(3);
for (const [range,width] of [["A:A",24],["B:B",34],["C:C",18],["D:D",16],["E:E",15]]) detail.getRange(range).format.columnWidth = width;

await fs.mkdir(`${root}/outputs/wellforia-month-end`, { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(wb); await exported.save(outputPath);
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
const check = await wb.inspect({ kind: "table", range: `Inventory Summary!A1:G${totalRow}`, include: "values,formulas", tableMaxRows: 80, tableMaxCols: 10, summary: "closing inventory summary" });
const preview = await wb.render({ sheetName: "Inventory Summary", range: "A1:G24", scale: 1.2, format: "png" });
await fs.writeFile(`${root}/outputs/wellforia-month-end/wellforia-closing-inventory-${period}.png`, new Uint8Array(await preview.arrayBuffer()));
await fs.writeFile(`${root}/outputs/wellforia-month-end/wellforia-closing-inventory-${period}-inspection.json`, JSON.stringify({ check: check.ndjson, errors: errors.ndjson }, null, 2));
console.log(JSON.stringify({ outputPath, totalOnHand, totalAllocated, totalAvailable, skuWithInventory, formulaErrors: errors.ndjson }));
