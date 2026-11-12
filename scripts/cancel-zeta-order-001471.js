const {
    APP_USER_ROLES,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const ORDER_CODE = "ORD-001471";
const ACCOUNT_NAME = "ZETA GROUP (CANADA) LTD.";
const APPLY = process.argv.includes("--apply");
const actor = {
    id: null,
    email: "wms365-operations@wms365.co",
    full_name: "WMS365 Operations - Owner Approved Cancellation",
    role: APP_USER_ROLES.SUPER_ADMIN
};

async function inspect(client, lock = false) {
    const result = await client.query(
        `select o.id, o.order_code, o.account_name, o.status, o.shipped_at,
                o.shipped_tracking_reference, o.pick_ticket_email_status,
                fl.code as warehouse_code
         from portal_orders o
         left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
         where o.order_code = $1
         ${lock ? "for update of o" : ""}`,
        [ORDER_CODE]
    );
    if (result.rowCount !== 1) throw new Error(`${ORDER_CODE}: expected exactly one order, found ${result.rowCount}.`);
    const order = result.rows[0];
    if (order.account_name !== ACCOUNT_NAME) {
        throw new Error(`${ORDER_CODE}: account is ${JSON.stringify(order.account_name)}, not Zeta. No changes made.`);
    }
    if (order.shipped_at || order.shipped_tracking_reference || order.status === "SHIPPED") {
        throw new Error(`${ORDER_CODE}: order has shipment evidence or is SHIPPED. No cancellation performed.`);
    }
    if (!["DRAFT", "RELEASED", "PICKED", "STAGED", "CANCELLED"].includes(order.status)) {
        throw new Error(`${ORDER_CODE}: status ${order.status} is not safely cancellable.`);
    }

    const lines = await client.query("select sku, requested_quantity from portal_order_lines where order_id = $1 order by id", [order.id]);
    const allocations = await client.query("select count(*)::integer as rows, coalesce(sum(allocated_quantity), 0)::numeric as quantity from portal_order_allocations where order_id = $1", [order.id]);
    const shipments = await client.query("select id, status, tracking_reference from warehouse_shipments where order_id = $1 order by id", [order.id]);
    order.lines = lines.rows;
    order.allocation_rows = allocations.rows[0].rows;
    order.allocated_quantity = Number(allocations.rows[0].quantity);
    order.shipments = shipments.rows;
    return order;
}

async function main() {
    const before = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return inspect(client);
    });
    console.log(JSON.stringify({ phase: "preflight", order: before }));
    if (!APPLY) return;

    await withTransaction(async (client) => {
        const current = await inspect(client, true);
        if (current.status !== "CANCELLED") {
            await updateAdminPortalOrderStatus(client, current.id, "CANCELLED", {
                cancelReason: "Owner requested cancellation on 2026-10-13. Do not ship.",
                idempotencyKey: `owner-zeta-cancel-20261013-${current.id}`
            }, actor);
        }
    });

    const after = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return inspect(client);
    });
    if (after.status !== "CANCELLED") throw new Error(`${ORDER_CODE}: cancellation did not persist.`);
    if (after.allocation_rows !== 0 || after.allocated_quantity !== 0) throw new Error(`${ORDER_CODE}: allocations remain after cancellation.`);
    if (after.shipments.some((shipment) => shipment.status !== "CANCELLED")) {
        throw new Error(`${ORDER_CODE}: a warehouse shipment is not cancelled.`);
    }
    console.log(JSON.stringify({ phase: "verified", order: after }));
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
