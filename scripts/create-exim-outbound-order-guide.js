const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SESSION_FILE = path.join(ROOT, ".tmp", "exim-outbound-guide-session.json");
const OUTPUT_DIR = path.join(ROOT, "outputs", "exim-outbound-order-guide");
const SCREEN_DIR = path.join(OUTPUT_DIR, "screenshots");
const HTML_PATH = path.join(OUTPUT_DIR, "EXIM_WMS365_Outbound_Order_Guide.html");
const PDF_PATH = path.join(OUTPUT_DIR, "EXIM_WMS365_Outbound_Order_Guide.pdf");
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
    await page.waitForTimeout(700);
}

function screenshotPath(filename) {
    return `screenshots/${filename}`;
}

function buildHtml(inventoryText) {
    const generatedAt = new Date().toLocaleString("en-CA", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "America/Toronto"
    });
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>EXIM WMS365 Outbound Order Guide</title>
<style>
@page { size: Letter; margin: 0.48in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #20313e; line-height: 1.4; font-size: 11pt; }
h1 { margin: 0 0 8px; color: #183247; font-size: 25pt; letter-spacing: 0; }
h2 { margin: 18px 0 7px; color: #1d4059; font-size: 16pt; letter-spacing: 0; break-after: avoid; }
p { margin: 0 0 8px; }
ol { margin: 6px 0 10px; padding-left: 23px; }
li { margin: 4px 0; }
.cover { padding: 20px 22px; background: #edf4f7; border: 1px solid #c7d7e0; border-radius: 8px; }
.brand { color: #5b7e95; font-weight: 700; text-transform: uppercase; font-size: 10pt; }
.meta { color: #657783; font-size: 9pt; }
.callout { margin: 9px 0; padding: 9px 11px; background: #f4f8fa; border-left: 4px solid #5b7e95; }
.warning { background: #fff8e9; border-left-color: #b77800; }
.screen { display: block; width: 100%; max-height: 5.6in; object-fit: contain; object-position: top left; margin: 8px 0 12px; border: 1px solid #ccd8df; border-radius: 6px; }
.compact { max-height: 4.6in; }
.page-break { break-before: page; }
.footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #d6e0e5; color: #657783; font-size: 9pt; }
</style>
</head>
<body>
<section class="cover">
  <div class="brand">WMS365 Customer Portal</div>
  <h1>Outbound Order Guide</h1>
  <p><strong>Prepared for EXIM WORLD CONNECT INC.</strong></p>
  <p>Use WMS365 for all outbound requests so EXIM and Grey Wolf can see the same order details, quantities, documents, and processing status.</p>
  <p><strong>Portal:</strong> https://app.wms365.co/portal.html</p>
  <p><strong>Live inventory at time of guide:</strong> ${inventoryText}</p>
  <p class="meta">Prepared ${generatedAt}. This guide contains EXIM-only system screens. No test order was submitted.</p>
</section>

<h2>1. Sign In</h2>
<ol>
  <li>Open <strong>https://app.wms365.co/portal.html</strong>.</li>
  <li>Enter your customer portal email and password.</li>
  <li>Select <strong>Sign in</strong>.</li>
</ol>
<img class="screen compact" src="${screenshotPath("01-sign-in.png")}" alt="WMS365 sign-in page">

<h2 class="page-break">2. Confirm the Warehouse</h2>
<ol>
  <li>Confirm the company shown is <strong>EXIM WORLD CONNECT INC.</strong></li>
  <li>Confirm the active warehouse is <strong>Grey Wolf 3PL - Mississauga</strong>.</li>
  <li>Select <strong>New Sales Order</strong> from the menu.</li>
</ol>
<div class="callout">EXIM is currently assigned to the Grey Wolf Mississauga warehouse. Stock and orders shown in the portal are limited to EXIM.</div>
<img class="screen" src="${screenshotPath("02-exim-portal.png")}" alt="EXIM customer portal and warehouse selector">

<h2 class="page-break">3. Check Stock Before Ordering</h2>
<ol>
  <li>Select <strong>Inventory</strong>.</li>
  <li>Search by SKU or description. For this item, search <strong>TIGER</strong>.</li>
  <li>Review the available quantity for the selected warehouse.</li>
</ol>
<div class="callout warning">You may save an out-of-stock order as a draft, but it cannot be released to the warehouse until enough pickable stock is available.</div>
<img class="screen" src="${screenshotPath("03-live-inventory.png")}" alt="EXIM live inventory for TIGER">

<h2 class="page-break">4. Enter the Order Details</h2>
<ol>
  <li>Open <strong>New Sales Order</strong>.</li>
  <li>Enter the customer PO number and shipping reference.</li>
  <li>Select the requested ship date, order type, and shipment method.</li>
  <li>Add any handling or delivery notes.</li>
</ol>
<img class="screen" src="${screenshotPath("04-order-setup.png")}" alt="Outbound order setup fields">

<h2 class="page-break">5. Search and Add Items</h2>
<ol>
  <li>In Step 2, search by SKU, description, or UPC.</li>
  <li>Select <strong>TIGER - Royal Tiger 250 ml</strong>.</li>
  <li>Enter the number of cases and select <strong>Add Item &amp; Next</strong>.</li>
  <li>Repeat for additional items. The portal warns you if the same item is added twice.</li>
</ol>
<img class="screen" src="${screenshotPath("05-add-tiger.png")}" alt="TIGER added to an outbound order">

<h2 class="page-break">6. Enter and Verify the Ship-To Address</h2>
<ol>
  <li>Select a saved ship-to address, or enter a new real delivery address.</li>
  <li>Complete the contact and phone fields.</li>
  <li>For a new address, select <strong>Verify Address</strong> and use the verified result.</li>
  <li>Manual override is available only when necessary and requires confirmation.</li>
</ol>
<img class="screen" src="${screenshotPath("06-ship-to.png")}" alt="Ship-to address section">

<h2 class="page-break">7. Save or Release</h2>
<ol>
  <li>Upload any shipping label or supporting document in Step 4.</li>
  <li>Select <strong>Save Draft</strong> when information or stock is not ready.</li>
  <li>Select <strong>Release Order</strong> only after quantities, warehouse, ship-to address, and documents are correct.</li>
  <li>In <strong>My Sales Orders</strong>, follow the order through Released, Picked, Staged, and Shipped.</li>
</ol>
<div class="callout">Using the portal instead of email keeps the order, stock allocation, documents, and shipment status together in one record.</div>
<img class="screen compact" src="${screenshotPath("07-save-release.png")}" alt="Save draft and release order buttons">

<div class="footer">Need help? Contact support@wms365.co.</div>
</body>
</html>`;
}

async function main() {
    if (!fs.existsSync(SESSION_FILE)) throw new Error("The temporary EXIM guide session file is missing.");
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    ensureDir(SCREEN_DIR);

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
        const localPortalHtml = fs.readFileSync(path.join(ROOT, "portal.html"), "utf8");
        await page.route("**/portal.html*", async (route) => {
            await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: localPortalHtml });
        });
        await page.goto(`${BASE_URL}/portal.html#home`, { waitUntil: "networkidle" });
        await page.locator("#portalView:not(.hidden)").waitFor({ timeout: 30000 });
        await page.waitForTimeout(1000);
        const accountChip = (await page.locator("#accountChip").textContent())?.trim() || "";
        if (!accountChip.includes("EXIM WORLD CONNECT INC.")) {
            throw new Error(`Unexpected portal account: ${accountChip}`);
        }
        await page.locator("#portalWarehouseSelect").selectOption({ label: /Grey Wolf 3PL - Mississauga/i }).catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(SCREEN_DIR, "02-exim-portal.png"), animations: "disabled", fullPage: false });

        await clickView(page, "inventory");
        await page.locator("#inventoryFilter").fill("TIGER");
        await page.waitForTimeout(450);
        const inventoryPanel = page.locator("#inventoryPanel");
        await capture(inventoryPanel, "03-live-inventory.png");
        const inventoryText = (await page.locator("#inventoryList").innerText()).replace(/\s+/g, " ").trim();
        if (!/TIGER/i.test(inventoryText)) throw new Error("TIGER was not visible in EXIM inventory.");

        await clickView(page, "order");
        await page.locator("#orderPoNumber").fill("EXAMPLE-PO-001");
        await page.locator("#orderShippingReference").fill("EXAMPLE-SHIP-001");
        await capture(page.locator("#orderSetupStep"), "04-order-setup.png");

        await page.locator("#orderItemSearch").fill("TIGER");
        await page.waitForTimeout(350);
        const itemResult = page.locator('[data-order-item-sku="TIGER"]').first();
        await itemResult.click();
        await page.locator("#orderItemQuantity").fill("100");
        await page.locator("#addLineBtn").click();
        await page.waitForTimeout(350);
        await capture(page.locator("#orderItemsStep"), "05-add-tiger.png");

        await page.locator('[data-order-jump="orderDestinationStep"]').click();
        await page.waitForTimeout(300);
        await capture(page.locator("#orderDestinationStep"), "06-ship-to.png");
        await capture(page.locator("#orderPanel > .order-actions"), "07-save-release.png");
        await context.close();

        const availableMatch = inventoryText.match(/Available\s+(\d[\d,]*)/i);
        const availableText = availableMatch ? `${availableMatch[1]} cases of TIGER` : "0 cases of TIGER";
        fs.writeFileSync(HTML_PATH, buildHtml(availableText), "utf8");

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
        console.log(JSON.stringify({ pdfPath: PDF_PATH, htmlPath: HTML_PATH, inventoryText }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
