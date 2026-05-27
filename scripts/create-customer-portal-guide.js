const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "customer-portal-guide");
const BASE_URL = process.env.WMS365_PORTAL_RUNTIME_BASE_URL || process.env.WMS365_PORTAL_BASE_URL || "https://app.wms365.co";
const PORTAL_DISPLAY_URL = process.env.WMS365_PORTAL_DISPLAY_URL || "https://www.wms365.co/portal";
const EMAIL = process.env.WMS365_PORTAL_EMAIL || "";
const PASSWORD = process.env.WMS365_PORTAL_PASSWORD || "";
const COMPANY = process.env.WMS365_PORTAL_COMPANY || "Your Company";

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

async function waitForPortal(page) {
    await page.waitForSelector("#portalView:not(.hidden)", { timeout: 30000 });
    await page.waitForTimeout(1000);
}

async function clickView(page, view) {
    await page.locator(`[data-view="${view}"]`).first().click();
    await page.waitForTimeout(650);
}

async function screenshot(page, name, selector = "body", options = {}) {
    const filePath = path.join(OUT_DIR, `${name}.png`);
    const target = page.locator(selector).first();
    await target.screenshot({ path: filePath, animations: "disabled", ...options });
    return filePath;
}

async function fillIfVisible(page, selector, value) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
        await locator.fill(value);
    }
}

async function generateScreenshots() {
    if (!EMAIL || !PASSWORD) {
        throw new Error("Set WMS365_PORTAL_EMAIL and WMS365_PORTAL_PASSWORD before running this script.");
    }
    ensureDir(OUT_DIR);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        deviceScaleFactor: 1,
        locale: "en-US"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(`${BASE_URL}/portal`, { waitUntil: "networkidle" });
    await screenshot(page, "01-login", ".auth-shell");
    await fillIfVisible(page, "#loginEmail", EMAIL);
    await fillIfVisible(page, "#loginPassword", PASSWORD);
    await page.locator("#loginForm button[type='submit']").click();
    await waitForPortal(page);
    await screenshot(page, "02-dashboard-inventory", "#portalView");

    await clickView(page, "inventory");
    await fillIfVisible(page, "#inventoryFilter", "SKU");
    await page.waitForTimeout(350);
    await screenshot(page, "03-inventory-filter", "#inventoryPanel");

    await clickView(page, "inbound");
    await fillIfVisible(page, "#inboundReferenceNumber", "PO-EXAMPLE-001");
    await fillIfVisible(page, "#inboundCarrierName", "Carrier name");
    await fillIfVisible(page, "#inboundExpectedDate", "2026-06-05");
    await fillIfVisible(page, "#inboundContactName", "Hisham Ajani");
    await fillIfVisible(page, "#inboundContactPhone", "+1 437 607 8691");
    await fillIfVisible(page, "#inboundNotes", "Attach packing slip/BOL after submitting.");
    await screenshot(page, "04-new-purchase-order", "#inboundPanel");

    await clickView(page, "inbounds");
    await screenshot(page, "05-my-purchase-orders", "#inboundsPanel");

    await clickView(page, "order");
    await fillIfVisible(page, "#orderPoNumber", "SO-EXAMPLE-001");
    await fillIfVisible(page, "#orderShippingReference", "SHIP-EXAMPLE-001");
    await fillIfVisible(page, "#orderRequestedShipDate", "2026-06-07");
    await fillIfVisible(page, "#orderContactName", "Hisham Ajani");
    await fillIfVisible(page, "#orderContactPhone", "+1 437 607 8691");
    await fillIfVisible(page, "#orderShipToName", "Receiver Company");
    await fillIfVisible(page, "#orderShipToPhone", "+1 555 555 1212");
    await fillIfVisible(page, "#orderShipToAddress1", "123 Example Street");
    await fillIfVisible(page, "#orderShipToCity", "Toronto");
    await fillIfVisible(page, "#orderShipToState", "ON");
    await fillIfVisible(page, "#orderShipToPostalCode", "M1M 1M1");
    await fillIfVisible(page, "#orderShipToCountry", "Canada");
    await fillIfVisible(page, "#orderNotes", "Attach shipping label before release if customer-provided.");
    await screenshot(page, "06-new-sales-order", "#orderPanel");

    await clickView(page, "orders");
    await screenshot(page, "07-my-sales-orders", "#ordersPanel");

    await clickView(page, "delivery");
    await fillIfVisible(page, "#deliveryReferenceNumber", "PO-EXAMPLE-001");
    await fillIfVisible(page, "#deliveryRequestedDate", "2026-06-05");
    await fillIfVisible(page, "#deliveryRequestedTime", "10:00 AM - 12:00 PM");
    await fillIfVisible(page, "#deliveryCarrierName", "Carrier name");
    await fillIfVisible(page, "#deliveryPalletCount", "3");
    await fillIfVisible(page, "#deliveryCartonCount", "120");
    await fillIfVisible(page, "#deliveryContactName", "Hisham Ajani");
    await fillIfVisible(page, "#deliveryContactEmail", EMAIL);
    await fillIfVisible(page, "#deliveryContactPhone", "+1 437 607 8691");
    await screenshot(page, "08-book-delivery", "#deliveryPanel");

    await browser.close();
}

