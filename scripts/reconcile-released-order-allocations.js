"use strict";

const crypto = require("node:crypto");
const { Client } = require("pg");
const { allocatePortalOrderInventory, getPortalOrderById } = require("../server");

const NON_PICKABLE_TYPES = [
    "RECEIVING_STAGE", "DOCK", "QA_HOLD", "STAGING", "HOLD",
    "INVESTIGATION", "DAMAGED", "QUARANTINE"
];
const APPLY_CONFIRMATION = "RECONCILE_RELEASED_ALLOCATIONS";

function parseArgs(argv = process.argv.slice(2)) {
    const apply = argv.includes("--apply");
    const planArg = argv.find((value) => value.startsWith("--plan-hash="));
    const confirmArg = argv.find((value) => value.startsWith("--confirm="));
    return {
        apply,
        planHash: String(planArg || "").slice("--plan-hash=".length).trim(),
        confirmation: String(confirmArg || "").slice("--confirm=".length).trim()
    };
}

async function loadPlan(client) {
    const result = await client.query(`
        select
            o.id,
            o.account_name,
            o.updated_at,
            o.split_fulfillment_approved,
            line_stats.line_count,
            line_stats.short_line_count,
            line_stats.shortage,
            allocation_stats.non_pickable_allocation_count,
            allocation_stats.allocation_quantity
        from portal_orders o
        cross join lateral (
            select
                count(*)::integer as line_count,
                count(*) filter (where allocated_quantity < requested_quantity)::integer as short_line_count,
                coalesce(sum(greatest(requested_quantity - allocated_quantity, 0)), 0)::integer as shortage
            from (
                select
                    l.requested_quantity,
                    coalesce(sum(a.allocated_quantity), 0)::integer as allocated_quantity
                from portal_order_lines l
                left join portal_order_allocations a on a.order_line_id = l.id
                where l.order_id = o.id
                group by l.id, l.requested_quantity
            ) lines
        ) line_stats
        cross join lateral (
            select
                count(*) filter (
                    where coalesce(bl.is_pickable, true) = false
                       or coalesce(bl.location_type, 'STORAGE') = any($1::text[])
                )::integer as non_pickable_allocation_count,
                coalesce(sum(a.allocated_quantity), 0)::integer as allocation_quantity
            from portal_order_allocations a
            left join bin_locations bl on bl.code = a.location
            where a.order_id = o.id
        ) allocation_stats
        where o.status = 'RELEASED'
          and not exists (select 1 from pick_confirmations p where p.order_id = o.id)
          and not exists (
              select 1
              from warehouse_tasks wt
              where wt.source_type = 'PORTAL_ORDER'
                and wt.source_id = o.id
                and wt.task_type = 'PICK'
                and wt.status in ('IN_PROGRESS', 'DONE', 'BLOCKED')
          )
          and (line_stats.short_line_count > 0 or allocation_stats.non_pickable_allocation_count > 0)
        order by o.id
    `, [NON_PICKABLE_TYPES]);
    const rows = result.rows.map((row) => ({
        id: String(row.id),
        accountName: String(row.account_name || ""),
        updatedAt: new Date(row.updated_at).toISOString(),
        splitFulfillmentApproved: row.split_fulfillment_approved === true,
        lineCount: Number(row.line_count) || 0,
        shortLineCount: Number(row.short_line_count) || 0,
        shortage: Number(row.shortage) || 0,
        nonPickableAllocationCount: Number(row.non_pickable_allocation_count) || 0,
        allocationQuantity: Number(row.allocation_quantity) || 0
    }));
    const fingerprint = rows.map((row) => [
        row.id,
        row.accountName,
        row.updatedAt,
        row.lineCount,
        row.shortLineCount,
        row.shortage,
        row.nonPickableAllocationCount,
        row.allocationQuantity,
        row.splitFulfillmentApproved ? 1 : 0
    ].join(":" )).join("|");
    return {
        rows,
        planHash: crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)
    };
}

async function loadIntegritySnapshot(client, orderIds) {
    if (!orderIds.length) return { inventoryHash: "", orderHash: "" };
    const [inventory, orders] = await Promise.all([
        client.query(`
            select md5(coalesce(string_agg(id::text || ':' || quantity::text, '|' order by id), '')) as hash
            from inventory_lines
        `),
        client.query(`
            select md5(coalesce(string_agg(
                o.id::text || ':' || o.status || ':' || l.id::text || ':' || l.requested_quantity::text,
                '|' order by o.id, l.id
            ), '')) as hash
            from portal_orders o
            join portal_order_lines l on l.order_id = o.id
            where o.id = any($1::bigint[])
        `, [orderIds])
    ]);
    return {
        inventoryHash: inventory.rows[0]?.hash || "",
        orderHash: orders.rows[0]?.hash || ""
    };
}

