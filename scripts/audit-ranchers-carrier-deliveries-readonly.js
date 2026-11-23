"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");
const INPUT = path.resolve(".codex-tmp/ranchers-delivery-status-audit-20260917.json");
const OUTPUT = path.resolve(".codex-tmp/ranchers-carrier-delivery-evidence-20260917.json");

function classify(carrier) {
    if (/^ICS\b/i.test(carrier)) return "ICS";
    if (/^Canpar\b/i.test(carrier)) return "CANPAR";
    if (/^GLS\b/i.test(carrier)) return "GLS";
    return null;
}
function deliveryRow(carrier, rows) {
    for (const cells of rows) {
        if (carrier === "ICS" && cells.length === 2 && /^Delivered at:/i.test(cells[1]) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cells[0])) {
            return { status: "DELIVERED", carrierLocalTimestamp: cells[0], statusLabel: "Delivered at", timezoneVerified: false };
        }
        if (carrier === "CANPAR" && cells.length >= 3 && cells[1] === "Our Package was Delivered" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cells[0])) {
            return { status: "DELIVERED", carrierLocalTimestamp: cells[0], statusLabel: cells[1], scanLocation: cells[2], timezoneVerified: false };
        }
        if (carrier === "GLS" && cells.length === 4 && /^Delivered\s+Your shipment was delivered(?:\.| (?:at|to|in) [^\n]{1,120}\.| and we received a signature\.)$/.test(cells[0]) && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cells[2]) && /^\d{1,2}:\d{2}:\d{2} [AP]M$/.test(cells[3])) {
            return { status: "DELIVERED", carrierLocalTimestamp: `${cells[2]} ${cells[3]}`, statusLabel: "Delivered", scanLocation: cells[1], timezoneVerified: false };
        }
        // Reviewed carrier tables are newest-first. A later return or exception
        // must not be overwritten using an older delivery row further down.
        if ((carrier !== "GLS" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cells[0]))
            || (carrier === "GLS" && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cells[2]))) return null;
    }
    return null;
}
async function readPackage(context, item) {
    const p = await context.newPage();
    try {
        let selector;
        if (item.carrier === "ICS") {
            await p.goto(`https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=${encodeURIComponent(item.number)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
            selector = "table[id$='_gvTracingDetail']";
            await p.locator("table[id$='_gvresult']").waitFor({ timeout: 12000 });
            const identity = await p.locator("table[id$='_gvresult'] tr td:first-child").allTextContents();
            if (!identity.some((s) => s.trim() === item.number)) throw new Error("TRACKING_ID_MISMATCH");
        } else if (item.carrier === "CANPAR") {
            await p.goto(`https://www.canpar.com/en/tracking/track.htm?barcode=${encodeURIComponent(item.number)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
            selector = "table#detailTable:visible";
            await p.locator(selector).waitFor({ timeout: 12000 });
            const numbers = await p.locator("table#tablepress-2:visible tr").evaluateAll((rows) => rows.filter((r) => r.cells[0]?.innerText.trim() === "Tracking Number").map((r) => r.cells[1]?.innerText.trim()));
            if (!numbers.includes(item.number)) throw new Error("TRACKING_ID_MISMATCH");
        } else {
            await p.goto(`https://ship.gls-canada.com/tracking/${encodeURIComponent(item.number)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
            selector = "table";
            await p.locator("table").first().waitFor({ timeout: 12000 });
            const pieceText = await p.locator("body").innerText();
            if (new URL(p.url()).pathname !== `/tracking/${item.number}` || !pieceText.split("\n").some((line) => line.trim() === item.number)) throw new Error("TRACKING_ID_MISMATCH");
            const pieces = /\bPiece\s+(\d+)\s+of\s+(\d+)/.exec(pieceText);
            if (!pieces || pieces[1] !== "1" || pieces[2] !== "1") throw new Error("MULTI_PIECE_REVIEW_REQUIRED");
        }
        const rows = await p.locator(`${selector} tr`).evaluateAll((rs) => rs.map((r) => Array.from(r.cells).map((c) => c.innerText.trim())));
        const evidence = deliveryRow(item.carrier, rows);
        if (!evidence && item.carrier === "GLS" && rows.some((cells) => /^Delivered\s/.test(cells[0]))) throw new Error("DELIVERY_LAYOUT_REVIEW_REQUIRED");
        return { ...item, checkedAt: new Date().toISOString(), result: evidence ? "CARRIER_CONFIRMED_DELIVERED" : "NO_DELIVERY_SCAN", evidence };
    } catch (error) {
        return { ...item, checkedAt: new Date().toISOString(), result: "CHECK_FAILED", error: error.message.split("\n")[0].slice(0, 160) };
    } finally { await p.close(); }
}
async function main() {
    const input = JSON.parse(fs.readFileSync(INPUT, "utf8"));
    if (input.accountName !== "RANCHER'S CHIPS" || input.mode !== "READ_ONLY") throw new Error("INVALID_AUDIT_SCOPE");
    const packages = new Map();
    for (const o of input.orders) for (const f of o.fulfillments) {
        if (f.displayStatus === "DELIVERED" || f.deliveredAt) continue;
        for (const t of f.trackingInfo) {
            const carrier = classify(t.company || "");
            if (carrier && /^[A-Za-z0-9-]{1,80}$/.test(t.number)) packages.set(`${carrier}:${t.number}`, { carrier, number: t.number });
        }
    }
    const report = { mode: "READ_ONLY", accountName: input.accountName, startedAt: new Date().toISOString(), packages: [], summary: {} };
    const cached = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, "utf8")) : null;
    if (cached && (cached.mode !== "READ_ONLY" || cached.accountName !== input.accountName)) throw new Error("INVALID_CACHE_SCOPE");
    const b = await chromium.launch({ headless: true });
    const context = await b.newContext();
    try {
        for (const item of packages.values()) {
            const previous = cached?.packages.find((p) => p.carrier === item.carrier && p.number === item.number && p.result !== "CHECK_FAILED"
                && !(item.carrier === "GLS" && p.result === "NO_DELIVERY_SCAN" && p.layoutVersion !== "20260917-v3")
                && new Date(p.checkedAt).getTime() > Date.now() - 3600000);
            report.packages.push(previous || await readPackage(context, item));
            if (!previous) report.packages.at(-1).layoutVersion = "20260917-v3";
            report.summary = { checked: report.packages.length, total: packages.size, confirmedDelivered: report.packages.filter((p) => p.evidence).length, failed: report.packages.filter((p) => p.result === "CHECK_FAILED").length };
            fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
            if (report.packages.length % 10 === 0) console.log(JSON.stringify(report.summary));
            if (!previous) await new Promise((resolve) => setTimeout(resolve, 1500));
        }
    } finally { await b.close(); }
    report.deliveryMismatchOrders = input.orders.filter((o) => o.fulfillments.some((f) => fulfillmentDeliveryMismatch(f, report.packages))).map((o) => ({ orderCode: o.orderCode, shopifyOrderNumber: o.shopifyOrderNumber }));
    report.completedAt = new Date().toISOString();
    report.summary.confirmedMismatchOrders = report.deliveryMismatchOrders.length;
    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report.summary, output: OUTPUT }));
}
function fulfillmentDeliveryMismatch(fulfillment, packages) {
    return fulfillment.status !== "CANCELLED" && fulfillment.displayStatus !== "DELIVERED" && !fulfillment.deliveredAt
        && fulfillment.trackingInfo.length > 0 && fulfillment.trackingInfo.every((tracking) => {
            const matches = packages.filter((p) => p.number === tracking.number && p.carrier === classify(tracking.company || ""));
            return matches.length === 1 && matches[0].result === "CARRIER_CONFIRMED_DELIVERED" && matches[0].evidence?.status === "DELIVERED";
        });
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { classify, deliveryRow, fulfillmentDeliveryMismatch };
