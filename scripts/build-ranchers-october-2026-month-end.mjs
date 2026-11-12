import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "file:///C:/Users/T470/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const root = "C:/WMS365Scanner-shopify-scheduler-fix";
const dir = `${root}/outputs/ranchers-october-2026-labels`;
const outputPath = `${dir}/Ranchers_October_2026_Month_End_Order_Report.xlsx`;
const all = JSON.parse(await fs.readFile(`${dir}/all-orders-snapshot.json`, "utf8"));
const source = JSON.parse(await fs.readFile(`${dir}/source-orders.json`, "utf8"));
const resolved = JSON.parse(await fs.readFile(`${dir}/source-orders-resolved.json`, "utf8"));
const audit = JSON.parse(await fs.readFile(`${dir}/final-shipment-audit.json`, "utf8"));

const colors = { navy: "#17324D", teal: "#167D8D", pale: "#EAF4F5", blue: "#EEF4F8", amber: "#FFF4D6", red: "#FDECEC", green: "#E8F4EA", line: "#CBD5E1", white: "#FFFFFF" };
const n = (v) => Number(v) || 0;
const text = (v) => String(v == null ? "" : v);
const excelText = (v) => { const value = text(v); return value ? `\u2060${value}` : ""; };
const dateOnly = (v) => { const s = text(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : null; };
const octoberOrders = all.orders.filter((o) => text(o.confirmed_ship_date).slice(0, 7) === "2026-10").sort((a,b) => text(a.confirmed_ship_date).localeCompare(text(b.confirmed_ship_date)) || text(a.order_code).localeCompare(text(b.order_code)));
const auditByOrder = new Map([...(audit.exceptions || []).map((x) => [x.orderCode, x])]);
const labelByOrder = new Map(resolved.rows.map((r) => [r.orderCode, r]));
const exportMissing = (audit.exceptions || []).filter((x) => x.status === "SHIPPED" && (x.issues || []).includes("Shopify fulfillment export is not recorded"));
const blockedDrafts = (audit.exceptions || []).filter((x) => x.status === "DRAFT");
const unresolved = source.unresolved.filter((r) => (resolved.blockers || []).some((b) => b.sourceOrder === r.shopifyOrder));
const labelOrderCodes = new Set(resolved.rows.map((r) => r.orderCode));
const OctoberLabelOrders = octoberOrders.filter((o) => labelOrderCodes.has(o.order_code)).length;
const noLabelOctober = octoberOrders.filter((o) => !labelOrderCodes.has(o.order_code)).length;
const totalUnits = octoberOrders.reduce((a,o) => a + n(o.total_requested_qty), 0);

function widths(sheet, entries) { for (const [range, width] of entries) sheet.getRange(range).format.columnWidth = width; }
function title(sheet, last, heading, subtitle) {
  sheet.showGridLines = false;
  sheet.getRange(`A1:${last}1`).merge(); sheet.getRange("A1").values = [[heading]];
  sheet.getRange(`A2:${last}2`).merge(); sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A1:${last}1`).format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 16 }, verticalAlignment: "center" };
  sheet.getRange(`A1:${last}1`).format.rowHeight = 32;
  sheet.getRange(`A2:${last}2`).format = { fill: colors.blue, font: { color: colors.navy, italic: true }, wrapText: true };
}
function tableSheet(wb, config) {
  const s = wb.worksheets.add(config.name); title(s, config.last, config.heading, config.subtitle);
  s.getRange(`A4:${config.last}4`).values = [config.headers];
  s.getRange(`A4:${config.last}4`).format = { fill: colors.teal, font: { bold: true, color: colors.white }, wrapText: true, borders: { preset: "all", style: "thin", color: colors.line } };
  if (config.rows.length) {
    const end = 4 + config.rows.length;
    s.getRangeByIndexes(4, 0, config.rows.length, config.headers.length).values = config.rows;
    s.getRange(`A5:${config.last}${end}`).format = { borders: { preset: "all", style: "thin", color: colors.line }, verticalAlignment: "top" };
    s.tables.add(`A4:${config.last}${end}`, true, config.table).style = "TableStyleMedium2";
    for (const [range, fmt] of config.formats || []) s.getRange(range.replaceAll("{end}", String(end))).format.numberFormat = fmt;
  }
  s.freezePanes.freezeRows(4); widths(s, config.widths); return s;
}

const wb = Workbook.create();
const summary = wb.worksheets.add("Summary");
title(summary, "H", "RANCHER'S CHIPS | OCTOBER 2026 MONTH-END", "Production order closeout and purchased-label reconciliation. Generated November 3, 2026.");
summary.getRange("A4:B12").values = [
  ["Order Activity", "Count"], ["October shipped orders", octoberOrders.length], ["October shipped units", totalUnits], ["Label-backed October orders", OctoberLabelOrders], ["Other October shipped orders", noLabelOctober],
  ["Purchased labels reviewed", source.confirmedLabelRows], ["Resolved label orders", resolved.orderCount], ["Resolved tracking numbers", resolved.rows.reduce((a,r) => a + r.trackingNumbers.length, 0)], ["Unmapped purchased labels", unresolved.length]
];
summary.getRange("D4:E12").values = [
  ["Closeout Status", "Count"], ["Label orders shipped", audit.summary.shipped], ["Exact WMS tracking", audit.summary.exactTracking], ["Shopify export recorded", audit.summary.shopifyExportRecorded], ["Shipped, Shopify export missing", exportMissing.length],
  ["Blocked draft orders", blockedDrafts.length], ["Unmapped labels", unresolved.length], ["Fully reconciled label orders", audit.summary.exactMatches], ["Label audit exceptions", audit.summary.exceptions]
];
summary.getRange("G4:H10").values = [
  ["Control", "Result"], ["Account", all.account], ["Warehouse", all.warehouse], ["Shopify integration", all.integrationId], ["Store", all.store], ["Reporting period", "2026-10-01 to 2026-10-31"], ["Production snapshot", new Date(all.readAt)]
];
for (const r of ["A4:B4","D4:E4","G4:H4"]) summary.getRange(r).format = { fill: colors.teal, font: { bold: true, color: colors.white }, borders: { preset: "all", style: "thin", color: colors.line } };
summary.getRange("B5:B12").format.numberFormat = "#,##0"; summary.getRange("E5:E12").format.numberFormat = "#,##0"; summary.getRange("H10").format.numberFormat = "yyyy-mm-dd hh:mm";
summary.getRange("A14:H14").merge(); summary.getRange("A14").values = [["Month-end status: WMS shipment closeout is complete for 366 resolved label orders. Eight draft orders remain blocked by zero allocation. Three purchased labels cannot be mapped to a WMS order. Shopify fulfillment export evidence is missing for 37 shipped orders."]];
summary.getRange("A14:H14").format = { fill: colors.amber, font: { color: colors.navy, bold: true }, wrapText: true }; summary.getRange("A14:H14").format.rowHeight = 52;
summary.getRange("A16:H16").merge(); summary.getRange("A16").values = [["Counts are derived from the production WMS snapshot and the supplied purchased-label workbook. No recipient data is included."]]; summary.getRange("A16:H16").format = { fill: colors.pale, font: { color: colors.navy }, wrapText: true };
widths(summary, [["A:A",31],["B:B",17],["C:C",3],["D:D",34],["E:E",17],["F:F",3],["G:G",23],["H:H",34]]);

tableSheet(wb, { name: "October Orders", last: "N", heading: "RANCHER'S CHIPS | OCTOBER 2026 SHIPPED ORDERS", subtitle: "All production orders with a confirmed ship date in October 2026.",
  headers: ["Ship Date","WMS Order","Shopify Order","Status","Shipment Method","Carrier","Tracking","Requested Units","Line Count","SKU Quantities","Label Backed?","Shopify Export?","Warehouse","Created"],
  rows: octoberOrders.map((o) => { const a = auditByOrder.get(o.order_code); return [dateOnly(o.confirmed_ship_date),o.order_code,excelText(o.shopify_order_number||o.external_order_id),o.status,o.shipment_method,o.shipped_carrier_name,excelText(o.shipped_tracking_reference),n(o.total_requested_qty),n(o.line_count),o.sku_quantities,labelOrderCodes.has(o.order_code)?"YES":"NO",labelOrderCodes.has(o.order_code)?(a && (a.issues||[]).includes("Shopify fulfillment export is not recorded")?"MISSING":"RECORDED"):"n.a.",o.warehouse_code,new Date(o.created_at)]; }),
  table: "RanchersOctoberOrders2026", formats: [["A5:A{end}","yyyy-mm-dd"],["C5:C{end}","@"],["G5:G{end}","@"],["H5:I{end}","#,##0"],["N5:N{end}","yyyy-mm-dd hh:mm"]],
  widths: [["A:A",14],["B:B",17],["C:C",18],["D:F",19],["G:G",30],["H:I",14],["J:J",42],["K:L",17],["M:M",17],["N:N",20]] });

tableSheet(wb, { name: "Label Closeout", last: "J", heading: "RANCHER'S CHIPS | PURCHASED LABEL CLOSEOUT", subtitle: "One row per resolved WMS order from the supplied label workbook.",
  headers: ["WMS Order","Label Date","Carrier","Tracking Numbers","Packages","Units","WMS Status","Exact Tracking?","Shopify Export?","Closeout Result"],
  rows: resolved.rows.map((r) => { const o = all.orders.find((x) => x.order_code === r.orderCode); const a = auditByOrder.get(r.orderCode); const missingExport = a && (a.issues||[]).includes("Shopify fulfillment export is not recorded"); const exact = o?.status === "SHIPPED" && text(o.shipped_tracking_reference).trim(); return [r.orderCode,dateOnly(r.actualShipDate),r.carrier,excelText(r.trackingNumbers.join("\n")),r.trackingNumbers.length,n(r.itemQuantityEa),o?.status||"NOT FOUND",exact?"YES":"NO",o?.status === "SHIPPED"?(missingExport?"MISSING":"RECORDED"):"n.a.",o?.status === "SHIPPED"?(missingExport?"WMS CLOSED; SHOPIFY REVIEW":"CLOSED"):"BLOCKED"]; }),
  table: "RanchersLabelCloseout2026", formats: [["B5:B{end}","yyyy-mm-dd"],["D5:D{end}","@"],["E5:F{end}","#,##0"]],
  widths: [["A:A",17],["B:B",14],["C:C",27],["D:D",34],["E:F",12],["G:J",22]] });

const exceptionRows = [
  ...blockedDrafts.map((x) => ["ORDER",x.orderCode,"Blocked draft","Zero allocation; order remains DRAFT","Release and allocate only after owner review"]),
  ...unresolved.map((x) => ["LABEL",x.shopifyOrder,"Unmapped purchased label",`Tracking ${x.tracking}; no integration-4 WMS mapping`,"Confirm the correct WMS order"]),
  ...exportMissing.map((x) => ["ORDER",x.orderCode,"Shopify export missing","WMS is SHIPPED with matching tracking","Retry/verify Shopify fulfillment export"])
];
tableSheet(wb, { name: "Exceptions", last: "E", heading: "RANCHER'S CHIPS | OCTOBER CLOSEOUT EXCEPTIONS", subtitle: "Owner or integration action still required after WMS shipment reconciliation.",
  headers: ["Type","Reference","Issue","Evidence","Required Action"], rows: exceptionRows, table: "RanchersOctoberExceptions2026", formats: [],
  widths: [["A:A",13],["B:B",19],["C:C",27],["D:D",48],["E:E",43]] });

await fs.mkdir(dir, { recursive: true });
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
await fs.writeFile(`${dir}/month-end-formula-errors.ndjson`, errors.ndjson || "");
const preview = await wb.render({ sheetName: "Summary", range: "A1:H16", scale: 1.3, format: "png" });
await fs.writeFile(`${dir}/month-end-summary-preview.png`, new Uint8Array(await preview.arrayBuffer()));
const detailPreview = await wb.render({ sheetName: "October Orders", range: `A1:N${Math.min(24, octoberOrders.length + 4)}`, scale: 0.85, format: "png" });
await fs.writeFile(`${dir}/month-end-orders-preview.png`, new Uint8Array(await detailPreview.arrayBuffer()));
await (await SpreadsheetFile.exportXlsx(wb)).save(outputPath);
console.log(JSON.stringify({ outputPath, octoberOrders: octoberOrders.length, totalUnits, labelOrdersShipped: audit.summary.shipped, blockedDrafts: blockedDrafts.length, unresolvedLabels: unresolved.length, shopifyExportMissing: exportMissing.length, formulaErrors: errors.ndjson || "" }, null, 2));
