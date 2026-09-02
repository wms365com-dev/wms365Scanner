const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { test, expect } = require("@playwright/test");

let server;
let baseUrl;

const testAccount = {
    accountName: "WMS365 TEST COMPANY",
    featureFlags: {
        CUSTOMER_PORTAL: true,
        ORDER_ENTRY: true,
        INBOUND_NOTICES: true
    },
    portalPermissions: {
        "inventory-only": true,
        "order-entry": true,
        "inbound-entry": true,
        "document-access": true,
        billing: true,
        admin: true
    }
};

test.beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.get("/portal.html", (_request, response) => response.sendFile(path.join(__dirname, "portal.html")));
    app.get("/marketing-logo.svg", (_request, response) => response.type("image/svg+xml").send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#5c7b92"/><path d="M14 20h7l4 23 7-18 7 18 4-23h7l-8 30h-7l-7-17-7 17h-7z" fill="white"/></svg>'
    ));
    app.get("/api/build-info", (_request, response) => response.json({ version: "test", build: "portal-navigation" }));
    app.get("/api/portal/me", (_request, response) => response.json({ account: testAccount }));
    app.get("/api/portal/inventory", (request, response) => {
        const warehouseId = String(request.query.fulfillmentLocationId || "");
        const inventory = warehouseId === "test-warehouse-west"
            ? [{
                sku: "WEST-ONLY",
                description: "West warehouse test item",
                trackingLevel: "CASE",
                onHandQuantity: 7,
                availableQuantity: 7,
                locationCount: 1,
                locations: ["TEST-WEST-A1"],
                warehouseAvailability: [{ fulfillmentLocationId: "test-warehouse-west", availableQuantity: 7 }]
            }]
            : [{
                sku: "MAIN-ONLY",
                description: "Main warehouse test item",
                trackingLevel: "CASE",
                onHandQuantity: 10,
                availableQuantity: 10,
                locationCount: 1,
                locations: ["TEST-MAIN-A1"],
                warehouseAvailability: [{ fulfillmentLocationId: "test-warehouse", availableQuantity: 10 }]
            }];
        response.json({ inventory });
    });
    app.get("/api/portal/items", (_request, response) => response.json({ items: [{ sku: "MAIN-ONLY", description: "Main warehouse test item", trackingLevel: "CASE" }] }));
    app.get("/api/portal/kitting-requests", (_request, response) => response.json({ requests: [] }));
    app.get("/api/portal/invoices", (_request, response) => response.json({ invoices: [], summary: { unpaidBalance: 125 } }));
    app.get("/api/portal/orders", (_request, response) => response.json({ orders: [{
        id: "test-order-main",
        orderCode: "TEST-ORDER-MAIN",
        status: "DRAFT",
        fulfillmentLocationId: "test-warehouse",
        createdAt: "2026-09-01T13:00:00Z",
        updatedAt: "2026-09-01T14:00:00Z",
        lines: [{ sku: "MAIN-ONLY", quantity: 12, trackingLevel: "CASE" }],
        stockWarnings: [{ sku: "MAIN-ONLY", requestedQuantity: 12, availableQuantity: 10, shortQuantity: 2, trackingLevel: "CASE", message: "Two cases are not currently pickable." }]
    }, {
        id: "test-order-west",
        orderCode: "TEST-ORDER-WEST",
        status: "DRAFT",
        fulfillmentLocationId: "test-warehouse-west",
        createdAt: "2026-09-01T15:00:00Z",
        lines: [{ sku: "WEST-ONLY", quantity: 2, trackingLevel: "CASE" }],
        shipToName: "Test West Receiver",
        shipToCity: "Burnaby",
        shipToState: "British Columbia",
        shipToAddressStatus: "SAVED"
    }] }));
    app.get("/api/portal/inbounds", (_request, response) => response.json({ inbounds: [{
        id: "test-inbound-main",
        inboundCode: "TEST-INBOUND-MAIN",
        status: "SUBMITTED",
        fulfillmentLocationId: "test-warehouse",
        expectedDate: "2026-08-31",
        referenceNumber: "MAIN-ASN",
        createdAt: "2026-08-30T13:00:00Z",
        lines: [{ sku: "MAIN-ONLY", quantity: 10, trackingLevel: "CASE" }]
    }] }));
    app.get("/api/portal/delivery-appointments", (_request, response) => response.json({ appointments: [{
        id: "test-delivery-west",
        appointmentCode: "TEST-DELIVERY-WEST",
        status: "REQUESTED",
        fulfillmentLocationId: "test-warehouse-west",
        requestedDate: "2026-09-03",
        createdAt: "2026-09-01T16:00:00Z"
    }] }));
    app.get("/api/portal/fulfillment-locations", (_request, response) => response.json({ locations: [{
        fulfillmentLocationId: "test-warehouse",
        locationCode: "TEST-WH",
        locationName: "WMS365 Test Warehouse",
        city: "Mississauga",
        state: "Ontario",
        country: "Canada"
    }, {
        fulfillmentLocationId: "test-warehouse-west",
        locationCode: "TEST-WEST",
        locationName: "WMS365 Test West Warehouse",
        city: "Burnaby",
        state: "British Columbia",
        country: "Canada"
    }] }));
    app.get("/api/portal/ship-to-addresses", (_request, response) => response.json({ addressValidationAvailable: true, addressValidationProvider: "GEOAPIFY", addresses: [{
        id: "saved-destination-1",
        shipToName: "Saved Test Receiver",
        shipToAddress1: "1330 Courtney Park Drive East",
        shipToAddress2: "",
        shipToCity: "Mississauga",
        shipToState: "Ontario",
        shipToPostalCode: "L5T 1V6",
        shipToCountry: "Canada",
        verificationStatus: "SAVED"
    }] }));
    app.post("/api/portal/address-suggestions", (_request, response) => response.json({
        available: true,
        attribution: "Google Maps",
        suggestions: [{
            placeId: "test-place-1",
            text: "4400 Poth Road, Whitehall, OH 43213, USA",
            mainText: "4400 Poth Road",
            secondaryText: "Whitehall, OH 43213, USA"
        }]
    }));
    app.post("/api/portal/address-validation", (_request, response) => response.json({
        status: "VERIFIED",
        canRelease: true,
        verificationToken: "test-address-verification-token",
        recommendedAddress: {
            shipToName: "Test Receiver",
            shipToAddress1: "4400 Poth Road",
            shipToAddress2: "",
            shipToCity: "Whitehall",
            shipToState: "OH",
            shipToPostalCode: "43213",
            shipToCountry: "US"
        }
    }));
    app.post("/api/portal/address-override", (request, response) => {
        if (!request.body?.confirmationAccepted || !request.body?.overrideReason) {
            return response.status(400).json({ message: "Manual address confirmation is incomplete." });
        }
        return response.json({
            status: "OVERRIDDEN",
            canRelease: true,
            verificationToken: "test-manual-address-token"
        });
    });
    app.get("/api/portal/jobs", (_request, response) => response.json({ jobs: [] }));

    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", () => {
            const address = server.address();
            baseUrl = `http://127.0.0.1:${address.port}`;
            resolve();
        });
    });
});

