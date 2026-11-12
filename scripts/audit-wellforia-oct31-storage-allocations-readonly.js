"use strict";

const { Client } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const CUTOFF = "2026-11-01";

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
    connectionTimeoutMillis: 20000
  });
  await db.connect();
  try {
    await db.query("begin read only");
    const company = await db.query(
      "select id,name,is_active from owner_accounts where name=$1",
      [ACCOUNT]
    );
    if (company.rowCount !== 1 || company.rows[0].is_active !== true) {
      throw new Error("Exact active Wellforia tenant verification failed.");
    }

    const allocationRows = await db.query(`
      select o.order_code,o.status,o.created_at,o.shipped_at,o.confirmed_ship_date,
             l.sku,a.allocated_quantity,a.created_at allocation_created_at,
             a.updated_at allocation_updated_at
      from portal_order_allocations a
      join portal_orders o on o.id=a.order_id
      join portal_order_lines l on l.id=a.order_line_id
      where o.account_name=$1
        and o.created_at < ($2::date::timestamp at time zone 'America/Toronto')
        and (o.shipped_at is null or o.shipped_at >= ($2::date::timestamp at time zone 'America/Toronto'))
        and o.status <> 'CANCELLED'
      order by o.order_code,l.sku,a.id
    `, [ACCOUNT, CUTOFF]);

    const cutoffMs = new Date("2026-11-01T04:00:00.000Z").getTime();
    const byOrder = new Map();
    const byStatus = new Map();
    const bySku = new Map();
    let reportTotal = 0;
    let createdBeforeCutoff = 0;
    let createdAfterCutoff = 0;
    let updatedAfterCutoff = 0;
    let physicallyShippedByCutoff = 0;
    let trueOpenAllocatedAtCutoff = 0;

    for (const row of allocationRows.rows) {
      const qty = Number(row.allocated_quantity) || 0;
      reportTotal += qty;
      const createdBefore = new Date(row.allocation_created_at).getTime() < cutoffMs;
      const updatedAfter = new Date(row.allocation_updated_at).getTime() >= cutoffMs;
      if (createdBefore) createdBeforeCutoff += qty;
      else createdAfterCutoff += qty;
      if (createdBefore && updatedAfter) updatedAfterCutoff += qty;
      const confirmedShipDate = row.confirmed_ship_date
        ? new Date(row.confirmed_ship_date).toISOString().slice(0, 10)
        : "";
      const physicallyShipped = Boolean(confirmedShipDate && confirmedShipDate < CUTOFF);
      if (physicallyShipped) physicallyShippedByCutoff += qty;
      else trueOpenAllocatedAtCutoff += qty;

      const order = byOrder.get(row.order_code) || {
        orderCode: row.order_code,
        status: row.status,
        orderCreatedAt: row.created_at,
        shippedAt: row.shipped_at,
        confirmedShipDate,
        total: 0,
        createdBeforeCutoff: 0,
        createdAfterCutoff: 0,
        updatedAfterCutoff: 0
        ,physicallyShippedByCutoff: 0
        ,trueOpenAtCutoff: 0
      };
      order.total += qty;
      if (createdBefore) order.createdBeforeCutoff += qty;
      else order.createdAfterCutoff += qty;
      if (createdBefore && updatedAfter) order.updatedAfterCutoff += qty;
      if (physicallyShipped) order.physicallyShippedByCutoff += qty;
      else order.trueOpenAtCutoff += qty;
      byOrder.set(row.order_code, order);

      byStatus.set(row.status, (byStatus.get(row.status) || 0) + qty);
      const sku = bySku.get(row.sku) || { sku: row.sku, total: 0, createdBeforeCutoff: 0, createdAfterCutoff: 0 };
      sku.total += qty;
      if (createdBefore) sku.createdBeforeCutoff += qty;
      else sku.createdAfterCutoff += qty;
      bySku.set(row.sku, sku);
    }

    const orders = [...byOrder.values()];
    const result = {
      account: ACCOUNT,
      cutoff: "2026-10-31T23:59:59.999-04:00",
      reportTotal,
      allocationRows: allocationRows.rowCount,
      orderCount: orders.length,
      createdBeforeCutoff,
      createdAfterCutoff,
      createdBeforeButUpdatedAfterCutoff: updatedAfterCutoff,
      physicallyShippedByCutoff,
      trueOpenAllocatedAtCutoff,
      byStatus: Object.fromEntries([...byStatus.entries()].sort()),
      bySku: [...bySku.values()].sort((a, b) => b.total - a.total),
      ordersCreatedAfterCutoffAllocations: orders
        .filter((row) => row.createdAfterCutoff > 0)
        .sort((a, b) => b.createdAfterCutoff - a.createdAfterCutoff),
      ordersWithPostCutoffAllocationUpdates: orders
        .filter((row) => row.updatedAfterCutoff > 0)
        .sort((a, b) => b.updatedAfterCutoff - a.updatedAfterCutoff),
      topOrders: orders.sort((a, b) => b.total - a.total).slice(0, 30)
    };
    console.log(JSON.stringify(result, null, 2));
    await db.query("rollback");
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
