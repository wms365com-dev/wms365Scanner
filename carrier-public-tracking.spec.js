"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createPublicCarrierTracking, buildPublicTrackingUrl, normalizePublicTracking,
    parseOffsetTimestamp, isAllowedPublicRequest, MAX_PAYLOAD_BYTES } = require("./carrier-public-tracking");

// All data is synthetic. No browser or carrier network is used by this suite.
const NUMBER = "TEST-123";
const NOW = "2026-09-17T20:00:00.000Z";
const LOCAL = "2026-09-16 12:00:15";
const MACHINE = "2026-09-16T12:00:15-04:00";
const options = { observedAt: NOW };
function localSnapshot(carrier = "CANPAR", label = "Our Package was Delivered", time = LOCAL) {
    return { identities: [NUMBER], rows: [[time, label, ...(carrier === "CANPAR" ? ["Synthetic depot"] : [])]] };
}
async function nuxt(activities, parcels = [{ id: "piece-1" }], extra = {}) {
    const { stringify } = await import("devalue");
    return stringify({ data: { [`waybill-${NUMBER}`]: { trackingNumber: NUMBER, parcels, activities, ...extra } } });
}
function activity(status = "Delivered", date = MACHINE, parcelId = "piece-1", extra = {}) {
    return { activityDate: date, status, statusDetail: "Synthetic private recipient; 123 Fake Street",
        terminal: "Synthetic private depot", parcelId, ...extra };
}
function glsRow(label = "Delivered\nYour shipment was delivered.", date = "9/16/2026", time = "12:00:15 PM") {
    return [label, "Synthetic private depot", date, time];
}
async function glsSnapshot(activities = [activity()], parcels = [{ id: "piece-1" }], rows = [glsRow()], extra = {}) {
    return { identities: [NUMBER], pieceCount: parcels.length, rows, nuxtPayload: await nuxt(activities, parcels), ...extra };
}
async function read(carrier, snapshot, extra = {}) {
    return normalizePublicTracking(carrier, NUMBER, snapshot, { ...options, ...extra });
}
async function rejectsCode(promise, code) { await assert.rejects(promise, (e) => e.code === code); }

test("normalized carrier names use only pinned public URLs and exact numbers", () => {
    assert.equal(buildPublicTrackingUrl("GLS Canada", NUMBER), `https://ship.gls-canada.com/tracking/${NUMBER}`);
    assert.equal(buildPublicTrackingUrl("Canpar Courier", NUMBER), `https://www.canpar.com/en/tracking/track.htm?barcode=${NUMBER}`);
    assert.equal(buildPublicTrackingUrl("ICS Ground", NUMBER), `https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums=${NUMBER}`);
    assert.throws(() => buildPublicTrackingUrl("UPS", NUMBER), /UNSUPPORTED_CARRIER/);
    for (const number of ["../x", "A B", "A?barcode=B", "", "A".repeat(81), 123]) {
        assert.throws(() => buildPublicTrackingUrl("GLS", number), /INVALID_TRACKING_NUMBER/);
    }
});

test("offset-bearing timestamps validate calendar, seconds, offset and leap years", () => {
    assert.equal(parseOffsetTimestamp(MACHINE).eventAt, "2026-09-16T16:00:15.000Z");
    assert.equal(parseOffsetTimestamp("2024-02-29T23:59:59.123+05:30").eventAt, "2024-02-29T18:29:59.123Z");
    assert.equal(parseOffsetTimestamp("2026-09-16T00:00:00+14:00").eventAt, "2026-09-15T10:00:00.000Z");
    for (const invalid of [LOCAL, "2026-09-16", "2026-09-16T12:00:15", "2026-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z", "2026-00-01T00:00:00Z", "2026-09-16T24:00:00Z",
        "2026-09-16T12:00:60Z", "2026-09-16T12:00:15+14:01", "2026-09-16T12:00:15+03:60",
        "2026-09-16T12:00:15-00:00", "2026-09-16T12:00:15.1234Z", "1999-09-16T12:00:15Z"]) {
        assert.equal(parseOffsetTimestamp(invalid), null, invalid);
    }
});

test("unknown carrier timezone defaults to HOLD with safe status proof", async () => {
    for (const [carrier, label] of [["CANPAR", "Our Package was Delivered"], ["ICS", "Delivered at: Synthetic Person 123 Fake Street"]]) {
        const snapshot = localSnapshot(carrier === "CANPAR" ? carrier : "ICS", label);
        snapshot.time_shift = -4; // Its semantics are not verified, so it is ignored.
        for (const mode of [undefined, "HOLD"]) {
            const result = await read(carrier, snapshot, { unverifiedTimeMode: mode });
            assert.equal(result.ok, false);
            assert.equal(result.code, "TIMEZONE_REQUIRED");
            assert.equal(result.proof.status, "DELIVERED");
            assert.equal(result.proof.carrierLocalTimestamp, LOCAL);
            assert.equal(result.proof.timezoneVerified, false);
            assert.equal(result.eventAt, undefined);
            assert.doesNotMatch(JSON.stringify(result), /Synthetic|Fake Street|time_shift/);
        }
    }
});

