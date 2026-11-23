const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const functions = source.slice(source.indexOf("        function createDeliveryDialog("), source.indexOf("        function onIntegrationListClick("));
const styles = source.match(/<style>([\s\S]*?)<\/style>/)[1];
const output = path.join(__dirname, "outputs", "shopify-delivery-tracking-tests");

for (const viewport of [{ width: 1365, height: 900 }, { width: 390, height: 844 }]) {
    test(`delivery settings and notification log remain usable at ${viewport.width}px`, async () => {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage({ viewport });
            await page.setContent(`<html><head><style>${styles}</style></head><body><h2>WMS365 - CODEX PORTAL SYSTEM TEST</h2></body></html>`);
            await page.addScriptTag({ content: `
                const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
                const attr = esc;
                const norm = value => String(value || '').toUpperCase();
                const formatDate = value => new Date(value).toISOString();
                const getActiveCompany = () => 'CODEX PORTAL SYSTEM TEST';
                const integrationRecords = [{id:'TEST-INTEGRATION',accountName:'CODEX PORTAL SYSTEM TEST',integrationName:'Test Store',storeIdentifier:'test.invalid'}];
                const portalOrderRecords = [{shipmentTracking:[{id:'TEST-TRACKER',carrierName:'ICS Courier',trackingNumber:'TEST-PACKAGE'}]}];
                const refreshPortalOrdersList = async () => {};
                const calls = [];
                let failRequest = false;
                const requestJson = async (url, options = {}) => {
                    calls.push({url,options});
                    if (failRequest) throw new Error('Access restricted: this shipment is outside your warehouse.');
                    if (url.endsWith('/delivery-settings')) return {settings:{enabled:false,mode:'SHOPIFY',events:['SHIPPED','DELIVERED']}};
                    return {notifications:[{id:'TEST-NOTIFICATION',recipient:'test@example.invalid',status:'DELIVERED',sentAt:'2026-09-17T15:30:00Z',method:'EMAIL',provider:'SHOPIFY',result:'PENDING',canResend:false}]};
                };
                ${functions}
            ` });
            await page.evaluate(() => openStoreDeliverySettings("TEST-INTEGRATION"));
            await page.getByRole("button", { name: "Save Settings" }).waitFor();
            assert.equal(await page.locator('input[name="enabled"]').isChecked(), false);
            await page.locator('[name="mode"]').selectOption("BOTH");
            await page.getByRole("button", { name: "Save Settings" }).click();
            await page.getByText("Delivery settings saved.", { exact: true }).waitFor();
            const saved = await page.evaluate(() => calls.find(call => call.options.method === "PUT"));
            assert.equal(JSON.parse(saved.options.body).mode, "BOTH");
            assert.equal(JSON.parse(saved.options.body).smsEnabled, false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            fs.mkdirSync(output, { recursive: true });
            await page.screenshot({ path: path.join(output, `settings-${viewport.width}.png`) });
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await page.evaluate(() => openShipmentNotificationLog("TEST-TRACKER"));
            await page.getByText("test@example.invalid", { exact: true }).waitFor();
            assert.equal(await page.getByRole("button", { name: "Resend", exact: true }).isDisabled(), true);
            await page.screenshot({ path: path.join(output, `notification-log-${viewport.width}.png`) });
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await page.evaluate(() => openShipmentTrackingCorrection("TEST-TRACKER"));
            assert.equal(await page.locator('[name="carrier"]').inputValue(), "ICS_COURIER");
            await page.locator('[name="trackingNumber"]').fill("TEST-PACKAGE-2");
            await page.locator('[name="reason"]').fill("Test-company correction fixture");
            await page.getByRole("button", { name: "Save Correction" }).click();
            await page.getByText("Correction saved. Shopify tracking confirmed.", { exact: true }).waitFor();
            const corrected = await page.evaluate(() => calls.find(call => call.url.endsWith("/correct")));
            assert.equal(corrected.options.method, "POST");
            assert.equal(JSON.parse(corrected.options.body).trackingNumber, "TEST-PACKAGE-2");
            assert.equal(JSON.parse(corrected.options.body).carrier, "ICS_COURIER");
            await page.screenshot({ path: path.join(output, `correction-${viewport.width}.png`) });
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await page.evaluate(() => { failRequest = true; return openStoreDeliverySettings("TEST-INTEGRATION"); });
            const alert = page.getByRole("alert");
            await alert.waitFor();
            assert.match(await alert.textContent(), /Access restricted/);
            const box = await alert.boundingBox();
            assert.ok(box.y >= 0 && box.y + box.height <= viewport.height);
            assert.equal(await alert.evaluate(element => getComputedStyle(element).color), "rgb(143, 23, 17)");
            await page.screenshot({ path: path.join(output, `visible-warning-${viewport.width}.png`) });
        } finally { await browser.close(); }
    });
}
