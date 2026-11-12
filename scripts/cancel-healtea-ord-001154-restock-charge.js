const {
    APP_USER_ROLES,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const ORDER_CODE = "ORD-001154";
const ACCOUNT = "HEALTEA";
const WAREHOUSE_CODE = "GW3PL-MISS";
const EXPECTED_SKU = "30627843973301";
const EXPECTED_QUANTITY = 3;
const SERVICE_DATE = "2026-10-19";
const APPLY = process.argv.includes("--apply");
const ACTOR = {
    id: null,
    email: "wms365-operations@wms365.co",
    full_name: "WMS365 Operations - Owner Approved Cancellation",
    role: APP_USER_ROLES.SUPER_ADMIN
};

async function inspect(client, lock = false) {
    const result = await client.query(
        `select o.id,o.order_code,o.account_name,o.status,o.shipped_at,o.cancelled_at,
                o.shipped_carrier_name,o.shipped_tracking_reference,
                fl.code as warehouse_code
         from portal_orders o
         join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.order_code=$1 ${lock ? "for update of o" : ""}`,
        [ORDER_CODE]
    );
    if (result.rowCount !== 1) throw new Error(`${ORDER_CODE}: expected exactly one order.`);
    const order = result.rows[0];
    if (order.account_name !== ACCOUNT || order.warehouse_code !== WAREHOUSE_CODE) {
        throw new Error(`${ORDER_CODE}: tenant or warehouse identity changed.`);
    }
    if (order.shipped_at || order.shipped_carrier_name || order.shipped_tracking_reference || order.status === "SHIPPED") {
        throw new Error(`${ORDER_CODE}: shipment evidence exists; cancellation stopped.`);
    }
    if (!["RELEASED", "CANCELLED"].includes(order.status)) {
        throw new Error(`${ORDER_CODE}: status ${order.status} is not the reviewed status.`);
    }
    const lines = await client.query(
        `select id,sku,requested_quantity from portal_order_lines where order_id=$1 order by line_number`,
        [order.id]
    );
    if (lines.rowCount !== 1 || lines.rows[0].sku !== EXPECTED_SKU
        || Number(lines.rows[0].requested_quantity) !== EXPECTED_QUANTITY) {
        throw new Error(`${ORDER_CODE}: line identity or quantity changed.`);
    }
    const allocations = await client.query(
        `select a.id,a.inventory_line_id,a.sku,a.allocated_quantity,a.location,a.lot_number,
                i.quantity as on_hand
         from portal_order_allocations a join inventory_lines i on i.id=a.inventory_line_id
         where a.order_id=$1 order by a.id`, [order.id]
    );
    if (order.status !== "CANCELLED"
        && (allocations.rowCount !== 1 || allocations.rows[0].sku !== EXPECTED_SKU
            || Number(allocations.rows[0].allocated_quantity) !== EXPECTED_QUANTITY
            || allocations.rows[0].location !== "BULK" || allocations.rows[0].lot_number !== "60526")) {
        throw new Error(`${ORDER_CODE}: reviewed stock allocation changed.`);
    }
    const shipments = await client.query(
        `select id,status,carrier_name,tracking_reference,shipped_at
         from warehouse_shipments where order_id=$1 order by id`, [order.id]
    );
    const billing = await client.query(
        `select event_key,fee_code,quantity,rate,amount,currency_code,status
         from billing_events where event_key=any($1::text[]) order by event_key`,
        [[`ORDER:${order.id}:CANCELLED_PICK_FIRST`, `ORDER:${order.id}:CANCELLED_PICK_ADDITIONAL`]]
    );
    return { order, line: lines.rows[0], allocations: allocations.rows, shipments: shipments.rows, billing: billing.rows };
}

async function resolvedRate(client, feeCode) {
    const result = await client.query(
        `select c.code,c.category,c.name,coalesce(nullif(r.unit_label,''),c.unit_label) unit_label,
                r.rate,r.is_enabled,c.is_active
         from billing_fee_catalog c join owner_billing_rates r
           on r.fee_code=c.code and r.account_name=$1
         where c.code=$2`, [ACCOUNT, feeCode]
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row.is_enabled || !row.is_active || Number(row.rate) !== 0.6) {
        throw new Error(`${feeCode}: approved HEALTEA rate changed.`);
    }
    return row;
}

async function addBillingEvent(client, fee, eventKey, quantity, description) {
    const amount = Number((quantity * Number(fee.rate)).toFixed(4));
    await client.query(
        `insert into billing_events (
            event_key,account_name,fee_code,fee_category,fee_name,unit_label,
            quantity,rate,amount,currency_code,service_date,source_type,source_ref,
            reference,note,metadata
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CAD',$10,'OUTBOUND_ORDER',$11,$11,$12,$13::jsonb)
         on conflict (event_key) do nothing`,
        [eventKey, ACCOUNT, fee.code, fee.category, description, fee.unit_label,
            quantity, Number(fee.rate), amount, SERVICE_DATE, ORDER_CODE,
            "Owner-approved charge for physically picked cases returned to stock after order cancellation.",
            JSON.stringify({ orderCode: ORDER_CODE, reason: "cancelled_after_physical_pick", returnedToStock: true })]
    );
}

async function main() {
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const before = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        const state = await inspect(client);
        const first = await resolvedRate(client, "CARTON_PICK_FEE");
        const additional = await resolvedRate(client, "ADDITIONAL_CARTON_PICK_FEE");
        return { ...state, rates: [first, additional] };
    });
    console.log(JSON.stringify({ phase: "preflight", status: before.order.status,
        account: before.order.account_name, sku: before.line.sku,
        quantity: Number(before.line.requested_quantity), allocated: before.allocations.reduce((n, row) => n + Number(row.allocated_quantity), 0),
        chargeCad: 1.8, existingBillingLines: before.billing.length }));
    if (!APPLY) return;

    await withTransaction(async (client) => {
        const current = await inspect(client, true);
        const first = await resolvedRate(client, "CARTON_PICK_FEE");
        const additional = await resolvedRate(client, "ADDITIONAL_CARTON_PICK_FEE");
        if (current.order.status !== "CANCELLED") {
            await updateAdminPortalOrderStatus(client, current.order.id, "CANCELLED", {
                cancelReason: "Owner requested cancellation after physical picking; return three cases to available stock and retain pick handling charge.",
                idempotencyKey: `owner-healtea-cancel-restock-${current.order.id}-20261019`
            }, ACTOR);
        }
        await addBillingEvent(client, first, `ORDER:${current.order.id}:CANCELLED_PICK_FIRST`, 1,
            "Cancelled order pick handling - first case");
        await addBillingEvent(client, additional, `ORDER:${current.order.id}:CANCELLED_PICK_ADDITIONAL`, 2,
            "Cancelled order pick handling - additional cases");
    });

    const after = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return inspect(client);
    });
    if (after.order.status !== "CANCELLED" || after.allocations.length !== 0
        || after.shipments.some((shipment) => shipment.status !== "CANCELLED")
        || after.billing.length !== 2
        || after.billing.some((line) => line.status !== "OPEN" || line.currency_code !== "CAD")
        || Number(after.billing.reduce((sum, line) => sum + Number(line.amount), 0).toFixed(2)) !== 1.8) {
        throw new Error(`${ORDER_CODE}: post-write cancellation, stock release, shipment, or billing verification failed.`);
    }
    console.log(JSON.stringify({ phase: "verified", order: ORDER_CODE, status: after.order.status,
        allocationsRemaining: after.allocations.length, shipmentStatuses: after.shipments.map((row) => row.status),
        billing: after.billing, totalChargeCad: 1.8 }));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
