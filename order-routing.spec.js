const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("sales order stores routing contact, shipment weight, and route history", () => {
    assert.match(server, /add column if not exists routing_email/);
    assert.match(server, /add column if not exists routing_total_weight/);
    assert.match(server, /add column if not exists routing_requested_delivery_date/);
    assert.match(server, /add column if not exists routed_at/);
    assert.match(desktop, /id="warehouseOrderRoutingEmail"/);
    assert.match(desktop, /id="warehouseOrderRoutingWeight"/);
    assert.match(desktop, /id="warehouseOrderRoutingPallets"/);
    assert.match(desktop, /id="warehouseOrderRoutingDeliveryDate"/);
});

test("blank optional routing delivery dates are stored as null", () => {
    assert.match(server, /routing_requested_delivery_date = nullif\(\$28, ''\)::date/);
    assert.match(server, /\$26, \$27, nullif\(\$28, ''\)::date(?:, \$29|\))/);
});

test("routing library is specific to company, ship-from, and ship-to", () => {
    assert.match(server, /create table if not exists order_routing_templates/);
    assert.match(server, /account_name = \$1 and fulfillment_location_id = \$2 and is_active = true/);
    assert.match(server, /ship_to_name_match/);
    assert.match(server, /ship_to_address_match/);
    assert.match(server, /ship_to_postal_match/);
    assert.match(server, /Alcona - Edwards to Nutem Clay/);
});

test("route order creates a review draft before sending", () => {
    assert.match(server, /\/routing-draft"/);
    assert.match(server, /\/route"/);
    assert.match(desktop, /id="orderRoutingDraftModal"/);
    assert.match(desktop, /No email has been sent yet/);
    assert.match(desktop, /id="sendOrderRoutingEmailBtn"/);
});

test("routing is limited to staged orders and missing details use one clear popup", () => {
    assert.match(server, /must be STAGED before it can be routed/);
    assert.match(desktop, /getWarehouseOrderRoutingRequirements/);
    assert.match(desktop, /This order cannot be routed yet\. Please complete/);
    assert.match(desktop, /window\.alert\(message\)/);
    assert.match(desktop, /Order status must be STAGED/);
});

test("routing email always copies Grey Wolf orders", () => {
    assert.match(server, /const ORDER_ROUTING_CC_EMAIL = "gworders@greywolf3pl\.com"/);
    assert.match(server, /cc: \[ORDER_ROUTING_CC_EMAIL\]/);
    assert.match(desktop, /CC gworders@greywolf3pl\.com/);
});

test("routing email includes a secure one-time delivery appointment link", () => {
    assert.match(server, /create table if not exists order_routing_requests/);
    assert.match(server, /order_id bigint not null unique/);
    assert.match(server, /crypto\.randomBytes\(32\)/);
    assert.match(server, /Provide Delivery Appointment/);
    assert.match(server, /window_start/);
    assert.match(server, /window_end/);
    assert.match(server, /end time must be later than the start time/i);
    assert.match(server, /This delivery appointment has already been submitted/);
});

test("route action is permanently disabled after the email is sent", () => {
    assert.match(server, /was already routed and cannot be routed again/);
    assert.match(desktop, /const alreadyRouted = !!order\?\.routedAt/);
    assert.match(desktop, /button\.disabled = !canRouteOrder \|\| alreadyRouted/);
    assert.match(desktop, /Routing can only be sent once/);
});

test("routing email has a durable per-order duplicate-send block", () => {
    assert.match(server, /add column if not exists delivery_key/);
    assert.match(server, /create unique index if not exists idx_email_delivery_log_delivery_key/);
    assert.match(server, /String\(error\?\.code \|\| ""\) !== "23505"/);
    assert.match(server, /const deliveryKey = `order-routing:\$\{draft\.order\.id\}`/);
    assert.match(server, /This \$\{label\} already has a \$\{deliveryClaim\.status\.toLowerCase\(\)\} delivery record\. It was not sent again\./);
    assert.match(server, /headers\["Idempotency-Key"\] = deliveryKey/);
});

test("confirmed appointment is returned and displayed on the sales order", () => {
    assert.match(server, /rr\.appointment_date as routing_appointment_date/);
    assert.match(server, /routingAppointment: row\.routing_appointment_status/);
    assert.match(desktop, /id="warehouseOrderRoutingAppointment"/);
    assert.match(desktop, /Delivery appointment confirmed/);
    assert.match(desktop, /Waiting for the recipient to provide the delivery date and time window/);
});

test("routing template contains requested date, PO, pallets, weight, and destination", () => {
    for (const token of ["greeting", "requested_delivery_date", "po_number", "total_pallets", "total_weight", "ship_to_name", "ship_to_address1"]) {
        assert.match(server, new RegExp(`\\{\\{${token}\\}\\}`));
    }
});
