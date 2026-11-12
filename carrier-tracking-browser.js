"use strict";

/**
 * Opt-in adapter only; no scheduler, persistence, messages, or server registration.
 * Deployment requires a dedicated, unprivileged browser worker, Playwright (or an
 * injected Chromium launcher), `npx playwright install --with-deps chromium`, and
 * an egress firewall allowing only reviewed carrier endpoints. Never disable the
 * Chromium sandbox. Limits are per adapter/process: use one worker or coordinate
 * limits externally. Caller must enforce company/warehouse ownership before poll.
 *
 * Public entry URLs reviewed 2026-09-17 (below). Result selectors are NOT verified
 * or bundled. Enable a carrier only after independently reviewing its actual DOM,
 * read-only form action/network paths, timestamp format/timezone and exact status
 * labels; supply verification metadata and scoped CSS selectors. Do not use page
 * text, estimated arrival dates, or arbitrary script evaluation as a fallback.
 *
 * privateScreenshotDir must be outside this repository, owner-only (Windows ACLs
 * must be provisioned by the worker operator), never web-served or synchronized.
 * Screenshots can contain personal data. Metadata is internal-only: do not return
 * it to portals or log it publicly. Operator must enforce retention/deletion.
 *
 * API: createCarrierTrackingBrowser({ launch?, privateScreenshotDir, layouts,
 * limits?, timeoutMs? }).poll({ carrier, trackingNumber, status, shippedAt,
 * completed?, manualClosed?, trackingWindowDays? }). trackingWindowDays defaults
 * to 45 only when omitted; overrides must be integer numbers from 1 through 180.
 * Invalid overrides skip polling. RETURNED/CANCELLED alone do not close polling;
 * delivery or explicit completion/manual closure does. The age limit still applies.
 * shippedAt/verifiedAt are ISO timestamps with
 * explicit offsets. Layout keys are CANPAR/ICS_COURIER/GLS. Each layout requires
 * verified: true, sourceUrl, verifiedAt, layoutVersion, timestampFormat and
 * selectors: results, trackingNumber, status, eventRows, eventStatus,
 * eventTimestamp; input+submit are paired for forms. Optional eventDescription,
 * eventLocation and exact statusMap aliases never supply delivery proof.
 * Selectors support CSS tags, IDs, classes, attributes, combinators and simple
 * structural pseudo-classes only; advanced/custom Playwright engines are refused.
 * Local ymd_hms timestamps require reviewed utcOffsetMinutes; update/reverify
 * at DST changes (prefer offset-bearing ISO). Failures return { ok:false, code }
 * with optional internal screenshot metadata; no failure contains parsed status.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeTrackingCarrier, normalizeTrackingStatus, sanitizeTrackingEvent } = require("./carrier-tracking");

const CARRIER_URLS = Object.freeze({
    CANPAR: "https://portal.canpar.com/en/track/tracking.jsp",
    ICS_COURIER: "https://www.icscourier.ca/online-services/parcel-tracking.aspx",
    GLS: "https://ship.gls-canada.com/tracking/"
});
const DAY = 86400000;
const DELIVERY_LABELS = new Set(["delivered", "shipment delivered", "delivered to consignee"]);
const PREDICTION = /\b(estimated|expected|scheduled|anticipated|eta|will|not|undelivered)\b/i;

class BrowserTrackingError extends Error {
    constructor(code) { super(code); this.name = "BrowserTrackingError"; this.code = code; }
}
function fail(code) { throw new BrowserTrackingError(code); }
function text(value) { return String(value ?? "").trim().replace(/\s+/g, " "); }
function trackingNumber(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(value)) fail("invalid_tracking_number");
    return value;
}
function carrierCode(value) {
    const carrier = normalizeTrackingCarrier(value);
    if (!Object.hasOwn(CARRIER_URLS, carrier)) fail("unsupported_carrier");
    return carrier;
}
function buildBrowserTrackingUrl(carrier, number) {
    const code = carrierCode(carrier);
    const url = new URL(CARRIER_URLS[code]);
    trackingNumber(number);
    if (code === "ICS_COURIER") url.searchParams.set("trackNums", number);
    return url.href;
}

// No Date.parse locale guessing or date-only/midnight substitution. Local DOM
// timestamps require an explicitly reviewed fixed offset for that layout.
function parseBrowserEventTimestamp(value, format = "iso_offset", utcOffsetMinutes) {
    const input = text(value);
    const match = format === "iso_offset"
        ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input)
        : format === "ymd_hms" ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(input) : null;
    if (!match) return null;
    const [, y, m, d, h, min, s, fraction, zone] = match;
    const parts = [y, m, d, h, min, s].map(Number);
    if (parts[0] < 2000 || parts[0] > 2100 || parts[1] < 1 || parts[1] > 12 ||
        parts[2] < 1 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;
    const milliseconds = Number((fraction || "").padEnd(3, "0"));
    const wall = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], milliseconds));
    if (wall.getUTCFullYear() !== parts[0] || wall.getUTCMonth() + 1 !== parts[1] || wall.getUTCDate() !== parts[2]) return null;
    let offset = utcOffsetMinutes;
    if (format === "iso_offset") {
        if (zone === "Z") offset = 0;
        else {
            const hours = Number(zone.slice(1, 3));
            const minutes = Number(zone.slice(4));
            if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
            offset = (hours * 60 + minutes) * (zone[0] === "+" ? 1 : -1);
        }
    }
    if (!Number.isInteger(offset) || Math.abs(offset) > 840) return null;
    return new Date(wall.getTime() - offset * 60000).toISOString();
}
function strictStatus(value, statusMap = {}) {
    const label = text(value).toLowerCase();
    if (PREDICTION.test(label)) return "UNKNOWN";
    if (DELIVERY_LABELS.has(label)) return "DELIVERED";
    const status = Object.hasOwn(statusMap, label) ? statusMap[label] : normalizeTrackingStatus(value);
    return status === "DELIVERED" ? "UNKNOWN" : status;
}
function normalizeBrowserTracking(carrier, snapshot, options = {}) {
    const code = carrierCode(carrier);
    const now = new Date(options.now ?? Date.now()).getTime();
    if (!Number.isFinite(now) || !Array.isArray(snapshot?.events) || snapshot.events.length > 200) fail("layout_unverified");
    const events = snapshot.events.map((row) => {
        const status = strictStatus(row.status, options.statusMap);
        const eventAt = parseBrowserEventTimestamp(row.timestamp, options.timestampFormat, options.utcOffsetMinutes);
        if (status === "UNKNOWN" || !eventAt || new Date(eventAt).getTime() > now ||
            PREDICTION.test(text(row.description)) || PREDICTION.test(text(row.rowText)) ||
            row.estimated === true) fail("layout_unverified");
        return sanitizeTrackingEvent({ status, eventAt, description: text(row.description),
            location: text(row.location), rawStatusCode: text(row.status), source: `${code}_BROWSER` });
    }).sort((a, b) => a.eventAt.localeCompare(b.eventAt));
    const latest = events.at(-1);
    const reported = strictStatus(snapshot.status, options.statusMap);
    if (!latest || reported === "UNKNOWN") fail("layout_unverified");
    // Summary delivery alone is never proof, and conflicting current state fails
    // closed rather than closing a tracker on an earlier delivery scan.
    if ((reported === "DELIVERED") !== (latest.status === "DELIVERED")) fail("layout_unverified");
    return { carrier: code, status: reported, statusDetail: text(snapshot.status).slice(0, 600),
        deliveredAt: reported === "DELIVERED" ? latest.eventAt : null,
        estimatedDelivery: null, events };
}
function pollingSkipReason(shipment, now = Date.now()) {
    const status = text(shipment?.status).replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase().replace(/[\s-]+/g, "_");
    if (shipment?.completed || shipment?.completedAt || shipment?.completed_at ||
        shipment?.deliveredAt || shipment?.delivered_at ||
        ["COMPLETED", "COMPLETE", "DONE", "CLOSED", "MANUAL_CLOSED", "MANUALLY_CLOSED", "MANUALCLOSED", "MANUALLYCLOSED"].includes(status) ||
        normalizeTrackingStatus(status) === "DELIVERED") return "completed";
    if (shipment?.manualClosed || shipment?.manuallyClosed || shipment?.manual_closed ||
        shipment?.manually_closed || shipment?.manualClosedAt || shipment?.manual_closed_at ||
        shipment?.closedAt || shipment?.closed_at) return "manual_closed";
    const windowDays = shipment?.trackingWindowDays === undefined ? 45 : shipment.trackingWindowDays;
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 180) return "invalid_tracking_window";
    const date = shipment?.shippedAt ?? shipment?.shipped_at;
    const shipped = parseBrowserEventTimestamp(date);
    const time = new Date(now).getTime();
    if (!shipped || !Number.isFinite(time) || new Date(shipped).getTime() > time) return "invalid_shipment_age";
    return time - new Date(shipped).getTime() > windowDays * DAY ? "age_limit" : null;
}
function integer(value, fallback, min, max) {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max) fail("invalid_configuration");
    return result;
}
function validCssSelector(selector) {
    const identifier = "[A-Za-z_][A-Za-z0-9_-]*";
    const attribute = `\\[${identifier}(?:\\s*[~|^$*]?=\\s*(?:\"[^\"\\\\]{1,120}\"|'[^'\\\\]{1,120}'|${identifier})\\s*)?\\]`;
    const structural = ":(?:first-child|last-child|first-of-type|last-of-type|nth-child\\([1-9][0-9]{0,2}\\))";
    const qualifier = `(?:[#.]${identifier}|${attribute}|${structural})`;
    const compound = `(?:${identifier}${qualifier}*|${qualifier}+)`;
    const chain = `${compound}(?:(?:\\s+|\\s*[>+~]\\s*)${compound})*`;
    return new RegExp(`^${chain}(?:\\s*,\\s*${chain})*$`).test(selector);
}
function validateLayout(carrier, config) {
    if (!config || config.verified !== true) return null;
    if (config.sourceUrl !== CARRIER_URLS[carrier] || !parseBrowserEventTimestamp(config.verifiedAt) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(config.layoutVersion || "")) fail("invalid_configuration");
    const required = ["results", "trackingNumber", "status", "eventRows", "eventStatus", "eventTimestamp"];
    const optional = ["eventDescription", "eventLocation", "input", "submit"];
    const selectors = {};
    if (!config.selectors || Object.keys(config.selectors).some((key) => ![...required, ...optional].includes(key))) fail("invalid_configuration");
    for (const key of [...required, ...optional]) {
        const selector = config.selectors[key];
        if (selector === undefined && optional.includes(key)) continue;
        // CSS only. Reject Playwright script/engine selectors and broad page reads.
        if (typeof selector !== "string" || !selector.trim() || selector.length > 240 ||
            /[\x00-\x1f]|>>|:has-text|:text/i.test(selector) ||
            /^(?:[A-Za-z_][A-Za-z0-9_-]*=|\/|\.\.)/.test(selector.trim()) ||
            !validCssSelector(selector.trim()) ||
            /^(?:\*|html|body|:root)$/i.test(selector.trim())) fail("invalid_configuration");
        selectors[key] = selector.trim();
    }
    if (Boolean(selectors.input) !== Boolean(selectors.submit) ||
        !["iso_offset", "ymd_hms"].includes(config.timestampFormat)) fail("invalid_configuration");
    if (config.timestampFormat === "ymd_hms" &&
        (!Number.isInteger(config.utcOffsetMinutes) || Math.abs(config.utcOffsetMinutes) > 840)) fail("invalid_configuration");
    const statusMap = {};
    if (config.statusMap !== undefined && (!config.statusMap || typeof config.statusMap !== "object" ||
        Array.isArray(config.statusMap) || Object.keys(config.statusMap).length > 64)) fail("invalid_configuration");
    for (const [label, status] of Object.entries(config.statusMap || {})) {
        if (!label.trim() || label.length > 120 || normalizeTrackingStatus(status) !== status ||
            status === "UNKNOWN" || status === "DELIVERED" || PREDICTION.test(label)) fail("invalid_configuration");
        statusMap[text(label).toLowerCase()] = status;
    }
    return { ...config, selectors: Object.freeze(selectors), statusMap: Object.freeze(statusMap) };
}

class CarrierGate {
    constructor(limits) { Object.assign(this, limits); this.active = 0; this.queue = []; this.nextStart = 0; }
    acquire() {
        if (this.queue.length >= this.maxQueue) return Promise.reject(new BrowserTrackingError("carrier_busy"));
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject };
            entry.timer = setTimeout(() => {
                this.queue = this.queue.filter((item) => item !== entry);
                reject(new BrowserTrackingError("carrier_busy"));
                this.drain();
            }, this.queueTimeoutMs);
            this.queue.push(entry);
            this.drain();
        });
    }
    drain() {
        clearTimeout(this.timer);
        if (!this.queue.length || this.active >= this.maxConcurrency) return;
        const delay = this.nextStart - Date.now();
        if (delay > 0) { this.timer = setTimeout(() => this.drain(), delay); return; }
        const entry = this.queue.shift();
        clearTimeout(entry.timer);
        this.active++;
        this.nextStart = Date.now() + this.minIntervalMs;
        let released = false;
        entry.resolve(() => {
            if (!released) { released = true; this.active--; this.drain(); }
        });
        this.drain();
    }
}
async function defaultLaunch(options) {
    let chromium;
    try { chromium = require("playwright").chromium; }
    catch {
        try { chromium = require("playwright-core").chromium; }
        catch { fail("chromium_unavailable"); }
    }
    try { return await chromium.launch(options); }
    catch { fail("chromium_unavailable"); }
}
function createCarrierTrackingBrowser({ layouts = {}, limits = {}, launch = defaultLaunch,
    privateScreenshotDir, timeoutMs = 20000, now = () => Date.now() } = {}) {
    if (typeof launch !== "function" || typeof now !== "function" || typeof privateScreenshotDir !== "string" ||
        !path.isAbsolute(privateScreenshotDir)) fail("invalid_configuration");
    const root = path.resolve(privateScreenshotDir);
    const relative = path.relative(__dirname, root);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) fail("invalid_configuration");
    const timeout = integer(timeoutMs, 20000, 100, 60000);
    const configs = new Map();
    const gates = new Map();
    for (const key of [...Object.keys(layouts), ...Object.keys(limits)]) {
        if (carrierCode(key) !== key) fail("invalid_configuration");
    }
    for (const carrier of Object.keys(CARRIER_URLS)) {
        configs.set(carrier, validateLayout(carrier, layouts[carrier]));
        const bound = limits[carrier] || {};
        gates.set(carrier, new CarrierGate({ maxConcurrency: integer(bound.maxConcurrency, 1, 1, 2),
            maxQueue: integer(bound.maxQueue, 8, 1, 32), minIntervalMs: integer(bound.minIntervalMs, 5000, 1000, 60000),
            queueTimeoutMs: integer(bound.queueTimeoutMs, 30000, 100, 60000) }));
    }
    async function diagnostic(page, carrier, code, layoutVersion) {
        if (!page) return { captured: false, code: "screenshot_unavailable", internalOnly: true };
        try {
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            if (path.resolve(await fs.realpath(root)) !== root) fail("unsafe_screenshot_path");
            const dir = await fs.mkdtemp(path.join(root, "tracking-"));
            await fs.chmod(dir, 0o700);
            const filename = path.join(dir, "layout.png");
            const file = await fs.open(filename, "wx", 0o600);
            await file.close();
            await page.screenshot({ path: filename, fullPage: false, timeout: 2000 });
            return { captured: true, privatePath: filename, carrier, code, layoutVersion,
                capturedAt: new Date(now()).toISOString(), internalOnly: true };
        } catch { return { captured: false, code: "screenshot_unavailable", internalOnly: true }; }
    }
    async function poll(shipment) {
        let release;
        let browser;
        let context;
        let page;
        let expired = false;
        let timer;
        let carrier;
        let config;
        const check = () => { if (expired) fail("timeout"); };
        try {
            const skip = pollingSkipReason(shipment, now());
            if (skip) return { ok: false, skipped: true, code: skip };
            carrier = carrierCode(shipment.carrier);
            const number = trackingNumber(shipment.trackingNumber ?? shipment.tracking_number);
            config = configs.get(carrier);
            if (!config || new Date(config.verifiedAt).getTime() > new Date(now()).getTime()) fail("layout_unverified");
            const url = buildBrowserTrackingUrl(carrier, number);
            release = await gates.get(carrier).acquire();
            // Recheck after queueing: callers may close a tracker while it waits.
            const queuedSkip = pollingSkipReason(shipment, now());
            if (queuedSkip) return { ok: false, skipped: true, code: queuedSkip };
            const work = async () => {
                try { browser = await launch({ headless: true, chromiumSandbox: true, timeout }); }
                catch { fail("chromium_unavailable"); }
                if (expired) { await browser.close(); check(); }
                context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block",
                    permissions: [], ignoreHTTPSErrors: false, javaScriptEnabled: true });
                if (expired) { await context.close(); check(); }
                const canonical = new URL(url);
                await context.route("**/*", async (route) => {
                    const request = route.request();
                    let target;
                    try { target = new URL(request.url()); } catch { return route.abort(); }
                    const navigation = request.isNavigationRequest();
                    const safeOrigin = target.protocol === "https:" && target.origin === canonical.origin &&
                        !target.username && !target.password;
                    const safeNavigation = target.href === canonical.href;
                    // Only the canonical read-only tracking form may POST.
                    const method = request.method();
                    const safeMethod = method === "GET" || (method === "POST" && navigation && safeNavigation && config.selectors.input);
                    if (!safeOrigin || !safeMethod || (navigation && !safeNavigation)) return route.abort();
                    // Playwright route.continue can follow redirects without a
                    // second route callback. Fetch once and forbid all redirects.
                    const response = await route.fetch({ maxRedirects: 0, timeout });
                    if (response.status() >= 300 && response.status() < 400) return route.abort();
                    return route.fulfill({ response });
                });
                if (typeof context.routeWebSocket !== "function") fail("chromium_unavailable");
                await context.routeWebSocket("**/*", (socket) => socket.close());
                context.on("page", (extra) => { if (page && extra !== page) void extra.close().catch(() => {}); });
                check();
                page = await context.newPage();
                page.setDefaultTimeout(timeout);
                page.setDefaultNavigationTimeout(timeout);
                page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
                await page.goto(url, { waitUntil: "domcontentloaded", timeout });
                check();
                const s = config.selectors;
                if (s.input) {
                    const input = page.locator(s.input);
                    if (await input.count() !== 1 || await page.locator(s.submit).count() !== 1) fail("layout_unverified");
                    await input.fill(number);
                    check();
                    await page.locator(s.submit).click();
                }
                await page.locator(s.results).waitFor({ state: "visible", timeout });
                await page.locator(s.results).locator(s.eventRows).first().waitFor({ state: "visible", timeout });
                check();
                if (page.url() !== url) fail("layout_unverified");
                const results = page.locator(s.results);
                async function read(scope, selector, optional = false) {
                    check();
                    if (!selector && optional) return "";
                    const node = scope.locator(selector);
                    if (await node.count() !== 1) fail("layout_unverified");
                    return text(await node.innerText({ timeout })).slice(0, 600);
                }
                if (await results.count() !== 1 || await read(results, s.trackingNumber) !== number) fail("layout_unverified");
                const status = await read(results, s.status);
                const rows = results.locator(s.eventRows);
                const count = await rows.count();
                if (count < 1 || count > 200) fail("layout_unverified");
                const events = [];
                for (let index = 0; index < count; index++) {
                    const row = rows.nth(index);
                    events.push({ status: await read(row, s.eventStatus), timestamp: await read(row, s.eventTimestamp),
                        description: await read(row, s.eventDescription, true), location: await read(row, s.eventLocation, true),
                        rowText: text(await row.innerText({ timeout })).slice(0, 2000) });
                }
                check();
                return { ok: true, ...normalizeBrowserTracking(carrier, { status, events }, { ...config, now: now() }) };
            };
            return await Promise.race([work(), new Promise((_, reject) => {
                timer = setTimeout(() => { expired = true; reject(new BrowserTrackingError("timeout")); }, timeout);
            })]);
        } catch (error) {
            const code = error instanceof BrowserTrackingError ? error.code
                : error?.name === "TimeoutError" ? "timeout" : "layout_unverified";
            const screenshot = ["timeout", "layout_unverified"].includes(code)
                ? await diagnostic(page, carrier, code, config?.layoutVersion) : undefined;
            return { ok: false, code, ...(screenshot ? { screenshot } : {}) };
        } finally {
            clearTimeout(timer);
            expired = true;
            if (context) await context.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
            if (release) release();
        }
    }
    return Object.freeze({ poll });
}

module.exports = { BrowserTrackingError, CARRIER_URLS, buildBrowserTrackingUrl,
    createCarrierTrackingBrowser, normalizeBrowserTracking, parseBrowserEventTimestamp, pollingSkipReason };
