import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "file:///C:/Users/T470/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const root = "C:/WMS365Scanner-shopify-scheduler-fix";
const inputPath = `${root}/outputs/wellforia-month-end/wellforia-120-day-billing-audit.json`;
const outputPath = `${root}/outputs/wellforia-month-end/Wellforia_120_Day_Billing_Audit_2026-11-04.xlsx`;
const data = JSON.parse(await fs.readFile(inputPath, "utf8"));
const colors = { navy: "#17324D", teal: "#167D8D", pale: "#EAF4F5", amber: "#FFF4D6", red: "#FCE8E6", line: "#CBD5E1", white: "#FFFFFF" };
const n = (value) => Number(value) || 0;
const d = (value) => value ? new Date(value) : null;
const dateOnly = (value) => value ? new Date(`${String(value).slice(0, 10)}T12:00:00-04:00`) : null;
const monthLabel = (value) => String(value || "").slice(0, 7);
const widths = (sheet, entries) => { for (const [range, width] of entries) sheet.getRange(range).format.columnWidth = width; };

function title(sheet, last, heading, subtitle) {
    sheet.showGridLines = false;
    sheet.getRange(`A1:${last}1`).merge();
    sheet.getRange("A1").values = [[heading]];
    sheet.getRange(`A2:${last}2`).merge();
    sheet.getRange("A2").values = [[subtitle]];
    sheet.getRange(`A1:${last}1`).format = { fill: colors.navy, font: { bold: true, color: colors.white, size: 16 }, verticalAlignment: "center" };
    sheet.getRange(`A1:${last}1`).format.rowHeight = 32;
    sheet.getRange(`A2:${last}2`).format = { fill: colors.pale, font: { color: colors.navy, italic: true }, wrapText: true };
}

function detail(workbook, config) {
    const sheet = workbook.worksheets.add(config.name);
    title(sheet, config.last, config.heading, config.subtitle);
    sheet.getRange(`A4:${config.last}4`).values = [config.headers];
    sheet.getRange(`A4:${config.last}4`).format = { fill: colors.teal, font: { bold: true, color: colors.white }, wrapText: true, borders: { preset: "all", style: "thin", color: colors.line } };
    if (config.rows.length) {
        const end = 4 + config.rows.length;
        sheet.getRangeByIndexes(4, 0, config.rows.length, config.headers.length).values = config.rows;
        sheet.getRange(`A5:${config.last}${end}`).format = { borders: { preset: "all", style: "thin", color: colors.line } };
        sheet.tables.add(`A4:${config.last}${end}`, true, config.table).style = "TableStyleMedium2";
        for (const [range, format] of config.formats || []) sheet.getRange(range.replaceAll("{end}", String(end))).format.numberFormat = format;
        if (config.highlightMissing) {
            for (let row = 5; row <= end; row += 1) {
                if (sheet.getRange(`B${row}`).values?.[0]?.[0] === "MISSING") sheet.getRange(`A${row}:${config.last}${row}`).format.fill = colors.red;
            }
        }
    } else {
        sheet.getRange(`A5:${config.last}5`).merge();
        sheet.getRange("A5").values = [["No records found."]];
        sheet.getRange(`A5:${config.last}5`).format = { fill: colors.amber, font: { italic: true } };
    }
    sheet.freezePanes.freezeRows(4);
    widths(sheet, config.widths);
}

const monthly = new Map();
for (const order of data.orders) {
    const key = monthLabel(order.service_date);
    if (!monthly.has(key)) monthly.set(key, { month: key, shipped: 0, matched: 0, missing: 0, billed: 0, quantity: 0 });
    const row = monthly.get(key);
    row.shipped += 1;
    row.matched += order.billing_status === "MATCHED" ? 1 : 0;
    row.missing += order.billing_status === "MISSING" ? 1 : 0;
    row.billed += n(order.billing_amount);
    row.quantity += n(order.shipped_quantity);
}

