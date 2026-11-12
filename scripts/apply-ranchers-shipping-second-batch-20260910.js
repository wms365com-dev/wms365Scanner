const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
    APP_USER_ROLES,
    getShipmentMethodTrackingConflict,
    getPortalOrderById,
    sendStoreShipmentConfirmationsForPortalOrder,
    sendWarehouseBillingActivityEmail,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const WAREHOUSE_CODE = "GW3PL-MISS";
const SHIP_DATE = "2026-09-10";
const SOURCE_PATH = path.resolve(__dirname, "../outputs/ranchers-shipping-second-batch-20260910.json");
const SOURCE_SHA256 = "46fcc24d239b295992855e761fdbb2846e4346900dfc23f46d0a1a931f09fda4";
const APPLY_CONFIRMATION = "APPROVED_SECOND_RANCHERS_BATCH_2026_09_10";
const APPLY = process.argv.includes("--apply");

const actor = {
    id: null,
    email: "wms365-batch-shipping@wms365.co",
    full_name: "WMS365 Approved Batch Shipping",
    role: APP_USER_ROLES.SUPER_ADMIN
};

function normalize(value) {
    return String(value || "").trim();
}

function loadSourceRows() {
    const sourceBytes = fs.readFileSync(SOURCE_PATH);
    const sourceSha256 = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    if (sourceSha256 !== SOURCE_SHA256) {
        throw new Error(`Approved source checksum changed. Expected ${SOURCE_SHA256}; found ${sourceSha256}.`);
    }
    delete require.cache[require.resolve(SOURCE_PATH)];
    const source = require(SOURCE_PATH);
    return Array.isArray(source.rows) ? source.rows : [];
}

function sourceDuplicates(rows, key) {
    const seen = new Set();
    const duplicates = new Set();
    for (const row of rows) {
        const value = normalize(row[key]);
        if (!value) continue;
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates];
}

async function getLiveFacts(client, row, { lock = false } = {}) {
    const orderResult = await client.query(
        `select o.id, o.order_code, o.status, o.account_name, o.fulfillment_location_id,
                o.shipment_method, o.shipped_carrier_name, o.shipped_tracking_reference,
                fl.code as warehouse_code,
                exists (
                    select 1 from store_order_imports soi where soi.portal_order_id=o.id
                ) as has_store_import
         from portal_orders o
         left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.account_name=$1 and o.order_code=$2
         limit 1${lock ? " for update of o" : ""}`,
        [ACCOUNT, normalize(row.orderCode)]
    );
    if (orderResult.rowCount !== 1) {
        throw new Error("Order was not found under Rancher's Chips.");
    }
    const order = orderResult.rows[0];

    const linesResult = await client.query(
        `select l.id, l.sku, l.requested_quantity,
                coalesce(sum(a.allocated_quantity),0)::integer as allocated_quantity
         from portal_order_lines l
         left join portal_order_allocations a on a.order_line_id=l.id
         where l.order_id=$1
         group by l.id, l.sku, l.requested_quantity
         order by l.line_number, l.id`,
        [order.id]
    );
    const lineQuantity = linesResult.rows.reduce((sum, line) => sum + Number(line.requested_quantity || 0), 0);
    const allocatedQuantity = linesResult.rows.reduce((sum, line) => sum + Number(line.allocated_quantity || 0), 0);

    const trackingOwnerResult = normalize(row.tracking)
        ? await client.query(
            `select order_code from portal_orders
             where account_name=$1 and shipped_tracking_reference=$2 and order_code<>$3
             limit 1`,
            [ACCOUNT, normalize(row.tracking), normalize(row.orderCode)]
        )
        : { rowCount: 0, rows: [] };

    return {
        order,
        lines: linesResult.rows,
        lineQuantity,
        allocatedQuantity,
        trackingOwner: trackingOwnerResult.rows[0]?.order_code || ""
    };
}

