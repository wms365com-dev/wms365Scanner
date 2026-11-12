"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { BrowserTrackingError, CARRIER_URLS, buildBrowserTrackingUrl, createCarrierTrackingBrowser,
    normalizeBrowserTracking, parseBrowserEventTimestamp, pollingSkipReason } = require("./carrier-tracking-browser");

const NOW = "2026-09-17T12:00:00Z";
const SHIPPED = "2026-09-15T10:00:00Z";
const EVENT = "2026-09-16T14:30:00-04:00";
const NUMBER = "TEST-123";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function shipment(carrier = "CANPAR", extra = {}) {
    return { carrier, trackingNumber: NUMBER, status: "IN_TRANSIT", shippedAt: SHIPPED, ...extra };
}
function layout(carrier, form = carrier !== "ICS_COURIER") {
    return { verified: true, verifiedAt: "2026-09-17T10:00:00Z", sourceUrl: CARRIER_URLS[carrier],
        layoutVersion: "fake-fixture-v1", timestampFormat: "iso_offset",
        selectors: { results: "#fixture-results", trackingNumber: ".fixture-number", status: ".fixture-status",
            eventRows: ".fixture-event", eventStatus: ".fixture-event-status", eventTimestamp: ".fixture-time",
            eventDescription: ".fixture-description", eventLocation: ".fixture-location",
            ...(form ? { input: "#fixture-input", submit: "#fixture-submit" } : {}) } };
}
function snapshot(status = "Delivered", events = [{ status, timestamp: EVENT, description: "Parcel scan", location: "Test depot" }]) {
    return { status, events };
}

// These selectors and statuses describe local fixtures, not verified live DOM.
function fakeBrowser({ data = snapshot(), number = NUMBER, waitError, screenshotError,
    launchError, pause, resultCount = 1, fieldCount = 1, redirectTo, screenshotPause = 0 } = {}) {
    const calls = { launches: [], contexts: [], urls: [], waits: [], fills: [], clicks: [], screenshots: [],
        contextClosed: 0, browserClosed: 0, starts: [], routes: [] };
    class Locator {
        constructor(kind, index = 0) { this.kind = kind; this.index = index; }
        locator(selector) { return new Locator(selector, this.index); }
        first() { return new Locator(this.kind, 0); }
        nth(index) { return new Locator(this.kind, index); }
        async count() {
            if (this.kind === "#fixture-results") return resultCount;
            if (this.kind === ".fixture-event") return data.events.length;
            return fieldCount;
        }
        async waitFor(options) {
            calls.waits.push({ kind: this.kind, ...options });
            if (pause) await pause;
            if (waitError) throw waitError;
        }
        async innerText() {
            const row = data.events[this.index] || {};
            return ({ ".fixture-number": number, ".fixture-status": data.status,
                ".fixture-event": row.rowText || [row.status, row.timestamp, row.description].join(" "),
                ".fixture-event-status": row.status, ".fixture-time": row.timestamp,
                ".fixture-description": row.description || "", ".fixture-location": row.location || "" })[this.kind];
        }
        async fill(value) { calls.fills.push(value); }
        async click() { calls.clicks.push(this.kind); }
    }
    const page = {
        locator: (selector) => new Locator(selector),
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {},
        async goto(url, options) { calls.urls.push({ url, options }); },
        url: () => redirectTo || calls.urls.at(-1).url,
        async screenshot(options) {
            calls.screenshots.push(options);
            if (screenshotPause) await sleep(screenshotPause);
            if (screenshotError) throw screenshotError;
            await fs.writeFile(options.path, Buffer.from("fake-private-png"));
        },
        async close() {}
    };
    const context = {
        async route(pattern, handler) { calls.routes.push({ pattern, handler }); },
        async routeWebSocket(pattern, handler) { calls.websocket = { pattern, handler }; },
        on(event, handler) { calls.contextEvent = { event, handler }; },
        async newPage() { return page; },
        async close() { calls.contextClosed++; }
    };
    const browser = {
        async newContext(options) {
            calls.contexts.push(options);
            let currentUrl;
            const isolatedPage = { ...page,
                async goto(url, navigationOptions) { currentUrl = url; calls.urls.push({ url, options: navigationOptions }); },
                url: () => redirectTo || currentUrl };
            return { ...context, async newPage() { return isolatedPage; } };
        },
        async close() { calls.browserClosed++; }
    };
    return { calls, page, browser, async launch(options) {
        calls.launches.push(options); calls.starts.push(Date.now());
        if (launchError) throw launchError;
        return browser;
    } };
}
async function setup(t, fake, carriers = ["CANPAR"], options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wms-tracking-spec-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const adapter = createCarrierTrackingBrowser({ layouts: Object.fromEntries(carriers.map((code) => [code, layout(code)])),
        privateScreenshotDir: root, launch: fake.launch, now: () => NOW, ...options });
    return { adapter, root };
}

