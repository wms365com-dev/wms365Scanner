const {
    APP_USER_ROLES,
    getPortalOrderById,
    getShipmentMethodTrackingConflict,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const SHIP_DATE = "2026-10-07";
const APPLY = process.argv.includes("--apply");
const REQUIRED_CONFIRMATION = "APPROVED_WELLFORIA_CONSUMER_CLOSEOUT_20261007";
const ACTOR = {
    id: null,
    email: "wms365-operations@wms365.co",
    full_name: "WMS365 Operations",
    role: APP_USER_ROLES.SUPER_ADMIN
};

const ROWS = [
    ["S-ORD101184", "UPS", "1ZV56D262018709244", "WW-12PK-EA", 1],
    ["S-ORD101185", "UPS", "1ZV56D262019099625", "WW-12PK-EA", 1],
    ["S-ORD101186", "UPS", "1ZV56D262025036707", "WW-6PK-EA", 1],
    ["S-ORD101187", "Canpar", "D420352470002790445001", "WW-12PK-EA", 1],
    ["S-ORD101188", "UPS", "1ZV56D262014430800", "WW-6PK-EA", 1],
    ["S-ORD101189", "UPS", "1ZV56D262024245699", "WW-12PK-EA", 1],
    ["S-ORD101190", "UPS", "1ZV56D262009269611", "WW-12PK-EA", 2],
    ["S-ORD101191", "UPS", "1ZV56D262000925516", "WW-12PK-EA", 1],
    ["S-ORD101192", "UPS", "1ZV56D262025708562", "WW-12PK-EA", 1],
    ["S-ORD101193", "UPS", "1ZV56D262015221570", "WW-12PK-EA", 1],
    ["S-ORD101194", "UPS", "1ZV56D262033318754", "WW-12PK-EA", 1],
    ["S-ORD101195", "UPS", "1ZV56D262007496736", "WW-12PK-EA", 1],
    ["S-ORD101196", "Canpar", "D420352470002790444001", "WW-12PK-EA", 1],
    ["S-ORD101197", "UPS", "1ZV56D262002549143", "WW-12PK-EA", 1],
    ["S-ORD101198", "UPS", "1ZV56D262022960482", "WW-12PK-EA", 1],
    ["S-ORD101199", "UPS", "1ZV56D262018839194", "WW-12PK-EA", 1],
    ["S-ORD101200", "UPS", "1ZV56D262021338746", "WW-12PK-EA", 1],
    ["S-ORD101201", "Canpar", "D420352470002790443001", "WW-12PK-EA", 1],
    ["S-ORD101202", "UPS", "1ZV56D262038192121", "WW-12PK-EA", 1],
    ["S-ORD101203", "UPS", "1ZV56D262020112179", "WW-12PK-EA", 2],
    ["S-ORD101204", "UPS", "1ZV56D262021017511", "WW-12PK-EA", 1],
    ["S-ORD101205", "UPS", "1ZV56D262019707566", "WW-12PK-EA", 1],
    ["S-ORD101206", "UPS", "1ZV56D262010544838", "WW-6PK-EA", 1],
    ["S-ORD101207", "UPS", "1ZV56D262012030782", "WW-12PK-EA", 1],
    ["S-ORD101208", "UPS", "1ZV56D262030053581", "WW-12PK-EA", 1],
    ["S-ORD101209", "UPS", "1ZV56D262026484534", "WW-6PK-EA", 1],
    ["S-ORD101210", "UPS", "1ZV56D262017264753", "WW-6PK-EA", 1],
    ["S-ORD101211", "UPS", "1ZV56D262007723525", "WW-12PK-EA", 1]
].map(([orderCode, carrier, tracking, sku, quantity]) => ({ orderCode, carrier, tracking, sku, quantity }));

async function facts(client, row, lock = false) {
    const orderResult = await client.query(
        `select o.id,o.order_code,o.status,o.account_name,o.shipped_carrier_name,
                o.shipped_tracking_reference,o.confirmed_ship_date,fl.code warehouse_code
         from portal_orders o
         left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.account_name=$1 and o.order_code=$2
         limit 1${lock ? " for update of o" : ""}`,
        [ACCOUNT, row.orderCode]
    );
    if (orderResult.rowCount !== 1) throw new Error("Order not found under the expected account.");
    const linesResult = await client.query(
        `select l.id,l.sku,l.requested_quantity,
                coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity,
                array_remove(array_agg(distinct fl.code),null) warehouse_codes
         from portal_order_lines l
         left join portal_order_allocations a on a.order_line_id=l.id
         left join inventory i on i.id=a.inventory_id
         left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
         where l.order_id=$1
         group by l.id,l.sku,l.requested_quantity,l.line_number
         order by l.line_number,l.id`,
        [orderResult.rows[0].id]
    );
    const trackingResult = await client.query(
        `select order_code from portal_orders
         where upper(btrim(coalesce(shipped_tracking_reference,'')))=$1
           and id<>$2`,
        [row.tracking.toUpperCase(), orderResult.rows[0].id]
    );
    return { order: orderResult.rows[0], lines: linesResult.rows, trackingOwners: trackingResult.rows };
}

function validate(row, current) {
    const errors = [];
    const { order, lines } = current;
    if (order.account_name !== ACCOUNT) errors.push("Account identity mismatch.");
    if (order.warehouse_code !== WAREHOUSE) errors.push(`Order warehouse is ${order.warehouse_code || "blank"}.`);
    if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) errors.push(`Status ${order.status} cannot be closed.`);
    if (lines.length !== 1 || lines[0].sku !== row.sku || Number(lines[0].requested_quantity) !== row.quantity) {
        errors.push("SKU or quantity does not match the reviewed shipping sheet.");
    }
    if (order.status !== "SHIPPED" && lines.some((line) => Number(line.allocated_quantity) < Number(line.requested_quantity))) {
        errors.push("Order is not fully allocated.");
    }
    if (lines.some((line) => (line.warehouse_codes || []).some((code) => code !== WAREHOUSE))) {
        errors.push("An allocation is outside GW3PL-MISS.");
    }
    if (current.trackingOwners.length) errors.push(`Tracking is already assigned to ${current.trackingOwners.map((x) => x.order_code).join(", ")}.`);
    const trackingConflict = getShipmentMethodTrackingConflict({
        shipmentMethod: "PARCEL",
        carrierName: row.carrier,
        trackingReference: row.tracking
    });
    if (trackingConflict) errors.push(trackingConflict.message || "Carrier and tracking do not match.");
    if (order.shipped_carrier_name && order.shipped_carrier_name.toUpperCase() !== row.carrier.toUpperCase()) errors.push("Existing carrier conflicts.");
    if (order.shipped_tracking_reference && order.shipped_tracking_reference.toUpperCase() !== row.tracking.toUpperCase()) errors.push("Existing tracking conflicts.");
    return errors;
}

