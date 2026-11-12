const { APP_USER_ROLES, withTransaction, updateAdminPortalOrderStatus, correctPortalOrderPickedQuantities, getPortalOrderById } = require("../server");

const ACCOUNT = "HEALTEA";
const TARGETS = new Map([["20628693486167", 103], ["30628693486072", 24]]);
const ORDERED = new Map([["20628693486167", 108], ["30628693486072", 36]]);
const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "k.prathab@gmail.com", full_name: "WMS365 Owner Approved Staging" };

async function main() {
    if (process.env.CONFIRM_ORD617_STAGE !== "APPROVED_103_24_CASES") throw new Error("Explicit approval required.");
    await withTransaction(async (client) => {
        const result = await client.query(
            `select o.id,o.status,fl.code warehouse from portal_orders o
             join fulfillment_locations fl on fl.id=o.fulfillment_location_id
             where o.order_code=$1 and o.account_name=$2 for update of o`, ["ORD-000617", ACCOUNT]
        );
        if (result.rowCount !== 1 || result.rows[0].warehouse !== "GW3PL-MISS") throw new Error("Order scope mismatch.");
        const row = result.rows[0];
        const lines = await client.query(
            `select l.id,l.sku,l.requested_quantity,c.tracking_level,
                    coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_line_id=l.id),0)::integer allocated,
                    coalesce((select sum(p.quantity) from pick_confirmations p where p.line_id=l.id and p.sync_status<>'FAILED'),0)::integer confirmed
             from portal_order_lines l join item_catalog c on c.account_name=$2 and c.sku=l.sku
             where l.order_id=$1 order by l.id`, [row.id, ACCOUNT]
        );
        if (lines.rowCount !== 2 || lines.rows.some((line) => Number(line.requested_quantity) !== ORDERED.get(line.sku) || line.tracking_level !== "CASE" || line.allocated < TARGETS.get(line.sku) || line.confirmed > TARGETS.get(line.sku))) throw new Error("Order lines/quantities require review.");
        if (row.status === "STAGED" && lines.rows.every((line) => line.allocated === TARGETS.get(line.sku))) { console.log("Already staged with the approved quantities; no changes."); return; }
        if (!["RELEASED", "PICKED"].includes(row.status)) throw new Error(`Order is ${row.status}; stopping.`);
        const blocked = await client.query("select 1 from warehouse_tasks where source_type='PORTAL_ORDER' and source_id=$1 and task_type='PICK' and status='BLOCKED' limit 1", [row.id]);
        if (blocked.rowCount) throw new Error("Blocked picking issue needs review.");
        const note = "Owner confirmed shipping/staging 103 cases of 20628693486167 and 24 cases of 30628693486072. Units are cases. Preserve original ordered quantities; release unpicked reservations. Do not ship or move shortages to investigation.";
        if (row.status === "RELEASED") await updateAdminPortalOrderStatus(client, row.id, "PICKED", {
            idempotencyKey: "owner-ord617-picked-20260916", note
        }, actor);
        await correctPortalOrderPickedQuantities(client, row.id, {
            lines: lines.rows.map((line) => ({ orderLineId: line.id, sku: line.sku, quantity: TARGETS.get(line.sku) })), note
        }, actor);
        const staged = await updateAdminPortalOrderStatus(client, row.id, "STAGED", {
            idempotencyKey: "owner-ord617-staged-20260916", note
        }, actor);
        const saved = await getPortalOrderById(client, row.id, ACCOUNT);
        const allocations = await client.query("select sku,sum(allocated_quantity)::integer quantity from portal_order_allocations where order_id=$1 group by sku order by sku", [row.id]);
        if (staged.status !== "STAGED" || saved.status !== "STAGED" || allocations.rowCount !== 2 || allocations.rows.some((line) => line.quantity !== TARGETS.get(line.sku))) throw new Error("Staging verification failed.");
        const unchanged = await client.query("select sku,requested_quantity from portal_order_lines where order_id=$1", [row.id]);
        if (unchanged.rows.some((line) => Number(line.requested_quantity) !== ORDERED.get(line.sku))) throw new Error("Original ordered quantities changed.");
        console.log(JSON.stringify({ verified: true, order: saved.orderCode, status: saved.status,
            quantities: allocations.rows, totalStagedCases: 127, unpickedCases: 17, shipped: false }, null, 2));
    });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