test.afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
});

test("desktop navigation opens the selected workspace and supports browser history", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/portal.html`);
    await expect(page.locator("#homePanel")).toBeVisible();
    await expect(page.locator("#inventoryPanel")).toBeHidden();
    await expect(page.locator("#homeWarehouseSummary")).toContainText("WMS365 Test Warehouse");
    await expect(page.locator("#homeAttentionList")).toContainText("Inventory check required");
    await expect(page.locator("#homeAttentionList")).not.toContainText("TEST-DELIVERY-WEST");
    await expect(page.locator("#statOpenOrders")).toHaveText("1");
    await expect(page.locator("#statOpenInbounds")).toHaveText("1");
    expect(await page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(90);

    await page.getByRole("button", { name: "Sales Orders", exact: true }).click();
    await expect(page).toHaveURL(/#orders$/);
    await expect(page.locator("#ordersPanel")).toBeVisible();
    expect(await page.locator("#ordersPanel").evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeLessThanOrEqual(110);
    await expect(page.locator("#ordersPanel h2")).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL(/#home$/);
    await expect(page.locator("#homePanel")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("portal-desktop.png"), fullPage: false });
});

test("mobile navigation keeps core destinations reachable without a stacked menu", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/portal.html`);
    await expect(page.locator(".portal-mobile-nav")).toBeVisible();
    await expect(page.locator(".portal-nav-desktop")).toBeHidden();
    expect(await page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(125);
    expect(await page.locator("#homePanel").evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeLessThanOrEqual(150);
    await expect(page.locator("#homeAttentionList")).toContainText("Inventory check required");
    await page.screenshot({ path: testInfo.outputPath("portal-mobile-home.png"), fullPage: false });

    await page.locator(".portal-mobile-nav").getByRole("button", { name: "Orders", exact: true }).click();
    await expect(page.locator("#ordersPanel")).toBeVisible();
    expect(await page.locator("#ordersPanel").evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeLessThanOrEqual(150);
    await expect(page.locator("#ordersPanel h2")).toBeFocused();

    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator("#portalMobileMoreMenu")).toBeVisible();
    await expect(page.locator("#portalMobileMoreMenu").getByRole("button", { name: "Purchase Orders", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("portal-mobile-more.png"), fullPage: false });
});

test("inventory and totals follow the selected warehouse only", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/portal.html#inventory`);

    await expect(page.locator("#inventoryWarehouseSummary")).toContainText("WMS365 Test Warehouse");
    await expect(page.locator("#statQty")).toHaveText("10");
    await expect(page.locator("#inventoryList")).toContainText("MAIN-ONLY");
    await expect(page.locator("#inventoryList")).toContainText("TEST-MAIN-A1");
    await expect(page.locator("#inventoryList")).not.toContainText("WEST-ONLY");

    await page.locator("#portalWarehouseSelect").selectOption("test-warehouse-west");
    await expect(page.locator("#inventoryWarehouseSummary")).toContainText("WMS365 Test West Warehouse");
    await expect(page.locator("#statQty")).toHaveText("7");
    await expect(page.locator("#inventoryList")).toContainText("WEST-ONLY");
    await expect(page.locator("#inventoryList")).toContainText("TEST-WEST-A1");
    await expect(page.locator("#inventoryList")).not.toContainText("MAIN-ONLY");
    await expect(page.locator("#homeWarehouseSummary")).toContainText("WMS365 Test West Warehouse");
    await expect(page.locator("#homeAttentionList")).toContainText("TEST-DELIVERY-WEST");
    await expect(page.locator("#homeAttentionList")).not.toContainText("TEST-ORDER-MAIN");
    await expect(page.locator("#statOpenOrders")).toHaveText("1");
    await expect(page.locator("#statOpenInbounds")).toHaveText("0");
});

