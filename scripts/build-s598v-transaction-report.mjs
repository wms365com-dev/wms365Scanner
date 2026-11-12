import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "file:///C:/Users/T470/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const root = "C:/WMS365Scanner-shopify-scheduler-fix";
const outputDir = `${root}/outputs/s598v-transaction-report`;
const data = JSON.parse(await fs.readFile(`${outputDir}/s598v-transactions.json`, "utf8"));
const wb = Workbook.create();
const colors = {
  navy: "#17324D", teal: "#167D8D", pale: "#EAF4F5", blue: "#EEF4F8",
  amber: "#FFF4D6", green: "#E8F5E9", line: "#CBD5E1", white: "#FFFFFF", text: "#1F2937",
};
const n = (value) => Number(value) || 0;
const d = (value) => value ? new Date(value) : null;
const setWidths = (sheet, entries) => entries.forEach(([range, width]) => { sheet.getRange(range).format.columnWidth = width; });

function title(sheet, lastCol, heading, subtitle) {
  sheet.showGridLines = false;
  sheet.getRange(`A1:${lastCol}1`).merge();
  sheet.getRange("A1").values = [[heading]];
  sheet.getRange(`A2:${lastCol}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A1:${lastCol}1`).format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 16 }, verticalAlignment: "center" };
  sheet.getRange(`A1:${lastCol}1`).format.rowHeight = 32;
  sheet.getRange(`A2:${lastCol}2`).format = { fill: colors.blue, font: { color: colors.navy, italic: true }, wrapText: true, verticalAlignment: "center" };
  sheet.getRange(`A2:${lastCol}2`).format.rowHeight = 30;
}

const account = data.accounts[0] || {};
const item = data.items[0] || {};
const currentQty = data.stock.reduce((sum, row) => sum + n(row.quantity), 0);
const firstLedgerTime = data.transactions.length ? d(data.transactions[0].transaction_time_et) : null;
const lastLedgerTime = data.transactions.length ? d(data.transactions[data.transactions.length - 1].transaction_time_et) : null;
const generatedEt = data.generatedAt ? new Date(new Date(data.generatedAt).getTime() - (4 * 60 * 60 * 1000)) : null;
const summary = wb.worksheets.add("Summary");
title(summary, "H", "SKU S598V TRANSACTION REPORT", "Read-only WMS365 production inventory history. Transaction times use Eastern Time.");
summary.getRange("A4:B12").values = [
  ["Item information", "Value"],
  ["Company", account.account_name || "n.a."],
  ["SKU", data.sku],
  ["Description", item.description || "n.a."],
  ["Tracking level", item.tracking_level || "n.a."],
  ["Units per case", n(item.units_per_case)],
  ["Current stock", currentQty],
  ["Transaction count", n(account.transaction_count)],
  ["Generated", generatedEt],
];
summary.getRange("D4:E9").values = [
  ["Ledger summary", "Value"],
  ["First transaction", firstLedgerTime],
  ["Last transaction", lastLedgerTime],
  ["Net ledger quantity", n(account.net_ledger_quantity)],
  ["Current stock quantity", currentQty],
  ["Reconciliation", n(account.net_ledger_quantity) === currentQty ? "MATCH" : "REVIEW"],
];
summary.getRange("G4:H7").values = [
  ["Transaction type", "Net quantity"],
  ...data.totals.map((row) => [row.transaction_type, n(row.net_quantity)]),
  ["Total", data.totals.reduce((sum, row) => sum + n(row.net_quantity), 0)],
];
for (const range of ["A4:B4", "D4:E4", "G4:H4"]) {
  summary.getRange(range).format = { fill: colors.teal, font: { bold: true, color: colors.white }, borders: { preset: "all", style: "thin", color: colors.line } };
}
for (const range of ["A4:B12", "D4:E9", "G4:H7"]) summary.getRange(range).format.borders = { preset: "outside", style: "thin", color: colors.line };
summary.getRange("B10:B11").format.numberFormat = "#,##0";
summary.getRange("B12").format.numberFormat = "yyyy-mm-dd hh:mm";
summary.getRange("E5:E6").format.numberFormat = "yyyy-mm-dd hh:mm";
summary.getRange("E7:E8").format.numberFormat = "#,##0";
summary.getRange("E9").format = { fill: colors.green, font: { bold: true, color: colors.navy } };
summary.getRange("H5:H7").format.numberFormat = "#,##0;[Red]-#,##0";
summary.getRange("A14:H14").merge();
summary.getRange("A14").values = [["Current stock reconciles to the net ledger quantity. Transfers show both the source decrease and destination increase, so their combined net effect is zero."]];
summary.getRange("A14:H14").format = { fill: colors.pale, font: { color: colors.navy }, wrapText: true, borders: { preset: "outside", style: "thin", color: colors.line } };
summary.getRange("A14:H14").format.rowHeight = 38;
setWidths(summary, [["A:A", 24], ["B:B", 36], ["C:C", 3], ["D:D", 24], ["E:E", 22], ["F:F", 3], ["G:G", 22], ["H:H", 18]]);