test("canonical allowlist supports normalizer aliases without accepting caller URLs", () => {
    for (const [alias, code] of [["Canpar Express", "CANPAR"], ["ICS", "ICS_COURIER"],
        ["ICS Courier", "ICS_COURIER"], ["GLS Canada", "GLS"], ["Dicom", "GLS"]]) {
        const url = new URL(buildBrowserTrackingUrl(alias, NUMBER));
        assert.equal(url.origin, new URL(CARRIER_URLS[code]).origin);
        assert.equal(url.pathname, new URL(CARRIER_URLS[code]).pathname);
        assert.equal(url.searchParams.get("trackNums"), code === "ICS_COURIER" ? NUMBER : null);
    }
    for (const carrier of ["UPS", "https://attacker.invalid", "UNKNOWN"]) {
        assert.throws(() => buildBrowserTrackingUrl(carrier, NUMBER), { code: "unsupported_carrier" });
    }
    for (const number of ["", "A&B", "A\nB", "https://localhost", "A/B", "x".repeat(81), 123]) {
        assert.throws(() => buildBrowserTrackingUrl("Canpar", number), { code: "invalid_tracking_number" });
    }
});

test("timestamps require real calendar dates, time and reviewed timezone", () => {
    assert.equal(parseBrowserEventTimestamp(EVENT), "2026-09-16T18:30:00.000Z");
    assert.equal(parseBrowserEventTimestamp("2026-09-16T18:30:00.12Z"), "2026-09-16T18:30:00.120Z");
    assert.equal(parseBrowserEventTimestamp("2026-09-16 14:30:00", "ymd_hms", -240), "2026-09-16T18:30:00.000Z");
    assert.equal(parseBrowserEventTimestamp("2026-09-16 14:30:00", "ymd_hms"), null);
    for (const date of ["2026-09-16", "09/16/2026 14:30", "2026-02-30T12:00:00Z", "2026-00-16T12:00:00Z",
        "2026-09-16T24:00:00Z", "2026-09-16T12:60:00Z", "2026-09-16T12:00:60Z", "2026-09-16T14:30:00",
        "2026-09-16T12:00:00+14:30", "2026-09-16T12:00:00-05:99", "Estimated 2026-09-16T12:00:00Z"]) {
        assert.equal(parseBrowserEventTimestamp(date), null, date);
    }
});