function validateFacts(row, facts) {
    const errors = [];
    const carrier = normalize(row.carrier);
    const tracking = normalize(row.tracking);
    const expectedQuantity = Number(row.itemQuantityEa || 0);
    const order = facts.order;

    if (!carrier || !tracking) errors.push("Carrier or tracking is blank in the spreadsheet.");
    if (normalize(order.account_name) !== ACCOUNT) errors.push("Order ownership does not match Rancher's Chips.");
    if (normalize(order.warehouse_code) !== WAREHOUSE_CODE) errors.push(`Warehouse is ${order.warehouse_code || "blank"}, not ${WAREHOUSE_CODE}.`);
    if (!order.has_store_import) errors.push("Shopify import relationship is missing.");
    if (facts.lineQuantity !== expectedQuantity) errors.push(`WMS quantity ${facts.lineQuantity} does not match spreadsheet quantity ${expectedQuantity}.`);
    if (order.status !== "SHIPPED" && facts.allocatedQuantity < facts.lineQuantity) {
        errors.push(`Allocated quantity ${facts.allocatedQuantity} is below ordered quantity ${facts.lineQuantity}.`);
    }
    if (facts.lines.some((line) => Number(line.allocated_quantity || 0) < Number(line.requested_quantity || 0)) && order.status !== "SHIPPED") {
        errors.push("At least one order line is not fully allocated.");
    }
    if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) {
        errors.push(`Order status ${order.status} cannot be shipped by this batch.`);
    }
    if (normalize(order.shipped_carrier_name) && normalize(order.shipped_carrier_name) !== carrier) {
        errors.push(`Existing carrier ${order.shipped_carrier_name} conflicts with ${carrier}.`);
    }
    if (normalize(order.shipped_tracking_reference) && normalize(order.shipped_tracking_reference) !== tracking) {
        errors.push(`Existing tracking ${order.shipped_tracking_reference} conflicts with ${tracking}.`);
    }
    if (facts.trackingOwner) errors.push(`Tracking is already assigned to ${facts.trackingOwner}.`);
    const methodConflict = getShipmentMethodTrackingConflict({
        shipmentMethod: "PARCEL",
        carrierName: carrier,
        trackingReference: tracking
    });
    if (methodConflict) errors.push(methodConflict.message || "Carrier and tracking format conflict.");
    return errors;
}

async function auditRow(row) {
    return withTransaction(async (client) => {
        const facts = await getLiveFacts(client, row);
        return {
            orderCode: row.orderCode,
            status: facts.order.status,
            carrier: row.carrier,
            tracking: row.tracking,
            quantity: facts.lineQuantity,
            errors: validateFacts(row, facts)
        };
    });
}

