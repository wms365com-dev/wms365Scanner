const crypto = require("crypto");
const {
    APP_USER_ROLES,
    getPortalOrderById,
    getShipmentMethodTrackingConflict,
    sendStoreShipmentConfirmationsForPortalOrder,
    sendWarehouseBillingActivityEmail,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const WAREHOUSE_CODE = "GW3PL-MISS";
const SHIP_DATE = "2026-09-15";
const APPLY = process.argv.includes("--apply");
const ROWS = [
    ["ORD-000928", "ICS Standard", "ND6C2BV3PTL450J2L3A2"],
    ["ORD-000927", "ICS Standard", "ND6C2BV3PTL4N8P0H1K0"],
    ["ORD-000926", "UPS Standard", "1ZV56D262032007556"],
    ["ORD-000924", "GLS Ground", "P62139420"],
    ["ORD-000923", "ICS Standard", "ND6C2BV3PTL5XML9K0G5"],
    ["ORD-000922", "GLS Ground", "P62139431"],
    ["ORD-000921", "ICS Ground", "GR6C2BV3PTL6MZT5T4V5"],
    ["ORD-000919", "ICS Ground", "GR6C2BV3PTL6ZTC1A3R6"],
    ["ORD-000918", "GLS Ground", "P62139475"],
    ["ORD-000917", "ICS Ground", "GR6C2BV3PTL7U9T9K0M1"],
    ["ORD-000916", "GLS Ground", "P62139836"],
    ["ORD-000915", "ICS Ground", "GR6C2BV3PTL8J8V9Z0W1"],
    ["ORD-000914", "ICS Standard", "ND6C2BV3PTL8VSJ4W3E2"],
    ["ORD-000913", "GLS Ground", "P62139873"],
    ["ORD-000912", "ICS Standard", "ND6C2BV3PTL9L5J0R1T0"],
    ["ORD-000911", "ICS Ground", "GR6C2BV3PTL9YXV9T5W3"],
    ["ORD-000910", "GLS Ground", "P62139991"],
    ["ORD-000909", "ICS Ground", "GR6C2BV3PTLANFT2X0Z8"],
    ["ORD-000908", "Canpar Ground", "D420352470002702366001"],
    ["ORD-000907", "GLS Ground", "P62140061"],
    ["ORD-000906", "ICS Ground", "GR6C2BV3PTLBRDT6W3V5"],
    ["ORD-000905", "ICS Standard", "ND6C2BV3PTLC3BJ6W6H5"],
    ["ORD-000904", "GLS Ground", "P62140083"],
    ["ORD-000903", "ICS Standard", "ND6C2BV3PTLCTBH4V1X4"],
    ["ORD-000901", "ICS Ground", "GR6C2BV3PTLD5KV9W2L9"],
    ["ORD-000900", "ICS Ground", "GR6C2BV3PTLDJ2V2A3E3"],
    ["ORD-000899", "GLS Ground", "P62140186"],
    ["ORD-000897", "ICS Standard", "ND6C2BV3PTLE7WH7X3N5"],
    ["ORD-000896", "ICS Ground", "GR6C2BV3PTLELZV9X1X6"],
    ["ORD-000895", "ICS Standard", "ND6C2BV3PTLEYWN9Y1Y6"],
    ["ORD-000893", "GLS Ground", "P62140212"],
    ["ORD-000891", "UPS Standard", "1ZV56D262033854273"],
    ["ORD-000890", "ICS Ground", "GR6C2BV3PTLG0PV1N3L9"],
    ["ORD-000889", "ICS Ground", "GR6C2BV3PTLGDDT2E1S2"],
    ["ORD-000888", "ICS Standard", "ND6C2BV3PTLGRQL3Y3E8"],
    ["ORD-000887", "ICS Ground", "GR6C2BV3PTLH40V1L2T2"],
    ["ORD-000885", "GLS Ground", "P62140352"],
    ["ORD-000884", "ICS Ground", "GR6C2BV3PTLHV8T4C0W8"],
    ["ORD-000883", "ICS Standard", "ND6C2BV3PTLJ6VL1C6S6"],
    ["ORD-000882", "ICS Standard", "ND6C2BV3PTLJKHN7M0A6"],
    ["ORD-000881", "GLS Ground", "P62140433"],
    ["ORD-000879", "ICS Standard", "ND6C2BV3PTLK8UN0A1N7"],
    ["ORD-000876", "ICS Standard", "ND6C2BV3PTLKLGM4R1N5"]
].map(([orderCode, carrier, tracking]) => ({ orderCode, carrier, tracking }));

const ACTOR = {
    id: null,
    email: "wms365-approved-shipping@wms365.co",
    full_name: "WMS365 Approved Shipping",
    role: APP_USER_ROLES.SUPER_ADMIN
};

function clean(value) {
    return String(value == null ? "" : value).trim();
}

async function getFacts(client, row, { lock = false } = {}) {
    const orderResult = await client.query(
        `select o.id,o.order_code,o.status,o.account_name,o.fulfillment_location_id,
                o.shipment_method,o.shipped_carrier_name,o.shipped_tracking_reference,
                o.confirmed_ship_date,fl.code as warehouse_code,
                exists(select 1 from store_order_imports soi where soi.portal_order_id=o.id) as has_store_import
         from portal_orders o
         left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.account_name=$1 and o.order_code=$2
         limit 1${lock ? " for update of o" : ""}`,
        [ACCOUNT, row.orderCode]
    );
    if (orderResult.rowCount !== 1) throw new Error("Order was not found under Rancher's Chips.");
    const order = orderResult.rows[0];
    const [linesResult, trackingOwnerResult] = await Promise.all([
        client.query(
            `select l.id,l.sku,l.requested_quantity,
                    coalesce(sum(a.allocated_quantity),0)::integer as allocated_quantity
             from portal_order_lines l
             left join portal_order_allocations a on a.order_line_id=l.id
             where l.order_id=$1
             group by l.id,l.sku,l.requested_quantity,l.line_number
             order by l.line_number,l.id`,
            [order.id]
        ),
        client.query(
            `select order_code from portal_orders
             where account_name=$1 and order_code<>$2
               and upper(trim(shipped_tracking_reference))=upper(trim($3))
             limit 1`,
            [ACCOUNT, row.orderCode, row.tracking]
        )
    ]);
    return {
        order,
        lines: linesResult.rows,
        quantity: linesResult.rows.reduce((sum, line) => sum + Number(line.requested_quantity || 0), 0),
        allocated: linesResult.rows.reduce((sum, line) => sum + Number(line.allocated_quantity || 0), 0),
        trackingOwner: trackingOwnerResult.rows[0]?.order_code || ""
    };
}

function validate(row, facts) {
    const errors = [];
    const order = facts.order;
    if (order.account_name !== ACCOUNT) errors.push("Customer ownership mismatch.");
    if (order.warehouse_code !== WAREHOUSE_CODE) errors.push(`Warehouse is ${order.warehouse_code || "blank"}, not ${WAREHOUSE_CODE}.`);
    if (!order.has_store_import) errors.push("Shopify import relationship is missing.");
    if (!facts.lines.length || facts.quantity <= 0) errors.push("Order has no shippable quantity.");
    if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) errors.push(`Status ${order.status} cannot be shipped.`);
    if (order.status !== "SHIPPED" && facts.allocated < facts.quantity) errors.push(`Allocated ${facts.allocated}, ordered ${facts.quantity}.`);
    if (facts.lines.some((line) => order.status !== "SHIPPED" && Number(line.allocated_quantity) < Number(line.requested_quantity))) {
        errors.push("At least one line is not fully allocated.");
    }
    if (facts.trackingOwner) errors.push(`Tracking is already assigned to ${facts.trackingOwner}.`);
    const conflict = getShipmentMethodTrackingConflict({ shipmentMethod: "PARCEL", carrierName: row.carrier, trackingReference: row.tracking });
    if (conflict) errors.push(conflict.message);
    if (order.status === "SHIPPED") {
        if (clean(order.shipped_carrier_name).toUpperCase() !== row.carrier.toUpperCase()) errors.push(`Already shipped with carrier ${order.shipped_carrier_name || "blank"}.`);
        if (clean(order.shipped_tracking_reference).toUpperCase() !== row.tracking.toUpperCase()) errors.push(`Already shipped with tracking ${order.shipped_tracking_reference || "blank"}.`);
    }
    return [...new Set(errors)];
}