test("portal search never crosses the selected warehouse boundary", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/portal.html#home`);

    await page.locator(".portal-nav-desktop").getByRole("button", { name: "Search Portal", exact: true }).click();
    await page.locator("#portalGlobalSearchInput").fill("MAIN");
    await expect(page.locator("#portalGlobalSearchResults")).toContainText("MAIN-ONLY");
    await expect(page.locator("#portalGlobalSearchResults")).toContainText("TEST-ORDER-MAIN");
    await expect(page.locator("#portalGlobalSearchResults")).toContainText("TEST-INBOUND-MAIN");
    await expect(page.locator("#portalGlobalSearchResults")).not.toContainText("WEST-ONLY");
    await expect(page.locator("#portalGlobalSearchResults")).not.toContainText("TEST-ORDER-WEST");
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await page.locator("#portalWarehouseSelect").selectOption("test-warehouse-west");
    await page.locator(".portal-nav-desktop").getByRole("button", { name: "Search Portal", exact: true }).click();
    await page.locator("#portalGlobalSearchInput").fill("WEST");
    await expect(page.locator("#portalGlobalSearchResults")).toContainText("WEST-ONLY");
    await expect(page.locator("#portalGlobalSearchResults")).toContainText("TEST-ORDER-WEST");
    await expect(page.locator("#portalGlobalSearchResults")).not.toContainText("MAIN-ONLY");
    await expect(page.locator("#portalGlobalSearchResults")).not.toContainText("TEST-ORDER-MAIN");
});

test("mobile order entry starts with setup and only makes actions sticky after an item is added", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/portal.html#order`);

    await expect(page.locator(".order-entry-steps")).toBeVisible();
    await expect(page.locator("#orderSetupStep")).toBeVisible();
    await expect(page.locator("#orderItemsStep")).toBeVisible();
    const actionTop = await page.locator("#orderPanel > .order-actions").evaluate((element) => element.getBoundingClientRect().top);
    expect(actionTop).toBeGreaterThan(844);
    await expect(page.locator("#orderPanel")).not.toHaveClass(/order-has-lines/);
    await page.screenshot({ path: testInfo.outputPath("portal-mobile-order-start.png"), fullPage: false });

    await page.locator("[data-order-jump='orderItemsStep']").click();
    await page.locator("#orderItemSearch").fill("MAIN-ONLY");
    await page.locator("#addLineBtn").click();
    await expect(page.locator("#orderPanel")).toHaveClass(/order-has-lines/);
    await expect(page.locator("#orderLines")).toContainText("MAIN-ONLY");
    expect(await page.locator("#orderPanel > .order-actions").evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
});

