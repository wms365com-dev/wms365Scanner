const {
    APP_USER_ROLES, withTransaction, saveMobileExecutionConfirmation,
    approvePortalOrderShortPick, getPortalOrderById
} = require("../server");

const CODE = "ORD-000557";
const SKU = "628693486408";
const QUANTITY = 63;
const APPLY = process.argv.includes("--apply");
const actor = { id: null, email: "k.prathab@gmail.com", full_name: "WMS365 Owner Approved Pick Update", role: APP_USER_ROLES.SUPER_ADMIN };

async function loadFacts(client, lock = false) {
    const result = await client.query(
        `select o.id,o.order_code,o.account_name,o.status,o.picked_at,fl.code warehouse
         from portal_orders o left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.order_code=$1${lock ? " for update of o" : ""}`, [CODE]
    );
    if (result.rows.length !== 1) throw new Error("Order must match exactly one record.");
    const order = result.rows[0];
    const lines = await client.query(
        `select l.id,l.sku,l.requested_quantity,i.description,i.tracking_level,i.unit_uom,
                coalesce((select sum(a.allocated_quantity) from portal_order_allocations a where a.order_line_id=l.id),0)::integer allocated,
                coalesce((select sum(p.quantity) from pick_confirmations p where p.line_id=l.id and p.sync_status<>'FAILED'),0)::integer confirmed
         from portal_order_lines l left join item_catalog i on i.account_name=$2 and i.sku=l.sku
         where l.order_id=$1 order by l.line_number,l.id`, [order.id, order.account_name]
    );
    const tasks = await client.query(
        `select id,status,blocked_reason,metadata from warehouse_tasks
         where source_type='PORTAL_ORDER' and source_id=$1 and task_type='PICK' order by id`, [order.id]
    );
    return { order, lines: lines.rows, tasks: tasks.rows };
}

async function main() {
    await withTransaction(async (client) => {
        if (!APPLY) await client.query("set transaction read only");
        const before = await loadFacts(client, APPLY);
        console.log(JSON.stringify({ mode: APPLY ? "apply" : "audit", ...before }, null, 2));
        if (!APPLY) return;
        if (process.env.CONFIRM_ORDER_ACCOUNT !== before.order.account_name || process.env.CONFIRM_SHORT_PICK !== "APPROVED_557_63") throw new Error("Explicit order account and short-pick confirmation required.");
        const matches = before.lines.filter((line) => line.sku === SKU);
        if (matches.length !== 1) throw new Error("SKU must match one order line.");
        const line = matches[0];
        if (before.order.status === "PICKED" && line.allocated === QUANTITY) { console.log("Already picked with 63 cases; no changes."); return; }
        if (before.order.status !== "RELEASED" || line.tracking_level !== "CASE" || line.allocated < QUANTITY || line.confirmed > QUANTITY) throw new Error("Order status, UOM or quantity requires review.");
        for (const task of before.tasks.filter((entry) => entry.status === "BLOCKED")) {
            const exception = task.metadata?.pickException;
            if (!exception || exception.sku !== SKU) throw new Error("A different blocked pick issue needs review.");
        }
        const note = "Owner confirmed only 63 cases of 628693486408 were physically picked; other lines picked complete. Preserve original ordered quantity; release unpicked allocation without changing physical stock or creating an investigation hold.";
        if (!before.tasks.some((task) => task.status === "BLOCKED")) {
            if (!before.tasks.some((task) => ["OPEN", "IN_PROGRESS"].includes(task.status))) throw new Error("No active pick task available.");
            await saveMobileExecutionConfirmation(client, "PICK_EXCEPTION", {
                sourceType: "PORTAL_ORDER", sourceId: before.order.id, accountName: before.order.account_name,
                lineId: line.id, sku: SKU, quantity: QUANTITY, reason: "SHORT_PICK", note,
                idempotencyKey: "owner-short-pick-557-63-20260916"
            }, actor);
        }
        const result = await approvePortalOrderShortPick(client, before.order.id, {
            lineId: line.id, sku: SKU, approvedQuantity: QUANTITY, moveShortageToInvestigation: false,
            idempotencyKey: "owner-short-pick-approved-557-63-20260916", note
        }, actor);
        const after = await loadFacts(client);
        const target = after.lines.find((entry) => entry.id === line.id);
        if (after.order.status !== "PICKED" || target.allocated !== QUANTITY || target.requested_quantity !== line.requested_quantity) throw new Error("Short-pick verification failed.");
        for (const original of before.lines.filter((entry) => entry.id !== line.id)) {
            const updated = after.lines.find((entry) => entry.id === original.id);
            if (!updated || original.requested_quantity !== updated.requested_quantity || original.allocated !== updated.allocated) throw new Error("An unrelated order line changed.");
        }
        const saved = await getPortalOrderById(client, before.order.id, before.order.account_name);
        console.log(JSON.stringify({ verified: true, order: saved.orderCode, status: saved.status,
            sku: SKU, orderedCases: line.requested_quantity, pickedCases: QUANTITY,
            unpickedCases: Number(line.requested_quantity) - QUANTITY,
            releasedReservationCases: line.allocated - QUANTITY,
            investigationMoved: result.shortageInvestigationMoves?.length || 0 }, null, 2));
    });
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