for (const carrier of ["CANPAR", "ICS_COURIER", "GLS"]) {
    test(`${carrier} normalizes fixture statuses and confirmed delivery events only`, () => {
        for (const [raw, status] of [["InfoReceived", "LABEL_CREATED"], ["Picked up", "PICKED_UP"],
            ["InTransit", "IN_TRANSIT"], ["Out for delivery", "OUT_FOR_DELIVERY"],
            ["Delivery attempted", "DELIVERY_ATTEMPTED"], ["Exception", "EXCEPTION"],
            ["Returned", "RETURNED"], ["Cancelled", "CANCELLED"], ["Delivered", "DELIVERED"]]) {
            const result = normalizeBrowserTracking(carrier, snapshot(raw), { now: NOW });
            assert.equal(result.status, status);
            assert.equal(result.events[0].status, status);
            assert.equal(result.deliveredAt, status === "DELIVERED" ? "2026-09-16T18:30:00.000Z" : null);
            assert.equal(result.estimatedDelivery, null);
            assert.match(result.events[0].eventKey, /^[a-f0-9]{64}$/);
        }
        const mapped = normalizeBrowserTracking(carrier, snapshot("At test depot"),
            { now: NOW, statusMap: { "at test depot": "IN_TRANSIT" } });
        assert.equal(mapped.status, "IN_TRANSIT");
    });
    test(`${carrier} fake browser waits for DOM results, submits forms and closes isolated context`, async (t) => {
        const fake = fakeBrowser();
        const { adapter } = await setup(t, fake, [carrier]);
        const result = await adapter.poll(shipment(carrier));
        assert.equal(result.ok, true);
        assert.equal(result.status, "DELIVERED");
        assert.equal(fake.calls.urls[0].url, buildBrowserTrackingUrl(carrier, NUMBER));
        assert.equal(fake.calls.urls[0].options.waitUntil, "domcontentloaded");
        assert.equal(fake.calls.launches[0].chromiumSandbox, true);
        assert.deepEqual(fake.calls.contexts[0], { acceptDownloads: false, serviceWorkers: "block",
            permissions: [], ignoreHTTPSErrors: false, javaScriptEnabled: true });
        assert.deepEqual(fake.calls.fills, carrier === "ICS_COURIER" ? [] : [NUMBER]);
        assert.equal(fake.calls.waits.length, 2);
        assert.equal(fake.calls.contextClosed, 1);
        assert.equal(fake.calls.browserClosed, 1);
    });
}

test("summary delivery, predictions, ambiguous dates, future scans and contradictory events fail closed", () => {
    const invalid = [snapshot("Estimated delivered"), snapshot("Not delivered"), snapshot("Will be delivered"),
        snapshot("Delivered", []), snapshot("Delivered", [{ status: "InTransit", timestamp: EVENT }]),
        snapshot("InTransit", [{ status: "Delivered", timestamp: EVENT }]),
        snapshot("Delivered", [{ status: "Delivered", timestamp: "2026-09-16" }]),
        snapshot("Delivered", [{ status: "Delivered", timestamp: "2026-09-18T00:00:00Z" }]),
        snapshot("Delivered", [{ status: "Delivered", timestamp: EVENT, description: "Expected delivery" }]),
        snapshot("Delivered", [{ status: "Delivered", timestamp: EVENT, estimated: true }]),
        snapshot("Delivered", [{ status: "Delivered", timestamp: EVENT, rowText: "Estimated arrival" }]),
        snapshot("Delivered", [{ status: "Delivered", timestamp: "2026-09-16 14:30:00" }]),
        snapshot("Delivered", [{ status: "Delivered", timestamp: "2026-02-30T12:00:00Z" }]),
        snapshot("Unrecognized new layout")];
    for (const data of invalid) {
        assert.throws(() => normalizeBrowserTracking("CANPAR", data, { now: NOW }), { code: "layout_unverified" });
    }
    const data = snapshot("Delivered", [
        { status: "Delivered", timestamp: EVENT, confidential_customer_data: "discard" },
        { status: "InTransit", timestamp: SHIPPED }
    ]);
    const result = normalizeBrowserTracking("Canpar", data, { now: NOW });
    assert.equal(result.events[0].status, "IN_TRANSIT");
    assert.equal(result.deliveredAt, "2026-09-16T18:30:00.000Z");
    assert.equal(JSON.stringify(result).includes("confidential_customer_data"), false);
});

