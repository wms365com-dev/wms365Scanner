const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SESSION_FILE = path.join(ROOT, ".tmp", "nht-order-guide-session.json");
const TEMP_DIR = path.join(ROOT, "outputs", "north-himalayan-order-guide-work");
const SCREEN_DIR = path.join(TEMP_DIR, "screenshots");
const HTML_PATH = path.join(TEMP_DIR, "North_Himalayan_Traders_WMS365_Order_Entry_Guide.html");
const OUTPUT_DIR = path.join(ROOT, "output", "pdf");
const PDF_PATH = path.join(OUTPUT_DIR, "North_Himalayan_Traders_WMS365_Order_Entry_Guide.pdf");
const BASE_URL = "https://app.wms365.co";

function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

async function capture(locator, filename, options = {}) {
    await locator.scrollIntoViewIfNeeded();
    await locator.screenshot({
        path: path.join(SCREEN_DIR, filename),
        animations: "disabled",
        ...options
    });
}

async function clickView(page, view) {
    await page.locator(`[data-view="${view}"]`).first().click();
    await page.waitForTimeout(600);
}

function screenshotPath(filename) {
    return `screenshots/${filename}`;
}

function buildHtml(session) {
    const generatedAt = new Date().toLocaleString("en-CA", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "America/Toronto"
    });
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>North Himalayan Traders - WMS365 Order Entry Guide</title>
<style>
@page { size: Letter; margin: 0.48in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #20313e; line-height: 1.4; font-size: 10.5pt; }
h1 { margin: 0 0 8px; color: #183247; font-size: 24pt; letter-spacing: 0; }
h2 { margin: 16px 0 7px; color: #1d4059; font-size: 16pt; letter-spacing: 0; break-after: avoid; }
p { margin: 0 0 8px; }
ol { margin: 6px 0 10px; padding-left: 23px; }
li { margin: 4px 0; }
.cover { padding: 20px 22px; background: #edf4f7; border: 1px solid #c7d7e0; border-radius: 7px; }
.brand { color: #5b7e95; font-weight: 700; text-transform: uppercase; font-size: 10pt; }
.meta { color: #657783; font-size: 9pt; }
.callout { margin: 9px 0; padding: 9px 11px; background: #f4f8fa; border-left: 4px solid #5b7e95; }
.warning { background: #fff8e9; border-left-color: #b77800; }
.screen { display: block; width: 100%; max-height: 5.55in; object-fit: contain; object-position: top left; margin: 8px 0 12px; border: 1px solid #ccd8df; border-radius: 5px; }
.compact { max-height: 4.75in; }
.page-break { break-before: page; }
.footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid #d6e0e5; color: #657783; font-size: 9pt; }
</style>
</head>
<body>
<section class="cover">
  <div class="brand">WMS365 Customer Portal</div>
  <h1>How to Enter an Outbound Order</h1>
  <p><strong>Prepared for North Himalayan Traders</strong></p>
  <p><strong>Portal:</strong> https://app.wms365.co/portal.html</p>
  <p><strong>Username:</strong> info@northhimalayantraders.com</p>
  <p>This guide uses North Himalayan Traders' actual customer portal and Edwards warehouse screens. No order was submitted while preparing it.</p>
  <p class="meta">Prepared ${generatedAt}</p>
</section>

<h2>1. Sign In</h2>
<ol>
  <li>Open <strong>https://app.wms365.co/portal.html</strong>.</li>
  <li>Enter <strong>info@northhimalayantraders.com</strong> and your password.</li>
  <li>Select <strong>Sign in</strong>. Use <strong>Forgot password?</strong> if you need a secure reset link.</li>
</ol>
<img class="screen compact" src="${screenshotPath("01-sign-in.png")}" alt="WMS365 customer portal sign-in">

<h2 class="page-break">2. Confirm Your Company and Warehouse</h2>
<ol>
  <li>Confirm the portal shows <strong>North Himalayan Traders</strong>.</li>
  <li>Confirm the warehouse is <strong>Grey Wolf 3PL - Edwards Warehouse</strong>.</li>
  <li>Select <strong>New Sales Order</strong> from the navigation menu.</li>
</ol>
<div class="callout">Only North Himalayan Traders information and its assigned Edwards warehouse should appear in this account.</div>
<img class="screen" src="${screenshotPath("02-portal-home.png")}" alt="North Himalayan Traders portal home">

<h2 class="page-break">3. Enter the Order Details</h2>
<ol>
  <li>Enter your PO number and shipping reference.</li>
  <li>Select the requested ship date.</li>
  <li>Select the order type and shipment method. Customer pickup, parcel, truck, and LTL orders follow different processing rules.</li>
  <li>Add clear handling or pickup instructions in the notes.</li>
</ol>
<div class="callout warning">Standard non-parcel orders require at least four business days. Select RUSH only when earlier processing is required and approved.</div>
<img class="screen" src="${screenshotPath("03-order-details.png")}" alt="North Himalayan Traders order details">

<h2 class="page-break">4. Search and Add Items</h2>
<ol>
  <li>Search by SKU or product description.</li>
  <li>Select the correct product. Example shown: <strong>${session.exampleSku}</strong> - ${session.exampleDescription}.</li>
  <li>Enter the quantity and select <strong>Add Item &amp; Next</strong>.</li>
  <li>Repeat for additional products. The portal warns you if the same item is entered twice.</li>
</ol>
<img class="screen" src="${screenshotPath("04-add-item.png")}" alt="Search and add a North Himalayan Traders item">

<h2 class="page-break">5. Enter and Verify the Ship-To Address</h2>
<ol>
  <li>Select a saved ship-to address, or enter the recipient and delivery address manually.</li>
  <li>Include a contact name, email, and phone number.</li>
  <li>Use <strong>Verify Address</strong> for a new address and review the suggested result.</li>
  <li>Use manual override only when the verified address is not suitable and you know the address is correct.</li>
</ol>
<img class="screen" src="${screenshotPath("05-ship-to.png")}" alt="Ship-to address entry and verification">

<h2 class="page-break">6. Review, Save, and Release</h2>
<ol>
  <li>Upload labels or supporting documents when required.</li>
  <li>Review the warehouse, ship-to address, item quantities, requested date, and notes.</li>
  <li>Select <strong>Save Draft</strong> if anything is incomplete.</li>
  <li>Select <strong>Release Order</strong> only when the order is ready for Grey Wolf to process.</li>
  <li>Open <strong>My Sales Orders</strong> to follow the order through Released, Picked, Staged, and Shipped.</li>
</ol>
<div class="callout">A released order is sent to the warehouse team. Changes made afterward may reset the expected ready date, so creating a new order is usually better when adding more items.</div>
<img class="screen compact" src="${screenshotPath("06-save-release.png")}" alt="Save draft and release order controls">

<div class="footer">WMS365 - https://wms365.co - Support: support@wms365.co</div>
</body>
</html>`;
}

async function main() {
    if (!fs.existsSync(SESSION_FILE)) throw new Error("The temporary North Himalayan Traders guide session is missing.");
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    ensureDir(SCREEN_DIR);
    ensureDir(OUTPUT_DIR);

    const browser = await chromium.launch({ headless: true });
    try {
        const publicContext = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "en-CA" });
        const publicPage = await publicContext.newPage();
        await publicPage.goto(`${BASE_URL}/portal.html`, { waitUntil: "networkidle" });
        await capture(publicPage.locator(".auth-shell").first(), "01-sign-in.png");
        await publicContext.close();

        const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "en-CA" });
        await context.addCookies([{
            name: "wms365_portal_session",
            value: session.token,
            domain: "app.wms365.co",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax"
        }]);
        const page = await context.newPage();
        await page.goto(`${BASE_URL}/portal.html#home`, { waitUntil: "networkidle" });
        await page.locator("#portalView:not(.hidden)").waitFor({ timeout: 30000 });
        await page.waitForTimeout(800);

        const accountChip = (await page.locator("#accountChip").textContent())?.trim() || "";
        if (!/NORTH HIMALAYAN TRADERS/i.test(accountChip)) throw new Error(`Unexpected portal account: ${accountChip}`);
        const warehouseText = await page.locator("#portalWarehouseSelect").locator("option:checked").textContent();
        if (!/Edwards/i.test(warehouseText || "")) throw new Error(`Unexpected warehouse selection: ${warehouseText || "(blank)"}`);
        await page.screenshot({ path: path.join(SCREEN_DIR, "02-portal-home.png"), animations: "disabled", fullPage: false });

        await clickView(page, "order");
        await page.locator("#orderPoNumber").fill("EXAMPLE-PO-001");
        await page.locator("#orderShippingReference").fill("EXAMPLE-SHIPMENT");
        await capture(page.locator("#orderSetupStep"), "03-order-details.png");

        await page.locator("#orderItemSearch").fill(session.exampleSku);
        await page.waitForTimeout(350);
        const itemResult = page.locator(`[data-order-item-sku="${session.exampleSku}"]`).first();
        await itemResult.waitFor({ timeout: 10000 });
        await itemResult.click();
        await page.locator("#orderItemQuantity").fill("1");
        await page.locator("#addLineBtn").click();
        await page.waitForTimeout(300);
        await capture(page.locator("#orderItemsStep"), "04-add-item.png");

        await page.locator('[data-order-jump="orderDestinationStep"]').click();
        await page.waitForTimeout(250);
        await capture(page.locator("#orderDestinationStep"), "05-ship-to.png");
        await capture(page.locator("#orderPanel > .order-actions"), "06-save-release.png");
        await context.close();

        fs.writeFileSync(HTML_PATH, buildHtml(session), "utf8");
        const pdfContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
        const pdfPage = await pdfContext.newPage();
        await pdfPage.goto(`file:///${HTML_PATH.replace(/\\/g, "/")}`, { waitUntil: "load" });
        await pdfPage.pdf({
            path: PDF_PATH,
            format: "Letter",
            printBackground: true,
            margin: { top: "0.42in", right: "0.42in", bottom: "0.42in", left: "0.42in" }
        });
        await pdfContext.close();
        console.log(JSON.stringify({ pdfPath: PDF_PATH, htmlPath: HTML_PATH, screenshots: fs.readdirSync(SCREEN_DIR) }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
