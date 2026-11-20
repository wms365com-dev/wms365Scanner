const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const style = source.match(/<style>[\s\S]*?<\/style>/)?.[0] || "";
const company = "BISON TRANSPORT TEST COMPANY WITH AN INTENTIONALLY LONG WAREHOUSE DIVISION NAME";

for (const context of ["Inventory Lookup", "Reports & Counts", "Marketplace Connections"]) {
    test(`long company name does not overlap FactBox rows in ${context}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.setContent(`<!doctype html><html><head>${style}</head><body>
            <aside class="desktop-factbox" style="width:240px">
                <section class="factbox-part">
                    <h3>${context}</h3>
                    <div class="factbox-line"><span>Company</span><strong title="${company}">${company}</strong></div>
                    <div class="factbox-line"><span>Selection</span><strong>Current warehouse records</strong></div>
                    <div class="factbox-line"><span>Action</span><strong>Select row</strong></div>
                </section>
            </aside>
        </body></html>`);

        const rows = page.locator(".factbox-line");
        await expect(rows).toHaveCount(3);
        const metrics = await rows.evaluateAll((elements) => elements.map((row) => {
            const label = row.querySelector("span").getBoundingClientRect();
            const value = row.querySelector("strong").getBoundingClientRect();
            return {
                overlaps: label.right > value.left && label.bottom > value.top && label.top < value.bottom,
                contained: row.scrollWidth <= row.clientWidth,
                valueContained: row.querySelector("strong").scrollWidth <= row.querySelector("strong").clientWidth
            };
        }));
        metrics.forEach((metric) => {
            expect(metric.overlaps).toBe(false);
            expect(metric.contained).toBe(true);
            expect(metric.valueContained).toBe(true);
        });
        await expect(rows.first().locator("strong")).toHaveAttribute("title", company);
        await page.screenshot({ path: testInfo.outputPath(`${context.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}.png`) });
    });
}
