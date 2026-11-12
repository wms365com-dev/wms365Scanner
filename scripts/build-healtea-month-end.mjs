import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "file:///C:/Users/T470/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const root = "C:/WMS365Scanner-shopify-scheduler-fix";
const inputDir = `${root}/outputs/healtea-month-end`;
const outputDir = `${root}/outputs/healtea-month-end`;
const periods = [
  { key: "2026-07", label: "July 2026", file: "Healtea_July_2026_Month_End_Activity.xlsx" },
  { key: "2026-08", label: "August 2026", file: "Healtea_August_2026_Month_End_Activity.xlsx" },
  { key: "2026-09", label: "September 2026", file: "Healtea_September_2026_Month_End_Activity.xlsx" },
];
const requestedPeriods = new Set(process.argv.slice(2));
const selectedPeriods = requestedPeriods.size ? periods.filter((period) => requestedPeriods.has(period.key)) : periods;
if (!selectedPeriods.length) throw new Error(`No supported period requested. Use one of: ${periods.map((period) => period.key).join(", ")}`);
const colors = { navy: "#17324D", teal: "#167D8D", pale: "#EAF4F5", blue: "#EEF4F8", amber: "#FFF4D6", line: "#CBD5E1", white: "#FFFFFF", text: "#1F2937" };
const n = (value) => Number(value) || 0;
const d = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const dateOnly = (value) => d(`${String(value || "").slice(0, 10)}T12:00:00-04:00`);
const uniqueCount = (rows, key) => new Set(rows.map((row) => row[key]).filter(Boolean)).size;
function setWidths(sheet, entries) { for (const [range, width] of entries) sheet.getRange(range).format.columnWidth = width; }

function title(sheet, lastCol, heading, subtitle) {
  sheet.showGridLines = false;
  sheet.getRange(`A1:${lastCol}1`).merge();
  sheet.getRange("A1").values = [[heading]];
  sheet.getRange(`A2:${lastCol}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A1:${lastCol}1`).format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 16 }, verticalAlignment: "center" };
  sheet.getRange(`A1:${lastCol}1`).format.rowHeight = 32;
  sheet.getRange(`A2:${lastCol}2`).format = { fill: colors.blue, font: { color: colors.navy, italic: true }, wrapText: true, verticalAlignment: "center" };
  sheet.getRange(`A2:${lastCol}2`).format.rowHeight = 28;
}

function detailSheet(wb, config) {
  const sheet = wb.worksheets.add(config.name);
  title(sheet, config.lastCol, config.heading, config.subtitle);
  const headerRow = 4, dataStart = 5;
  sheet.getRange(`A${headerRow}:${config.lastCol}${headerRow}`).values = [config.headers];
  sheet.getRange(`A${headerRow}:${config.lastCol}${headerRow}`).format = { fill: colors.teal, font: { bold: true, color: colors.white }, wrapText: true, borders: { preset: "all", style: "thin", color: colors.line }, verticalAlignment: "center" };
  sheet.getRange(`A${headerRow}:${config.lastCol}${headerRow}`).format.rowHeight = 36;
  if (config.rows.length) {
    const dataEnd = dataStart + config.rows.length - 1;
    sheet.getRangeByIndexes(dataStart - 1, 0, config.rows.length, config.headers.length).values = config.rows;
    sheet.getRange(`A${dataStart}:${config.lastCol}${dataEnd}`).format = { borders: { preset: "all", style: "thin", color: colors.line }, verticalAlignment: "center" };
    sheet.tables.add(`A${headerRow}:${config.lastCol}${dataEnd}`, true, config.tableName).style = "TableStyleMedium2";
    for (const [range, format] of config.formats || []) sheet.getRange(range.replaceAll("{end}", String(dataEnd))).format.numberFormat = format;
  } else {
    sheet.getRange(`A${dataStart}:${config.lastCol}${dataStart}`).merge();
    sheet.getRange(`A${dataStart}`).values = [["No activity recorded for this period."]];
    sheet.getRange(`A${dataStart}:${config.lastCol}${dataStart}`).format = { fill: colors.amber, font: { color: colors.text, italic: true } };
  }
  sheet.freezePanes.freezeRows(headerRow);
  setWidths(sheet, config.widths);
}