test("completed/manual-closed and >45-day shipments never launch or queue a poll", async (t) => {
    const fake = fakeBrowser();
    const { adapter } = await setup(t, fake);
    for (const extra of [{ completed: true }, { completedAt: NOW }, { completed_at: NOW }, { status: "COMPLETED" },
        { status: "Delivered" }, { status: "ManuallyClosed" },
        { status: "manualclosed" }, { delivered_at: NOW }, { manual_closed_at: NOW },
        { manualClosed: true }, { manually_closed: true }, { closed_at: NOW },
        { shippedAt: "2026-08-02T11:59:59Z" }, { shippedAt: undefined }, { shippedAt: "bad" },
        { shippedAt: "2026-09-18T00:00:00Z" }]) {
        assert.equal((await adapter.poll(shipment("CANPAR", extra))).skipped, true);
    }
    assert.equal(fake.calls.launches.length, 0);
    assert.equal(pollingSkipReason(shipment("CANPAR", { shippedAt: "2026-08-03T12:00:00Z" }), NOW), null);
    assert.equal(pollingSkipReason(shipment("CANPAR", { shippedAt: "2026-08-02T12:00:00Z" }), NOW), "age_limit");
});

test("returned/cancelled shipments remain active until manual closure or explicit completion", async (t) => {
    for (const carrier of Object.keys(CARRIER_URLS)) {
        for (const status of ["RETURNED", "CANCELLED"]) {
            const fake = fakeBrowser({ data: snapshot(status) });
            const { adapter } = await setup(t, fake, [carrier]);
            const active = shipment(carrier, { status });
            assert.equal(pollingSkipReason(active, NOW), null);
            const result = await adapter.poll(active);
            assert.equal(result.ok, true);
            assert.equal(result.status, status);
            active.manualClosed = true;
            assert.deepEqual(await adapter.poll(active), { ok: false, skipped: true, code: "manual_closed" });
            assert.equal(fake.calls.launches.length, 1);
            assert.equal(pollingSkipReason(shipment(carrier, { status, completed: true }), NOW), "completed");
            assert.equal(pollingSkipReason(shipment(carrier, { status, manual_closed_at: NOW }), NOW), "manual_closed");
        }
    }
});

test("30-day and 60-day tracking windows have strict inclusive age boundaries", async (t) => {
    const now = new Date(NOW).getTime();
    for (const trackingWindowDays of [1, 30, 45, 60, 180]) {
        const boundary = new Date(now - trackingWindowDays * 86400000).toISOString();
        const expired = new Date(now - trackingWindowDays * 86400000 - 1).toISOString();
        assert.equal(pollingSkipReason(shipment("CANPAR", { trackingWindowDays, shippedAt: boundary }), NOW), null);
        assert.equal(pollingSkipReason(shipment("CANPAR", { trackingWindowDays, shippedAt: expired }), NOW), "age_limit");
    }
    for (const [trackingWindowDays, ageDays, allowed] of [[30, 31, false], [60, 50, true], [60, 61, false]]) {
        const fake = fakeBrowser();
        const { adapter } = await setup(t, fake);
        const shippedAt = new Date(now - ageDays * 86400000).toISOString();
        const result = await adapter.poll(shipment("CANPAR", { trackingWindowDays, shippedAt }));
        assert.equal(result.ok, allowed);
        if (!allowed) assert.equal(result.code, "age_limit");
        assert.equal(fake.calls.launches.length, allowed ? 1 : 0);
    }
});

test("invalid tracking window overrides fail closed without coercion or fallback", async (t) => {
    const fake = fakeBrowser();
    const { adapter } = await setup(t, fake);
    for (const trackingWindowDays of [null, 0, -1, 181, 30.5, NaN, Infinity, "30", "", true, false, {}, []]) {
        const result = await adapter.poll(shipment("CANPAR", { trackingWindowDays }));
        assert.deepEqual(result, { ok: false, skipped: true, code: "invalid_tracking_window" });
    }
    assert.equal(fake.calls.launches.length, 0);
    const older = { shippedAt: "2026-08-02T12:00:00Z" };
    assert.equal(pollingSkipReason(shipment("CANPAR", older), NOW), "age_limit");
    assert.equal(pollingSkipReason(shipment("CANPAR", { ...older, trackingWindowDays: undefined }), NOW), "age_limit");
});

