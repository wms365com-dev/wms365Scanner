const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");

test("public homepage uses the sales funnel while preserving login and guided demo paths", () => {
    const server = read("server.js");
    const page = read("site-funnel.html");
    assert.match(server, /sendMarketingPage\(req, res, "site-funnel\.html"\)/);
    assert.match(page, /Warehouse management software that gets work moving/);
    assert.match(page, /href="#start">Start 14-Day Trial/);
    assert.match(page, /href="\/book-demo">Book a Guided Demo/);
    assert.match(page, /href="https:\/\/app\.wms365\.co\/">Sign In/);
});

test("homepage trial form supplies every required Stripe onboarding field", () => {
    const page = read("site-funnel.html");
    const marketing = read("marketing.js");
    assert.match(page, /data-stripe-signup-form/);
    assert.match(page, /name="fullName"/);
    assert.match(page, /name="workEmail"/);
    assert.match(page, /name="companyName"/);
    assert.match(page, /data-stripe-plan="LAUNCH_WAREHOUSE"/);
    assert.match(page, /Credit card required/);
    assert.match(page, /\$129 monthly subscription begins after the trial/);
    assert.match(marketing, /form\.querySelector\("\[data-stripe-plan\]"\)/);
});

test("homepage keeps buyer conversion primary and secondary programs in the footer", () => {
    const page = read("site-funnel.html");
    const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
    const footer = page.slice(page.indexOf("<footer"));
    assert.doesNotMatch(main, /Affiliate Program|Sales members wanted|Careers/);
    assert.match(footer, /Affiliate Program/);
    assert.match(footer, /Careers/);
});

test("homepage hero uses a real raster warehouse asset and responsive funnel layout", () => {
    const page = read("site-funnel.html");
    const css = read("marketing.css");
    assert.equal(fs.existsSync(path.join(__dirname, "wms365-warehouse-hero-v2.webp")), true);
    assert.match(page, /og:image[^>]+wms365-warehouse-hero-v2\.webp/);
    assert.match(css, /\.funnel-hero-media[\s\S]*wms365-warehouse-hero-v2\.webp/);
    assert.match(css, /@media \(max-width: 620px\)/);
    assert.match(css, /\.funnel-start-grid/);
});
