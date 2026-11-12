"use strict";

const fs = require("node:fs");
const path = require("node:path");

const targetRoot = process.argv[2];
if (!targetRoot) {
  throw new Error("Usage: node scripts/stage-warehouse-shipment-picking-status-compat.js TARGET_ROOT");
}

const targetPath = path.join(targetRoot, "server.js");
let target = fs.readFileSync(targetPath, "utf8");
const oldStatuses = 'alter table warehouse_shipments add constraint warehouse_shipments_status_check check (status in (\'RELEASED\', \'PICKED\', \'STAGED\', \'SHIPPED\', \'CANCELLED\'))';
const newStatuses = 'alter table warehouse_shipments add constraint warehouse_shipments_status_check check (status in (\'RELEASED\', \'PICKING\', \'PICKED\', \'STAGED\', \'SHIPPED\', \'CANCELLED\'))';
const statusMatches = target.split(oldStatuses).length - 1;
if (statusMatches !== 1) {
  throw new Error(`Expected one legacy warehouse-shipment constraint, found ${statusMatches}.`);
}
target = target.replace(oldStatuses, newStatuses);
fs.writeFileSync(targetPath, target, "utf8");
console.log(JSON.stringify({ targetPath, staged: true, compatibility: "WAREHOUSE_PICKING" }));