async function applyRow(row) {
    const confirmation = {
        confirmedShipDate: SHIP_DATE,
        shipmentMethod: "PARCEL",
        carrierName: normalize(row.carrier),
        trackingReference: normalize(row.tracking),
        packingSlipQuantityConfirmed: true
    };
    const committed = await withTransaction(async (client) => {
        let facts = await getLiveFacts(client, row, { lock: true });
        const errors = validateFacts(row, facts);
        if (errors.length) throw new Error(errors.join(" "));

        if (facts.order.status === "SHIPPED") {
            const existingOrder = await getPortalOrderById(client, facts.order.id, ACCOUNT);
            const billingResult = await client.query(
                `select * from billing_events
                 where account_name=$1 and (source_reference=$2 or source_ref=$2)
                 order by id`,
                [ACCOUNT, row.orderCode]
            );
            return { order: existingOrder, billingEvents: billingResult.rows, outcome: "already-shipped" };
        }

        if (facts.order.status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, facts.order.id, "PICKED", {
                idempotencyKey: `ranchers-second-sheet-20260910-${facts.order.id}-picked`
            }, actor);
            facts = await getLiveFacts(client, row, { lock: true });
        }
        if (facts.order.status === "PICKED") {
            await updateAdminPortalOrderStatus(client, facts.order.id, "STAGED", {
                idempotencyKey: `ranchers-second-sheet-20260910-${facts.order.id}-staged`
            }, actor);
            facts = await getLiveFacts(client, row, { lock: true });
        }
        if (facts.order.status !== "STAGED") {
            throw new Error(`Expected STAGED before shipping; found ${facts.order.status}.`);
        }

        const shippedLines = facts.lines.map((line) => ({
            orderLineId: line.id,
            sku: line.sku,
            shippedQuantity: Number(line.requested_quantity)
        }));
        const shipped = await updateAdminPortalOrderStatus(client, facts.order.id, "SHIPPED", {
            idempotencyKey: `ranchers-second-sheet-20260910-${facts.order.id}-shipped`,
            ...confirmation,
            shippedLines
        }, actor);

        if (shipped.status !== "SHIPPED") throw new Error(`Final status is ${shipped.status}, not SHIPPED.`);
        return {
            order: shipped,
            billingEvents: Array.isArray(shipped.billingEventsCreated) ? shipped.billingEventsCreated : [],
            outcome: "shipped"
        };
    });

    await sendStoreShipmentConfirmationsForPortalOrder(committed.order, confirmation, {
        isUpdate: committed.outcome === "already-shipped"
    });
    await sendWarehouseBillingActivityEmail({
        activityType: "ORDER_SHIPPED",
        accountName: committed.order.accountName,
        sourceRef: committed.order.orderCode,
        document: committed.order,
        billingEvents: committed.billingEvents
    });

    return {
        orderCode: row.orderCode,
        status: committed.order.status,
        outcome: committed.outcome,
        shopifyConfirmation: "processed",
        billingNotification: "processed"
    };
}

async function getOrderCounts() {
    return withTransaction(async (client) => {
        const result = await client.query(
            `select status, count(*)::integer as count
             from portal_orders where account_name=$1 group by status order by status`,
            [ACCOUNT]
        );
        return result.rows;
    });
}

async function main() {
    if (APPLY && process.env.CONFIRM_RANCHERS_SHIPPING_BATCH !== APPLY_CONFIRMATION) {
        throw new Error(`Set CONFIRM_RANCHERS_SHIPPING_BATCH=${APPLY_CONFIRMATION} before using --apply.`);
    }

    const rows = loadSourceRows();
    const duplicateOrders = sourceDuplicates(rows, "orderCode");
    const duplicateTracking = sourceDuplicates(rows.filter((row) => normalize(row.tracking)), "tracking");
    if (duplicateOrders.length || duplicateTracking.length) {
        throw new Error(`Source duplicates found. Orders: ${duplicateOrders.join(", ") || "none"}. Tracking: ${duplicateTracking.join(", ") || "none"}.`);
    }

    const excluded = rows.filter((row) => !normalize(row.carrier) || !normalize(row.tracking));
    const candidates = rows.filter((row) => normalize(row.carrier) && normalize(row.tracking));
    const results = [];

    for (const row of candidates) {
        try {
            const result = APPLY ? await applyRow(row) : await auditRow(row);
            results.push(result);
            if (APPLY) console.log(JSON.stringify({ progress: results.length, total: candidates.length, ...result }));
        } catch (error) {
            results.push({ orderCode: row.orderCode, status: "FAILED", errors: [error.message || String(error)] });
        }
    }

    const failures = results.filter((result) => Array.isArray(result.errors) && result.errors.length);
    const orderCounts = await getOrderCounts();
    const summary = {
        mode: APPLY ? "apply" : "audit",
        sourceRows: rows.length,
        candidates: candidates.length,
        excluded: excluded.map((row) => ({ orderCode: row.orderCode, reason: "Missing carrier or tracking" })),
        successful: results.length - failures.length,
        failed: failures.length,
        failures,
        orderCounts
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 50);
});

