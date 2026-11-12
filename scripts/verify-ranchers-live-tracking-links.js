const crypto = require("crypto");
const { chromium } = require("playwright");
const { Pool } = require("pg");
const { normalizeTrackingCarrier } = require("../carrier-tracking");
const { buildCarrierTrackingUrl } = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const BASE_URL = "https://app.wms365.co";

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function trackingReferences(value) {
    return [...new Set(String(value || "").split(/[\n,;|]+/).map((entry) => entry.trim()).filter(Boolean))];
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    let browser = null;
    try {
        const userResult = await pool.query(
            `select distinct u.id, u.role
             from app_users u
             join app_user_fulfillment_location_access access on access.app_user_id = u.id
             join company_fulfillment_locations company_warehouse
               on company_warehouse.fulfillment_location_id = access.fulfillment_location_id
             where u.is_active = true and u.role <> 'super_admin'
               and upper(company_warehouse.account_name) = upper($1)
             order by u.id limit 1`,
            [ACCOUNT]
        );
        if (userResult.rowCount !== 1) throw new Error("No active assigned warehouse user was found.");
        const token = crypto.randomBytes(32).toString("hex");
        const sessionResult = await pool.query(
            `insert into app_sessions (app_user_id, token_hash, expires_at)
             values ($1, $2, now() + interval '10 minutes') returning id`,
            [userResult.rows[0].id, hashToken(token)]
        );
        sessionId = sessionResult.rows[0].id;

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-CA" });
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
        await page.locator("#desktopCompanySwitcherSummary").click();
        const companyOption = page.locator("#companySwitcherList [data-company-switcher-value]").filter({ hasText: ACCOUNT }).first();
        await companyOption.waitFor({ state: "visible", timeout: 30000 });
        await companyOption.click();
        await page.waitForFunction((account) => document.querySelector("#activeCompany")?.value === account, ACCOUNT, { timeout: 30000 });
        await page.locator('[data-section="orders"]').evaluate((button) => button.click());
        await page.locator("#portalOrderStatusFilter").selectOption("SHIPPED");
        await page.waitForFunction(() => /Updated .* sales orders/i.test(document.querySelector("#portalOrdersMessage")?.textContent || ""), null, { timeout: 30000 });

        const apiResult = await page.evaluate(async (account) => {
            const response = await fetch(`/api/admin/portal-orders?accountName=${encodeURIComponent(account)}&status=SHIPPED`, { cache: "no-store" });
            return { status: response.status, payload: await response.json() };
        }, ACCOUNT);
        if (apiResult.status !== 200) throw new Error(`Shipped-order API returned ${apiResult.status}.`);
        const orders = Array.isArray(apiResult.payload?.orders) ? apiResult.payload.orders : [];
        const allLinkChecks = [];
        for (const order of orders) {
            for (const tracking of trackingReferences(order.shippedTrackingReference)) {
                const expectedUrl = buildCarrierTrackingUrl(order.shippedCarrierName, tracking);
                const browserUrl = await page.evaluate(({ carrier, trackingNumber }) => (
                    buildClientCarrierTrackingUrl(carrier, trackingNumber)
                ), { carrier: order.shippedCarrierName, trackingNumber: tracking });
                allLinkChecks.push({
                    orderCode: order.orderCode,
                    carrier: order.shippedCarrierName,
                    carrierFamily: normalizeTrackingCarrier(order.shippedCarrierName),
                    tracking,
                    expectedUrl,
                    browserUrl,
                    matches: Boolean(expectedUrl && browserUrl === expectedUrl)
                });
            }
        }
        const invalidLinks = allLinkChecks.filter((entry) => !entry.matches);
        if (invalidLinks.length) throw new Error(`Live link generation failed: ${JSON.stringify(invalidLinks.slice(0, 10))}`);

        const representativeByCarrier = new Map();
        for (const check of allLinkChecks) {
            if (!representativeByCarrier.has(check.carrierFamily)) representativeByCarrier.set(check.carrierFamily, check);
        }
        const uiChecks = [];
        for (const check of representativeByCarrier.values()) {
            await page.locator("#portalOrderSearch").fill(check.orderCode);
            await page.waitForFunction((orderCode) => {
                const rows = [...document.querySelectorAll("#portalOrdersList tbody tr[data-open-warehouse-order]")];
                return rows.length === 1 && rows[0].textContent.includes(orderCode);
            }, check.orderCode, { timeout: 15000 });
            await page.locator("#portalOrdersList button[data-open-warehouse-order]").click();
            await page.waitForFunction(() => document.body.classList.contains("sales-order-popout-open"), null, { timeout: 30000 });
            const link = page.getByRole("link", { name: "Track shipment" });
            await link.waitFor({ state: "visible", timeout: 30000 });
            const href = await link.getAttribute("href");
            uiChecks.push({ ...check, href, matches: href === check.expectedUrl });
            if (href !== check.expectedUrl) throw new Error(`${check.orderCode} displayed ${href} instead of ${check.expectedUrl}.`);
            await page.getByRole("button", { name: "Back to Sales Orders" }).click();
            await page.waitForFunction(() => !document.body.classList.contains("sales-order-popout-open"), null, { timeout: 15000 });
        }

        const destinationChecks = [];
        for (const check of representativeByCarrier.values()) {
            const carrierPage = await context.newPage();
            try {
                const response = await carrierPage.goto(check.expectedUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
                destinationChecks.push({
                    carrierFamily: check.carrierFamily,
                    orderCode: check.orderCode,
                    tracking: check.tracking,
                    requestedUrl: check.expectedUrl,
                    responseStatus: response?.status() || null,
                    finalUrl: carrierPage.url(),
                    loaded: Boolean(response && response.status() < 500)
                });
            } catch (error) {
                destinationChecks.push({
                    carrierFamily: check.carrierFamily,
                    orderCode: check.orderCode,
                    tracking: check.tracking,
                    requestedUrl: check.expectedUrl,
                    responseStatus: null,
                    finalUrl: carrierPage.url(),
                    loaded: false,
                    error: error.message
                });
            } finally {
                await carrierPage.close();
            }
        }
        console.log(JSON.stringify({
            role: userResult.rows[0].role,
            shippedOrdersChecked: orders.length,
            trackingLinksChecked: allLinkChecks.length,
            invalidLinks: invalidLinks.length,
            carrierFamilies: [...representativeByCarrier.keys()],
            uiChecks,
            destinationChecks
        }, null, 2));
        await context.close();
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (sessionId) await pool.query("delete from app_sessions where id = $1", [sessionId]).catch(() => {});
        await pool.end().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