for (const period of selectedPeriods) {
  const data = JSON.parse(await fs.readFile(`${inputDir}/healtea-month-end-${period.key}.json`, "utf8"));
  const wb = Workbook.create();
  const summary = wb.worksheets.add("Summary");
  title(summary, "H", `WMS365 | HEALTEA ${period.label.toUpperCase()} MONTH-END ACTIVITY`, "Read-only production activity report; dates use America/Toronto warehouse time.");
  const outboundOrders = uniqueCount(data.outbound, "order_code");
  const inboundReceipts = uniqueCount(data.inbound, "inbound_code");
  const shippedQty = data.outbound.reduce((sum, row) => sum + n(row.shipped_quantity), 0);
  const receivedQty = data.inbound.reduce((sum, row) => sum + n(row.received_quantity), 0);
  const netInventory = data.inventoryActivity.reduce((sum, row) => sum + n(row.quantity_delta), 0);
  const billingAmount = data.billing.reduce((sum, row) => sum + n(row.amount), 0);
  const currency = [...new Set(data.billing.map((row) => row.currency_code).filter(Boolean))].join(", ") || "n.a.";
  summary.getRange("A4:B11").values = [["Report Information", "Value"], ["Company", data.account], ["Period", period.label], ["Period start", dateOnly(data.period.start)], ["Period end (exclusive)", dateOnly(data.period.end)], ["Generated", d(data.generatedAt)], ["Time zone", "America/Toronto"], ["Source", "WMS365 production database"]];
  summary.getRange("D4:E11").values = [["Activity Summary", "Total"], ["Shipped orders", outboundOrders], ["Shipped line quantity", shippedQty], ["Received inbounds", inboundReceipts], ["Received line quantity", receivedQty], ["Inventory transactions", data.inventoryActivity.length], ["Net inventory quantity change", netInventory], ["Billing activity", data.billing.length]];
  summary.getRange("G4:H7").values = [["Billing Summary", "Value"], ["Non-void amount", billingAmount], ["Currency", currency], ["Billing rows", data.billing.length]];
  for (const range of ["A4:B4", "D4:E4", "G4:H4"]) summary.getRange(range).format = { fill: colors.teal, font: { bold: true, color: colors.white }, borders: { preset: "all", style: "thin", color: colors.line } };
  for (const range of ["A4:B11", "D4:E11", "G4:H7"]) summary.getRange(range).format.borders = { preset: "outside", style: "thin", color: colors.line };
  summary.getRange("B7:B8").format.numberFormat = "yyyy-mm-dd";
  summary.getRange("B9").format.numberFormat = "yyyy-mm-dd hh:mm";
  summary.getRange("E5:E11").format.numberFormat = "#,##0";
  summary.getRange("H5").format.numberFormat = '"$"#,##0.00';
  summary.getRange("A13:H13").merge();
  summary.getRange("A13").values = [["Reconciliation: summary totals are calculated from the detail tabs. Cancelled orders, cancelled inbounds, and void billing events are excluded."]];
  summary.getRange("A13:H13").format = { fill: colors.pale, font: { color: colors.navy }, wrapText: true, borders: { preset: "outside", style: "thin", color: colors.line } };
  summary.getRange("A13:H13").format.rowHeight = 40;
  setWidths(summary, [["A:A", 27], ["B:B", 31], ["C:C", 3], ["D:D", 30], ["E:E", 18], ["F:F", 3], ["G:G", 22], ["H:H", 20]]);
  detailSheet(wb, { name: "Outbound", lastCol: "M", heading: `HEALTEA | ${period.label.toUpperCase()} OUTBOUND`, subtitle: "Orders confirmed shipped during the reporting period.", headers: ["Ship Date", "Order", "Status", "PO", "Order Type", "Shipment Method", "Carrier", "Pallets", "Line", "SKU", "Requested Qty", "Shipped Qty", "Quantity Check"], rows: data.outbound.map((r) => [dateOnly(r.confirmed_ship_date || r.shipped_at), r.order_code, r.status, r.po_number, r.order_type, r.shipment_method, r.shipped_carrier_name, n(r.outbound_total_pallets), n(r.line_number), r.sku, n(r.requested_quantity), n(r.shipped_quantity), n(r.requested_quantity) === n(r.shipped_quantity) ? "MATCH" : "REVIEW"]), tableName: `HealteaOutbound${period.key.replace("-", "")}`, formats: [["A5:A{end}", "yyyy-mm-dd"], ["H5:L{end}", "#,##0"]], widths: [["A:A", 14], ["B:B", 18], ["C:C", 12], ["D:D", 18], ["E:F", 20], ["G:G", 24], ["H:I", 11], ["J:J", 24], ["K:L", 15], ["M:M", 16]] });
  detailSheet(wb, { name: "Inbound", lastCol: "L", heading: `HEALTEA | ${period.label.toUpperCase()} INBOUND`, subtitle: "Inbound lines received during the reporting period.", headers: ["Received Date", "Inbound", "Status", "Reference", "Carrier", "Line", "SKU", "Expected Qty", "Received Qty", "Location", "Lot", "Expiration"], rows: data.inbound.map((r) => [dateOnly(r.received_date), r.inbound_code, r.status, r.reference_number, r.carrier_name, n(r.line_number), r.sku, n(r.expected_quantity), n(r.received_quantity), r.received_location, r.lot_number, dateOnly(r.expiration_date)]), tableName: `HealteaInbound${period.key.replace("-", "")}`, formats: [["A5:A{end}", "yyyy-mm-dd"], ["F5:I{end}", "#,##0"], ["L5:L{end}", "yyyy-mm-dd"]], widths: [["A:A", 15], ["B:B", 18], ["C:C", 21], ["D:E", 22], ["F:F", 10], ["G:G", 24], ["H:I", 15], ["J:J", 28], ["K:L", 16]] });
  detailSheet(wb, { name: "Inventory Activity", lastCol: "L", heading: `HEALTEA | ${period.label.toUpperCase()} INVENTORY ACTIVITY`, subtitle: "Append-only inventory ledger transactions posted during the reporting period.", headers: ["Activity Time", "Type", "Source Type", "Source ID", "Location", "SKU", "Lot", "Expiration", "Qty Change", "Qty Before", "Qty After", "Balance Check"], rows: data.inventoryActivity.map((r) => [d(r.activity_time), r.transaction_type, r.source_type, r.source_id, r.location, r.sku, r.lot_number, r.expiration_date, n(r.quantity_delta), n(r.quantity_before), n(r.quantity_after), n(r.quantity_before) + n(r.quantity_delta) === n(r.quantity_after) ? "MATCH" : "REVIEW"]), tableName: `HealteaInventory${period.key.replace("-", "")}`, formats: [["A5:A{end}", "yyyy-mm-dd hh:mm"], ["I5:K{end}", "#,##0"]], widths: [["A:A", 21], ["B:D", 20], ["E:E", 32], ["F:F", 24], ["G:H", 16], ["I:K", 14], ["L:L", 16]] });
  detailSheet(wb, { name: "Billing", lastCol: "N", heading: `HEALTEA | ${period.label.toUpperCase()} BILLING ACTIVITY`, subtitle: "Non-void billing events with service dates in the reporting period.", headers: ["Service Date", "Category", "Fee Code", "Fee Name", "Unit", "Quantity", "Rate", "Amount", "Currency", "Status", "Source Type", "Source Ref", "Reference", "Note"], rows: data.billing.map((r) => [dateOnly(r.service_date), r.fee_category, r.fee_code, r.fee_name, r.unit_label, n(r.quantity), n(r.rate), n(r.amount), r.currency_code, r.status, r.source_type, r.source_ref, r.reference, r.note]), tableName: `HealteaBilling${period.key.replace("-", "")}`, formats: [["A5:A{end}", "yyyy-mm-dd"], ["F5:F{end}", "#,##0.0000"], ["G5:H{end}", '"$"#,##0.00']], widths: [["A:A", 15], ["B:B", 18], ["C:C", 20], ["D:D", 30], ["E:E", 14], ["F:H", 15], ["I:J", 13], ["K:M", 22], ["N:N", 36]] });
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = `${outputDir}/${period.file}`;
  const exported = await SpreadsheetFile.exportXlsx(wb);
  await exported.save(outputPath);
  const errorScan = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: `${period.key} formula error scan` });
  const preview = await wb.render({ sheetName: "Summary", range: "A1:H13", scale: 1.3, format: "png" });
  await fs.writeFile(`${outputDir}/healtea-month-end-${period.key}-summary.png`, new Uint8Array(await preview.arrayBuffer()));
  console.log(JSON.stringify({ outputPath, period: period.key, outboundOrders, inboundReceipts, shippedQty, receivedQty, netInventory, billingAmount, formulaErrors: errorScan.ndjson }));
}