test("OBSERVED is explicit and never presents delivery observation as actual delivery UTC", async () => {
    const result = await read("ICS", localSnapshot("ICS", "Delivered at: Synthetic Person 123 Fake Street"), { unverifiedTimeMode: "OBSERVED" });
    assert.equal(result.ok, true);
    assert.equal(result.eventAt, NOW);
    assert.equal(result.events[0].eventAt, NOW);
    assert.equal(result.timeBasis, "OBSERVED_CONFIRMED_STATUS");
    assert.equal(result.timezoneVerified, false);
    assert.equal(result.deliveredAt, null);
    assert.equal(result.carrierLocalTimestamp, LOCAL);
    assert.match(result.statusDetail, /timezone unverified; event time is observation time/);
    assert.doesNotMatch(JSON.stringify(result), /Synthetic|Fake Street/);
    await rejectsCode(read("ICS", localSnapshot("ICS", "Picked up"), { unverifiedTimeMode: "observed" }), "INVALID_TIME_MODE");
});

test("exact local label mappings include all six requested statuses and redact pickup PII", async () => {
    for (const carrier of ["CANPAR", "ICS"]) {
        const labels = carrier === "CANPAR"
            ? ["Our Package was Picked Up", "In Transit", "Exception", "Out for Delivery", "Delivery Attempted", "Our Package was Delivered"]
            : ["Picked up at: Synthetic Person 123 Fake Street", "In Transit", "Exception", "Out for Delivery", "Delivery Attempted", "Delivered at: Synthetic Person"];
        const statuses = ["PICKED_UP", "IN_TRANSIT", "EXCEPTION", "OUT_FOR_DELIVERY", "DELIVERY_ATTEMPTED", "DELIVERED"];
        for (let i = 0; i < labels.length; i++) {
            const result = await read(carrier, localSnapshot(carrier, labels[i]), { unverifiedTimeMode: "OBSERVED" });
            assert.equal(result.status, statuses[i]);
            assert.doesNotMatch(JSON.stringify(result), /Synthetic|Fake Street/);
        }
    }
});

test("fake DEL, ETA, summary-only, unknown labels and missing or impossible local time fail closed", async () => {
    for (const [carrier, label] of [["CANPAR", "Delivered"], ["CANPAR", "Estimated Delivery"],
        ["CANPAR", "Our Package was Delivered tomorrow"], ["ICS", "Delivered"],
        ["ICS", "Delivered at: Expected delivery tomorrow"], ["ICS", "Something new"]]) {
        await rejectsCode(read(carrier, localSnapshot(carrier, label), { unverifiedTimeMode: "OBSERVED" }), "LAYOUT_REVIEW_REQUIRED");
    }
    for (const time of ["", "2026-09-16", "2026-02-29 12:00:15", "2026-04-31 12:00:15", "2026-09-16 24:00:15"]) {
        await rejectsCode(read("CANPAR", localSnapshot("CANPAR", "Our Package was Delivered", time)), "LAYOUT_REVIEW_REQUIRED");
    }
    await rejectsCode(read("CANPAR", { identities: [NUMBER], rows: [], summary: "Delivered", eta: LOCAL }), "LAYOUT_REVIEW_REQUIRED");
});

test("current return/exception after delivery cannot be overwritten by historical DEL", async () => {
    for (const [carrier, delivered] of [["CANPAR", "Our Package was Delivered"], ["ICS", "Delivered at: Synthetic Person"]]) {
        const snapshot = localSnapshot(carrier, "Returned", "2026-09-17 12:00:15");
        snapshot.rows.push(localSnapshot(carrier, delivered).rows[0]);
        assert.equal((await read(carrier, snapshot, { unverifiedTimeMode: "OBSERVED" })).status, "EXCEPTION");
        snapshot.rows[0][1] = "Unreviewed return label";
        await rejectsCode(read(carrier, snapshot), "LAYOUT_REVIEW_REQUIRED");
        snapshot.rows.reverse();
        snapshot.rows[1][1] = "Returned";
        await rejectsCode(read(carrier, snapshot), "LAYOUT_REVIEW_REQUIRED");
    }
});

test("local identity must match one visible shipment, not a prefix or additional result", async () => {
    for (const identities of [[], ["TEST-1234"], ["OTHER"], [NUMBER, "OTHER"], [NUMBER, NUMBER]]) {
        await rejectsCode(read("CANPAR", { ...localSnapshot(), identities }), "TRACKING_ID_MISMATCH");
    }
});

test("ICS Date Time header and older depot labels do not obscure the latest confirmed scan", async () => {
    const snapshot={identities:[NUMBER],rows:[["Date Time","Status"],
        [LOCAL,"Delivered at: Synthetic Person"],
        ["2026-09-16 06:08:03","Out for Delivery"],
        ["2026-09-16 00:42:00","In Sort Process"]]};
    const held=await read("ICS",snapshot);
    assert.equal(held.code,"TIMEZONE_REQUIRED");
    assert.equal(held.proof.status,"DELIVERED");
    snapshot.rows[1][1]="Unknown current scan";
    await rejectsCode(read("ICS",snapshot),"LAYOUT_REVIEW_REQUIRED");
});