const latestRate = new Map();
for (const line of data.rateCardLines) {
    const key = `${line.charge_type}|${line.customer_id || ""}`;
    const current = latestRate.get(key);
    if (!current || d(line.line_effective_from) > d(current.line_effective_from)) latestRate.set(key, line);
}

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Summary");
title(summary, "H", "WMS365 | WELLFORIA 120-DAY BILLING AUDIT", "Read-only reconciliation of shipped orders against recorded billing events, July 8 through November 4, 2026.");
summary.getRange("A4:B11").values = [
    ["Report Information", "Value"], ["Company", data.account], ["Start date", dateOnly(data.period.start)],
    ["End date", dateOnly("2026-11-04")], ["Window", "120 calendar days"], ["Generated", d(data.generatedAt)],
    ["Mode", data.mode], ["Source", "WMS365 production database"]
];
summary.getRange("D4:E11").values = [
    ["Reconciliation", "Count"], ["Shipped orders", data.reconciliation.shippedOrders], ["Orders with billing", data.reconciliation.matchedOrders],
    ["Missing billing", data.reconciliation.missingOrders], ["Void-only billing", data.reconciliation.voidOnlyOrders],
    ["Billing events", data.reconciliation.billingEvents], ["Open unshipped orders", data.reconciliation.openUnshippedOrders],
    ["Recorded billed amount", data.reconciliation.billedAmount]
];
summary.getRange("G4:H9").values = [
    ["Configuration Check", "Result"], ["Active billing profile", data.billingProfiles.some((row) => row.is_active) ? "YES" : "NO"],
    ["Assigned rate card", data.billingProfiles[0]?.assigned_rate_card_id || "NONE"], ["Account-specific rates", data.ownerBillingRates.length],
    ["Shared rate-card history rows", data.rateCardLines.length], ["Audit conclusion", data.reconciliation.missingOrders ? "ACTION REQUIRED" : "CLEAR"]
];
for (const range of ["A4:B4", "D4:E4", "G4:H4"]) summary.getRange(range).format = { fill: colors.teal, font: { bold: true, color: colors.white }, borders: { preset: "all", style: "thin", color: colors.line } };
summary.getRange("B6:B7").format.numberFormat = "yyyy-mm-dd";
summary.getRange("B9").format.numberFormat = "yyyy-mm-dd hh:mm";
summary.getRange("E5:E11").format.numberFormat = "#,##0";
summary.getRange("E11").format.numberFormat = '"$"#,##0.00';
summary.getRange("A13:H14").merge();
summary.getRange("A13").values = [["Finding: no billing events were recorded for any of the 134 shipped orders in this window. The account has an active billing profile but no Wellforia-specific owner billing rates. The shared standard rate card contains repeated historical rows; amounts must be reviewed against the signed agreement before invoice creation."]];
summary.getRange("A13:H14").format = { fill: colors.red, font: { bold: true, color: "#8A1C13" }, wrapText: true, verticalAlignment: "center" };
widths(summary, [["A:A", 26], ["B:B", 31], ["C:C", 3], ["D:D", 28], ["E:E", 18], ["F:F", 3], ["G:G", 29], ["H:H", 24]]);

detail(workbook, {
    name: "Monthly Summary", last: "F", heading: "WELLFORIA | 120-DAY MONTHLY RECONCILIATION",
    subtitle: "Counts and shipped quantities by confirmed ship month.",
    headers: ["Month", "Shipped Orders", "Shipped Quantity", "Orders Matched", "Missing Billing", "Recorded Amount"],
    rows: [...monthly.values()].map((row) => [row.month, row.shipped, row.quantity, row.matched, row.missing, row.billed]),
    table: "Wellforia120DayMonthly", formats: [["B5:E{end}", "#,##0"], ["F5:F{end}", '"$"#,##0.00']],
    widths: [["A:A", 14], ["B:E", 19], ["F:F", 20]]
});

const orderRows = data.orders.map((order) => [
    dateOnly(order.service_date), order.billing_status, order.order_code, order.po_number, order.order_type,
    order.shipment_method, order.shipped_carrier_name, order.shipped_tracking_reference, n(order.outbound_total_pallets),
    n(order.line_count), n(order.requested_quantity), n(order.shipped_quantity), n(order.billing_event_count),
    n(order.billing_amount), order.billing_currencies
]);
detail(workbook, {
    name: "Missing Billing Orders", last: "O", heading: "WELLFORIA | ORDERS MISSING BILLING",
    subtitle: "Every shipped order without a non-void billing event. Charge amounts are intentionally blank until the signed Wellforia rate agreement is confirmed.",
    headers: ["Ship Date", "Billing Status", "Order", "PO", "Order Type", "Shipment Method", "Carrier", "Tracking / BOL", "Pallets", "Lines", "Requested Qty", "Shipped Qty", "Billing Events", "Recorded Amount", "Currency"],
    rows: orderRows.filter((row) => row[1] !== "MATCHED"), table: "WellforiaMissingBilling120", highlightMissing: true,
    formats: [["A5:A{end}", "yyyy-mm-dd"], ["I5:M{end}", "#,##0"], ["N5:N{end}", '"$"#,##0.00']],
    widths: [["A:A", 14], ["B:B", 17], ["C:C", 18], ["D:D", 24], ["E:F", 19], ["G:G", 20], ["H:H", 27], ["I:M", 14], ["N:N", 18], ["O:O", 12]]
});
detail(workbook, {
    name: "All Shipped Orders", last: "O", heading: "WELLFORIA | ALL SHIPPED ORDERS",
    subtitle: "Complete shipped-order population used for the reconciliation.",
    headers: ["Ship Date", "Billing Status", "Order", "PO", "Order Type", "Shipment Method", "Carrier", "Tracking / BOL", "Pallets", "Lines", "Requested Qty", "Shipped Qty", "Billing Events", "Recorded Amount", "Currency"],
    rows: orderRows, table: "WellforiaAllOrders120",
    formats: [["A5:A{end}", "yyyy-mm-dd"], ["I5:M{end}", "#,##0"], ["N5:N{end}", '"$"#,##0.00']],
    widths: [["A:A", 14], ["B:B", 17], ["C:C", 18], ["D:D", 24], ["E:F", 19], ["G:G", 20], ["H:H", 27], ["I:M", 14], ["N:N", 18], ["O:O", 12]]
});

