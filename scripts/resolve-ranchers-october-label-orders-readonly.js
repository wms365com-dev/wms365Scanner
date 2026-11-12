"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const INPUT = path.resolve("outputs/ranchers-october-2026-labels/source-orders.json");
const OUTPUT = path.resolve("outputs/ranchers-october-2026-labels/source-orders-resolved.json");

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function directOrderCode(value) {
  const normalized = clean(value).replace(/^#/, "").toUpperCase();
  return /^ORD-\d{6}$/.test(normalized) ? normalized : "";
}

async function main() {
  const source = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  const unresolved = Array.isArray(source.unresolved) ? source.unresolved : [];
  const db = new Client({
    connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
    ssl: false,
  });
  await db.connect();
  try {
    await db.query("begin read only");
    const directCodes = [...new Set(unresolved.map((row) => directOrderCode(row.shopifyOrder)).filter(Boolean))];
    const shopifyNumbers = [...new Set(unresolved.map((row) => clean(row.shopifyOrder)).filter((value) => !directOrderCode(value)))];
    const direct = directCodes.length ? await db.query(
      `select o.order_code, o.account_name, o.fulfillment_location_id,
              count(soi.id)::integer import_count
         from portal_orders o
         left join store_order_imports soi on soi.portal_order_id = o.id and soi.integration_id = 4
        where o.order_code = any($1::text[])
        group by o.order_code, o.account_name, o.fulfillment_location_id`,
      [directCodes]
    ) : { rows: [] };
    const mapped = shopifyNumbers.length ? await db.query(
      `select c.shopify_order_number, o.order_code, o.account_name,
              o.fulfillment_location_id, c.integration_id
         from shopify_tracking_order_contacts c
         join portal_orders o on o.id = c.order_id
        where c.integration_id = 4 and c.shopify_order_number = any($1::text[])`,
      [shopifyNumbers]
    ) : { rows: [] };
    await db.query("rollback");

    const directMap = new Map(direct.rows.map((row) => [row.order_code, row]));
    const shopifyMap = new Map();
    for (const row of mapped.rows) {
      if (!shopifyMap.has(row.shopify_order_number)) shopifyMap.set(row.shopify_order_number, []);
      shopifyMap.get(row.shopify_order_number).push(row);
    }
    const resolvedPackages = [];
    const blockers = [];
    for (const row of unresolved) {
      const directCode = directOrderCode(row.shopifyOrder);
      let match = null;
      if (directCode) {
        match = directMap.get(directCode) || null;
        if (!match) blockers.push({ sourceOrder: row.shopifyOrder, reason: "WMS order not found" });
      } else {
        const candidates = shopifyMap.get(clean(row.shopifyOrder)) || [];
        if (candidates.length !== 1) {
          blockers.push({ sourceOrder: row.shopifyOrder, reason: `Expected one Shopify mapping, found ${candidates.length}` });
        } else {
          match = candidates[0];
        }
      }
      if (!match) continue;
      if (match.account_name !== ACCOUNT || Number(match.fulfillment_location_id) !== 1
          || (directCode && Number(match.import_count) !== 1)
          || (!directCode && Number(match.integration_id) !== 4)) {
        blockers.push({ sourceOrder: row.shopifyOrder, reason: "Pinned Rancher's ownership, warehouse, or Shopify linkage mismatch" });
        continue;
      }
      resolvedPackages.push({
        orderCode: match.order_code,
        shopifyOrder: row.shopifyOrder,
        actualShipDate: row.purchaseDate,
        itemQuantityEa: row.units,
        carrier: row.carrier,
        tracking: row.tracking,
        trackingNumbers: [row.tracking],
      });
    }

    const allRows = [...source.rows, ...resolvedPackages];
    const groups = new Map();
    for (const row of allRows) {
      const current = groups.get(row.orderCode) || [];
      current.push(row);
      groups.set(row.orderCode, current);
    }
    const rows = [];
    for (const [orderCode, group] of groups) {
      const dates = new Set(group.map((row) => row.actualShipDate));
      const quantities = new Set(group.map((row) => Number(row.itemQuantityEa)));
      const carriers = new Set(group.map((row) => clean(row.carrier)));
      const trackingNumbers = [...new Set(group.flatMap((row) => row.trackingNumbers || [row.tracking]).filter(Boolean))];
      if (dates.size !== 1 || quantities.size !== 1 || carriers.size !== 1) {
        blockers.push({ sourceOrder: orderCode, reason: "Conflicting date, quantity, or carrier across package rows" });
        continue;
      }
      rows.push({
        orderCode,
        actualShipDate: [...dates][0],
        itemQuantityEa: [...quantities][0],
        carrier: [...carriers][0],
        tracking: trackingNumbers.join("\n"),
        trackingNumbers,
      });
    }
    rows.sort((a, b) => a.orderCode.localeCompare(b.orderCode));
    const trackingOwners = new Map();
    for (const row of rows) {
      for (const tracking of row.trackingNumbers) {
        const prior = trackingOwners.get(tracking);
        if (prior && prior !== row.orderCode) blockers.push({ sourceOrder: row.orderCode, reason: `Tracking conflicts with ${prior}` });
        trackingOwners.set(tracking, row.orderCode);
      }
    }
    const orders = rows.map((row) => ({
      orderCode: row.orderCode,
      carriers: [row.carrier],
      trackingNumbers: row.trackingNumbers,
    }));
    fs.writeFileSync(OUTPUT, JSON.stringify({
      source: source.source,
      packageRows: source.confirmedLabelRows,
      orderCount: rows.length,
      rows,
      orders,
      blockers,
    }, null, 2));
    console.log(JSON.stringify({
      outputPath: OUTPUT,
      sourceConfirmedLabels: source.confirmedLabelRows,
      resolvedAdditionalLabels: resolvedPackages.length,
      orderCount: rows.length,
      trackingCount: trackingOwners.size,
      blockers,
    }, null, 2));
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