test("GLS server-rendered UTC table reconciles the offset-bearing machine scan", async () => {
    const snapshot=await glsSnapshot([activity()],undefined,[glsRow(undefined,"9/16/2026","4:00:15 PM")],{renderingTimezone:"UTC_SERVER_RENDERED"});
    assert.equal((await read("GLS",snapshot)).eventAt,"2026-09-16T16:00:15.000Z");
    delete snapshot.renderingTimezone;
    await rejectsCode(read("GLS",snapshot),"SCAN_CONFLICT");
});

test("ICS tied progress scans require a matching independent current summary",async()=>{
    const snapshot={identities:[NUMBER],currentScan:{local:LOCAL,label:"Delivered at: Synthetic Person"},
        rows:[["Date Time","Status"],[LOCAL,"Delivered at: Synthetic Person"],[LOCAL,"Out for Delivery"],
            [LOCAL,"In Sort Process"],[LOCAL,"At ICS Branch SYNTHETIC, ON for processing"]]};
    assert.equal((await read("ICS",snapshot,{unverifiedTimeMode:"OBSERVED"})).status,"DELIVERED");
    assert.equal((await read("ICS",snapshot)).code,"TIMEZONE_REQUIRED");
    await rejectsCode(read("ICS",{...snapshot,currentScan:undefined}),"SCAN_CONFLICT");
    for(const currentScan of [{local:LOCAL,label:"Out for Delivery"},{local:"2026-09-16 12:00:16",label:snapshot.currentScan.label}])
        await rejectsCode(read("ICS",{...snapshot,currentScan}),"SCAN_CONFLICT");
    for(const label of ["Returned","Exception","Delivery Attempted"])
        await rejectsCode(read("ICS",{...snapshot,rows:[...snapshot.rows,[LOCAL,label]]}),"SCAN_CONFLICT");
    await rejectsCode(read("ICS",{...snapshot,rows:[...snapshot.rows,[LOCAL,"Unknown new scan"]]}),"LAYOUT_REVIEW_REQUIRED");
    const earlier="2026-09-15 12:00:15";
    await rejectsCode(read("ICS",{...snapshot,rows:[[earlier,"Delivered at: Synthetic Person"],[LOCAL,"Out for Delivery"]]}),"LAYOUT_REVIEW_REQUIRED");
});

test("ICS reviewed pickup, damage, undeliverable and pickup-point scans remain non-delivery and redact details",async()=>{
    for(const [label,status] of [
        ["Picked Up Synthetic Sender 123 Fake Street","PICKED_UP"],
        ["Damaged Item\nPlease contact Customer Service\nat 1-888-427-8729","EXCEPTION"],
        ["Undeliverable","EXCEPTION"],["Return: Undeliverable","EXCEPTION"],
        ["At SMARTSpot for pickup Synthetic Shop 123 Fake Street","EXCEPTION"],
        ["Delivery Attempt: Consignee Not Available","DELIVERY_ATTEMPTED"]]){
        const result=await read("ICS",{...localSnapshot("ICS",label),currentScan:{local:LOCAL,label}},{unverifiedTimeMode:"OBSERVED"});
        assert.equal(result.status,status);
        assert.equal(result.deliveredAt,null);
        assert.doesNotMatch(JSON.stringify(result),/Synthetic|Fake Street|427-8729/);
    }
});

test("GLS uses each piece's newest scans; old alerts or unknown wording cannot hide delivery",async()=>{
    const earlier="2026-09-15T12:00:15-04:00";
    for(const label of ["Service Alert","Unreviewed historical scan"]){
        for(const scans of [[activity(),activity(label,earlier)],[activity(label,earlier),activity()]])
            assert.equal((await read("GLS",await glsSnapshot(scans))).status,"DELIVERED");
    }
    const alert=activity("Service Alert","2026-09-17T12:00:15-04:00");
    assert.equal((await read("GLS",await glsSnapshot([activity(),alert],undefined,
        [glsRow("Service Alert","9/17/2026"),glsRow()]))).status,"EXCEPTION");
    await rejectsCode(read("GLS",await glsSnapshot([activity(),activity("Unreviewed current scan","2026-09-17T12:00:15-04:00")],
        undefined,[glsRow("In Transit","9/17/2026")])) ,"LAYOUT_REVIEW_REQUIRED");
    await rejectsCode(read("GLS",await glsSnapshot([activity(),activity("Service Alert")])) ,"SCAN_CONFLICT");
    const parcels=[{id:"piece-1"},{id:"piece-2"}];
    const partial=await read("GLS",await glsSnapshot([activity(),activity("Service Alert",earlier,"piece-2")],parcels));
    assert.equal(partial.status,"EXCEPTION");
    assert.equal(partial.deliveredAt,null);
});