test("new ship-to address flow is clear and usable on mobile", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/portal.html#order`);
    await page.locator("#orderItemSearch").fill("MAIN-ONLY");
    await page.locator("#addLineBtn").click();
    await page.locator("[data-order-jump='orderDestinationStep']").click();

    await expect(page.locator("#orderSavedShipToAddress")).toBeVisible();
    await page.locator("#orderSavedShipToAddress").selectOption("saved-destination-1");
    await expect(page.locator("#orderShipToVerificationStatus")).toContainText("Saved address");

    await page.locator("#orderSavedShipToAddress").selectOption("");
    await page.locator("#orderShipToName").fill("Test Receiver");
    await page.locator("#orderShipToAddress1").fill("4400 Poth");
    await expect(page.locator("#orderShipToSuggestions")).toBeVisible();
    await expect(page.locator("#orderShipToSuggestions")).toContainText("4400 Poth Road");
    await page.locator("#orderShipToSuggestions [data-ship-to-suggestion='0']").click();
    await expect(page.locator("#orderShipToVerificationStatus")).toContainText("Address verified");
    await expect(page.locator("#orderShipToPostalCode")).toHaveValue("43213");
    await page.screenshot({ path: testInfo.outputPath("portal-mobile-address-verified.png"), fullPage: false });
});

test("manual ship-to override is explicit and usable on mobile", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/portal.html#order`);
    await page.locator("#orderItemSearch").fill("MAIN-ONLY");
    await page.locator("#addLineBtn").click();
    await page.locator("[data-order-jump='orderDestinationStep']").click();
    await page.locator("#orderShipToName").fill("Test Rural Receiver");
    await page.locator("#orderShipToAddress1").fill("12 Concession Road 4");
    await page.locator("#orderShipToCity").fill("Uxbridge");
    await page.locator("#orderShipToState").fill("Ontario");
    await page.locator("#orderShipToPostalCode").fill("L9P 1R1");
    await page.locator("#orderShipToCountry").fill("Canada");
    await page.locator("#manualOverrideShipToAddressBtn").click();
    await expect(page.locator("#shipToManualOverridePanel")).toBeVisible();
    await page.locator("#shipToManualOverrideReason").selectOption("RURAL_OR_ALTERNATE");
    await page.locator("#shipToManualOverrideConfirmation").check();
    await page.locator("#confirmManualShipToAddressBtn").click();
    await expect(page.locator("#orderShipToVerificationStatus")).toContainText("entered manually and confirmed");
    await expect(page.locator("#releaseOrderBtn")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("portal-mobile-address-manual-confirmed.png"), fullPage: false });
});

test("critical form warnings remain visible in the current mobile viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/portal.html#order`);
    await page.locator("#orderItemSearch").fill("NOT-A-REAL-SKU");
    await page.locator("#addLineBtn").click();

    const alert = page.locator("#portalViewportAlert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Action required");
    await expect(alert).toContainText("Select an item from the search results");
    const box = await alert.boundingBox();
    expect(box).not.toBeNull();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await expect(page.locator("#portalViewportAlert .portal-viewport-alert-panel")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("portal-mobile-visible-warning.png"), fullPage: false });

    await page.locator("#portalViewportAlertClose").click();
    await expect(alert).toBeHidden();
});

test("release validation appears above the form without requiring dialog scrolling", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/portal.html#orders`);
    await page.locator("#portalWarehouseSelect").selectOption("test-warehouse-west");
    await page.locator("[data-release-order='test-order-west']").click();
    await expect(page.locator("#portalReleaseModal")).toBeVisible();
    await page.locator("#portalReleaseSubmitBtn").click();

    const message = page.locator("#portalReleaseMessage");
    await expect(message).toBeVisible();
    await expect(message).toContainText("Confirm the ship-from warehouse");
    const dialogBox = await page.locator("#portalReleaseModal .feedback-modal-dialog").boundingBox();
    const messageBox = await message.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    expect(messageBox.y).toBeGreaterThanOrEqual(dialogBox.y);
    expect(messageBox.y + messageBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height);
    await expect(message).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("portal-mobile-release-warning.png"), fullPage: false });
});