const stock = wb.worksheets.add("Current Stock");
title(stock, "G", "SKU S598V CURRENT STOCK", "Non-zero inventory lines from the WMS365 production inventory table.");
stock.getRange("A4:G4").values = [["Company", "Location", "Lot", "Expiration", "Tracking level", "Quantity", "Units per case"]];
stock.getRange("A4:G4").format = { fill: colors.teal, font: { bold: true, color: colors.white }, wrapText: true, borders: { preset: "all", style: "thin", color: colors.line } };
const stockRows = data.stock.map((row) => [row.account_name, row.location, row.lot_number || "", row.expiration_date ? d(row.expiration_date) : null, row.tracking_level, n(row.quantity), n(item.units_per_case)]);
if (stockRows.length) {
  stock.getRangeByIndexes(4, 0, stockRows.length, 7).values = stockRows;
  stock.tables.add(`A4:G${4 + stockRows.length}`, true, "S598VCurrentStock").style = "TableStyleMedium2";
  stock.getRange(`D5:D${4 + stockRows.length}`).format.numberFormat = "yyyy-mm-dd";
  stock.getRange(`F5:G${4 + stockRows.length}`).format.numberFormat = "#,##0";
}
stock.freezePanes.freezeRows(4);
setWidths(stock, [["A:A", 30], ["B:B", 34], ["C:C", 18], ["D:D", 15], ["E:E", 16], ["F:G", 15]]);

const ledger = wb.worksheets.add("Transactions");
title(ledger, "Q", "SKU S598V TRANSACTION LEDGER", "Complete chronological ledger. Quantity before and after are the recorded balance for each affected inventory line.");
const headers = ["Transaction ID", "Time (ET)", "Company", "Type", "Source type", "Source reference", "Warehouse", "Warehouse name", "Location", "Lot", "Expiration", "Qty change", "Qty before", "Qty after", "Balance check", "Recorded source", "Idempotency key"];
ledger.getRange("A4:Q4").values = [headers];
ledger.getRange("A4:Q4").format = { fill: colors.teal, font: { bold: true, color: colors.white }, wrapText: true, borders: { preset: "all", style: "thin", color: colors.line }, verticalAlignment: "center" };
ledger.getRange("A4:Q4").format.rowHeight = 36;
const rows = data.transactions.map((row) => [
  n(row.id), d(row.transaction_time_et), row.account_name, row.transaction_type,
  row.source_type, row.source_reference || row.source_id || "", row.warehouse_code || "",
  row.warehouse_name || "", row.location, row.lot_number || "",
  row.expiration_date ? d(row.expiration_date) : null, n(row.quantity_delta),
  n(row.quantity_before), n(row.quantity_after),
  n(row.quantity_before) + n(row.quantity_delta) === n(row.quantity_after) ? "MATCH" : "REVIEW",
  row.source || "", row.idempotency_key || "",
]);
if (rows.length) {
  ledger.getRangeByIndexes(4, 0, rows.length, headers.length).values = rows;
  ledger.tables.add(`A4:Q${4 + rows.length}`, true, "S598VTransactions").style = "TableStyleMedium2";
  ledger.getRange(`B5:B${4 + rows.length}`).format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  ledger.getRange(`K5:K${4 + rows.length}`).format.numberFormat = "yyyy-mm-dd";
  ledger.getRange(`L5:N${4 + rows.length}`).format.numberFormat = "#,##0;[Red]-#,##0";
}
ledger.freezePanes.freezeRows(4);
setWidths(ledger, [["A:A", 15], ["B:B", 21], ["C:C", 30], ["D:F", 22], ["G:G", 20], ["H:H", 32], ["I:I", 34], ["J:K", 16], ["L:N", 14], ["O:O", 15], ["P:P", 16], ["Q:Q", 28]]);

await fs.mkdir(outputDir, { recursive: true });
const outputPath = `${outputDir}/S598V_Transaction_Report_2026-10-28.xlsx`;
const exported = await SpreadsheetFile.exportXlsx(wb);
await exported.save(outputPath);
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "Formula error scan" });
const preview = await wb.render({ sheetName: "Summary", range: "A1:H14", scale: 1.3, format: "png" });
await fs.writeFile(`${outputDir}/S598V_Transaction_Report_Summary.png`, new Uint8Array(await preview.arrayBuffer()));
console.log(JSON.stringify({ outputPath, currentQty, transactionCount: rows.length, formulaErrors: errors.ndjson }));