async function processRow(row) {
    return withTransaction(async (client) => {
        let current = await facts(client, row, APPLY);
        const errors = validate(row, current);
        if (errors.length) throw new Error(errors.join(" "));
        if (!APPLY) return { orderCode: row.orderCode, status: current.order.status, outcome: "ready" };
        if (current.order.status === "SHIPPED") return { orderCode: row.orderCode, status: "SHIPPED", outcome: "already-shipped" };
        const key = `wellforia-consumer-20261007-${current.order.id}`;
        if (current.order.status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, current.order.id, "PICKED", { idempotencyKey: `${key}-picked` }, ACTOR);
            current = await facts(client, row, true);
        }
        if (current.order.status === "PICKED") {
            await updateAdminPortalOrderStatus(client, current.order.id, "STAGED", { idempotencyKey: `${key}-staged` }, ACTOR);
            current = await facts(client, row, true);
        }
        if (current.order.status !== "STAGED") throw new Error(`Expected STAGED; found ${current.order.status}.`);
        const shipped = await updateAdminPortalOrderStatus(client, current.order.id, "SHIPPED", {
            idempotencyKey: `${key}-shipped`,
            confirmedShipDate: SHIP_DATE,
            shipmentMethod: "PARCEL",
            carrierName: row.carrier,
            trackingReference: row.tracking,
            packingSlipQuantityConfirmed: true,
            shippedLines: current.lines.map((line) => ({
                orderLineId: line.id,
                sku: line.sku,
                shippedQuantity: Number(line.requested_quantity)
            }))
        }, ACTOR);
        if (shipped.status !== "SHIPPED") throw new Error(`Final status is ${shipped.status}.`);
        return { orderCode: row.orderCode, status: shipped.status, outcome: "shipped" };
    });
}

async function verify() {
    return withTransaction(async (client) => {
        await client.query("set transaction read only");
        const results = [];
        for (const row of ROWS) {
            const current = await facts(client, row);
            const detail = await getPortalOrderById(client, current.order.id, ACCOUNT);
            results.push({
                orderCode: row.orderCode,
                status: detail.status,
                carrier: detail.shippedCarrierName,
                tracking: detail.shippedTrackingReference,
                confirmedShipDate: detail.confirmedShipDate,
                shipmentEmailStatus: detail.shipmentEmailStatus
            });
        }
        return results;
    });
}

async function main() {
    if (APPLY && process.env.CONFIRM_WELLFORIA_CONSUMER_CLOSEOUT !== REQUIRED_CONFIRMATION) {
        throw new Error(`Set CONFIRM_WELLFORIA_CONSUMER_CLOSEOUT=${REQUIRED_CONFIRMATION} before --apply.`);
    }
    const results = [];
    for (const row of ROWS) {
        try {
            const result = await processRow(row);
            results.push(result);
            console.log(JSON.stringify({ progress: results.length, total: ROWS.length, ...result }));
        } catch (error) {
            results.push({ orderCode: row.orderCode, status: "FAILED", error: error.message || String(error) });
        }
    }
    const failures = results.filter((result) => result.status === "FAILED");
    const verification = APPLY ? await verify() : [];
    const verificationFailures = verification.filter((result, index) =>
        result.status !== "SHIPPED"
        || result.carrier.toUpperCase() !== ROWS[index].carrier.toUpperCase()
        || result.tracking.toUpperCase() !== ROWS[index].tracking.toUpperCase()
        || String(result.confirmedShipDate || "").slice(0, 10) !== SHIP_DATE
    );
    console.log(JSON.stringify({ mode: APPLY ? "apply" : "preflight", total: ROWS.length, failures, verificationFailures, verification }, null, 2));
    if (failures.length || verificationFailures.length) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
