const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { Pool } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const TARGET_ORDER = "ORD-000676";
const EXPECTED_TRACKING_URL = "https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=ND6C2BV3PNHFR5N7L2X8";
const BASE_URL = "https://app.wms365.co";
const OUTPUT_DIR = path.resolve(__dirname, "..", "outputs", "ranchers-shipped-orders-screen");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "Ranchers_Chips_Warehouse_User_Shipped_Orders_Live.png");

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    let browser = null;
    try {
        const userResult = await pool.query(
            `select u.id, u.email, u.role, company_warehouse.account_name, warehouse.code as warehouse_code
             from app_users u
             join app_user_fulfillment_location_access access
               on access.app_user_id = u.id
             join fulfillment_locations warehouse
               on warehouse.id = access.fulfillment_location_id
             join company_fulfillment_locations company_warehouse
               on company_warehouse.fulfillment_location_id = warehouse.id
             join portal_orders shipped_order
               on upper(shipped_order.account_name) = upper(company_warehouse.account_name)
              and shipped_order.fulfillment_location_id = warehouse.id
              and shipped_order.status = 'SHIPPED'
             where u.is_active = true
               and u.role <> 'super_admin'
             order by case when upper(company_warehouse.account_name) = upper($1) then 0 else 1 end,
                      u.id, shipped_order.id desc
             limit 1`,
            [ACCOUNT]
        );
        if (userResult.rowCount !== 1) throw new Error("No active warehouse user with assigned shipped orders was found.");
        const warehouseUser = userResult.rows[0];
        const testAccount = warehouseUser.account_name;

        const token = crypto.randomBytes(32).toString("hex");
        const sessionResult = await pool.query(
            `insert into app_sessions (app_user_id,token_hash,expires_at)
             values ($1,$2,now() + interval '10 minutes') returning id`,
            [warehouseUser.id, hashToken(token)]
        );
        sessionId = sessionResult.rows[0].id;

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: { width: 1500, height: 1000 },
            deviceScaleFactor: 1,
            locale: "en-CA"
        });
        await context.addCookies([{
            name: "wms365_app_session",
            value: token,
            domain: "app.wms365.co",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax"
        }]);

        const page = await context.newPage();
        await page.goto(`${BASE_URL}/desktop`, { waitUntil: "networkidle", timeout: 60000 });
        await page.locator("#desktopCompanySwitcherSummary").waitFor({ state: "visible", timeout: 30000 });
        await page.locator("#desktopCompanySwitcherSummary").click();
        const companyOption = page.locator("#companySwitcherList [data-company-switcher-value]").filter({ hasText: testAccount }).first();
        await companyOption.waitFor({ state: "visible", timeout: 30000 });
        await companyOption.click();
        await page.waitForFunction((expectedAccount) => (
            document.querySelector("#activeCompany")?.value || ""
        ).trim() === expectedAccount, testAccount, { timeout: 30000 });
        await page.waitForTimeout(1800);
        await page.locator('[data-section="orders"]').evaluate((button) => button.click());
        await page.locator("#portalOrdersQueueCard").waitFor({ state: "visible", timeout: 30000 });
        await page.locator("#portalOrderStatusFilter").selectOption("SHIPPED");
        await page.waitForFunction(() => {
            const rows = document.querySelectorAll("#portalOrdersList tbody tr[data-open-warehouse-order]");
            return rows.length > 0
                && document.querySelector("#portalOrderStatusFilter")?.value === "SHIPPED"
                && /Updated .* sales orders/i.test(document.querySelector("#portalOrdersMessage")?.textContent || "");
        }, null, { timeout: 30000 });
        const diagnostics = await page.evaluate(async (account) => {
            const response = await fetch(`/api/admin/portal-orders?accountName=${encodeURIComponent(account)}&status=SHIPPED`, { cache: "no-store" });
            const payload = await response.json().catch(() => ({}));
            const shippedOrders = Array.isArray(payload.orders) ? payload.orders : [];
            return {
                responseStatus: response.status,
                apiOrders: shippedOrders.length,
                apiAllShipped: shippedOrders.every((order) => order.status === "SHIPPED"),
                apiAllSameCompany: shippedOrders.every((order) => order.accountName === account),
                renderedRows: document.querySelectorAll("#portalOrdersList tbody tr[data-open-warehouse-order]").length,
                activeCompany: document.querySelector("#activeCompany")?.value || "",
                activeCompanyDisplay: document.querySelector("#activeCompanyDisplay")?.textContent || "",
                activeSection: document.querySelector(".tab.active")?.dataset?.section || "",
                statusFilter: document.querySelector("#portalOrderStatusFilter")?.value || "",
                message: document.querySelector("#portalOrdersMessage")?.textContent || "",
                listText: (document.querySelector("#portalOrdersList")?.textContent || "").trim().slice(0, 500)
            };
        }, testAccount);
        if (diagnostics.responseStatus !== 200) throw new Error(`Shipped order API returned ${diagnostics.responseStatus}.`);
        if (!diagnostics.apiOrders || diagnostics.renderedRows !== diagnostics.apiOrders) throw new Error(`Shipped order count mismatch: ${JSON.stringify(diagnostics)}`);
        if (!diagnostics.apiAllShipped || !diagnostics.apiAllSameCompany) throw new Error(`Shipped order scope mismatch: ${JSON.stringify(diagnostics)}`);
        await page.waitForTimeout(800);

        const activeCompany = (await page.locator("#activeCompany").inputValue()).trim();
        const status = (await page.locator("#portalOrderStatusFilter").inputValue()).trim();
        const orderCount = await page.locator("#portalOrdersList").locator("tbody tr[data-open-warehouse-order]").count();
        if (activeCompany !== testAccount) throw new Error(`Unexpected active company: ${activeCompany}`);
        if (status !== "SHIPPED") throw new Error(`Unexpected order status filter: ${status}`);
        if (diagnostics.activeSection !== "orders") throw new Error(`Unexpected active section: ${diagnostics.activeSection}`);

        await page.locator("#portalOrderSearch").fill(TARGET_ORDER);
        await page.waitForFunction((orderCode) => {
            const rows = [...document.querySelectorAll("#portalOrdersList tbody tr[data-open-warehouse-order]")];
            return rows.length === 1 && rows[0].textContent.includes(orderCode);
        }, TARGET_ORDER, { timeout: 10000 });
        await page.locator("#portalOrdersList button[data-open-warehouse-order]").click();
        await page.waitForFunction(() => document.body.classList.contains("sales-order-popout-open"), null, { timeout: 30000 });
        const trackingLink = page.getByRole("link", { name: "Track shipment" });
        await trackingLink.waitFor({ state: "visible", timeout: 30000 });
        const actualTrackingUrl = await trackingLink.getAttribute("href");
        if (actualTrackingUrl !== EXPECTED_TRACKING_URL) {
            throw new Error(`Unexpected tracking link for ${TARGET_ORDER}: ${actualTrackingUrl}`);
        }

        await page.locator("#portalOrdersQueueCard").scrollIntoViewIfNeeded();
        await page.screenshot({ path: OUTPUT_PATH, animations: "disabled", fullPage: false });
        await context.close();
        console.log(JSON.stringify({ outputPath: OUTPUT_PATH, role: warehouseUser.role, warehouseCode: warehouseUser.warehouse_code, activeCompany, status, visibleOrderRows: orderCount, targetOrder: TARGET_ORDER, trackingUrl: actualTrackingUrl, diagnostics }, null, 2));
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (sessionId) await pool.query("delete from app_sessions where id=$1", [sessionId]).catch(() => {});
        await pool.end().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
