const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const portalHtml = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("customer portal navigation script remains valid JavaScript", () => {
    const scripts = [...portalHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    scripts.forEach((match) => new vm.Script(match[1]));
});

test("signed-in portal uses a compact application shell", () => {
    assert.match(portalHtml, /class="portal-app-shell"/);
    assert.match(portalHtml, /class="card portal-sidebar"/);
    assert.match(portalHtml, /id="portalWorkspace" tabindex="-1"/);
    assert.match(portalHtml, /body:not\(\.portal-auth-only\) \.topbar/);
    assert.match(portalHtml, /body:not\(\.portal-auth-only\) \.topbar > \.header-copy > h1/);
    assert.match(portalHtml, /grid-template-columns: 224px minmax\(0, 1fr\)/);
});

test("home owns selected-warehouse statistics, attention, activity, and quick actions", () => {
    assert.match(portalHtml, /<section id="homePanel" class="portal-section">[\s\S]*?<div class="portal-home-overview"/);
    assert.match(portalHtml, /id="homeAttentionList"/);
    assert.match(portalHtml, /id="homeActivityList"/);
    assert.match(portalHtml, /function getActiveWarehouseRecords\(records\)/);
    assert.match(portalHtml, /function renderHomeWorkspace\(\)/);
    assert.match(portalHtml, /data-view="home">Home<\/button>/);
    assert.match(portalHtml, /portalState\.activeView = getFirstAllowedPortalView\(view\)/);
    assert.match(portalHtml, /ui\.homePanel\?\.classList\.toggle\("hidden", activeView !== "home"\)/);
});

test("mobile portal uses a five-destination bottom navigation", () => {
    assert.match(portalHtml, /class="portal-mobile-nav"/);
    assert.match(portalHtml, /id="portalMobileMoreButton"/);
    assert.match(portalHtml, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
    assert.match(portalHtml, /\.portal-sidebar \{[\s\S]*?position: fixed;[\s\S]*?inset: auto 0 0 0;/);
    assert.match(portalHtml, /function togglePortalMobileMore\(\)/);
    assert.match(portalHtml, /function closePortalMobileMore\(\)/);
});

test("portal navigation updates history and moves focus to the active screen", () => {
    assert.match(portalHtml, /function getPortalViewFromLocation\(\)/);
    assert.match(portalHtml, /function updatePortalLocation\(view, historyMode\)/);
    assert.match(portalHtml, /window\.history\[mode\]/);
    assert.match(portalHtml, /window\.addEventListener\("popstate"/);
    assert.match(portalHtml, /panel\.scrollIntoView\(\{ behavior: smooth \? "smooth" : "auto", block: "start" \}\)/);
    assert.match(portalHtml, /heading\.focus\(\{ preventScroll: true \}\)/);
    assert.match(portalHtml, /button\.setAttribute\("aria-current", "page"\)/);
});

test("mobile sales order and inbound actions stay reachable", () => {
    assert.match(portalHtml, /#orderPanel > \.order-actions/);
    assert.match(portalHtml, /#orderPanel\.order-has-lines > \.order-actions/);
    assert.match(portalHtml, /ui\.orderPanel\?\.classList\.toggle\("order-has-lines", hasLines\)/);
    assert.match(portalHtml, /#inboundPanel > \.order-actions/);
    assert.match(portalHtml, /bottom: calc\(64px \+ env\(safe-area-inset-bottom\)\)/);
});

test("sales order entry is a guided four-step workflow", () => {
    assert.match(portalHtml, /data-order-jump="orderSetupStep"/);
    assert.match(portalHtml, /data-order-jump="orderItemsStep"/);
    assert.match(portalHtml, /data-order-jump="orderDestinationStep"/);
    assert.match(portalHtml, /data-order-jump="orderDocumentsStep"/);
    assert.match(portalHtml, /function jumpToOrderStep\(button\)/);
});

test("global portal search is limited to selected-warehouse records", () => {
    assert.match(portalHtml, /id="openPortalSearchBtn"/);
    assert.match(portalHtml, /id="portalMobileSearchBtn"/);
    assert.match(portalHtml, /function getPortalSearchResults\(query\)/);
    assert.match(portalHtml, /getActiveWarehouseRecords\(portalState\.orders\)/);
    assert.match(portalHtml, /getActiveWarehouseRecords\(portalState\.inbounds\)/);
    assert.match(portalHtml, /portalState\.inventory\.map/);
});

test("portal element ids remain unique", () => {
    const ids = [...portalHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], []);
});

test("inventory requests and exports are scoped to the active warehouse", () => {
    assert.match(portalHtml, /function portalWarehouseScopedUrl\(path\)/);
    assert.match(portalHtml, /requestJson\(portalWarehouseScopedUrl\("\/api\/portal\/inventory"\)\)/);
    assert.match(portalHtml, /requestFile\(portalWarehouseScopedUrl\("\/api\/portal\/inventory\/export\.csv"\)\)/);
    assert.match(portalHtml, /changeActiveFulfillmentLocation\(ui\.portalWarehouseSelect\.value\)/);
    assert.match(serverSource, /getPortalInventorySummary\(session\.access\.accountName, pool, \{ fulfillmentLocationId \}\)/);
    assert.match(serverSource, /resolvePortalFulfillmentLocation\(client, normalizedAccount, \{ fulfillmentLocationId: requestedFulfillmentLocationId \}/);
});
