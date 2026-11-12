const {
    APP_USER_ROLES,
    getPortalOrderById,
    getShipmentMethodTrackingConflict,
    splitShipmentTrackingReferences,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const SHIP_DATE = "2026-10-13";
const APPLY = process.argv.includes("--apply");
const CONFIRMATION = "APPROVED_WELLFORIA_REPLACEMENT_CLOSEOUT_20261013";
const ACTOR = { id: null, email: "wms365-operations@wms365.co", full_name: "WMS365 Operations", role: APP_USER_ROLES.SUPER_ADMIN };

const ORDERS = [
    { code: "S-ORD101224", carrier: "Purolator", tracking: ["520801600690"], lines: [{ sku: "WW-12PK-EA", quantity: 1 }] },
    { code: "S-ORD101225", carrier: "UPS", tracking: ["1ZV56D262053581057"], lines: [{ sku: "WW-12PK-EA", quantity: 1 }] },
    { code: "S-ORD101226", carrier: "UPS", tracking: ["1ZV56D262055397897"], lines: [{ sku: "WW-12PK-EA", quantity: 1 }] },
    { code: "S-ORD101227", carrier: "UPS", tracking: ["1ZV56D262041257724", "1ZV56D262061669135"], lines: [{ sku: "WW-12PK-EA", quantity: 1 }, { sku: "WW-6PK-EA", quantity: 1 }] },
    { code: "S-ORD101228", carrier: "UPS", tracking: ["1ZV56D262069430814"], lines: [{ sku: "WW-12PK-EA", quantity: 1 }] },
];

function trackingText(order) { return order.tracking.join("\n"); }

async function facts(client, expected, lock = false) {
    const orderResult = await client.query(
        `select o.id,o.order_code,o.status,o.account_name,o.shipped_carrier_name,
                o.shipped_tracking_reference,o.confirmed_ship_date,fl.code warehouse_code
           from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
          where o.account_name=$1 and o.order_code=$2 limit 1${lock ? " for update of o" : ""}`,
        [ACCOUNT, expected.code]
    );
    if (orderResult.rowCount !== 1) throw new Error(`${expected.code} was not found under Wellforia.`);
    const order = orderResult.rows[0];
    const lines = (await client.query(
        `select l.id,l.line_number,l.sku,l.requested_quantity,
                coalesce(sum(a.allocated_quantity),0)::int allocated_quantity,
                array_remove(array_agg(distinct fl.code),null) warehouse_codes
           from portal_order_lines l
           left join portal_order_allocations a on a.order_line_id=l.id
           left join inventory_lines i on i.id=a.inventory_line_id
           left join bin_locations b on b.code=i.location
           left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
          where l.order_id=$1 group by l.id,l.line_number,l.sku,l.requested_quantity
          order by l.line_number,l.id`, [order.id]
    )).rows;
    const duplicatePackages = (await client.query(
        `select distinct o.order_code,trim(x.package_number) package_number
           from portal_orders o
           cross join lateral regexp_split_to_table(coalesce(o.shipped_tracking_reference,''), E'[\\n,;|]+') x(package_number)
          where upper(trim(x.package_number))=any($1::text[]) and o.id<>$2`,
        [expected.tracking.map((value) => value.toUpperCase()), order.id]
    )).rows;
    return { order, lines, duplicatePackages };
}

function validate(expected, current) {
    const errors = [];
    const { order, lines } = current;
    if (order.account_name !== ACCOUNT) errors.push("Account identity mismatch.");
    if (order.warehouse_code !== WAREHOUSE) errors.push(`Warehouse is ${order.warehouse_code || "blank"}.`);
    if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) errors.push(`Status ${order.status} is not shippable.`);
    const actualLines = lines.map((line) => ({ sku: line.sku, quantity: Number(line.requested_quantity) }));
    if (JSON.stringify(actualLines) !== JSON.stringify(expected.lines)) errors.push("SKU or quantity changed from the reviewed batch.");
    if (order.status !== "SHIPPED" && lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) errors.push("Order is not fully allocated.");
    if (lines.some((line) => (line.warehouse_codes || []).some((code) => code !== WAREHOUSE))) errors.push("An allocation is outside GW3PL-MISS.");
    if (current.duplicatePackages.length) errors.push(`Package tracking is already assigned: ${current.duplicatePackages.map((row) => `${row.package_number} (${row.order_code})`).join(", ")}.`);
    const conflict = getShipmentMethodTrackingConflict({ shipmentMethod: "PARCEL", carrierName: expected.carrier, trackingReference: trackingText(expected) });
    if (conflict) errors.push(conflict.message || "Carrier/tracking conflict.");
    if (order.shipped_carrier_name && order.shipped_carrier_name.toUpperCase() !== expected.carrier.toUpperCase()) errors.push("Existing carrier conflicts.");
    const savedPackages = splitShipmentTrackingReferences(order.shipped_tracking_reference).map((value) => value.toUpperCase()).sort();
    const expectedPackages = expected.tracking.map((value) => value.toUpperCase()).sort();
    if (savedPackages.length && JSON.stringify(savedPackages) !== JSON.stringify(expectedPackages)) errors.push("Existing tracking conflicts.");
    return errors;
}

