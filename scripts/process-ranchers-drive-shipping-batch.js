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
const APPLY = process.argv.includes("--apply");
const SOURCE_PATH = path.resolve(process.env.RANCHERS_SHIPPING_SOURCE_PATH || "outputs/ranchers-drive-shipping-20260911.json");
const EXPECTED_SHA256 = String(process.env.RANCHERS_SHIPPING_SOURCE_SHA256 || "").trim().toLowerCase();
const SHIP_DATE = String(process.env.RANCHERS_SHIP_DATE || new Date().toISOString().slice(0, 10));
const RESULT_PATH = cleanPath(process.env.RANCHERS_SHIPPING_RESULT_PATH || "");
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.RANCHERS_SHIPPING_CONCURRENCY || 1)));
const ONLY_ORDER_CODES = new Set(clean(process.env.RANCHERS_SHIPPING_ONLY_ORDERS || "").toUpperCase().split(/[\s,;]+/).filter(Boolean));
const REQUIRED_CONFIRMATION = "APPROVED_RANCHERS_DRIVE_SHIPPING";
const ACTOR = {
    id: null,
    email: "wms365-drive-shipping@wms365.co",
    full_name: "WMS365 Drive Shipping Automation",
    role: APP_USER_ROLES.SUPER_ADMIN
};

function clean(value) {
    return String(value == null ? "" : value).trim();
}

function cleanPath(value) {
    const normalized = String(value == null ? "" : value).trim();
    return normalized ? path.resolve(normalized) : "";
}

function shipDateForRow(row) {
    const value = clean(row.actualShipDate) || SHIP_DATE;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new Error(`Invalid ship date ${value || "blank"}.`);
    }
    return value;
}

function trackingTokens(value) {
    return clean(value)
        .split(/[\s,;]+/)
        .map((token) => token.trim().toUpperCase().replace(/\s+/g, ""))
        .filter(Boolean);
}

function loadSource() {
    const bytes = fs.readFileSync(SOURCE_PATH);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (EXPECTED_SHA256 && sha256 !== EXPECTED_SHA256) {
        throw new Error(`Source checksum changed. Expected ${EXPECTED_SHA256}; found ${sha256}.`);
    }
    const source = JSON.parse(bytes.toString("utf8"));
    if (!source || !Array.isArray(source.rows)) throw new Error("Source JSON must contain a rows array.");
    return { ...source, sha256 };
}

function assertSourceIntegrity(rows) {
    const orderCodes = new Set();
    const seenTracking = new Map();
    const duplicateOrders = [];
    const duplicateTracking = [];
    for (const row of rows) {
        const orderCode = clean(row.orderCode).toUpperCase();
        if (!/^ORD-\d{6}$/.test(orderCode)) throw new Error(`Invalid WMS order code: ${orderCode || "blank"}.`);
        if (orderCodes.has(orderCode)) duplicateOrders.push(orderCode);
        orderCodes.add(orderCode);
        for (const token of trackingTokens(row.tracking)) {
            if (seenTracking.has(token) && seenTracking.get(token) !== orderCode) duplicateTracking.push(token);
            seenTracking.set(token, orderCode);
        }
    }
    if (duplicateOrders.length || duplicateTracking.length) {
        throw new Error(`Source duplicates found. Orders: ${[...new Set(duplicateOrders)].join(", ") || "none"}; tracking: ${[...new Set(duplicateTracking)].join(", ") || "none"}.`);
    }
}

async function getLiveFacts(client, row, { lock = false } = {}) {
    const orderResult = await client.query(
        `select o.id,o.order_code,o.status,o.account_name,o.fulfillment_location_id,o.shipment_method,
                o.shipped_carrier_name,o.shipped_tracking_reference,o.confirmed_ship_date,
                fl.code warehouse_code,
                exists(select 1 from store_order_imports soi where soi.portal_order_id=o.id) has_store_import
         from portal_orders o
         left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.account_name=$1 and o.order_code=$2
         limit 1${lock ? " for update of o" : ""}`,
        [ACCOUNT, clean(row.orderCode).toUpperCase()]
    );
    if (orderResult.rowCount !== 1) throw new Error("Order was not found under Rancher's Chips.");
    const order = orderResult.rows[0];
    const linesResult = await client.query(
        `select l.id,l.sku,l.requested_quantity,
                coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity
         from portal_order_lines l
         left join portal_order_allocations a on a.order_line_id=l.id
         where l.order_id=$1
         group by l.id,l.sku,l.requested_quantity,l.line_number
         order by l.line_number,l.id`,
        [order.id]
    );
    const otherTrackingResult = await client.query(
        `select order_code,shipped_tracking_reference from portal_orders
         where account_name=$1 and order_code<>$2 and btrim(coalesce(shipped_tracking_reference,''))<>''`,
        [ACCOUNT, order.order_code]
    );
    const requestedTokens = new Set(trackingTokens(row.tracking));
    const trackingOwners = otherTrackingResult.rows.filter((candidate) =>
        trackingTokens(candidate.shipped_tracking_reference).some((token) => requestedTokens.has(token))
    );
    return {
        order,
        lines: linesResult.rows,
        lineQuantity: linesResult.rows.reduce((sum, line) => sum + Number(line.requested_quantity || 0), 0),
        allocatedQuantity: linesResult.rows.reduce((sum, line) => sum + Number(line.allocated_quantity || 0), 0),
        trackingOwners
    };
}