test("GLS machine timestamps reconcile exact DOM delivery labels without leaking details", async () => {
    for (const label of ["Delivered\nYour shipment was delivered.", "Delivered\nYour shipment was delivered at the front door.",
        "Delivered\nYour shipment was delivered to the mailbox.", "Delivered\nYour shipment was delivered and we received a signature."]) {
        const result = await read("GLS", await glsSnapshot([activity()], undefined, [glsRow(label)]));
        assert.equal(result.ok, true);
        assert.equal(result.status, "DELIVERED");
        assert.equal(result.deliveredAt, "2026-09-16T16:00:15.000Z");
        assert.equal(result.timeBasis, "CARRIER_OFFSET_TIMESTAMP");
        assert.doesNotMatch(JSON.stringify(result), /Synthetic|Fake Street|front door|signature|mailbox|piece-1/);
    }
});

test("GLS literal On Delivery is out-for-delivery, not delivered; other exact labels map", async () => {
    for (const [label, status] of [["On Delivery", "OUT_FOR_DELIVERY"], ["In Transit", "IN_TRANSIT"],
        ["Pickup", "PICKED_UP"], ["Exception", "EXCEPTION"], ["Delivery Attempted", "DELIVERY_ATTEMPTED"], ["Returned", "EXCEPTION"]]) {
        const result = await read("GLS", await glsSnapshot([activity(label)], undefined, [glsRow(`${label}\nSynthetic description`)]));
        assert.equal(result.status, status);
        assert.equal(result.deliveredAt, null);
    }
    const created = await read("GLS", await glsSnapshot([activity("Shipment Created")], undefined, [glsRow("Shipment Created")]));
    assert.equal(created.status, "LABEL_CREATED");
    assert.equal(created.deliveredAt, null);
});

test("GLS ETA, fake delivered descriptions and DOM/machine conflicts do not confirm delivery", async () => {
    for (const label of ["Delivered", "Delivered\nYour shipment will be delivered.", "Delivered\nExpected delivery tomorrow",
        "Estimated Delivery", "Something new"]) {
        await rejectsCode(read("GLS", await glsSnapshot([activity()], undefined, [glsRow(label)])), "LAYOUT_REVIEW_REQUIRED");
    }
    await rejectsCode(read("GLS", await glsSnapshot([activity("On Delivery")])), "SCAN_CONFLICT");
    await rejectsCode(read("GLS", await glsSnapshot([activity()], undefined, [glsRow(undefined, "9/16/2026", "12:00:16 PM")])), "SCAN_CONFLICT");
    for (const [date, time] of [["2/29/2026", "12:00:15 PM"], ["9/16/2026", "00:00:15 AM"], ["9/16/2026", "12:00 PM"]]) {
        await rejectsCode(read("GLS", await glsSnapshot([activity()], undefined, [glsRow(undefined, date, time)])), "LAYOUT_REVIEW_REQUIRED");
    }
});

test("GLS requires every declared piece currently delivered and picks actual contributing scan time", async () => {
    const parcels = [{ id: "piece-1" }, { id: "piece-2" }];
    const earlier = "2026-09-15T12:00:15-04:00";
    const delivered = activity();
    const transit = activity("In Transit", earlier, "piece-2");
    const partial = await read("GLS", await glsSnapshot([delivered, transit], parcels));
    assert.equal(partial.status, "IN_TRANSIT");
    assert.equal(partial.eventAt, "2026-09-15T16:00:15.000Z");
    assert.equal(partial.deliveredAt, null);
    const all = await read("GLS", await glsSnapshot([delivered, activity("Delivered", earlier, "piece-2")], parcels));
    assert.equal(all.status, "DELIVERED");
    assert.equal(all.pieceCount, 2);
    assert.equal(all.deliveredAt, "2026-09-16T16:00:15.000Z");
    await rejectsCode(read("GLS", await glsSnapshot([delivered], parcels)), "PIECE_REVIEW_REQUIRED");
    await rejectsCode(read("GLS", await glsSnapshot([delivered], [{ id: "piece-1" }, { id: "piece-1" }])), "PIECE_REVIEW_REQUIRED");
    await rejectsCode(read("GLS", await glsSnapshot([activity("Delivered", MACHINE, "other-piece")], parcels)), "PIECE_REVIEW_REQUIRED");
    await rejectsCode(read("GLS", await glsSnapshot([delivered], undefined, undefined, { pieceCount: 2 })), "PIECE_REVIEW_REQUIRED");
});

test("GLS returned after DEL is current exception regardless of machine array order", async () => {
    const latest = activity("Returned", "2026-09-17T12:00:15-04:00");
    const rows = [glsRow("Returned", "9/17/2026"), glsRow()];
    for (const activities of [[activity(), latest], [latest, activity()]]) {
        const result = await read("GLS", await glsSnapshot(activities, undefined, rows));
        assert.equal(result.status, "EXCEPTION");
        assert.equal(result.deliveredAt, null);
    }
    await rejectsCode(read("GLS", await glsSnapshot([activity(), latest])), "SCAN_CONFLICT");
    await rejectsCode(read("GLS", await glsSnapshot([activity(), activity("Returned")])), "SCAN_CONFLICT");
});

