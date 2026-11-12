"use strict";

const { Client } = require("pg");
const {
    APP_USER_ROLES,
    updateAdminPortalOrderStatus,
    correctPortalOrderPickedQuantities,
    getPortalOrderById
} = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001798";
const SHORT_SKU = "143";
const STAGED_QUANTITY = 44;
const SHORTAGE = 16;
const CARRIER = "Jagjot";
const actor = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "k.prathab@gmail.com",
    full_name: "Owner-approved ORD-001798 short staging"
};

async function load(client, lock = false) {
    const order = await client.query(`
        select o.id,o.order_code,o.account_name,o.status,o.shipped_at,o.fulfillment_location_id,
               o.po_number,o.requested_ship_date::text,o.routing_requested_delivery_date::text,
               o.outbound_total_pallets,o.routing_total_weight,o.routing_weight_uom,
               fl.code as warehouse_code
        from portal_orders o
        join fulfillment_locations fl on fl.id=o.fulfillment_location_id
        where o.order_code=$1
        ${lock ? "for update of o" : ""}
    `, [CODE]);
    if (order.rowCount !== 1) throw new Error(`${CODE} was not found uniquely.`);
    const lines = await client.query(`
        select l.id,l.sku,l.requested_quantity,
               coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_line_id=l.id),0)::integer as allocated,
               coalesce((select sum(p.quantity) from pick_confirmations p where p.line_id=l.id and p.sync_status<>'FAILED'),0)::integer as confirmed
        from portal_order_lines l
        where l.order_id=$1
        order by l.id
        ${lock ? "for update of l" : ""}
    `, [order.rows[0].id]);
    const shipments = await client.query(`
        select id,status,shipment_method,carrier_name,bol_reference,total_pallets,total_weight,
               weight_uom,delivery_date::text
        from warehouse_shipments where order_id=$1 order by id
    `, [order.rows[0].id]);
    return { order: order.rows[0], lines: lines.rows, shipments: shipments.rows };
}

function plan(snapshot) {
    const matches = snapshot.lines.filter((line) => line.sku === SHORT_SKU);
    if (matches.length !== 1) throw new Error("SKU 143 does not match exactly one order line.");
    const line = matches[0];
    if (Number(line.requested_quantity) !== STAGED_QUANTITY + SHORTAGE) {
        throw new Error(`SKU 143 requested quantity changed from expected ${STAGED_QUANTITY + SHORTAGE}.`);
    }
    return snapshot.lines.map((item) => ({
        orderLineId: item.id,
        sku: item.sku,
        quantity: item.sku === SHORT_SKU ? STAGED_QUANTITY : Number(item.allocated)
    }));
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const client = new Client({ connectionString, connectionTimeoutMillis: 15000 });
    await client.connect();
    try {
        const before = await load(client);
        const planned = plan(before);
        console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "READ_ONLY", before, planned,
            bol: { carrier: CARRIER, pallets: before.shipments[0]?.total_pallets || before.order.outbound_total_pallets,
                weight: before.shipments[0]?.total_weight || before.order.routing_total_weight,
                weightUom: before.shipments[0]?.weight_uom || before.order.routing_weight_uom,
                deliveryDate: before.shipments[0]?.delivery_date || before.order.routing_requested_delivery_date || before.order.requested_ship_date } }, null, 2));
        if (!APPLY) return;
        if (process.env.APPROVE_ORD_001798_SHORT_STAGE !== "SKU143_STAGE_44_SHORT_16") {
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
        const note = "Owner confirmed ORD-001798 short shipment: SKU143 ordered 60 cartons, stage and ship 44 cartons, shortage 16 cartons. All other lines ship in full. Stage only; do not ship.";
        let status = locked.order.status;
        if (status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, locked.order.id, "PICKING", {
                idempotencyKey: "owner-ord-001798-picking-20261029", note
            }, actor);
            status = "PICKING";
        }
        if (status === "PICKING") {
            await updateAdminPortalOrderStatus(client, locked.order.id, "PICKED", {
                idempotencyKey: "owner-ord-001798-picked-20261029", note
            }, actor);
            status = "PICKED";
        }
        if (status === "PICKED") {
            await correctPortalOrderPickedQuantities(client, locked.order.id, { lines: planned, note }, actor);
            await updateAdminPortalOrderStatus(client, locked.order.id, "STAGED", {
                idempotencyKey: "owner-ord-001798-staged-20261029", note
            }, actor);
        } else if (status === "STAGED") {
            await correctPortalOrderPickedQuantities(client, locked.order.id, { lines: planned, note }, actor);
        }
        await client.query(`update portal_orders set shipped_carrier_name=$2,
            order_notes=case when position($3 in coalesce(order_notes,''))>0 then order_notes
            else concat_ws(E'\n',nullif(order_notes,''),$3) end,updated_at=now() where id=$1`,
            [locked.order.id, CARRIER, note]);
        await client.query("update warehouse_shipments set carrier_name=$2,updated_at=now() where order_id=$1", [locked.order.id, CARRIER]);

        const saved = await getPortalOrderById(client, locked.order.id, locked.order.account_name);
        const after = await load(client);
        const expected = new Map(planned.map((line) => [line.sku, Number(line.quantity)]));
        if (saved.status !== "STAGED" || saved.shippedAt || after.order.status !== "STAGED" || after.order.shipped_at
            || after.lines.some((line) => Number(line.allocated) !== expected.get(line.sku))
            || after.shipments.length !== 1 || after.shipments[0].status !== "STAGED"
            || after.shipments[0].carrier_name !== CARRIER) {
            throw new Error("Final staging verification failed; rolling back.");
        }
        await client.query("commit");
        console.log(JSON.stringify({ verified: true, orderCode: CODE, account: after.order.account_name,
            warehouse: after.order.warehouse_code, status: after.order.status, shipped: false, carrier: CARRIER,
            lines: after.lines.map(({ sku, requested_quantity, allocated }) => ({ sku, requested_quantity, staged_quantity: allocated })),
            bol: { pallets: after.shipments[0].total_pallets, weight: after.shipments[0].total_weight,
                weightUom: after.shipments[0].weight_uom,
                deliveryDate: after.shipments[0].delivery_date || after.order.routing_requested_delivery_date || after.order.requested_ship_date } }, null, 2));
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
