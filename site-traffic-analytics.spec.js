const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    SITE_TRAFFIC_OWNER_EMAIL,
    SITE_TRAFFIC_RETENTION_MONTHS,
    isSiteTrafficOwner,
    sanitizeSiteTrafficPath,
    sanitizeSiteTrafficReferrer,
    detectSiteTrafficDeviceType,
    recordSiteTrafficEvent
} = require("./server");

test("website traffic reporting is restricted to the exact owner email", () => {
    assert.equal(SITE_TRAFFIC_OWNER_EMAIL, "k.prathab@gmail.com");
    assert.equal(isSiteTrafficOwner({ email: "K.PRATHAB@GMAIL.COM" }), true);
    assert.equal(isSiteTrafficOwner({ email: "admin@wms365.co", role: "super_admin" }), false);
});

test("website traffic collection keeps only safe paths, referral domains, and device categories", () => {
    assert.equal(sanitizeSiteTrafficPath("/pricing?customer=secret#plans"), "/pricing");
    assert.equal(sanitizeSiteTrafficPath("https://outside.example/private"), "/");
    assert.equal(sanitizeSiteTrafficReferrer("https://www.google.com/search?q=wms", "wms365.co"), "google.com");
    assert.equal(sanitizeSiteTrafficReferrer("https://wms365.co/pricing", "wms365.co"), "");
    assert.equal(detectSiteTrafficDeviceType("Mozilla/5.0 (iPhone; Mobile)"), "MOBILE");
    assert.equal(detectSiteTrafficDeviceType("Mozilla/5.0 (iPad)"), "TABLET");
    assert.equal(SITE_TRAFFIC_RETENTION_MONTHS, 13);
});

test("website traffic events hash identifiers and never store raw IP addresses", async () => {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql: String(sql), params });
            return { rowCount: 1, rows: [{ id: 1 }] };
        }
    };
    const recorded = await recordSiteTrafficEvent(client, {
        eventId: "event_1234567890123456",
        visitorId: "visitor_12345678901234",
        sessionId: "session_12345678901234",
        path: "/pricing?plan=private",
        referrer: "https://google.com/search?q=wms"
    }, { headers: { host: "wms365.co", "user-agent": "Mozilla/5.0 (iPhone; Mobile)" }, ip: "192.0.2.10" });

    assert.equal(recorded, true);
    assert.match(calls[0].sql, /insert into site_traffic_events/);
    assert.doesNotMatch(calls[0].sql, /ip_address/);
    assert.notEqual(calls[0].params[0], "event_1234567890123456");
    assert.notEqual(calls[0].params[1], "visitor_12345678901234");
    assert.equal(calls[0].params[3], "/pricing");
    assert.equal(calls[0].params[4], "google.com");
    assert.equal(calls[0].params[5], "MOBILE");
});

test("public marketing pages collect traffic while the owner dashboard remains hidden by default", () => {
    const marketing = fs.readFileSync(path.join(__dirname, "marketing.js"), "utf8");
    const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    assert.match(marketing, /navigator\.doNotTrack/);
    assert.match(marketing, /\/api\/site\/traffic/);
    assert.match(desktop, /class="[^"]*hidden[^"]*" id="siteTrafficCard"/);
    assert.match(desktop, /currentAppUser\.email === "k\.prathab@gmail\.com"/);
    assert.match(server, /app\.get\("\/api\/admin\/site-traffic", requireSiteTrafficOwner/);
});