async function verifyOrder(client, orderId) {
    const result = await client.query(`
        select
            o.status,
            count(distinct l.id) filter (
                where coalesce(line_alloc.allocated_quantity, 0) <> l.requested_quantity
            )::integer as mismatched_lines,
            count(distinct a.id) filter (
                where coalesce(bl.is_pickable, true) = false
                   or coalesce(bl.location_type, 'STORAGE') = any($2::text[])
            )::integer as non_pickable_allocations
        from portal_orders o
        join portal_order_lines l on l.order_id = o.id
        left join lateral (
            select coalesce(sum(a2.allocated_quantity), 0)::integer as allocated_quantity
            from portal_order_allocations a2
            where a2.order_line_id = l.id
        ) line_alloc on true
        left join portal_order_allocations a on a.order_line_id = l.id
        left join bin_locations bl on bl.code = a.location
        where o.id = $1
        group by o.status
    `, [orderId, NON_PICKABLE_TYPES]);
    const row = result.rows[0];
    if (!row || row.status !== "RELEASED") throw new Error("A target order changed lifecycle status during reconciliation.");
    if (Number(row.mismatched_lines) !== 0) throw new Error("A target order did not reconcile to its requested quantities.");
    if (Number(row.non_pickable_allocations) !== 0) throw new Error("A target order retained a non-pickable allocation.");
}

async function main() {
    const options = parseArgs();
    if (options.apply && (options.confirmation !== APPLY_CONFIRMATION || !/^[a-f0-9]{24}$/.test(options.planHash))) {
        throw new Error(`Apply requires --confirm=${APPLY_CONFIRMATION} and the exact 24-character --plan-hash from preflight.`);
    }
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("A database connection is required.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    let committed = false;
    try {
        await client.query(options.apply
            ? "begin transaction isolation level serializable"
            : "begin transaction isolation level repeatable read read only");
        await client.query("set local statement_timeout = '60s'");
        if (options.apply) {
            await client.query("select pg_advisory_xact_lock(hashtext('wms365:ops05:released-allocation-reconciliation'))");
        }
        let plan = await loadPlan(client);
        if (options.apply && plan.rows.length) {
            await client.query(
                "select id from portal_orders where id = any($1::bigint[]) order by id for update",
                [plan.rows.map((row) => row.id)]
            );
            plan = await loadPlan(client);
        }
        const summary = {
            apply: options.apply,
            readOnly: !options.apply,
            targetOrders: plan.rows.length,
            targetLines: plan.rows.reduce((sum, row) => sum + row.shortLineCount, 0),
            shortage: plan.rows.reduce((sum, row) => sum + row.shortage, 0),
            nonPickableAllocations: plan.rows.reduce((sum, row) => sum + row.nonPickableAllocationCount, 0),
            planHash: plan.planHash
        };
        if (!options.apply) {
            await client.query("rollback");
            console.log(JSON.stringify(summary));
            return;
        }
        if (plan.planHash !== options.planHash) throw new Error("The allocation plan changed after preflight; no changes were applied.");
        const orderIds = plan.rows.map((row) => row.id);
        const before = await loadIntegritySnapshot(client, orderIds);
        for (const target of plan.rows) {
            const order = await getPortalOrderById(client, target.id, target.accountName);
            if (!order || order.status !== "RELEASED") throw new Error("A target order is no longer safely released.");
            await allocatePortalOrderInventory(client, order, {
                allowSplitFulfillment: target.splitFulfillmentApproved
            });
            await verifyOrder(client, target.id);
        }
        const after = await loadIntegritySnapshot(client, orderIds);
        if (before.inventoryHash !== after.inventoryHash) throw new Error("Inventory quantities changed during allocation reconciliation.");
        if (before.orderHash !== after.orderHash) throw new Error("Order statuses or requested quantities changed during allocation reconciliation.");
        const remainingPlan = await loadPlan(client);
        if (remainingPlan.rows.length) throw new Error("Released-order allocation exceptions remain after reconciliation.");
        await client.query("commit");
        committed = true;
        console.log(JSON.stringify({ ...summary, appliedOrders: orderIds.length, verified: true }));
    } finally {
        if (!committed) await client.query("rollback").catch(() => {});
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { APPLY_CONFIRMATION, parseArgs, loadPlan, loadIntegritySnapshot, verifyOrder };
