const fs = require("fs");
const {
    APP_USER_ROLES, getPortalOrderById, updateAdminPortalOrderStatus,
    sendStoreShipmentConfirmationsForPortalOrder, sendWarehouseBillingActivityEmail, withTransaction
} = require("../server");

const apply = process.argv.includes("--apply");
const actor = { id: null, email: "prathab@greywolf3pl.com", full_name: "Owner-approved shipment update", role: APP_USER_ROLES.SUPER_ADMIN };
const expected = { "ORD-000606": { "20628693486167": 86 }, "ORD-000543": { "20628693486136": 10, "20628693486150": 10 } };
const fileName = "Healtea BOL ORD 606 and 543.pdf";
const bytes = fs.readFileSync(`C:/Users/T470/Desktop/${fileName}`);
const document = { fileName, fileType: "application/pdf", documentCategory: "SHIPMENT_BOL", dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}` };

async function validate(client, code) {
    const result = await client.query(`select o.id,o.account_name,o.status,o.shipment_method,fl.code warehouse
        from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
        where o.order_code=$1 for update of o`, [code]);
    if (result.rowCount !== 1) throw new Error(`${code}: unique order required.`);
    const row = result.rows[0];
    if (row.account_name !== "HEALTEA" || row.warehouse !== "GW3PL-MISS" || row.shipment_method !== "CUSTOMER_PICKUP") throw new Error(`${code}: ownership, warehouse or shipment type changed.`);
    const order = await getPortalOrderById(client, row.id, "HEALTEA");
    if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) throw new Error(`${code}: unexpected status ${order.status}.`);
    const lines = await client.query(`select l.id,l.sku,l.requested_quantity,coalesce(sum(a.allocated_quantity),0)::integer allocated
        from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id
        where l.order_id=$1 group by l.id order by l.id`, [row.id]);
    if (lines.rowCount !== Object.keys(expected[code]).length) throw new Error(`${code}: lines changed.`);
    for (const line of lines.rows) {
        if (expected[code][line.sku] !== Number(line.requested_quantity)) throw new Error(`${code}: quantity changed for ${line.sku}.`);
        if (order.status !== "SHIPPED" && Number(line.allocated) !== Number(line.requested_quantity)) throw new Error(`${code}: full allocation required.`);
    }
    if (order.status === "SHIPPED") {
        const facts = await client.query("select confirmed_ship_date::text,shipped_carrier_name,shipped_tracking_reference,outbound_total_pallets from portal_orders where id=$1", [row.id]);
        const f = facts.rows[0];
        if (f.confirmed_ship_date !== "2026-09-14" || f.shipped_carrier_name !== "CimTran" || f.shipped_tracking_reference !== "P063791" || Number(f.outbound_total_pallets) !== 1) throw new Error(`${code}: existing shipment conflicts.`);
    }
    return { order, lines: lines.rows };
}

async function main() {
    if (apply && process.env.CONFIRM_HEALTEA_606_543 !== "APPROVED_SEPT14_ONE_PALLET_EACH") throw new Error("Explicit shipment confirmation required.");
    const outcomes = await withTransaction(async client => {
        const checked = [];
        for (const code of Object.keys(expected)) checked.push(await validate(client, code));
        if (!apply) return checked.map(({order, lines}) => ({ order: order.orderCode, status: order.status, cases: lines.reduce((sum,l) => sum + Number(l.requested_quantity), 0), shipDate: "2026-09-14", carrier: "CimTran", bol: "P063791", pallets: 1 }));
        const saved = [];
        for (const {order, lines} of checked) {
            if (order.status === "SHIPPED") { saved.push({ order, duplicate: true }); continue; }
            let status = order.status;
            for (const next of ["PICKED", "STAGED"]) {
                if ((status === "RELEASED" && next === "PICKED") || (status === "PICKED" && next === "STAGED")) {
                    await updateAdminPortalOrderStatus(client, order.id, next, { idempotencyKey: `healtea-sept14-${order.id}-${next.toLowerCase()}` }, actor);
                    status = next;
                }
            }
            const confirmation = {
                idempotencyKey: `healtea-sept14-${order.id}-shipped`, confirmedShipDate: "2026-09-14",
                shipmentMethod: "CUSTOMER_PICKUP", carrierName: "CimTran", trackingReference: "P063791",
                packingSlipQuantityConfirmed: true, documents: [document],
                outboundPallets: { totalPalletsOut: 1, existingPalletsOut: 1, newPalletsUsed: 0, mixedPalletsBuilt: 0,
                    palletNote: "One pallet per order confirmed by owner; shared BOL P063791 lists one pallet total. Combined shipment with ORD-000606 / ORD-000543." },
                note: "Shipped together September 14, 2026 per owner confirmation and signed BOL; printed BOL date September 1 retained in source document. No individual order weights supplied.",
                shippedLines: lines.map(l => ({ orderLineId: l.id, sku: l.sku, shippedQuantity: Number(l.requested_quantity) }))
            };
            const shipped = await updateAdminPortalOrderStatus(client, order.id, "SHIPPED", confirmation, actor);
            if (shipped.status !== "SHIPPED") throw new Error(`${order.orderCode}: final status mismatch.`);
            saved.push({ order: shipped, confirmation, duplicate: false });
        }
        return saved;
    });
    if (!apply) { console.log(JSON.stringify(outcomes, null, 2)); return; }
    for (const result of outcomes) {
        if (!result.duplicate) {
            await sendStoreShipmentConfirmationsForPortalOrder(result.order, result.confirmation);
            await sendWarehouseBillingActivityEmail({ activityType: "ORDER_SHIPPED", accountName: result.order.accountName, sourceRef: result.order.orderCode,
                document: result.order, billingEvents: result.order.billingEventsCreated || [] });
        }
        console.log(JSON.stringify({ order: result.order.orderCode, status: result.order.status, duplicate: result.duplicate }));
    }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