test("GLS invalid, offset-free, future machine scans and unknown labels fail closed", async () => {
    for (const date of [LOCAL, "2026-09-16T12:00:15", "2026-02-29T12:00:15-04:00", "2026-09-18T12:00:15-04:00"]) {
        await rejectsCode(read("GLS", await glsSnapshot([activity("Delivered", date)])), "INVALID_SCAN_TIME");
    }
    await rejectsCode(read("GLS", await glsSnapshot([activity("Estimated Delivered")])), "LAYOUT_REVIEW_REQUIRED");
});

test("GLS devalue parse binds root key and tracking identity; payload and custom revivers are bounded", async () => {
    const { stringify } = await import("devalue");
    const base = await glsSnapshot();
    for (const payload of [await nuxt([activity()], undefined, { trackingNumber: "OTHER" }),
        stringify({ data: { "waybill-OTHER": { trackingNumber: NUMBER } } })]) {
        await rejectsCode(read("GLS", { ...base, nuxtPayload: payload }), "TRACKING_ID_MISMATCH");
    }
    for (const payload of ["not JSON", "[]", '[["UnreviewedNuxtType",1],{}]', '[["Date","2026-09-16"]]',
        '[["Ref",0]]', '[{"__proto__":1},{}]']) {
        await rejectsCode(read("GLS", { ...base, nuxtPayload: payload }), "LAYOUT_REVIEW_REQUIRED");
    }
    await rejectsCode(read("GLS", { ...base, nuxtPayload: "x".repeat(MAX_PAYLOAD_BYTES + 1) }), "PAYLOAD_LIMIT");
    await rejectsCode(read("GLS", { ...base, nuxtPayload: JSON.stringify(Array(20001).fill(null)) }), "PAYLOAD_LIMIT");
    // Explicit Nuxt wrappers are safe identity revivers, not evaluated functions.
    const decoded = { data: { [`waybill-${NUMBER}`]: { trackingNumber: NUMBER, parcels: [{ id: "piece-1" }], activities: [activity()] } } };
    for (const type of ["Ref", "ShallowRef", "Reactive", "ShallowReactive"]) {
        const wrapper = { syntheticWrapper: true, value: decoded };
        const payload = stringify(wrapper, { [type]: (v) => v?.syntheticWrapper ? v.value : undefined });
        assert.equal((await read("GLS", { ...base, nuxtPayload: payload })).status, "DELIVERED");
    }
});

test("GLS accepts bounded native Nuxt once Set with ShallowReactive/Reactive wrappers", async () => {
    const { stringify } = await import("devalue");
    const wrap = (type, value) => ({ fixtureNuxtType: type, value });
    const waybill = { trackingNumber: NUMBER, parcels: [{ id: "piece-1" }], activities: [activity()] };
    for (const once of [new Set(), new Set(["synthetic-once-key", "another-key"])]) {
        const root = wrap("ShallowReactive", {
            data: wrap("Reactive", { [`waybill-${NUMBER}`]: waybill }),
            state: wrap("Reactive", {}), once
        });
        const nuxtPayload = stringify(root, {
            ShallowReactive: (v) => v?.fixtureNuxtType === "ShallowReactive" ? v.value : undefined,
            Reactive: (v) => v?.fixtureNuxtType === "Reactive" ? v.value : undefined
        });
        const snapshot = { ...await glsSnapshot(), nuxtPayload };
        const result = await read("GLS", snapshot);
        assert.equal(result.status, "DELIVERED");
        assert.equal(result.deliveredAt, "2026-09-16T16:00:15.000Z");
        assert.doesNotMatch(JSON.stringify(result), /synthetic-once-key|another-key|Synthetic/);
        await rejectsCode(read("GLS", { ...snapshot, identities: ["OTHER"] }), "TRACKING_ID_MISMATCH");
    }
    const base = await glsSnapshot();
    const oversized = stringify({ data: {}, once: new Set(Array.from({ length: 1001 }, (_, i) => `key-${i}`)) });
    await rejectsCode(read("GLS", { ...base, nuxtPayload: oversized }), "PAYLOAD_LIMIT");
    for (const nuxtPayload of ['[["Set",999]]', '[["Set",-1]]', '[["Set","not-a-reference"]]', '[["Set",1.5]]']) {
        await rejectsCode(read("GLS", { ...base, nuxtPayload }), "LAYOUT_REVIEW_REQUIRED");
    }
    await rejectsCode(read("GLS", { ...base, nuxtPayload: '[["Map"]]' }), "LAYOUT_REVIEW_REQUIRED");
});