async function preflight(row) {
    return withTransaction(async (client) => {
        const facts = await getFacts(client, row);
        return { orderCode: row.orderCode, status: facts.order.status, quantity: facts.quantity, allocated: facts.allocated, errors: validate(row, facts) };
    });
}

async function processRow(row) {
    const result = await withTransaction(async (client) => {
        let facts = await getFacts(client, row, { lock: true });
        const errors = validate(row, facts);
        if (errors.length) throw new Error(errors.join(" "));
        if (facts.order.status === "SHIPPED") {
            return { order: await getPortalOrderById(client, facts.order.id, ACCOUNT), billingEvents: [], outcome: "already-shipped" };
        }
        const keyBase = `ranchers-approved-20260915-${facts.order.id}`;
        if (facts.order.status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, facts.order.id, "PICKED", { idempotencyKey: `${keyBase}-picked` }, ACTOR);
            facts = await getFacts(client, row, { lock: true });
        }
        if (facts.order.status === "PICKED") {
            await updateAdminPortalOrderStatus(client, facts.order.id, "STAGED", { idempotencyKey: `${keyBase}-staged` }, ACTOR);
            facts = await getFacts(client, row, { lock: true });
        }
        if (facts.order.status !== "STAGED") throw new Error(`Expected STAGED before shipping; found ${facts.order.status}.`);
        const confirmation = {
            idempotencyKey: `${keyBase}-shipped`,
            confirmedShipDate: SHIP_DATE,
            shipmentMethod: "PARCEL",
            carrierName: row.carrier,
            trackingReference: row.tracking,
            packingSlipQuantityConfirmed: true,
            shippedLines: facts.lines.map((line) => ({
                orderLineId: line.id,
                sku: line.sku,
                shippedQuantity: Number(line.requested_quantity)
            }))
        };
        const shipped = await updateAdminPortalOrderStatus(client, facts.order.id, "SHIPPED", confirmation, ACTOR);
        if (shipped.status !== "SHIPPED") throw new Error(`Final status is ${shipped.status}.`);
        return { order: shipped, billingEvents: shipped.billingEventsCreated || [], confirmation, outcome: "shipped" };
    });
    if (result.outcome === "shipped") {
        await sendStoreShipmentConfirmationsForPortalOrder(result.order, result.confirmation, { isUpdate: false });
        await sendWarehouseBillingActivityEmail({
            activityType: "ORDER_SHIPPED",
            accountName: result.order.accountName,
            sourceRef: result.order.orderCode,
            document: result.order,
            billingEvents: result.billingEvents
        });
    }
    return { orderCode: row.orderCode, status: result.order.status, quantity: result.order.lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0), outcome: result.outcome };
}

async function main() {
    const orderCodes = ROWS.map((row) => row.orderCode);
    const trackings = ROWS.map((row) => row.tracking);
    if (new Set(orderCodes).size !== ROWS.length || new Set(trackings).size !== ROWS.length) throw new Error("The approved input contains duplicate orders or tracking numbers.");
    const results = [];
    for (const row of ROWS) {
        try {
            const result = APPLY ? await processRow(row) : await preflight(row);
            results.push(result);
            if (APPLY) console.log(JSON.stringify({ progress: results.length, total: ROWS.length, ...result }));
        } catch (error) {
            results.push({ orderCode: row.orderCode, status: "FAILED", errors: [error.message || String(error)] });
        }
    }
    const failed = results.filter((result) => result.errors?.length);
    const summary = {
        mode: APPLY ? "APPLIED" : "PREFLIGHT",
        shipDate: SHIP_DATE,
        requested: ROWS.length,
        successful: results.length - failed.length,
        failed: failed.length,
        totalQuantity: results.filter((result) => !result.errors).reduce((sum, result) => sum + Number(result.quantity || 0), 0),
        results
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failed.length) process.exitCode = 2;
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
