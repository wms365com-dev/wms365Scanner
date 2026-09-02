const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const style = source.match(/<style>[\s\S]*?<\/style>/)?.[0] || "";
const alertMarkup = source.match(/<div class="warehouse-viewport-alert" id="warehouseViewportAlert" hidden>[\s\S]*?<\/section>\s*<\/div>/)?.[0] || "";

async function renderWarehouseError(page, viewport) {
    await page.setViewportSize(viewport);
    await page.setContent(`<!doctype html><html><head>${style}</head><body>${alertMarkup}<main style="min-height:1600px;background:#fff"></main></body></html>`);
    await page.evaluate(() => {
        const alert = document.getElementById("warehouseViewportAlert");
        alert.hidden = false;
        document.getElementById("warehouseViewportAlertText").textContent = "Pallet 1 location DJ32AB is not allocated to this order. Review the location and try again.";
        document.getElementById("warehouseViewportAlertReview").hidden = false;
    });
}

for (const scenario of [
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    { name: "warehouse tablet", viewport: { width: 390, height: 844 } }
]) {
    test(`warehouse action error stays prominent on ${scenario.name}`, async ({ page }, testInfo) => {
        await renderWarehouseError(page, scenario.viewport);
        const alert = page.locator("#warehouseViewportAlertPanel");
        const errorText = page.locator("#warehouseViewportAlertText");
        await expect(alert).toBeVisible();
        await expect(errorText).toContainText("Pallet 1 location DJ32AB");
        await expect(page.getByRole("button", { name: "Review field" })).toBeVisible();

        const metrics = await alert.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const styles = getComputedStyle(element);
            const textStyles = getComputedStyle(document.getElementById("warehouseViewportAlertText"));
            return {
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
                left: bounds.left,
                position: getComputedStyle(element.parentElement).position,
                borderLeftWidth: styles.borderLeftWidth,
                background: styles.backgroundColor,
                textColor: textStyles.color
            };
        });
        expect(metrics.position).toBe("fixed");
        expect(metrics.top).toBeGreaterThanOrEqual(0);
        expect(metrics.left).toBeGreaterThanOrEqual(0);
        expect(metrics.right).toBeLessThanOrEqual(scenario.viewport.width);
        expect(metrics.bottom).toBeLessThanOrEqual(scenario.viewport.height);
        expect(metrics.borderLeftWidth).toBe("8px");
        expect(metrics.background).toBe("rgb(255, 255, 255)");
        expect(metrics.textColor).toBe("rgb(95, 32, 26)");
        await page.screenshot({ path: testInfo.outputPath(`warehouse-error-${scenario.name.replaceAll(" ", "-")}.png`) });
    });
}