function validate(row, facts) {
    const errors = [];
    const carrier = clean(row.carrier);
    const tracking = clean(row.tracking);
    const tokens = trackingTokens(tracking);
    const expectedQuantity = Number(row.itemQuantityEa || 0);
    const order = facts.order;
    if (!carrier || !tracking || !tokens.length) errors.push("Carrier or tracking is blank.");
    if (order.account_name !== ACCOUNT) errors.push("Order ownership is not Rancher's Chips.");
    if (order.warehouse_code !== WAREHOUSE_CODE) errors.push(`Warehouse is ${order.warehouse_code || "blank"}, not ${WAREHOUSE_CODE}.`);
    if (!order.has_store_import) errors.push("Shopify import relationship is missing.");
    if (!Number.isInteger(expectedQuantity) || expectedQuantity <= 0) errors.push("Spreadsheet item quantity is invalid.");
    if (facts.lineQuantity !== expectedQuantity) errors.push(`WMS quantity ${facts.lineQuantity} does not match spreadsheet quantity ${expectedQuantity}.`);
    if (order.status !== "SHIPPED" && facts.allocatedQuantity < facts.lineQuantity) {
        errors.push(`Allocated quantity ${facts.allocatedQuantity} is below ordered quantity ${facts.lineQuantity}.`);
    }
    if (!['RELEASED','PICKING','PICKED','STAGED','SHIPPED'].includes(order.status)) errors.push(`Order status ${order.status} cannot be shipped.`);
    if (clean(order.shipped_carrier_name) && clean(order.shipped_carrier_name).toUpperCase() !== carrier.toUpperCase()) {
        errors.push(`Existing carrier ${order.shipped_carrier_name} conflicts with ${carrier}.`);
    }
    const existingTokens = trackingTokens(order.shipped_tracking_reference);
    if (existingTokens.length && existingTokens.some((token) => !tokens.includes(token))) {
        errors.push(`Existing tracking ${order.shipped_tracking_reference} conflicts with the source.`);
    }
    if (facts.trackingOwners.length) {
        errors.push(`Tracking is already assigned to ${facts.trackingOwners.map((entry) => entry.order_code).join(", ")}.`);
    }
    for (const token of tokens) {
        const conflict = getShipmentMethodTrackingConflict({ shipmentMethod: "PARCEL", carrierName: carrier, trackingReference: token });
        if (conflict) errors.push(conflict.message || `Tracking ${token} does not match ${carrier}.`);
    }
    return [...new Set(errors)];
}

async function auditRow(row) {
    return withTransaction(async (client) => {
        const facts = await getLiveFacts(client, row);
        return {
            orderCode: row.orderCode,
            status: facts.order.status,
            quantity: facts.lineQuantity,
            carrier: row.carrier,
            confirmedShipDate: shipDateForRow(row),
            trackingCount: trackingTokens(row.tracking).length,
            errors: validate(row, facts)
        };
    });
}