detail(workbook, {
    name: "Billing Events", last: "N", heading: "WELLFORIA | RECORDED BILLING EVENTS",
    subtitle: "Non-void and void billing events whose activity or service date falls in the audit window.",
    headers: ["Service Date", "Status", "Event ID", "Fee Code", "Fee Name", "Unit", "Quantity", "Rate", "Amount", "Currency", "Source Type", "Source Reference", "Invoice", "Note"],
    rows: data.billingEvents.map((event) => [dateOnly(event.service_date), event.status, event.id, event.fee_code, event.fee_name, event.unit_label, n(event.quantity), n(event.rate), n(event.amount), event.currency_code, event.source_type || event.source_module, event.source_ref || event.source_reference, event.invoice_number, event.note]),
    table: "WellforiaBillingEvents120", formats: [["A5:A{end}", "yyyy-mm-dd"], ["G5:G{end}", "#,##0.0000"], ["H5:I{end}", '"$"#,##0.00']],
    widths: [["A:A", 14], ["B:C", 14], ["D:D", 22], ["E:E", 30], ["F:F", 16], ["G:I", 15], ["J:J", 12], ["K:L", 22], ["M:M", 18], ["N:N", 34]]
});

detail(workbook, {
    name: "Open Unshipped", last: "F", heading: "WELLFORIA | OPEN UNSHIPPED ORDERS",
    subtitle: "Included for control purposes only. These are not treated as billable shipped orders.",
    headers: ["Created", "Requested Ship", "Order", "Status", "Lines", "Requested Qty"],
    rows: data.openUnshippedOrders.map((order) => [d(order.created_at), dateOnly(order.requested_ship_date), order.order_code, order.status, n(order.line_count), n(order.requested_quantity)]),
    table: "WellforiaOpenOrders120", formats: [["A5:A{end}", "yyyy-mm-dd hh:mm"], ["B5:B{end}", "yyyy-mm-dd"], ["E5:F{end}", "#,##0"]],
    widths: [["A:A", 20], ["B:B", 16], ["C:C", 18], ["D:D", 15], ["E:F", 16]]
});

detail(workbook, {
    name: "Rate Setup Review", last: "H", heading: "WELLFORIA | BILLING RATE SETUP REVIEW",
    subtitle: "Latest row per shared rate-card charge type. These are reference values, not approved Wellforia invoice amounts.",
    headers: ["Charge Type", "Unit", "Rate", "Currency", "Effective From", "Customer Scope", "Rate Card", "Review Note"],
    rows: [...latestRate.values()].map((line) => [line.charge_type, line.unit, n(line.rate), line.currency || data.billingProfiles[0]?.currency || "CAD", dateOnly(line.line_effective_from), line.customer_id || "Shared default", line.rate_card_name, "Confirm against signed Wellforia agreement"]),
    table: "WellforiaRateSetup120", formats: [["C5:C{end}", '"$"#,##0.0000'], ["E5:E{end}", "yyyy-mm-dd"]],
    widths: [["A:A", 31], ["B:B", 18], ["C:C", 16], ["D:D", 12], ["E:E", 16], ["F:F", 20], ["G:G", 28], ["H:H", 39]]
});

await fs.mkdir(`${root}/outputs/wellforia-month-end`, { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
const preview = await workbook.render({ sheetName: "Summary", range: "A1:H14", scale: 1.3, format: "png" });
await fs.writeFile(`${root}/outputs/wellforia-month-end/wellforia-120-day-billing-audit-summary.png`, new Uint8Array(await preview.arrayBuffer()));
console.log(JSON.stringify({ outputPath, reconciliation: data.reconciliation, formulaErrors: errors.ndjson }));