function request(url, method = "GET", type = "script", navigation = false, body = null, parent = null) {
    return { url: () => url, method: () => method, resourceType: () => type,
        isNavigationRequest: () => navigation, postData: () => body, frame: () => ({ parentFrame: () => parent }) };
}
test("egress allows canonical navigation/static assets and exact Canpar read endpoint only", () => {
    const allow = (carrier, req) => isAllowedPublicRequest(carrier, NUMBER, req);
    assert.equal(allow("GLS", request(buildPublicTrackingUrl("GLS", NUMBER), "GET", "document", true)), true);
    assert.equal(allow("GLS", request("https://ship.gls-canada.com/_nuxt/fixture.js")), true);
    const api = "https://canship.canpar.com/api/CanparAddons/trackByBarcodeV2";
    assert.equal(allow("CANPAR", request(api, "POST", "xhr", false, JSON.stringify({ barcode: NUMBER }))), true);
    assert.equal(allow("CANPAR", request(`${api}?barcode=${NUMBER}`, "GET", "fetch")), true);
    assert.equal(allow("CANPAR", request(api, "POST", "fetch", false, `barcode=${NUMBER}`)), true);
    for (const req of [request(api, "POST", "xhr", false, '{"barcode":"OTHER"}'), request(`${api}/write`, "POST", "xhr"),
        request(api, "DELETE", "xhr"), request(api, "POST", "document", true), request(api, "POST", "xhr", false, "x".repeat(9000)),
        request("https://canship.canpar.com/api/other"), request("https://evil.invalid/file.js"),
        request("http://www.canpar.com/fixture.js"), request("https://user:password@www.canpar.com/fixture.js"),
        request("https://www.canpar.com:8443/fixture.js"), request(buildPublicTrackingUrl("CANPAR", "OTHER"), "GET", "document", true),
        request(buildPublicTrackingUrl("CANPAR", NUMBER), "POST", "document", true),
        request(buildPublicTrackingUrl("CANPAR", NUMBER), "GET", "document", true, null, {}),
        request("https://www.canpar.com/form", "GET", "xhr")]) assert.equal(allow("CANPAR", req), false);
    assert.equal(allow("GLS", request(api, "POST", "xhr", false, JSON.stringify({ barcode: NUMBER }))), false);
});

function fakeBrowser({ data = localSnapshot(), gotoError, hangGoto = false, launchPause, redirect, closeError = false } = {}) {
    const calls = { launches: [], contexts: [], urls: [], waits: [], closes: [], screenshots: [], events: {}, routes: [], webSockets: [] };
    let releaseGoto;
    const page = {
        locator: (selector) => ({ first() { return this; }, async waitFor(opts) { calls.waits.push({ selector, ...opts }); } }),
        async evaluate(fn, arg) { calls.extraction = arg; return data; },
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
        on(event, handler) { calls.events[event] = handler; },
        async goto(url, opts) {
            calls.urls.push({ url, ...opts });
            if (gotoError) throw gotoError;
            if (hangGoto) await new Promise((resolve) => { releaseGoto = resolve; });
            return { ok: () => true };
        },
        url: () => redirect || calls.urls.at(-1).url,
        async screenshot(opts) { calls.screenshots.push(opts); },
        async close() { calls.closes.push("page"); if (releaseGoto) releaseGoto(); }
    };
    const context = {
        async route(pattern, handler) { calls.routes.push({ pattern, handler }); },
        async routeWebSocket(pattern, handler) { calls.webSockets.push({ pattern, handler }); },
        on(event, handler) { calls.events[`context:${event}`] = handler; },
        async newPage() { return page; },
        async close() { calls.closes.push("context"); }
    };
    const browser = {
        async newContext(opts) { calls.contexts.push(opts); return context; },
        async close() { calls.closes.push("browser"); if (closeError) throw Error("private error"); }
    };
    const launch = async (opts) => { calls.launches.push(opts); if (launchPause) await launchPause; return browser; };
    return { launch, calls, page, context };
}
const shipment = (carrier = "CANPAR") => ({ carrier, trackingNumber: NUMBER, status: "LABEL_CREATED",
    trackingUrl: "https://evil.invalid/do-not-use", companyId: "synthetic-company", warehouseId: "synthetic-warehouse" });
function reader(fake, extra = {}) { return createPublicCarrierTracking({ launch: fake.launch, now: () => NOW, ...extra }); }

test("injected browser is sandboxed, ephemeral, TLS strict, no success screenshots, resources closed", async () => {
    const fake = fakeBrowser();
    const result = await reader(fake).poll(shipment(), { unverifiedTimeMode: "OBSERVED" });
    assert.equal(result.ok, true);
    assert.deepEqual(fake.calls.launches, [{ headless: true, chromiumSandbox: true, timeout: 20000 }]);
    assert.deepEqual(fake.calls.contexts, [{ ignoreHTTPSErrors: false, acceptDownloads: false,
        serviceWorkers: "block", permissions: [], javaScriptEnabled: true }]);
    assert.equal(fake.calls.urls[0].url, buildPublicTrackingUrl("CANPAR", NUMBER));
    assert.equal(fake.calls.waits[0].selector, "table#detailTable:visible");
    assert.deepEqual(fake.calls.closes, ["page", "context", "browser"]);
    assert.equal(fake.calls.screenshots.length, 0);
    assert.equal(fake.calls.routes.length, 1);
    assert.equal(fake.calls.webSockets.length, 1);
    let socketClosed = false;
    fake.calls.webSockets[0].handler({ close: () => { socketClosed = true; } });
    assert.equal(socketClosed, true);
});