test("unverified or absent layouts are inactive, even with a launcher installed", async (t) => {
    const fake = fakeBrowser();
    const { adapter } = await setup(t, fake, [], { layouts: { CANPAR: { verified: false } } });
    for (const carrier of Object.keys(CARRIER_URLS)) {
        const result = await adapter.poll(shipment(carrier));
        assert.equal(result.code, "layout_unverified");
        assert.equal(result.ok, false);
        assert.equal(result.screenshot.captured, false);
    }
    assert.equal(fake.calls.launches.length, 0);
});

test("selector, verification, status-map and runtime limit configuration is validated", () => {
    const base = { privateScreenshotDir: path.join(os.tmpdir(), "wms-private-not-created") };
    const badLayouts = [
        { ...layout("CANPAR"), sourceUrl: "https://attacker.invalid" },
        { ...layout("CANPAR"), verifiedAt: "2026-09-17" },
        { ...layout("CANPAR"), layoutVersion: "" },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, results: "body" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, eventStatus: "xpath=//div" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, eventStatus: "text=Delivered" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, eventStatus: "//div" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, eventStatus: "custom=script" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, eventStatus: "[" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, eventStatus: "#results >" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, script: "window.eval" } },
        { ...layout("CANPAR"), selectors: { ...layout("CANPAR").selectors, submit: undefined } },
        { ...layout("CANPAR"), timestampFormat: "guess" },
        { ...layout("CANPAR"), timestampFormat: "ymd_hms" },
        { ...layout("CANPAR"), statusMap: { "Expected delivery": "DELIVERED" } },
        { ...layout("CANPAR"), statusMap: { "anything": "DELIVERED" } },
        { ...layout("CANPAR"), statusMap: { "anything": "CUSTOM_STATUS" } }
    ];
    for (const config of badLayouts) assert.throws(() => createCarrierTrackingBrowser({ ...base, layouts: { CANPAR: config } }),
        { code: "invalid_configuration" });
    for (const limits of [{ maxConcurrency: 3 }, { minIntervalMs: 0 }, { maxQueue: 100 }, { queueTimeoutMs: Infinity }]) {
        assert.throws(() => createCarrierTrackingBrowser({ ...base, limits: { CANPAR: limits } }), { code: "invalid_configuration" });
    }
    assert.throws(() => createCarrierTrackingBrowser({ ...base, layouts: { ICS: layout("ICS_COURIER") } }), { code: "invalid_configuration" });
    assert.throws(() => createCarrierTrackingBrowser({ privateScreenshotDir: __dirname }), { code: "invalid_configuration" });
    assert.throws(() => createCarrierTrackingBrowser({ privateScreenshotDir: "public/screenshots" }), { code: "invalid_configuration" });
    assert.throws(() => createCarrierTrackingBrowser({ ...base, launch: {} }), { code: "invalid_configuration" });
    assert.ok(new BrowserTrackingError("test") instanceof Error);
    const css = layout("CANPAR");
    css.selectors.input = 'form#tracking > input[name="trackingNumber"]';
    css.selectors.eventRows = "table.events tr:nth-child(2)";
    assert.doesNotThrow(() => createCarrierTrackingBrowser({ ...base, layouts: { CANPAR: css } }));
});

test("timeouts and changed/mismatched/ambiguous layouts capture private diagnostics, not page data", async (t) => {
    const timeout = Object.assign(new Error("secret page details"), { name: "TimeoutError" });
    for (const options of [{ waitError: timeout }, { number: "OTHER-TENANT-NUMBER" }, { resultCount: 2 },
        { fieldCount: 2 }, { data: snapshot("Unknown carrier layout") }, { redirectTo: "https://attacker.invalid/" }]) {
        const fake = fakeBrowser(options);
        const { adapter, root } = await setup(t, fake);
        const result = await adapter.poll(shipment());
        assert.equal(result.ok, false);
        assert.equal(result.code, options.waitError ? "timeout" : "layout_unverified");
        assert.equal(result.screenshot.captured, true);
        assert.equal(result.screenshot.internalOnly, true);
        assert.equal(path.isAbsolute(result.screenshot.privatePath), true);
        assert.equal(path.relative(root, result.screenshot.privatePath).startsWith(".."), false);
        assert.equal(await fs.readFile(result.screenshot.privatePath, "utf8"), "fake-private-png");
        assert.equal(result.screenshot.privatePath.includes(NUMBER), false);
        assert.equal(JSON.stringify(result).includes("secret page details"), false);
        assert.equal(Object.hasOwn(result, "status"), false);
        assert.equal(fake.calls.contextClosed, 1);
        assert.equal(fake.calls.browserClosed, 1);
    }
});