function image(name) {
    return `customer-portal-guide/${name}.png`;
}

function buildGuideHtml() {
    const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WMS365 Customer Portal Quick Guide - ${esc(COMPANY)}</title>
<style>
    @page { size: Letter; margin: 0.55in; }
    :root { --ink:#20303a; --muted:#637788; --brand:#5c7b92; --line:#d8e0e7; --soft:#f3f7f9; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: var(--ink); margin: 0; line-height: 1.42; }
    h1 { font-size: 28px; margin: 0 0 8px; color: #1f3446; }
    h2 { font-size: 20px; margin: 24px 0 8px; color: #243f54; break-after: avoid; }
    h3 { font-size: 14px; margin: 12px 0 6px; }
    p { margin: 0 0 8px; }
    .cover { display:grid; gap:12px; padding: 22px; border:1px solid var(--line); border-radius:12px; background:var(--soft); }
    .meta { color: var(--muted); font-size: 12px; }
    .callout { border-left: 4px solid var(--brand); background:#f7fafc; padding:10px 12px; margin:10px 0; }
    .warning { border-left-color:#d28400; background:#fff8ec; }
    ol, ul { margin-top: 6px; padding-left: 22px; }
    li { margin: 4px 0; }
    img.screen { width: 100%; border:1px solid var(--line); border-radius:10px; margin: 8px 0 14px; box-shadow:0 2px 8px rgba(32,48,58,.08); break-inside: avoid; }
    .page-break { break-before: page; }
    .checklist { display:grid; grid-template-columns: 1fr 1fr; gap:8px 16px; }
    .checklist div { border:1px solid var(--line); padding:8px; border-radius:8px; }
    .small { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<section class="cover">
    <div class="meta">WMS365 Customer Portal</div>
    <h1>Quick Guide for ${esc(COMPANY)}</h1>
    <p>Use this guide to check inventory, submit purchase orders/inbounds, create outbound sales orders, upload documents, and track order status.</p>
    <p><strong>Portal URL:</strong> ${esc(PORTAL_DISPLAY_URL)}</p>
    <p><strong>Username:</strong> ${esc(EMAIL)}</p>
    <p class="meta">Generated ${esc(generatedAt)}. Use the password provided in the welcome email.</p>
</section>

<h2>1. Sign In</h2>
<ol>
    <li>Go to <strong>${esc(PORTAL_DISPLAY_URL)}</strong>.</li>
    <li>Enter your email and portal password.</li>
    <li>Select <strong>Sign in</strong>.</li>
</ol>
<div class="callout">Warehouse staff use a separate warehouse login. Customer portal users should always use the customer portal page.</div>
<img class="screen" src="${image("01-login")}" alt="WMS365 customer portal login screen">

<h2>2. Check Inventory</h2>
<ol>
    <li>Select <strong>Inventory</strong> from the portal menu.</li>
    <li>Use the <strong>Filter</strong> box to search by SKU, UPC, description, or location.</li>
    <li>Review available quantity, on-hand quantity, tracking level, and locations.</li>
    <li>Use <strong>Export Report</strong> when you need a spreadsheet copy.</li>
</ol>
<div class="callout">Inventory is account-scoped. You only see inventory assigned to your company.</div>
<img class="screen" src="${image("02-dashboard-inventory")}" alt="Portal dashboard inventory overview">
<img class="screen" src="${image("03-inventory-filter")}" alt="Inventory filter screen">

<h2 class="page-break">3. Enter an Inbound / Purchase Order</h2>
<ol>
    <li>Select <strong>New Purchase Order</strong>.</li>
    <li>Enter the purchase order/reference number, carrier if known, expected date, contact name, and phone number.</li>
    <li>Add one line per SKU with the expected quantity.</li>
    <li>Select <strong>Submit Purchase Order</strong>.</li>
    <li>After submitting, open <strong>My Purchase Orders</strong> to track status and upload packing slips, BOLs, or product documents.</li>
</ol>
<div class="callout warning">If the warehouse has not received the freight yet, status will remain open/submitted. Once freight arrives, the warehouse may check it in before full receiving is completed.</div>
<img class="screen" src="${image("04-new-purchase-order")}" alt="New purchase order screen">
<img class="screen" src="${image("05-my-purchase-orders")}" alt="My purchase orders screen">

<h2>4. Book a Delivery Appointment</h2>
<ol>
    <li>Create or select the inbound/purchase order first.</li>
    <li>Select <strong>Book Delivery</strong>.</li>
    <li>Enter requested date/time, carrier, trailer/container if available, pallet count, carton count, and contact details.</li>
    <li>Select <strong>Request Delivery Appointment</strong>.</li>
    <li>Watch <strong>My Deliveries</strong> for approval or alternate date/time from the warehouse.</li>
</ol>
<img class="screen" src="${image("08-book-delivery")}" alt="Book delivery appointment screen">

<h2 class="page-break">5. Enter an Outbound Sales Order</h2>
<ol>
    <li>Select <strong>New Sales Order</strong>.</li>
    <li>Enter PO number, shipping reference, requested ship date, contact, and ship-to address.</li>
    <li>Add order lines by selecting each SKU and quantity.</li>
    <li>Select <strong>Save Draft</strong> if you still need to review.</li>
    <li>Select <strong>Release Order</strong> when the order is ready for the warehouse.</li>
</ol>
<div class="callout warning">If you select “Shipping label is attached” during release, a label or document must already be uploaded to the order. This prevents missed labels.</div>
<img class="screen" src="${image("06-new-sales-order")}" alt="New sales order screen">

<h2>6. Upload Labels and Order Documents</h2>
<ol>
    <li>Open <strong>My Sales Orders</strong> for outbound documents or <strong>My Purchase Orders</strong> for inbound documents.</li>
    <li>Find the order or purchase order card.</li>
    <li>Choose the PDF/image files under <strong>Shipping Labels / Order Documents</strong> or <strong>Purchase Order Documents</strong>.</li>
    <li>Select <strong>Upload Labels / Docs</strong> or <strong>Upload PO Docs</strong>.</li>
</ol>
<p class="small">Accepted files are PDF or image files. Upload up to 5 files at a time.</p>
<img class="screen" src="${image("07-my-sales-orders")}" alt="My sales orders screen">

<h2>7. Track Status</h2>
<div class="checklist">
    <div><strong>Draft</strong><br>Order is saved but not released to the warehouse.</div>
    <div><strong>Released</strong><br>Warehouse can see the order for picking.</div>
    <div><strong>Picked / Staged</strong><br>Warehouse is processing the order.</div>
    <div><strong>Shipped</strong><br>Carrier/tracking details are available when completed.</div>
    <div><strong>Submitted Inbound</strong><br>Purchase order has been sent to the warehouse.</div>
    <div><strong>Checked In / Received</strong><br>Freight has arrived or receiving has been completed.</div>
</div>

<h2>Need Help?</h2>
<p>Use <strong>Report Bug / Request Feature</strong> in the portal, or contact WMS365 / Grey Wolf 3PL support.</p>
</body>
</html>`;
}

async function generatePdf() {
    const htmlPath = path.join(ROOT, "docs", "WMS365-Customer-Portal-Quick-Guide-Traveone.html");
    const pdfPath = path.join(ROOT, "docs", "WMS365-Customer-Portal-Quick-Guide-Traveone.pdf");
    fs.writeFileSync(htmlPath, buildGuideHtml(), "utf8");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
    await page.pdf({
        path: pdfPath,
        format: "Letter",
        printBackground: true,
        margin: { top: "0.45in", right: "0.45in", bottom: "0.45in", left: "0.45in" }
    });
    await browser.close();
    return { htmlPath, pdfPath };
}

(async () => {
    await generateScreenshots();
    const result = await generatePdf();
    console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