test("ICS/GLS reader uses actual result selectors; default HOLD closes all resources", async () => {
    for (const [carrier, data, selector, ok] of [["ICS Ground", localSnapshot("ICS", "Delivered at: Synthetic Person"), "table[id$='_gvTracingDetail']:visible", false],
        ["GLS", await glsSnapshot(), "table:visible", true]]) {
        const fake = fakeBrowser({ data });
        const result = await reader(fake).poll(shipment(carrier));
        assert.equal(result.ok, ok);
        if (!ok) assert.equal(result.code, "TIMEZONE_REQUIRED");
        assert.equal(fake.calls.waits[0].selector, selector);
        assert.deepEqual(fake.calls.closes, ["page", "context", "browser"]);
    }
});

test("GLS DOM extraction ignores the separate piece-description table", async () => {
    const data = await glsSnapshot();
    const fake = fakeBrowser();
    const table = (rows) => ({ getClientRects: () => [{}], rows: rows.map((cells) => ({
        cells: cells.map((innerText) => ({ innerText, tagName: "TD" }))
    })) });
    const activityTable = table([["Status", "Location", "Date", "Time"], glsRow()]);
    const pieceTable = table([["#", "Type", "Quantity", "Weight", "Dimensions"], ["1", "Box", "1", "2 lb", "synthetic dimensions"]]);
    fake.page.evaluate = async (extract, arg) => {
        const priorDocument = global.document, priorStyle = global.getComputedStyle;
        try {
            global.getComputedStyle = () => ({ visibility: "visible" });
            global.document = {
                body: { innerText: `${NUMBER}\nPiece 1 of 1` },
                querySelectorAll: (css) => css === "script#__NUXT_DATA__"
                    ? [{ textContent: data.nuxtPayload }] : [pieceTable, activityTable]
            };
            return extract(arg);
        } finally {
            if (priorDocument === undefined) delete global.document; else global.document = priorDocument;
            if (priorStyle === undefined) delete global.getComputedStyle; else global.getComputedStyle = priorStyle;
        }
    };
    const result = await reader(fake).poll(shipment("GLS"));
    assert.equal(result.ok, true);
    assert.equal(result.status, "DELIVERED");
    assert.equal(result.pieceCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic dimensions|Synthetic/);
});

test("timeouts, generic provider errors, redirect and close failures contain no private text", async () => {
    const timeout = new Error("Synthetic Person 123 Fake Street"); timeout.name = "TimeoutError";
    for (const [config, code] of [[{ gotoError: timeout }, "TIMEOUT"], [{ gotoError: new Error("secret payload") }, "CARRIER_READ_FAILED"],
        [{ redirect: "https://evil.invalid" }, "TRACKING_ID_MISMATCH"], [{ hangGoto: true }, "TIMEOUT"], [{ closeError: true }, "RESOURCE_CLOSE_FAILED"]]) {
        const fake = fakeBrowser(config);
        const result = await reader(fake, { timeoutMs: 100 }).poll(shipment());
        assert.deepEqual(result, { ok: false, code });
        assert.deepEqual(fake.calls.closes, ["page", "context", "browser"]);
        assert.equal(fake.calls.screenshots.length, 0);
    }
});

test("a late injected launch is closed after deadline, never used to create a context", async () => {
    let resolve;
    const fake = fakeBrowser({ launchPause: new Promise((r) => { resolve = r; }) });
    const adapter = reader(fake, { timeoutMs: 100 });
    const result = await adapter.poll(shipment());
    assert.deepEqual(result, { ok: false, code: "TIMEOUT" });
    assert.deepEqual(await adapter.poll(shipment()), { ok: false, code: "CARRIER_BUSY" });
    resolve();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fake.calls.closes, ["browser"]);
    assert.equal(fake.calls.contexts.length, 0);
    assert.deepEqual(await adapter.poll(shipment()), { ok: false, code: "RATE_LIMITED" });
});

test("failed browser cleanup holds its carrier gate for worker recovery", async () => {
    const fake = fakeBrowser({ closeError: true });
    const adapter = reader(fake);
    assert.deepEqual(await adapter.poll(shipment()), { ok: false, code: "RESOURCE_CLOSE_FAILED" });
    assert.deepEqual(await adapter.poll(shipment()), { ok: false, code: "CARRIER_BUSY" });
    assert.equal(fake.calls.launches.length, 1);
});

