const { Client } = require("pg");

const ACTIVE_STATUSES = ["RELEASED", "PICKING", "PICKED", "STAGED"];
const NON_PICKABLE_TYPES = new Set([
    "RECEIVING_STAGE", "DOCK", "QA_HOLD", "STAGING", "HOLD",
    "INVESTIGATION", "DAMAGED", "QUARANTINE"
]);

function number(value) {
    return Number(value) || 0;
}

function locationMatches(location, code) {
    const normalizedLocation = String(location || "").trim().toUpperCase();
    const normalizedCode = String(code || "").trim().toUpperCase();
    return Boolean(normalizedLocation && normalizedCode)
        && (normalizedLocation === normalizedCode || normalizedLocation.startsWith(`${normalizedCode}-`));
}

function isPickable(row) {
    return row.is_pickable !== false
        && !NON_PICKABLE_TYPES.has(String(row.location_type || "STORAGE").trim().toUpperCase());
}

function addCount(target, key, quantity = 0) {
    target[key] ||= { lines: 0, shortage: 0 };
    target[key].lines += 1;
    target[key].shortage += quantity;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("A database connection is required.");
    const db = new Client({ connectionString, ssl: false });
    await db.connect();
    try {
        await db.query("begin read only");
        await db.query("set local statement_timeout = '30s'");
        const shortLinesResult = await db.query(`
                select o.id order_id, o.status, o.account_name, o.fulfillment_location_id,
                       l.id line_id, l.sku, l.requested_quantity,
                       coalesce(sum(a.allocated_quantity), 0)::integer allocated_quantity,
                       coalesce(c.blocked, false) item_blocked
                from portal_orders o
                join portal_order_lines l on l.order_id = o.id
                left join portal_order_allocations a on a.order_line_id = l.id
                left join item_catalog c on c.account_name = o.account_name and c.sku = l.sku
                where o.status = any($1::text[])
                group by o.id, o.status, o.account_name, o.fulfillment_location_id,
                         l.id, l.sku, l.requested_quantity, c.blocked
                having coalesce(sum(a.allocated_quantity), 0) < l.requested_quantity
                order by o.id, l.id
            `, [ACTIVE_STATUSES]);
        const warehousesResult = await db.query(`
                select cfl.account_name, cfl.fulfillment_location_id,
                       cfl.portal_inventory_rollup_location_id, cfl.allow_storage,
                       fl.code, fl.is_active
                from company_fulfillment_locations cfl
                join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id
                order by cfl.account_name, cfl.fulfillment_location_id
            `);
        const inventoryResult = await db.query(`
                select i.id, i.account_name, i.sku, i.location, i.quantity,
                       bl.location_type, bl.is_pickable,
                       (bl.code is null) as missing_bin_master
                from inventory_lines i
                left join bin_locations bl on bl.code = i.location
                where i.quantity <> 0
            `);
        const allocationsResult = await db.query(`
                select a.id, a.order_id, a.order_line_id, a.inventory_line_id, o.status,
                       a.sku allocation_sku, a.location allocation_location,
                       a.allocated_quantity, o.account_name order_account,
                       o.fulfillment_location_id, i.account_name inventory_account,
                       i.sku inventory_sku, i.location inventory_location, i.quantity inventory_quantity,
                       bl.location_type, bl.is_pickable
                from portal_order_allocations a
                join portal_orders o on o.id = a.order_id
                left join inventory_lines i on i.id = a.inventory_line_id
                left join bin_locations bl on bl.code = i.location
                where o.status = any($1::text[])
            `, [ACTIVE_STATUSES]);

        const shortLines = shortLinesResult.rows;
        const shortKeys = new Set(shortLines.map((row) => `${row.account_name}\u0000${row.sku}`));
        const inventory = inventoryResult.rows.filter((row) => shortKeys.has(`${row.account_name}\u0000${row.sku}`));
        const warehousesByAccount = new Map();
        for (const row of warehousesResult.rows) {
            if (!warehousesByAccount.has(row.account_name)) warehousesByAccount.set(row.account_name, []);
            warehousesByAccount.get(row.account_name).push(row);
        }
        const allocationsByInventory = new Map();
        for (const row of allocationsResult.rows) {
            const key = String(row.inventory_line_id || "");
            allocationsByInventory.set(key, (allocationsByInventory.get(key) || 0) + number(row.allocated_quantity));
        }

        const integrity = {
            orphanInventory: 0,
            nonPositiveAllocation: 0,
            inventoryOverallocated: 0,
            crossCompany: 0,
            skuMismatch: 0,
            locationMismatch: 0,
            nonPickableAllocation: 0
        };
        const nonPickableAllocationsByStatus = {};
        const nonPickableAllocationsByLocationType = {};
        for (const row of allocationsResult.rows) {
            if (!row.inventory_line_id || row.inventory_account == null) integrity.orphanInventory += 1;
            if (number(row.allocated_quantity) <= 0) integrity.nonPositiveAllocation += 1;
            if (row.order_account !== row.inventory_account) integrity.crossCompany += 1;
            if (row.allocation_sku !== row.inventory_sku) integrity.skuMismatch += 1;
            if (row.allocation_location !== row.inventory_location) integrity.locationMismatch += 1;
            if (!isPickable(row)) {
                integrity.nonPickableAllocation += 1;
                nonPickableAllocationsByStatus[row.status] = (nonPickableAllocationsByStatus[row.status] || 0) + 1;
                const locationType = String(row.location_type || "MISSING_BIN_MASTER").trim().toUpperCase();
                nonPickableAllocationsByLocationType[locationType] = (nonPickableAllocationsByLocationType[locationType] || 0) + 1;
            }
        }
        for (const [inventoryLineId, allocated] of allocationsByInventory.entries()) {
            const row = inventory.find((entry) => String(entry.id) === inventoryLineId)
                || allocationsResult.rows.find((entry) => String(entry.inventory_line_id) === inventoryLineId);
            if (row && allocated > number(row.inventory_quantity ?? row.quantity)) integrity.inventoryOverallocated += 1;
        }

        const byStatus = {};
        const byReason = {};
        let totalShortage = 0;
        let missingBinMasterLines = 0;
        let blockedItemLines = 0;
        for (const line of shortLines) {
            const shortage = number(line.requested_quantity) - number(line.allocated_quantity);
            totalShortage += shortage;
            addCount(byStatus, line.status, shortage);
            if (line.item_blocked) blockedItemLines += 1;

            const assigned = (warehousesByAccount.get(line.account_name) || []).filter((row) => row.is_active === true);
            const targetId = number(line.fulfillment_location_id)
                || (assigned.length === 1 ? number(assigned[0].fulfillment_location_id) : 0);
            const target = assigned.find((row) => number(row.fulfillment_location_id) === targetId) || null;
            const pool = targetId ? assigned.filter((row) => row.allow_storage === true && (
                number(row.fulfillment_location_id) === targetId
                || number(row.portal_inventory_rollup_location_id) === targetId
            )) : [];
            const poolEnabled = pool.some((row) => number(row.fulfillment_location_id) !== targetId);
            const eligibleCodes = poolEnabled ? pool.map((row) => row.code) : (assigned.length > 1 && target ? [target.code] : []);
            const rows = inventory.filter((row) => row.account_name === line.account_name && row.sku === line.sku);
            let eligibleFree = 0;
            let nonPickable = 0;
            let otherWarehouse = 0;
            let unscoped = 0;
            let missingBinMaster = false;
            for (const row of rows) {
                const free = Math.max(0, number(row.quantity) - (allocationsByInventory.get(String(row.id)) || 0));
                const matchedAssigned = assigned.some((warehouse) => locationMatches(row.location, warehouse.code));
                const eligible = !eligibleCodes.length || eligibleCodes.some((code) => locationMatches(row.location, code));
                if (row.missing_bin_master) missingBinMaster = true;
                if (!isPickable(row)) nonPickable += free;
                else if (eligible) eligibleFree += free;
                else if (matchedAssigned) otherWarehouse += free;
                else unscoped += free;
            }
            if (missingBinMaster) missingBinMasterLines += 1;

            let reason = "NO_PICKABLE_STOCK";
            if (!targetId && assigned.length > 1) reason = "MISSING_WAREHOUSE_SCOPE";
            else if (eligibleFree >= shortage) reason = "ELIGIBLE_PICKABLE_STOCK_AVAILABLE";
            else if (otherWarehouse >= shortage) reason = "STOCK_AT_OTHER_WAREHOUSE";
            else if (nonPickable >= shortage) reason = "STOCK_NON_PICKABLE_OR_HELD";
            else if (unscoped >= shortage) reason = "STOCK_IN_LEGACY_UNSCOPED_LOCATION";
            else if (eligibleFree + otherWarehouse + nonPickable + unscoped >= shortage) reason = "STOCK_SPLIT_ACROSS_INELIGIBLE_POOLS";
            addCount(byReason, reason, shortage);
        }

        await db.query("rollback");
        const integrityFailureCount = Object.values(integrity).reduce((sum, value) => sum + value, 0);
        console.log(JSON.stringify({
            auditedAt: new Date().toISOString(),
            readOnly: true,
            activeStatuses: ACTIVE_STATUSES,
            activeAllocationRows: allocationsResult.rowCount,
            shortLines: shortLines.length,
            shortOrders: new Set(shortLines.map((row) => row.order_id)).size,
            totalShortage,
            byStatus,
            byReason,
            blockedItemLines,
            missingBinMasterLines,
            integrity,
            nonPickableAllocationsByStatus,
            nonPickableAllocationsByLocationType,
            integrityFailureCount
        }));
        if (integrityFailureCount) throw new Error("Active allocation integrity violations were detected.");
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
