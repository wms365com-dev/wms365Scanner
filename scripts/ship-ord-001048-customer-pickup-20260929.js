const {
    APP_USER_ROLES,
    getPortalOrderById,
    updateAdminPortalOrderStatus,
    sendStoreShipmentConfirmationsForPortalOrder,
    sendWarehouseBillingActivityEmail,
    withTransaction
} = require("../server");

const apply = process.argv.includes("--apply");
const code = "ORD-001048";
const account = "PURE FOODS BY ESTEE";
const warehouse = "GW3PL-MISS";
const shipDate = "2026-09-29";
const quantities = new Map([["143", 2], ["142", 2], ["148", 1], ["138", 2]]);
const actor = {
    id: null,
    email: "prathab@greywolf3pl.com",
    full_name: "Owner-confirmed customer pickup",
    role: APP_USER_ROLES.SUPER_ADMIN
};

async function inspect(client, { lock = false } = {}) {
    const row = await client.query(
        `select o.id, o.account_name, o.status, o.shipment_method,
                o.confirmed_ship_date::text as confirmed_ship_date,
                o.shipped_carrier_name, o.shipped_tracking_reference,
                fl.code as warehouse
         from portal_orders o
         left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
         where o.order_code = $1 ${lock ? "for update of o" : ""}`,
        [code]
    );
    if (row.rowCount !== 1) throw new Error(`${code}: unique order required`);
    const facts = row.rows[0];
    if (facts.account_name !== account || facts.warehouse !== warehouse) {
        throw new Error(`${code}: account or warehouse mismatch`);
    }
    if (!["STAGED", "SHIPPED"].includes(facts.status)) {
        throw new Error(`${code}: unexpected status ${facts.status}`);
    }
    const lines = await client.query(
        `select l.id, l.sku, l.requested_quantity,
                coalesce(sum(a.allocated_quantity), 0)::integer as allocated
         from portal_order_lines l
         left join portal_order_allocations a on a.order_line_id = l.id
         where l.order_id = $1
         group by l.id order by l.id`,
        [facts.id]
    );
    if (lines.rowCount !== quantities.size) throw new Error(`${code}: line count mismatch`);
    for (const line of lines.rows) {
        if (Number(line.requested_quantity) !== quantities.get(line.sku)) {
            throw new Error(`${code}: quantity mismatch for ${line.sku}`);
        }
        if (facts.status === "STAGED" && Number(line.allocated) !== Number(line.requested_quantity)) {
            throw new Error(`${code}: incomplete allocation for ${line.sku}`);
        }
    }
    const order = await getPortalOrderById(client, facts.id, account);
    if (!order || order.status !== facts.status) throw new Error(`${code}: order view mismatch`);
    return { facts, order, lines: lines.rows };
}

async function main() {
    if (apply && process.env.CONFIRM_ORD_001048_PICKUP !== "OWNER_CONFIRMED_2026_09_29") {
        throw new Error("Explicit owner pickup confirmation required");
    }
    const result = await withTransaction(async (client) => {
        const { facts, order, lines } = await inspect(client, { lock: apply });
        if (facts.status === "SHIPPED") {
            if (facts.confirmed_ship_date !== shipDate || facts.shipped_tracking_reference ||
                facts.shipped_carrier_name !== "Customer Pickup" || facts.shipment_method !== "CUSTOMER_PICKUP") {
                throw new Error(`${code}: existing shipment conflicts with confirmed pickup`);
            }
            return { order, duplicate: true };
        }
        if (facts.shipped_carrier_name || facts.shipped_tracking_reference) {
            throw new Error(`${code}: unexpected carrier or tracking before shipment`);
        }
        const confirmation = {
            idempotencyKey: "ord-001048-customer-pickup-2026-09-29",
            confirmedShipDate: shipDate,
            shipmentMethod: "CUSTOMER_PICKUP",
            shippedCarrierName: "Customer Pickup",
            shippedTrackingReference: "",
            packingSlipQuantityConfirmed: true,
            outboundPallets: {
                totalPalletsOut: 1,
                existingPalletsOut: 1,
                newPalletsUsed: 0,
                mixedPalletsBuilt: 0,
                palletNote: "One pallet and seven boxes recorded on the checked pick ticket. Pallet origin not documented."
            },
            note: "Owner confirmed physical customer pickup on 2026-09-29. Seven cases across four SKUs per checked pick ticket supplied by owner. Attachment is a pick ticket, not a signed BOL or pickup receipt. No carrier tracking for customer pickup.",
            shippedLines: lines.map((line) => ({
                orderLineId: line.id,
                sku: line.sku,
                shippedQuantity: Number(line.requested_quantity)
            }))
        };
        if (!apply) return { order: code, status: facts.status, shipDate, method: confirmation.shipmentMethod, lines: confirmation.shippedLines };
        const shipped = await updateAdminPortalOrderStatus(client, order.id, "SHIPPED", confirmation, actor);
        if (shipped.status !== "SHIPPED") throw new Error(`${code}: shipment did not complete`);
        return { order: shipped, confirmation, duplicate: false };
    });
    if (!apply) {
        console.log(JSON.stringify(result));
        return;
    }
    if (!result.duplicate) {
        await sendStoreShipmentConfirmationsForPortalOrder(result.order, result.confirmation);
        await sendWarehouseBillingActivityEmail({
            activityType: "ORDER_SHIPPED",
            accountName: result.order.accountName,
            sourceRef: result.order.orderCode,
            document: result.order,
            billingEvents: result.order.billingEventsCreated || []
        });
    }
    console.log(JSON.stringify({ order: result.order.orderCode, status: result.order.status, duplicate: result.duplicate }));
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