test("screenshot failures stay fail-closed and still release browser resources", async (t) => {
    const fake = fakeBrowser({ resultCount: 0, screenshotError: new Error("private filesystem details") });
    const { adapter } = await setup(t, fake);
    const result = await adapter.poll(shipment());
    assert.equal(result.code, "layout_unverified");
    assert.equal(result.screenshot.code, "screenshot_unavailable");
    assert.equal(JSON.stringify(result).includes("private filesystem details"), false);
    assert.equal(fake.calls.browserClosed, 1);
});

test("estimated DOM fields cannot prove delivery even without a description selector", async (t) => {
    const fake = fakeBrowser({ data: snapshot("Delivered", [{ status: "Delivered", timestamp: EVENT,
        rowText: "Delivered - Expected arrival 2026-09-16" }]) });
    const config = layout("CANPAR");
    delete config.selectors.eventDescription;
    const { adapter } = await setup(t, fake, ["CANPAR"], { layouts: { CANPAR: config } });
    const result = await adapter.poll(shipment());
    assert.equal(result.code, "layout_unverified");
    assert.equal(result.screenshot.captured, true);
});

test("missing Chromium/injected launch failure is an explicit unavailable error without fallback HTTP", async (t) => {
    const fake = fakeBrowser({ launchError: new Error("Executable does not exist: secret installation path") });
    const { adapter } = await setup(t, fake);
    const result = await adapter.poll(shipment());
    assert.deepEqual(result, { ok: false, code: "chromium_unavailable" });
    assert.equal(fake.calls.contexts.length, 0);
});

test("routing blocks off-host/credentialed URLs, redirects, sends, downloads and sockets", async (t) => {
    const fake = fakeBrowser();
    const { adapter } = await setup(t, fake);
    await adapter.poll(shipment());
    const handler = fake.calls.routes[0].handler;
    async function request(url, method = "GET", navigation = false, status = 200) {
        const calls = [];
        await handler({ request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => navigation }),
            async abort() { calls.push("abort"); },
            async fetch(options) { calls.push(options); return { status: () => status }; },
            async fulfill() { calls.push("fulfill"); } });
        return calls;
    }
    for (const url of ["http://portal.canpar.com/en/track/tracking.jsp", "https://portal.canpar.com.attacker.invalid/",
        "https://localhost/", "https://127.0.0.1/", "file:///etc/passwd", "https://user:pass@portal.canpar.com/x"]) {
        assert.deepEqual(await request(url), ["abort"]);
    }
    assert.deepEqual(await request("https://portal.canpar.com/purchase", "POST"), ["abort"]);
    assert.deepEqual(await request("https://portal.canpar.com/purchase", "GET", true), ["abort"]);
    assert.deepEqual(await request(`${CARRIER_URLS.CANPAR}?other=1`, "GET", true), ["abort"]);
    assert.deepEqual(await request(CARRIER_URLS.CANPAR, "DELETE", true), ["abort"]);
    assert.equal((await request(CARRIER_URLS.CANPAR, "GET", true)).at(-1), "fulfill");
    assert.equal((await request(CARRIER_URLS.CANPAR, "POST", true)).at(-1), "fulfill");
    assert.equal((await request("https://portal.canpar.com/assets/app.js")).at(-1), "fulfill");
    const redirected = await request(CARRIER_URLS.CANPAR, "GET", true, 302);
    assert.equal(redirected.at(-1), "abort");
    assert.equal(redirected[0].maxRedirects, 0);
    let socketClosed = false;
    fake.calls.websocket.handler({ close() { socketClosed = true; } });
    assert.equal(socketClosed, true);
});

