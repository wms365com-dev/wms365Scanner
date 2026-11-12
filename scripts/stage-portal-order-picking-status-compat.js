"use strict";

const fs = require("node:fs");
const path = require("node:path");

const targetRoot = process.argv[2];
if (!targetRoot) {
  throw new Error("Usage: node scripts/stage-portal-order-picking-status-compat.js TARGET_ROOT");
}

const targetPath = path.join(targetRoot, "server.js");
let target = fs.readFileSync(targetPath, "utf8");
const oldStatuses = "'DRAFT', 'RELEASED', 'PICKED', 'STAGED', 'SHIPPED', 'CANCELLED', 'ARCHIVED'";
const newStatuses = "'DRAFT', 'RELEASED', 'PICKING', 'PICKED', 'STAGED', 'SHIPPED', 'CANCELLED', 'ARCHIVED'";
const statusMatches = target.split(oldStatuses).length - 1;
if (statusMatches !== 2) {
  throw new Error(`Expected two legacy order-status constraints, found ${statusMatches}.`);
}
target = target.replaceAll(oldStatuses, newStatuses);

const columnAnchor = '    await pool.query("alter table portal_orders add column if not exists picked_at timestamptz");';
if (!target.includes(columnAnchor)) {
  throw new Error("Portal order timestamp-column anchor is missing.");
}
target = target.replace(
  columnAnchor,
  '    await pool.query("alter table portal_orders add column if not exists picking_at timestamptz");\n' + columnAnchor
);

fs.writeFileSync(targetPath, target, "utf8");
console.log(JSON.stringify({ targetPath, staged: true, compatibility: "PICKING" }));