async function processOrder(expected) {
    return withTransaction(async (client) => {
        let current = await facts(client, expected, APPLY);
        const errors = validate(expected, current);
        if (errors.length) throw new Error(errors.join(" "));
        if (!APPLY) return { orderCode: expected.code, status: current.order.status, outcome: "ready", packages: expected.tracking.length };
        if (current.order.status === "SHIPPED") return { orderCode: expected.code, status: "SHIPPED", outcome: "already-shipped", packages: expected.tracking.length };
        const key = `wellforia-replacement-20261013-${current.order.id}`;
        if (current.order.status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, current.order.id, "PICKED", { idempotencyKey: `${key}-picked` }, ACTOR);
            current = await facts(client, expected, true);
        }
        if (current.order.status === "PICKED") {
            await updateAdminPortalOrderStatus(client, current.order.id, "STAGED", { idempotencyKey: `${key}-staged` }, ACTOR);
            current = await facts(client, expected, true);
        }
        if (current.order.status !== "STAGED") throw new Error(`Expected STAGED; found ${current.order.status}.`);
        const shipped = await updateAdminPortalOrderStatus(client, current.order.id, "SHIPPED", {
            idempotencyKey: `${key}-shipped`, confirmedShipDate: SHIP_DATE, shipmentMethod: "PARCEL",
            carrierName: expected.carrier, trackingReference: trackingText(expected), packingSlipQuantityConfirmed: true,
            shippedLines: current.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: Number(line.requested_quantity) }))
        }, ACTOR);
        return { orderCode: expected.code, status: shipped.status, outcome: "shipped", packages: expected.tracking.length };
    });
}

async function verify() {
    return withTransaction(async (client) => {
        await client.query("set transaction read only");
        const results = [];
        for (const expected of ORDERS) {
            const current = await facts(client, expected);
            const detail = await getPortalOrderById(client, current.order.id, ACCOUNT);
            results.push({ orderCode: expected.code, status: detail.status, carrier: detail.shippedCarrierName,
                packages: splitShipmentTrackingReferences(detail.shippedTrackingReference), confirmedShipDate: detail.confirmedShipDate,
                shipmentEmailStatus: detail.shipmentEmailStatus });
        }
        return results;
    });
}

async function main() {
    if (APPLY && process.env.CONFIRM_WELLFORIA_REPLACEMENT_CLOSEOUT !== CONFIRMATION) throw new Error(`Set CONFIRM_WELLFORIA_REPLACEMENT_CLOSEOUT=${CONFIRMATION}.`);
    const results = [];
    for (const expected of ORDERS) {
        try { results.push(await processOrder(expected)); }
        catch (error) { results.push({ orderCode: expected.code, status: "FAILED", error: error.message || String(error) }); }
    }
    const failures = results.filter((row) => row.status === "FAILED");
    const verification = APPLY ? await verify() : [];
    const verificationFailures = verification.filter((row, index) => {
        const expected = ORDERS[index];
        return row.status !== "SHIPPED" || row.carrier.toUpperCase() !== expected.carrier.toUpperCase()
            || JSON.stringify(row.packages.map((value) => value.toUpperCase()).sort()) !== JSON.stringify(expected.tracking.map((value) => value.toUpperCase()).sort())
            || String(row.confirmedShipDate || "").slice(0, 10) !== SHIP_DATE;
    });
    console.log(JSON.stringify({ mode: APPLY ? "apply" : "preflight", results, failures, verificationFailures, verification }, null, 2));
    if (failures.length || verificationFailures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
