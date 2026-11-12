const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { Pool } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const BASE_URL = "https://app.wms365.co";
const OUTPUT_DIR = path.resolve(__dirname, "..", "outputs", "ranchers-shipped-orders-screen");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "Ranchers_Chips_Standard_User_Shipped_Orders_Live.png");

function hashToken(token) {
    return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    let browser = null;
    try {
        const accessResult = await pool.query(
            `select id
             from portal_vendor_access
             where account_name=$1 and is_active=true
             order by id asc
             limit 1`,
            [ACCOUNT]
        );
        if (accessResult.rowCount !== 1) throw new Error("No active Rancher's customer portal user was found.");

        const token = crypto.randomBytes(32).toString("hex");
        const sessionResult = await pool.query(
            `insert into portal_sessions (portal_access_id, token_hash, expires_at)
             values ($1,$2,now() + interval '10 minutes')
             returning id`,
            [accessResult.rows[0].id, hashToken(token)]
        );
        sessionId = sessionResult.rows[0].id;

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: { width: 1500, height: 1000 },
            deviceScaleFactor: 1,
            locale: "en-CA"
        });
        await context.addCookies([{
            name: "wms365_portal_session",
            value: token,
            domain: "app.wms365.co",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax"
        }]);

        const page = await context.newPage();
        await page.goto(`${BASE_URL}/portal.html#shipped`, { waitUntil: "networkidle", timeout: 60000 });
        await page.locator("#portalView").waitFor({ state: "visible", timeout: 30000 });
        await page.locator('.portal-nav-desktop [data-view="shipped"]').click();
        await page.locator("#shippedPanel").waitFor({ state: "visible", timeout: 30000 });
        await page.waitForFunction(() => document.querySelectorAll("#shippedOrdersList .shipped-order-card").length > 0, null, { timeout: 30000 });

        const diagnostics = await page.evaluate(async (expectedAccount) => {
            const response = await fetch("/api/portal/orders?status=SHIPPED", { cache: "no-store" });
            const payload = await response.json().catch(() => ({}));
            const orders = Array.isArray(payload.orders) ? payload.orders : [];
            return {
                status: response.status,
                apiOrderCount: orders.length,
                apiAllShipped: orders.every((order) => order.status === "SHIPPED"),
                apiAllSameCustomer: orders.every((order) => order.accountName === expectedAccount),
                visibleCards: document.querySelectorAll("#shippedOrdersList .shipped-order-card").length,
                visibleOrderText: (document.querySelector("#shippedOrdersList")?.textContent || "").trim().slice(0, 500),
                activeView: location.hash
            };
        }, ACCOUNT);

        if (diagnostics.status !== 200) throw new Error(`Shipped order API returned ${diagnostics.status}.`);
        if (!diagnostics.apiOrderCount || diagnostics.visibleCards !== diagnostics.apiOrderCount) {
            throw new Error(`Shipped order count mismatch: ${JSON.stringify(diagnostics)}`);
        }
        if (!diagnostics.apiAllShipped || !diagnostics.apiAllSameCustomer) {
            throw new Error(`Customer or status isolation failed: ${JSON.stringify(diagnostics)}`);
        }
        if (!/ORD-\d{6}/.test(diagnostics.visibleOrderText)) {
            throw new Error(`Visible shipped order cards do not contain an order number: ${JSON.stringify(diagnostics)}`);
        }

        await page.screenshot({ path: OUTPUT_PATH, animations: "disabled", fullPage: false });
        await context.close();
        console.log(JSON.stringify({ outputPath: OUTPUT_PATH, account: ACCOUNT, ...diagnostics }, null, 2));
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (sessionId) await pool.query("delete from portal_sessions where id=$1", [sessionId]).catch(() => {});
        await pool.end().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
