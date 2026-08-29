const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    renderWms365ServiceUnavailablePage,
    shouldServeWms365MaintenancePage
} = require("./server");

test("WMS365 renders a branded maintenance page without exposing Railway", () => {
    const html = renderWms365ServiceUnavailablePage({ requestId: "REQ-123" });
    assert.match(html, /WMS365 is reconnecting/);
    assert.match(html, /retry automatically in 30 seconds/i);
    assert.match(html, /support@wms365\.co/);
    assert.match(html, /REQ-123/);
    assert.doesNotMatch(html, /Railway/i);
});

test("maintenance page covers customer and warehouse application entry routes only", () => {
    for (const pathName of ["/login", "/portal", "/desktop", "/mobile-pick"]) {
        assert.equal(shouldServeWms365MaintenancePage({ method: "GET", path: pathName }), true, pathName);
    }
    assert.equal(shouldServeWms365MaintenancePage({ method: "POST", path: "/api/app/login" }), false);
    assert.equal(shouldServeWms365MaintenancePage({ method: "GET", path: "/api/health" }), false);
    assert.equal(shouldServeWms365MaintenancePage({ method: "GET", path: "/pricing" }), false);
});

test("database watchdog remains alive in degraded mode instead of exiting the process", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const start = source.indexOf("function ensureDatabaseHealthWatchdogStarted()");
    const end = source.indexOf("async function getServerState", start);
    assert.ok(start >= 0 && end > start);
    const watchdog = source.slice(start, end);
    assert.doesNotMatch(watchdog, /process\.exit\s*\(/);
    assert.match(watchdog, /keeping the WMS365 web process online in degraded mode/);
});
