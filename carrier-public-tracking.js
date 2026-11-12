"use strict";

/**
 * Standalone, opt-in public reader. No persistence, scheduler, Shopify, or writes.
 * Caller must authorize company/warehouse ownership before supplying a number.
 * URLs/selectors reviewed in the read-only audit on 2026-09-17. Unrecognized
 * labels/layouts require review, never fuzzy delivery classification.
 * Limits apply to one reader/process; use a single worker or an external gate.
 * diagnosticDir is optional, must already exist outside this repo, and MUST be
 * owner-only, not web-served/synchronized (operator-provisioned Windows ACLs).
 * Error screenshots may contain PII; the operator owns private retention.
 * API: createPublicCarrierTracking({launch?, diagnosticDir?, now?,
 * minIntervalMs?, timeoutMs?}).poll({carrier, trackingNumber},
 * {unverifiedTimeMode?: "HOLD" | "OBSERVED"}). Input status/URLs are ignored.
 * now is an injected function returning a Date, epoch milliseconds or ISO time.
 * Local HOLD: {ok:false, code:"TIMEZONE_REQUIRED", proof:{carrier,status,
 * carrierLocalTimestamp,timezoneVerified:false,source:"PUBLIC_CARRIER"}}.
 * Success: {ok:true,carrier,status,eventAt,carrierLocalTimestamp,timeBasis,
 * timezoneVerified,statusDetail,deliveredAt,estimatedDelivery:null,events}.
 * GLS also returns pieceCount and pieces:[{status,eventAt}]. Events contain
 * status,eventAt,carrierLocalTimestamp,timeBasis,description,source.
 * timeBasis is CARRIER_OFFSET_TIMESTAMP or OBSERVED_CONFIRMED_STATUS.
 * OBSERVED always has deliveredAt:null, even if confirmed status is DELIVERED.
 * Generic failures: {ok:false,code,diagnosticCaptured?}; no provider text.
 * Run in an unprivileged worker with a carrier-only egress firewall as defense
 * in depth. An external supervisor must terminate an unresponsive browser.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeTrackingCarrier, trackingStatusLabel } = require("./carrier-tracking");

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ROWS = 500;
const MAX_PIECES = 100;
const MAX_SET_ENTRIES = 1000;
const CANPAR_API = "https://canship.canpar.com/api/CanparAddons/trackByBarcodeV2";
const REVIVERS = Object.freeze(Object.assign(Object.create(null), {
    Ref: (value) => value, ShallowRef: (value) => value,
    Reactive: (value) => value, ShallowReactive: (value) => value
}));
const LABELS = Object.freeze({
    CANPAR: Object.freeze({
        "Our Package was Delivered": "DELIVERED",
        "Our Package was Picked Up": "PICKED_UP",
        "Picked Up": "PICKED_UP", "In Transit": "IN_TRANSIT",
        "Out for Delivery": "OUT_FOR_DELIVERY",
        "Delivery Attempted": "DELIVERY_ATTEMPTED", "Exception": "EXCEPTION",
        "Returned": "EXCEPTION", "Returned to Sender": "EXCEPTION"
    }),
    ICS_COURIER: Object.freeze({
        "Picked up": "PICKED_UP", "In Transit": "IN_TRANSIT",
        "Out for Delivery": "OUT_FOR_DELIVERY", "Delivery Attempted": "DELIVERY_ATTEMPTED",
        "Exception": "EXCEPTION", "Returned": "EXCEPTION", "Returned to Sender": "EXCEPTION",
        "In Sort Process": "IN_TRANSIT", "Undeliverable": "EXCEPTION", "Return: Undeliverable": "EXCEPTION",
        "Damaged Item\nPlease contact Customer Service\nat 1-888-427-8729": "EXCEPTION",
        "Delivery Attempt: Consignee Not Available": "DELIVERY_ATTEMPTED"
    }),
    GLS: Object.freeze({
        Delivered: "DELIVERED", "On Delivery": "OUT_FOR_DELIVERY",
        "In Transit": "IN_TRANSIT", Pickup: "PICKED_UP",
        Exception: "EXCEPTION", "Delivery Attempted": "DELIVERY_ATTEMPTED",
        Returned: "EXCEPTION", "Returned to Sender": "EXCEPTION",
        "Shipment Created": "LABEL_CREATED", "Service Alert": "EXCEPTION"
    })
});

class PublicTrackingError extends Error {
    constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new PublicTrackingError(code); }
function carrierCode(value) {
    const code = normalizeTrackingCarrier(value);
    if (!Object.hasOwn(LABELS, code)) fail("UNSUPPORTED_CARRIER");
    return code;
}
function numberValue(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(value)) fail("INVALID_TRACKING_NUMBER");
    return value;
}
function buildPublicTrackingUrl(carrier, trackingNumber) {
    const code = carrierCode(carrier);
    const number = encodeURIComponent(numberValue(trackingNumber));
    if (code === "GLS") return `https://ship.gls-canada.com/tracking/${number}`;
    if (code === "CANPAR") return `https://www.canpar.com/en/tracking/track.htm?barcode=${number}`;
    return `https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=${number}`;
}
function modeValue(value) {
    if (value !== undefined && value !== "HOLD" && value !== "OBSERVED") fail("INVALID_TIME_MODE");
    return value || "HOLD";
}

// Calendar validation precedes Date construction: rollover is never scan proof.
function calendar(y, m, d, h, minute, second, ms = 0) {
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || h > 23 ||
        h < 0 || minute > 59 || minute < 0 || second > 59 || second < 0) return null;
    const date = new Date(Date.UTC(y, m - 1, d, h, minute, second, ms));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return null;
    return date.getTime();
}
function parseOffsetTimestamp(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return null;
    const wall = calendar(...match.slice(1, 7).map(Number), Number((match[7] || "").padEnd(3, "0")));
    if (wall === null) return null;
    const zone = match[8];
    let offset = 0;
    if (zone !== "Z") {
        const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4));
        if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0) || zone === "-00:00") return null;
        offset = (hours * 60 + minutes) * (zone[0] === "+" ? 1 : -1);
    }
    return { eventAt: new Date(wall - offset * 60000).toISOString(),
        local: `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` };
}
function localTimestamp(value) {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    return match && calendar(...match.slice(1).map(Number)) !== null ? value : null;
}
function glsLocal(date, time) {
    const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date || "");
    const t = /^(\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/.exec(time || "");
    if (!d || !t || Number(t[1]) < 1 || Number(t[1]) > 12) return null;
    const hour = Number(t[1]) % 12 + (t[4] === "PM" ? 12 : 0);
    const parts = [Number(d[3]), Number(d[1]), Number(d[2]), hour, Number(t[2]), Number(t[3])];
    if (calendar(...parts) === null) return null;
    return `${d[3]}-${d[1].padStart(2, "0")}-${d[2].padStart(2, "0")} ${String(hour).padStart(2, "0")}:${t[2]}:${t[3]}`;
}
function mappedStatus(carrier, label) {
    if (typeof label !== "string" || label.length > 2000) fail("LAYOUT_REVIEW_REQUIRED");
    if (carrier === "ICS_COURIER") {
        if (/\b(?:estimated|expected|eta|undelivered|not delivered|will be delivered)\b/i.test(label)) fail("LAYOUT_REVIEW_REQUIRED");
        if (/^Delivered at:(?:\s+[^\r\n]+)?$/.test(label)) return "DELIVERED";
        if (/^Picked up at:(?:\s+[^\r\n]+)?$/.test(label)) return "PICKED_UP";
        if (/^Picked Up [^\r\n]{1,500}$/.test(label)) return "PICKED_UP";
        if (/^At ICS Branch [^\r\n]{1,160} for processing$/.test(label)) return "IN_TRANSIT";
        if (/^At SMARTSpot for pickup [^\r\n]{1,500}$/.test(label)) return "EXCEPTION";
    }
    if (!Object.hasOwn(LABELS[carrier], label)) fail("LAYOUT_REVIEW_REQUIRED");
    return LABELS[carrier][label];
}
function glsDOMStatus(label) {
    if (typeof label !== "string" || label.length > 2000) fail("LAYOUT_REVIEW_REQUIRED");
    const normalized = label.trim().replace(/\s+/g, " ");
    if (/^Delivered\s+Your shipment was delivered(?:\.| (?:at|to|in) [^.\r\n]{1,120}\.| and we received a signature\.)$/.test(normalized)) return "DELIVERED";
    // Non-delivery descriptions are discarded, not mapped to delivery.
    const heading = label.trim().split(/\r?\n/)[0];
    const status = mappedStatus("GLS", heading);
    if (status === "DELIVERED") fail("LAYOUT_REVIEW_REQUIRED");
    return status;
}
function boundedRows(rows) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS ||
        rows.some((r) => !Array.isArray(r) || r.length > 12 || r.some((c) => typeof c !== "string" || c.length > 2000))) fail("LAYOUT_REVIEW_REQUIRED");
    return rows;
}
function latestDOM(carrier, rows, currentScan) {
    const scans = [];
    for (const cells of boundedRows(rows)) {
        const dateIndex = carrier === "GLS" ? 2 : 0;
        // Only actual table headers may be skipped. Missing/invalid scan dates fail.
        if (cells.every((c) => !c) || /^(Date|Date\/Time|Date Time|Status|Activity)$/i.test(cells[0])) continue;
        const local = carrier === "GLS" ? glsLocal(cells[2], cells[3]) : localTimestamp(cells[0]);
        if (!local || (carrier === "ICS_COURIER" && cells.length !== 2) ||
            (carrier === "CANPAR" && cells.length < 3) || (carrier === "GLS" && cells.length !== 4)) fail("LAYOUT_REVIEW_REQUIRED");
        const label = carrier === "GLS" ? cells[0] : cells[1];
        scans.push({ local, label });
        if (!cells[dateIndex]) fail("LAYOUT_REVIEW_REQUIRED");
    }
    if (!scans.length) fail("NO_DATED_SCAN");
    // Reviewed DOM is newest-first. A rearranged table needs review, not a guess.
    if (scans.some((s, i) => i && s.local > scans[i - 1].local)) fail("LAYOUT_REVIEW_REQUIRED");
    // Only the newest actual scan determines status. Unrelated older wording
    // must not obscure a confirmed latest scan or override a later exception.
    const latest=scans.filter((s)=>s.local===scans[0].local).map((s)=>({...s,
        status:carrier==="GLS"?glsDOMStatus(s.label):mappedStatus(carrier,s.label)}));
    if (carrier === "ICS_COURIER" && currentScan !== undefined) {
        if (!localTimestamp(currentScan?.local) || currentScan.local !== latest[0].local
            || currentScan.label !== latest[0].label) fail("SCAN_CONFLICT");
        const currentStatus = mappedStatus(carrier, currentScan.label);
        // ICS repeats its update time across prior progress rows. The independent
        // summary must match the first dated scan; exceptions never lose a tie.
        const progress = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"];
        const rank = progress.indexOf(currentStatus);
        if (rank >= 0 && latest.every((scan) => progress.includes(scan.status)
            && progress.indexOf(scan.status) <= rank)) return latest[0];
    }
    if (latest.some((s) => s.status !== latest[0].status)) fail("SCAN_CONFLICT");
    return latest[0];
}
function safeEvent(status, eventAt, local, timeBasis) {
    const description = trackingStatusLabel(status) + (timeBasis === "OBSERVED_CONFIRMED_STATUS"
        ? `; carrier local timestamp ${local} (timezone unverified; event time is observation time).` : ".");
    return { status, eventAt, carrierLocalTimestamp: local, timeBasis, description, source: "PUBLIC_CARRIER" };
}

async function decodeGLS(payload, number) {
    if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) fail("PAYLOAD_LIMIT");
    try {
        // Preflight prevents deep/huge flattened graphs and unreviewed tagged types.
        const flat = JSON.parse(payload);
        if (!Array.isArray(flat) || flat.length > 20000) fail("PAYLOAD_LIMIT");
        const allowed = new Set([...Object.keys(REVIVERS), "Set"]);
        for (const value of flat) {
            if (Array.isArray(value) && typeof value[0] === "string" && !allowed.has(value[0])) fail("LAYOUT_REVIEW_REQUIRED");
            if (Array.isArray(value) && value[0] === "Set") {
                // Nuxt's `once` is a native devalue Set, not a custom reviver.
                // Bound its entries and require valid flattened graph references.
                if (value.length - 1 > MAX_SET_ENTRIES) fail("PAYLOAD_LIMIT");
                if (value.slice(1).some((ref) => !Number.isInteger(ref) || ref < 0 || ref >= flat.length)) fail("LAYOUT_REVIEW_REQUIRED");
            }
        }
        const { parse } = await import("devalue");
        const root = parse(payload, REVIVERS);
        const key = `waybill-${number}`;
        if (!root?.data || !Object.hasOwn(root.data, key)) fail("TRACKING_ID_MISMATCH");
        const waybill = root.data[key];
        if (waybill?.trackingNumber !== number) fail("TRACKING_ID_MISMATCH");
        return waybill;
    } catch (error) {
        if (error instanceof PublicTrackingError) throw error;
        fail("LAYOUT_REVIEW_REQUIRED");
    }
}
async function normalizePublicTracking(carrier, number, snapshot, options = {}) {
    const code = carrierCode(carrier);
    numberValue(number);
    const mode = modeValue(options.unverifiedTimeMode);
    const observed = parseOffsetTimestamp(options.observedAt);
    if (!observed) fail("INVALID_OBSERVATION_TIME");
    if (!Array.isArray(snapshot?.identities) || snapshot.identities.length !== 1 || snapshot.identities[0] !== number) fail("TRACKING_ID_MISMATCH");
    const latest = latestDOM(code, snapshot.rows, snapshot.currentScan);
    if (code !== "GLS") {
        const proof = { carrier: code, status: latest.status, carrierLocalTimestamp: latest.local,
            timezoneVerified: false, source: "PUBLIC_CARRIER" };
        if (mode === "HOLD") return { ok: false, code: "TIMEZONE_REQUIRED", proof };
        const event = safeEvent(latest.status, observed.eventAt, latest.local, "OBSERVED_CONFIRMED_STATUS");
        return { ok: true, carrier: code, status: event.status, timeBasis: event.timeBasis,
            timezoneVerified: false, eventAt: event.eventAt, carrierLocalTimestamp: latest.local,
            statusDetail: event.description, deliveredAt: null, estimatedDelivery: null, events: [event] };
    }
    const waybill = await decodeGLS(snapshot.nuxtPayload, number);
    if (!Array.isArray(waybill.parcels) || waybill.parcels.length < 1 || waybill.parcels.length > MAX_PIECES ||
        !Array.isArray(waybill.activities) || waybill.activities.length < 1 || waybill.activities.length > MAX_ROWS) fail("PIECE_REVIEW_REQUIRED");
    const ids = waybill.parcels.map((p) => p?.id);
    if (ids.some((id) => typeof id === "string" ? !/^[A-Za-z0-9-]{1,80}$/.test(id)
        : !Number.isSafeInteger(id) || id < 1) ||
        new Set(ids).size !== ids.length) fail("PIECE_REVIEW_REQUIRED");
    if (snapshot.pieceCount !== ids.length) fail("PIECE_REVIEW_REQUIRED");
    const current = new Map();
    for (const activity of waybill.activities) {
        if (!ids.includes(activity?.parcelId)) fail("PIECE_REVIEW_REQUIRED");
        if (typeof activity.status !== "string" || !activity.status || activity.status.length>2000) fail("LAYOUT_REVIEW_REQUIRED");
        const time = parseOffsetTimestamp(activity.activityDate);
        if (!time || time.eventAt > observed.eventAt) fail("INVALID_SCAN_TIME");
        const scan = { label: activity.status, eventAt: time.eventAt, local: time.local, id: activity.parcelId };
        const previous = current.get(scan.id);
        if (!previous || scan.eventAt > previous.eventAt) current.set(scan.id, { ...scan, tiedLabels: [scan.label] });
        else if (previous.eventAt === scan.eventAt) previous.tiedLabels.push(scan.label);
    }
    if (current.size !== ids.length) fail("PIECE_REVIEW_REQUIRED");
    const pieces = [...current.values()].map((scan) => {
        const statuses = scan.tiedLabels.map((label) => mappedStatus("GLS", label));
        if (statuses.some((status) => status !== statuses[0])) fail("SCAN_CONFLICT");
        return { ...scan, status: statuses[0] };
    });
    // The reviewed UI exposes a selected piece, not an authenticated DOM parcel ID.
    // Reconcile that visible latest scan against the bound machine piece scans;
    // every piece's current state is independently derived above, never a summary.
    const domTime = (p) => snapshot.renderingTimezone === "UTC_SERVER_RENDERED"
        ? p.eventAt.slice(0,19).replace("T"," ") : p.local;
    if (!pieces.some((p) => domTime(p) === latest.local && p.status === latest.status)) fail("SCAN_CONFLICT");
    let status;
    if (pieces.every((p) => p.status === "DELIVERED")) status = "DELIVERED";
    else if (pieces.some((p) => p.status === "EXCEPTION")) status = "EXCEPTION";
    else if (pieces.some((p) => p.status === "DELIVERY_ATTEMPTED")) status = "DELIVERY_ATTEMPTED";
    else {
        // Conservative progress: delivery of one piece does not advance others.
        const remaining = pieces.filter((p) => p.status !== "DELIVERED");
        const progress = ["LABEL_CREATED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"];
        status = progress[Math.min(...remaining.map((p) => progress.indexOf(p.status)))];
    }
    if (!status) fail("LAYOUT_REVIEW_REQUIRED");
    const contributors = pieces.filter((p) => p.status === status);
    const latestPiece = contributors.reduce((a, b) => a.eventAt > b.eventAt ? a : b);
    const event = safeEvent(status, latestPiece.eventAt, latestPiece.local, "CARRIER_OFFSET_TIMESTAMP");
    return { ok: true, carrier: code, status, eventAt: event.eventAt, timeBasis: event.timeBasis,
        timezoneVerified: true, carrierLocalTimestamp: event.carrierLocalTimestamp,
        statusDetail: event.description, deliveredAt: status === "DELIVERED" ? event.eventAt : null,
        estimatedDelivery: null, pieceCount: pieces.length, events: [event],
        pieces: pieces.map((p) => ({ status: p.status, eventAt: p.eventAt })) };
}

function isAllowedPublicRequest(carrier, number, request) {
    const canonical = buildPublicTrackingUrl(carrier, number);
    let url;
    try { url = new URL(request.url()); } catch { return false; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    const method = request.method();
    if (carrierCode(carrier) === "CANPAR" && url.origin + url.pathname === CANPAR_API &&
        !request.isNavigationRequest() && ["xhr", "fetch"].includes(request.resourceType())) {
        if (!["GET", "POST"].includes(method)) return false;
        if (method === "GET") return url.searchParams.get("barcode") === number;
        const body = request.postData();
        if (typeof body !== "string" || Buffer.byteLength(body) > 8192) return false;
        try { return JSON.parse(body)?.barcode === number; } catch { return new URLSearchParams(body).get("barcode") === number; }
    }
    if (url.origin !== new URL(canonical).origin || method !== "GET") return false;
    if (request.isNavigationRequest()) {
        try { if (request.frame().parentFrame()) return false; } catch { return false; }
        return url.href === canonical;
    }
    // No arbitrary same-host APIs or read/write forms. Only static rendering assets.
    return ["script", "stylesheet", "image", "font"].includes(request.resourceType()) &&
        (/\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)(?:$)/i.test(url.pathname));
}
async function readSnapshot(page, carrier, number, timeout) {
    const selector = carrier === "CANPAR" ? "table#detailTable:visible"
        : carrier === "ICS_COURIER" ? "table[id$='_gvTracingDetail']:visible" : "table:visible";
    await page.locator(selector).first().waitFor({ state: "visible", timeout });
    // DOM-only extraction; never evaluate provider JavaScript or serialized code.
    return page.evaluate(({ carrier, number, maxRows, maxPayload }) => {
        const visible = (el) => !!el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
        const tables = (css) => [...document.querySelectorAll(css)].filter(visible);
        const readRows = (ts) => {
            const rows = ts.flatMap((t) => [...t.rows]);
            if (rows.length > maxRows) return null;
            const cells = rows.map((r) => [...r.cells].map((c) => c.innerText.trim()));
            return cells.some((r) => r.length > 12 || r.some((c) => c.length > 2000)) ? null : cells;
        };
        if (carrier === "CANPAR") {
            const detail = tables("table#detailTable"), summary = tables("table#tablepress-2");
            return { identities: summary.flatMap((t) => [...t.rows].filter((r) => r.cells[0]?.innerText.trim() === "Tracking Number")
                .map((r) => r.cells[1]?.innerText.trim())), rows: detail.length === 1 ? readRows(detail) : null };
        }
        if (carrier === "ICS_COURIER") {
            const result = tables("table[id$='_gvresult']"), detail = tables("table[id$='_gvTracingDetail']");
            const identities = result.flatMap((t) => [...t.rows].filter((r) => r.cells[0]?.tagName === "TD")
                .map((r) => r.cells[0].innerText.trim()));
            const summaryRows = readRows(result);
            const reviewed = summaryRows?.length === 2 && summaryRows[1].length === 5
                && JSON.stringify(summaryRows[0]) === JSON.stringify(["Tracking Number", "Last Updated", "Status", "Signature", "Est Delivery Date"]);
            return { identities, rows: result.length === 1 && detail.length === 1 && reviewed ? readRows(detail) : null,
                currentScan: reviewed ? { local: summaryRows[1][1], label: summaryRows[1][2] } : undefined };
        }
        const text = document.body.innerText;
        if (text.length > maxPayload) return { identities: [], rows: null };
        const piece = [...text.matchAll(/\bPiece\s+(\d+)\s+of\s+(\d+)\b/g)];
        const scripts = document.querySelectorAll("script#__NUXT_DATA__");
        const payload = scripts.length === 1 ? scripts[0].textContent : "";
        const ts = tables("table").filter((t) => [...t.rows].some((r) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(r.cells[2]?.innerText.trim() || "")));
        return { identities: text.split("\n").filter((line) => line.trim() === number).map((line) => line.trim()),
            rows: ts.length === 1 ? readRows(ts) : null,
            pieceCount: piece.length === 1 && +piece[0][1] >= 1 && +piece[0][1] <= +piece[0][2] ? +piece[0][2] : null,
            nuxtPayload: payload.length <= maxPayload ? payload : null };
    }, { carrier, number, maxRows: MAX_ROWS, maxPayload: MAX_PAYLOAD_BYTES });
}
async function defaultLaunch(options) { return require("@playwright/test").chromium.launch(options); }
function createPublicCarrierTracking({ launch = defaultLaunch, diagnosticDir, now = () => new Date(),
    minIntervalMs = 5000, timeoutMs = 20000 } = {}) {
    if (typeof launch !== "function" || typeof now !== "function" || !Number.isInteger(minIntervalMs) ||
        minIntervalMs < 1000 || minIntervalMs > 60000 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) fail("INVALID_CONFIGURATION");
    let root;
    if (diagnosticDir !== undefined) {
        if (typeof diagnosticDir !== "string" || !path.isAbsolute(diagnosticDir)) fail("INVALID_DIAGNOSTIC_DIR");
        root = path.resolve(diagnosticDir);
        const relative = path.relative(__dirname, root);
        if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) fail("INVALID_DIAGNOSTIC_DIR");
    }
    const gates = new Map();
    async function poll(shipment, options = {}) {
        let carrier, browser, context, page, timer, expired = false, gate;
        let workStarted = false, workSettled = false, cleanupFinished = false, cleanupFailed = false;
        const closed = new WeakMap();
        const close = (resource) => {
            if (!resource) return Promise.resolve(true);
            if (closed.has(resource)) return closed.get(resource);
            const closing = new Promise((resolve) => {
                const t = setTimeout(() => { cleanupFailed = true; resolve(false); }, 1000);
                Promise.resolve().then(() => resource.close()).then(() => { clearTimeout(t); resolve(true); }, () => {
                    clearTimeout(t); cleanupFailed = true; resolve(false);
                });
            });
            closed.set(resource, closing);
            return closing;
        };
        const check = () => { if (expired) fail("TIMEOUT"); };
        async function acquire(operation, assign) {
            const resource = await operation();
            if (expired) { await close(resource); fail("TIMEOUT"); }
            assign(resource);
            return resource;
        }
        async function diagnostic() {
            if (!root || !page) return false;
            let filename;
            try {
                if (path.resolve(await fs.realpath(root)) !== root) return false;
                const stat = await fs.stat(root);
                if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077))) return false;
                filename = path.join(root, `carrier-error-${randomUUID()}.png`);
                const handle = await fs.open(filename, "wx", 0o600);
                await handle.close();
                await page.screenshot({ path: filename, fullPage: false, timeout: 1000 });
                return true;
            } catch {
                if (filename) await fs.unlink(filename).catch(() => {});
                return false;
            }
        }
        let result;
        try {
            carrier = carrierCode(shipment?.carrier);
            const number = numberValue(shipment?.trackingNumber);
            const mode = modeValue(options.unverifiedTimeMode);
            const url = buildPublicTrackingUrl(carrier, number);
            const observation = new Date(now());
            if (!Number.isFinite(observation.getTime())) fail("INVALID_OBSERVATION_TIME");
            const wallNow = performance.now();
            const previous = gates.get(carrier);
            if (previous?.busy) fail("CARRIER_BUSY");
            if (previous && wallNow - previous.started < minIntervalMs) fail("RATE_LIMITED");
            gate = { busy: true, started: wallNow };
            gates.set(carrier, gate);
            const work = async () => {
                await acquire(() => launch({ headless: true, chromiumSandbox: true, timeout: timeoutMs }), (v) => { browser = v; });
                await acquire(() => browser.newContext({ ignoreHTTPSErrors: false, acceptDownloads: false,
                    serviceWorkers: "block", permissions: [], javaScriptEnabled: true }), (v) => { context = v; });
                let requests = 0;
                await context.route("**/*", async (route) => {
                    try {
                        const request = route.request();
                        if (expired || !page || request.frame().page() !== page || ++requests > 128 ||
                            !isAllowedPublicRequest(carrier, number, request)) return await route.abort();
                        // continue() can follow redirects without rechecking egress.
                        const response = await route.fetch({ maxRedirects: 0, timeout: timeoutMs });
                        if (expired || (response.status() >= 300 && response.status() < 400)) return await route.abort();
                        await route.fulfill({ response });
                    } catch { await route.abort().catch(() => {}); }
                });
                if (typeof context.routeWebSocket !== "function") fail("BROWSER_UNAVAILABLE");
                await context.routeWebSocket("**/*", (socket) => socket.close());
                context.on("page", (extra) => { if (page && extra !== page) void close(extra); });
                check();
                await acquire(() => context.newPage(), (v) => { page = v; });
                page.setDefaultTimeout(timeoutMs);
                page.setDefaultNavigationTimeout(timeoutMs);
                page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
                page.on("download", (download) => { void download.cancel().catch(() => {}); });
                page.on("popup", (popup) => { void close(popup); });
                const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
                check();
                if (response && !response.ok()) fail("CARRIER_UNAVAILABLE");
                if (page.url() !== url) fail("TRACKING_ID_MISMATCH");
                const snapshot = await readSnapshot(page, carrier, number, timeoutMs);
                check();
                const observedAt = new Date(now()).toISOString();
                const normalized = await normalizePublicTracking(carrier, number, snapshot, { unverifiedTimeMode: mode, observedAt });
                check();
                return normalized;
            };
            workStarted = true;
            const running = work();
            const settled = () => {
                workSettled = true;
                // A timed-out launch may still be in flight. Do not allow a second
                // browser until its late resources have closed successfully.
                if (cleanupFinished && gate && !cleanupFailed) gate.busy = false;
            };
            void running.then(settled, settled);
            result = await Promise.race([running, new Promise((_, reject) => {
                timer = setTimeout(() => { expired = true; reject(new PublicTrackingError("TIMEOUT")); }, timeoutMs);
            })]);
        } catch (error) {
            const code = error instanceof PublicTrackingError ? error.code : error?.name === "TimeoutError" ? "TIMEOUT" : "CARRIER_READ_FAILED";
            // Never return provider errors, URLs, recipient lines, or payloads.
            result = { ok: false, code };
            if (root) result.diagnosticCaptured = await diagnostic();
        } finally {
            clearTimeout(timer);
            expired = true;
            const pageClosed = await close(page);
            const contextClosed = await close(context);
            const browserClosed = await close(browser);
            if (!pageClosed || !contextClosed || !browserClosed) result = { ok: false, code: "RESOURCE_CLOSE_FAILED" };
            cleanupFinished = true;
            if (gate && (!workStarted || workSettled) && !cleanupFailed) gate.busy = false;
        }
        return result;
    }
    return { poll };
}

module.exports = { createPublicCarrierTracking, buildPublicTrackingUrl, normalizePublicTracking,
    parseOffsetTimestamp, isAllowedPublicRequest, MAX_PAYLOAD_BYTES };
