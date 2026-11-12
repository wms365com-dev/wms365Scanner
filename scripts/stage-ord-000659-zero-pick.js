"use strict";

const { Client } = require("pg");
const { APP_USER_ROLES, updateAdminPortalOrderStatus, correctPortalOrderPickedQuantities, getPortalOrderById } = require("../server");

const CODE = "ORD-000659";
const ACCOUNT = "HEALTEA";
const EXCLUDED = "30628693486072";
const expected = new Map([["30627843973301", 72], [EXCLUDED, 32], ["30627843973318", 36], ["30627843973325", 36]]);
const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "k.prathab@gmail.com", full_name: "Owner-approved ORD-000659 zero-pick staging" };
const note = "Owner confirmed no 30628693486072 is being shipped on ORD-000659: 0 picked/staged out of 32 ordered cases. Other lines picked complete. Release excluded reservations; preserve ordered quantities and on-hand stock. Stage only; do not ship or move stock to investigation.";

async function main() {
    if (process.env.APPROVE_ORD659_STAGE !== "EXCLUDE_30628693486072_AND_STAGE") throw new Error("Explicit order-specific approval required.");
    const client = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    await client.connect();
    try {
        await client.query("begin");
        await client.query("set local lock_timeout = '10s'");
        const result = await client.query(`select o.id,o.status,o.shipped_at,fl.code warehouse
            from portal_orders o join fulfillment_locations fl on fl.id=o.fulfillment_location_id
            where o.order_code=$1 and o.account_name=$2 for update of o`, [CODE, ACCOUNT]);
        const row = result.rows[0];
        if (result.rowCount !== 1 || String(row.id) !== "659" || row.warehouse !== "GW3PL-MISS" || row.shipped_at
            || !["RELEASED", "PICKED", "STAGED"].includes(row.status)) throw new Error("Order scope or status changed; stopping.");
        const lines = await client.query(`select l.id,l.sku,l.requested_quantity,
            coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_line_id=l.id),0)::integer allocated,
            coalesce((select sum(p.quantity) from pick_confirmations p where p.line_id=l.id and p.sync_status<>'FAILED'),0)::integer confirmed
            from portal_order_lines l where l.order_id=$1 order by l.id for update of l`, [row.id]);
        if (lines.rowCount !== expected.size || new Set(lines.rows.map(l => l.sku)).size !== expected.size
            || lines.rows.some(l => Number(l.requested_quantity) !== expected.get(l.sku)
                || (l.sku === EXCLUDED ? l.confirmed !== 0 || ![0,32].includes(l.allocated) : l.allocated !== expected.get(l.sku)))) {
            throw new Error("Order quantities or pick evidence require review.");
        }
        const blocked = await client.query("select 1 from warehouse_tasks where source_type='PORTAL_ORDER' and source_id=$1 and status='BLOCKED' limit 1", [row.id]);
        if (blocked.rowCount) throw new Error("Blocked warehouse work needs review.");
        const stock = await client.query("select id,quantity from inventory_lines where account_name=$1 and sku=$2 order by id for update", [ACCOUNT, EXCLUDED]);
        const beforeStock = JSON.stringify(stock.rows);
        if (row.status === "RELEASED") await updateAdminPortalOrderStatus(client, row.id, "PICKED", {
            idempotencyKey: "owner-ord659-picked-exclude-hibiscus-20260917", note
        }, actor);
        const excluded = lines.rows.find(l => l.sku === EXCLUDED);
        await correctPortalOrderPickedQuantities(client, row.id, { lines: [{ orderLineId: excluded.id, sku: EXCLUDED, quantity: 0 }], note }, actor);
        await client.query(`update portal_orders set order_notes=case when position($2 in coalesce(order_notes,''))>0 then order_notes
            else concat_ws(E'\n',nullif(order_notes,''),$2) end,updated_at=now() where id=$1`, [row.id, note]);
        await updateAdminPortalOrderStatus(client, row.id, "STAGED", {
            idempotencyKey: "owner-ord659-staged-exclude-hibiscus-20260917", note
        }, actor);
        const saved = await getPortalOrderById(client, row.id, ACCOUNT);
        const afterLines = await client.query(`select l.sku,l.requested_quantity,
            coalesce(sum(a.allocated_quantity),0)::integer allocated from portal_order_lines l
            left join portal_order_allocations a on a.order_line_id=l.id where l.order_id=$1 group by l.id order by l.id`, [row.id]);
        const afterStock = await client.query("select id,quantity from inventory_lines where account_name=$1 and sku=$2 order by id", [ACCOUNT, EXCLUDED]);
        const shipment = await client.query("select status,shipped_at from warehouse_shipments where order_id=$1 and account_name=$2", [row.id, ACCOUNT]);
        if (saved.status !== "STAGED" || saved.shippedAt || beforeStock !== JSON.stringify(afterStock.rows)
            || afterLines.rowCount !== expected.size || afterLines.rows.some(l => Number(l.requested_quantity) !== expected.get(l.sku)
                || l.allocated !== (l.sku === EXCLUDED ? 0 : expected.get(l.sku)))
            || shipment.rowCount !== 1 || shipment.rows[0].status !== "STAGED" || shipment.rows[0].shipped_at) {
            throw new Error("Staging or stock verification failed; rolling back.");
        }
        await client.query("commit");
        const verified = await client.query("select order_code,status,picked_at,staged_at,shipped_at from portal_orders where id=$1 and account_name=$2", [row.id, ACCOUNT]);
        console.log(JSON.stringify({ verified: true, order: verified.rows[0], lines: afterLines.rows,
            excludedSku: EXCLUDED, excludedPicked: 0, reservationReleased: excluded.allocated,
            onHandUnchanged: true, shipped: false }, null, 2));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally { await client.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