async function applyRow(row) {
    const shipDate = shipDateForRow(row);
    const trackingReference = trackingTokens(row.tracking).join("\n");
    const baseConfirmation = {
        confirmedShipDate: shipDate,
        shipmentMethod: "PARCEL",
        carrierName: clean(row.carrier),
        trackingReference,
        packingSlipQuantityConfirmed: true
    };
    const committed = await withTransaction(async (client) => {
        let facts = await getLiveFacts(client, row, { lock: true });
        const errors = validate(row, facts);
        if (errors.length) throw new Error(errors.join(" "));

        if (facts.order.status === "SHIPPED") {
            const existingTokens = trackingTokens(facts.order.shipped_tracking_reference);
            const requestedTokens = trackingTokens(row.tracking);
            if (JSON.stringify(existingTokens) === JSON.stringify(requestedTokens)) {
                const order = await getPortalOrderById(client, facts.order.id, ACCOUNT);
                return { order, billingEvents: [], outcome: "already-shipped", confirmation: baseConfirmation };
            }
            const confirmedShipDate = facts.order.confirmed_ship_date
                ? new Date(facts.order.confirmed_ship_date).toISOString().slice(0, 10)
                : shipDate;
            const trackingHash = crypto.createHash("sha256").update(trackingReference).digest("hex").slice(0, 16);
            const enriched = await updateAdminPortalOrderStatus(client, facts.order.id, "SHIPPED", {
                idempotencyKey: `ranchers-drive-${facts.order.id}-tracking-${trackingHash}`,
                ...baseConfirmation,
                confirmedShipDate
            }, ACTOR);
            return {
                order: enriched,
                billingEvents: [],
                outcome: "tracking-enriched",
                confirmation: { ...baseConfirmation, confirmedShipDate }
            };
        }
        if (facts.order.status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, facts.order.id, "PICKING", {
                idempotencyKey: `ranchers-drive-${facts.order.id}-picking`
            }, ACTOR);
            facts = await getLiveFacts(client, row, { lock: true });
        }
        if (facts.order.status === "PICKING") {
            await updateAdminPortalOrderStatus(client, facts.order.id, "PICKED", {
                idempotencyKey: `ranchers-drive-${facts.order.id}-picked`
            }, ACTOR);
            facts = await getLiveFacts(client, row, { lock: true });
        }
        if (facts.order.status === "PICKED") {
            await updateAdminPortalOrderStatus(client, facts.order.id, "STAGED", {
                idempotencyKey: `ranchers-drive-${facts.order.id}-staged`
            }, ACTOR);
            facts = await getLiveFacts(client, row, { lock: true });
        }
        if (facts.order.status !== "STAGED") throw new Error(`Expected STAGED before shipping; found ${facts.order.status}.`);
        const shipped = await updateAdminPortalOrderStatus(client, facts.order.id, "SHIPPED", {
            idempotencyKey: `ranchers-drive-${facts.order.id}-shipped-${shipDate}`,
            ...baseConfirmation,
            shippedLines: facts.lines.map((line) => ({
                orderLineId: line.id,
                sku: line.sku,
                shippedQuantity: Number(line.requested_quantity)
            }))
        }, ACTOR);
        if (shipped.status !== "SHIPPED") throw new Error(`Final status is ${shipped.status}, not SHIPPED.`);
        return {
            order: shipped,
            billingEvents: Array.isArray(shipped.billingEventsCreated) ? shipped.billingEventsCreated : [],
            outcome: "shipped",
            confirmation: baseConfirmation
        };
    });

    if (committed.outcome === "shipped" || committed.outcome === "tracking-enriched") {
        await sendStoreShipmentConfirmationsForPortalOrder(committed.order, committed.confirmation, {
            isUpdate: committed.outcome === "tracking-enriched"
        });
    }
    if (committed.outcome === "shipped") {
        await sendWarehouseBillingActivityEmail({
            activityType: "ORDER_SHIPPED",
            accountName: committed.order.accountName,
            sourceRef: committed.order.orderCode,
            document: committed.order,
            billingEvents: committed.billingEvents
        });
    }
    return { orderCode: row.orderCode, status: committed.order.status, outcome: committed.outcome };
}

async function main() {
    if (APPLY && process.env.CONFIRM_RANCHERS_DRIVE_SHIPPING !== REQUIRED_CONFIRMATION) {
        throw new Error(`Set CONFIRM_RANCHERS_DRIVE_SHIPPING=${REQUIRED_CONFIRMATION} before --apply.`);
    }
    const source = loadSource();
    assertSourceIntegrity(source.rows);
    const candidates = source.rows.filter((row) => clean(row.carrier) && trackingTokens(row.tracking).length
        && (!ONLY_ORDER_CODES.size || ONLY_ORDER_CODES.has(clean(row.orderCode).toUpperCase())));
    const incomplete = source.rows.filter((row) => !clean(row.carrier) || !trackingTokens(row.tracking).length);
    const results = [];
    let cursor = 0;
    async function worker() {
        while (cursor < candidates.length) {
            const row = candidates[cursor++];
            let result;
            try {
                result = APPLY ? await applyRow(row) : await auditRow(row);
            } catch (error) {
                result = { orderCode: row.orderCode, status: "FAILED", errors: [error.message || String(error)] };
            }
            results.push(result);
            if (APPLY) console.log(JSON.stringify({ progress: results.length, total: candidates.length, ...result }));
        }
    }
    await Promise.all(Array.from({ length: APPLY ? CONCURRENCY : 1 }, () => worker()));
    const failures = results.filter((result) => result.errors?.length);
    const summary = {
        mode: APPLY ? "apply" : "audit",
        source: source.source || {},
        sourceSha256: source.sha256,
        sourceRows: source.rows.length,
        candidates: candidates.length,
        incomplete: incomplete.map((row) => row.orderCode),
        successful: results.length - failures.length,
        failed: failures.length,
        failures,
        outcomes: results.reduce((counts, result) => {
            const key = result.outcome || result.status || "unknown";
            counts[key] = (counts[key] || 0) + 1;
            return counts;
        }, {})
    };
    if (RESULT_PATH) {
        fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
        fs.writeFileSync(RESULT_PATH, JSON.stringify({ ...summary, results }, null, 2));
    }
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = failures.length ? 1 : 0;
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
