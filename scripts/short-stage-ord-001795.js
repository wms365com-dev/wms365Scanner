"use strict";

const { Client } = require("pg");
const {
    APP_USER_ROLES,
    updateAdminPortalOrderStatus,
    correctPortalOrderPickedQuantities,
    getPortalOrderById
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001795";
const ZERO_SKU = "135";
const SHORT_SKU = "145";
const SHORT_CASES = 12;
const actor = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "k.prathab@gmail.com",
    full_name: "Owner-approved ORD-001795 short staging"
};

async function load(client, lock = false) {
    const order = await client.query(`
        select o.id,o.order_code,o.account_name,o.status,o.shipped_at,o.fulfillment_location_id,
               fl.code as warehouse_code
        from portal_orders o
        join fulfillment_locations fl on fl.id=o.fulfillment_location_id
        where o.order_code=$1
        ${lock ? "for update of o" : ""}
    `, [CODE]);
    if (order.rowCount !== 1) throw new Error("ORD-001795 was not found uniquely.");
    const lines = await client.query(`
        select l.id,l.sku,l.requested_quantity,
               coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_line_id=l.id),0)::integer as allocated,
               coalesce((select sum(p.quantity) from pick_confirmations p where p.line_id=l.id and p.sync_status<>'FAILED'),0)::integer as confirmed
        from portal_order_lines l
        where l.order_id=$1
        order by l.id
        ${lock ? "for update of l" : ""}
    `, [order.rows[0].id]);
    const tasks = await client.query(`
        select id,task_type,status,blocked_reason
        from warehouse_tasks
        where source_type='PORTAL_ORDER' and source_id=$1
        order by id
    `, [order.rows[0].id]);
    return { order: order.rows[0], lines: lines.rows, tasks: tasks.rows };
}

function targets(snapshot) {
    const zero = snapshot.lines.filter((line) => line.sku === ZERO_SKU);
    const short = snapshot.lines.filter((line) => line.sku === SHORT_SKU);
    if (zero.length !== 1 || short.length !== 1) throw new Error("Required SKUs do not each match one order line.");
    const shortTarget = Number(short[0].requested_quantity) - SHORT_CASES;
    if (shortTarget < 0) throw new Error("SKU145 ordered quantity is less than the approved 12-case shortage.");
    return [
        { orderLineId: zero[0].id, sku: ZERO_SKU, quantity: 0 },
        { orderLineId: short[0].id, sku: SHORT_SKU, quantity: shortTarget }
    ];
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const client = new Client({ connectionString, connectionTimeoutMillis: 15000 });
    await client.connect();
    try {
        const before = await load(client, false);
        const planned = targets(before);
        console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "READ_ONLY", before, planned }, null, 2));
        if (!APPLY) return;
        if (process.env.APPROVE_ORD_001795_SHORT_STAGE !== "ZERO_135_SHORT_145_BY_12_AND_STAGE") {
            throw new Error("Order-specific approval variable is missing.");
        }
        if (before.order.shipped_at || !["RELEASED", "PICKING", "PICKED", "STAGED"].includes(before.order.status)) {
            throw new Error(`Order status ${before.order.status} is not eligible for short staging.`);
        }

        await client.query("begin");
        await client.query("set local lock_timeout='10s'");
        const locked = await load(client, true);
        if (JSON.stringify(locked.order) !== JSON.stringify(before.order)
            || JSON.stringify(locked.lines) !== JSON.stringify(before.lines)) {
            throw new Error("Order changed after preflight; retry from read-only mode.");
        }
        const note = "Owner confirmed ORD-001795 short shipment: SKU135 ships 0 cases; SKU145 ships 12 cases fewer than ordered. Other lines remain unchanged. Stage only; do not ship.";
        let status = locked.order.status;
        if (status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, locked.order.id, "PICKING", {
                idempotencyKey: "owner-ord-001795-picking-20261029", note
            }, actor);
            status = "PICKING";
        }
        if (status === "PICKING") {
            await updateAdminPortalOrderStatus(client, locked.order.id, "PICKED", {
                idempotencyKey: "owner-ord-001795-picked-20261029", note
            }, actor);
            status = "PICKED";
        }
        if (status === "PICKED") {
            await correctPortalOrderPickedQuantities(client, locked.order.id, { lines: planned, note }, actor);
            await updateAdminPortalOrderStatus(client, locked.order.id, "STAGED", {
                idempotencyKey: "owner-ord-001795-staged-20261029", note
            }, actor);
        } else if (status === "STAGED") {
            await correctPortalOrderPickedQuantities(client, locked.order.id, { lines: planned, note }, actor);
        }
        await client.query(`update portal_orders set order_notes=case when position($2 in coalesce(order_notes,''))>0 then order_notes
            else concat_ws(E'\n',nullif(order_notes,''),$2) end,updated_at=now() where id=$1`, [locked.order.id, note]);

        const saved = await getPortalOrderById(client, locked.order.id, locked.order.account_name);
        const after = await load(client, false);
        const expected = new Map(planned.map((line) => [line.sku, Number(line.quantity)]));
        const changedSkus = new Set(planned.map((line) => line.sku));
        if (saved.status !== "STAGED" || saved.shippedAt || after.order.status !== "STAGED" || after.order.shipped_at
            || after.lines.some((line) => changedSkus.has(line.sku) && Number(line.allocated) !== expected.get(line.sku))
            || after.lines.some((line) => !changedSkus.has(line.sku)
                && Number(line.allocated) !== Number(before.lines.find((old) => old.id === line.id)?.allocated))) {
            throw new Error("Final staging verification failed; rolling back.");
        }
        await client.query("commit");
        console.log(JSON.stringify({ verified: true, orderCode: CODE, account: after.order.account_name,
            warehouse: after.order.warehouse_code, status: after.order.status, shipped: false,
            lines: after.lines.map(({ sku, requested_quantity, allocated }) => ({ sku, requested_quantity, staged_quantity: allocated })) }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