test("carrier semaphore/queue bounds are independent and waiting closures are rechecked", async (t) => {
    let resume;
    const pause = new Promise((resolve) => { resume = resolve; });
    const fake = fakeBrowser({ pause });
    const { adapter } = await setup(t, fake, ["CANPAR", "GLS"], { timeoutMs: 5000,
        limits: { CANPAR: { maxQueue: 1, minIntervalMs: 1000 }, GLS: { minIntervalMs: 1000 } } });
    const first = adapter.poll(shipment());
    while (!fake.calls.waits.length) await sleep(5);
    const mutable = shipment();
    const waiting = adapter.poll(mutable);
    const busy = await adapter.poll(shipment());
    assert.equal(busy.code, "carrier_busy");
    const other = adapter.poll(shipment("GLS"));
    while (fake.calls.launches.length < 2) await sleep(5);
    assert.equal(fake.calls.launches.length, 2);
    mutable.manualClosed = true;
    resume();
    assert.equal((await first).ok, true);
    assert.equal((await other).ok, true);
    assert.equal((await waiting).code, "manual_closed");
    assert.equal(fake.calls.launches.length, 2);
});

test("per-carrier start rate is bounded even when concurrency is two", async (t) => {
    const fake = fakeBrowser();
    const { adapter } = await setup(t, fake, ["CANPAR"], {
        limits: { CANPAR: { maxConcurrency: 2, minIntervalMs: 1000 } } });
    const first = adapter.poll(shipment());
    const second = adapter.poll(shipment());
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.ok(fake.calls.starts[1] - fake.calls.starts[0] >= 990);
    assert.equal(fake.calls.contexts.length, 2);
});

test("queue timeout does not launch another browser", async (t) => {
    let resume;
    const fake = fakeBrowser({ pause: new Promise((resolve) => { resume = resolve; }) });
    const { adapter } = await setup(t, fake, ["CANPAR"], { limits: { CANPAR: { queueTimeoutMs: 100 } } });
    const first = adapter.poll(shipment());
    while (!fake.calls.waits.length) await sleep(5);
    const second = await adapter.poll(shipment());
    assert.equal(second.code, "carrier_busy");
    resume();
    await first;
    assert.equal(fake.calls.launches.length, 1);
});

test("overall DOM timeout is bounded and closes the browser on every failure", async (t) => {
    let resume;
    const fake = fakeBrowser({ pause: new Promise((resolve) => { resume = resolve; }) });
    const { adapter } = await setup(t, fake, ["CANPAR"], { timeoutMs: 100 });
    const result = await adapter.poll(shipment());
    assert.equal(result.code, "timeout");
    assert.equal(result.screenshot.captured, true);
    assert.equal(fake.calls.contextClosed, 1);
    assert.equal(fake.calls.browserClosed, 1);
    resume();
});

test("a Chromium launch that completes after the deadline is closed without opening a context", async (t) => {
    let resume;
    const late = new Promise((resolve) => { resume = resolve; });
    const fake = fakeBrowser();
    const { adapter } = await setup(t, fake, ["CANPAR"], { timeoutMs: 100,
        async launch() { await late; return fake.browser; } });
    const result = await adapter.poll(shipment());
    assert.equal(result.code, "timeout");
    resume();
    await sleep(10);
    assert.equal(fake.calls.browserClosed, 1);
    assert.equal(fake.calls.contexts.length, 0);
});

test("future verification metadata and unsupported carriers do not launch", async (t) => {
    const fake = fakeBrowser();
    const config = { ...layout("CANPAR"), verifiedAt: "2026-09-18T10:00:00Z" };
    const { adapter } = await setup(t, fake, ["CANPAR"], { layouts: { CANPAR: config } });
    assert.equal((await adapter.poll(shipment())).code, "layout_unverified");
    assert.equal((await adapter.poll(shipment("UPS"))).code, "unsupported_carrier");
    assert.equal((await adapter.poll(shipment("CANPAR", { trackingNumber: "X\nY" }))).code, "invalid_tracking_number");
    assert.equal(fake.calls.launches.length, 0);
});