test("rate limiting and single concurrency are per normalized carrier, with other carriers isolated", async () => {
    const fake = fakeBrowser({ hangGoto: true });
    const other = fakeBrowser({ hangGoto: true });
    let launches = 0;
    const adapter = reader(fake, { timeoutMs: 100, launch: (opts) => (++launches === 1 ? fake : other).launch(opts) });
    const first = adapter.poll(shipment());
    assert.deepEqual(await adapter.poll(shipment("Canpar Courier")), { ok: false, code: "CARRIER_BUSY" });
    assert.equal((await adapter.poll(shipment("ICS"))).code, "TIMEOUT");
    assert.equal((await first).code, "TIMEOUT");
    assert.deepEqual(await adapter.poll(shipment()), { ok: false, code: "RATE_LIMITED" });
    assert.equal(launches, 2);
    assert.deepEqual(fake.calls.closes, ["page", "context", "browser"]);
    assert.deepEqual(other.calls.closes, ["page", "context", "browser"]);
});

test("invalid inputs fail before launch; malformed observation cannot expose exceptions", async () => {
    const fake = fakeBrowser();
    const adapter = reader(fake);
    assert.equal((await adapter.poll(shipment(), { unverifiedTimeMode: true })).code, "INVALID_TIME_MODE");
    assert.equal((await adapter.poll({ ...shipment(), trackingNumber: "../evil" })).code, "INVALID_TRACKING_NUMBER");
    assert.equal((await adapter.poll(shipment("UPS"))).code, "UNSUPPORTED_CARRIER");
    assert.equal((await reader(fake, { now: () => "bad time" }).poll(shipment())).code, "INVALID_OBSERVATION_TIME");
    assert.equal(fake.calls.launches.length, 0);
    for (const extra of [{ minIntervalMs: 0 }, { minIntervalMs: NaN }, { timeoutMs: 99 }, { diagnosticDir: "." }, { diagnosticDir: __dirname }]) {
        assert.throws(() => reader(fake, extra));
    }
});

test("route fetch disallows redirects and blocks arbitrary egress without sending a request", async () => {
    const fake = fakeBrowser();
    // Keep poll active so its routing gate remains open while exercising it.
    let release;
    fake.page.goto = async (url) => { fake.calls.urls.push({ url }); await new Promise((r) => { release = r; }); return { ok: () => true }; };
    const polling = reader(fake).poll(shipment());
    while (!release) await new Promise((r) => setImmediate(r));
    const handler = fake.calls.routes[0].handler;
    let aborted = 0, fetched = 0, fulfilled = 0;
    const route = (req, status = 200, owner = fake.page) => ({ request: () => ({ ...req,
        frame: () => ({ parentFrame: () => null, page: () => owner }) }),
        async abort() { aborted++; }, async fetch(opts) { fetched++; assert.equal(opts.maxRedirects, 0); return { status: () => status }; },
        async fulfill() { fulfilled++; } });
    await handler(route(request("https://evil.invalid/fixture.js")));
    assert.equal(fetched, 0);
    await handler(route(request(buildPublicTrackingUrl("CANPAR", NUMBER), "GET", "document", true), 200, {}));
    assert.equal(fetched, 0); // A popup's canonical URL is still forbidden.
    await handler(route(request("https://www.canpar.com/fixture.js"), 302));
    assert.equal(fulfilled, 0);
    await handler(route(request("https://www.canpar.com/fixture.js")));
    assert.equal(fulfilled, 1);
    assert.equal(aborted, 3);
    release();
    await polling;
});

test("popup/dialog/download handlers cancel unsafe browser interactions", async () => {
    const fake = fakeBrowser();
    await reader(fake).poll(shipment());
    let closed = 0, dismissed = 0, canceled = 0;
    fake.calls.events.popup({ async close() { closed++; } });
    fake.calls.events.dialog({ async dismiss() { dismissed++; } });
    fake.calls.events.download({ async cancel() { canceled++; } });
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1); assert.equal(dismissed, 1); assert.equal(canceled, 1);
});

test("diagnostics are error-only, opt-in, private and never named using a tracking number", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "public-reader-private-test-"));
    try {
        await fs.chmod(dir, 0o700);
        const good = fakeBrowser();
        await reader(good, { diagnosticDir: dir }).poll(shipment(), { unverifiedTimeMode: "OBSERVED" });
        assert.equal(good.calls.screenshots.length, 0);
        assert.deepEqual(await fs.readdir(dir), []);
        const bad = fakeBrowser({ data: { ...localSnapshot(), identities: ["OTHER"] } });
        const result = await reader(bad, { diagnosticDir: dir }).poll(shipment());
        assert.deepEqual(result, { ok: false, code: "TRACKING_ID_MISMATCH", diagnosticCaptured: true });
        assert.equal(bad.calls.screenshots.length, 1);
        const file = bad.calls.screenshots[0].path;
        assert.equal(path.dirname(file), dir);
        assert.doesNotMatch(path.basename(file), /TEST-123/);
        assert.deepEqual(bad.calls.closes, ["page", "context", "browser"]);
        await fs.unlink(file);
    } finally { await fs.rmdir(dir); }
});
