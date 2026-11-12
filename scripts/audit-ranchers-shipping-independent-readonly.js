const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const EXPECTED_WAREHOUSE = "GW3PL-MISS";
const INPUT_PATH = path.resolve(__dirname, "..", "outputs", "ranchers-shipping-match-20260910.json");
const ACTIVE_STATUSES = new Set(["RELEASED", "PICKED", "STAGED"]);

function text(value) {
    return String(value == null ? "" : value).trim();
}

function upper(value) {
    return text(value).toUpperCase();
}

function asNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function groupBy(rows, keyFn) {
    const grouped = new Map();
    for (const row of rows) {
        const key = keyFn(row);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
    }
    return grouped;
}

async function main() {
    const source = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
    const sourceRows = Array.isArray(source.rows) ? source.rows : [];
    const orderCodes = sourceRows.map((row) => text(row.orderCode)).filter(Boolean);
    const poNumbers = sourceRows.map((row) => text(row.poNumber)).filter(Boolean);
    const trackingValues = sourceRows.map((row) => text(row.tracking)).filter(Boolean);

    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();

    try {
        await client.query("begin transaction read only");

        const [
            orderResult,
            lineResult,
            allocationResult,
            shipmentResult,
            shipmentLineResult,
            importResult,
            statusResult,
            poMatchResult,
            trackingOrderResult,
            trackingShipmentResult,
            warehouseConfigResult
        ] = await Promise.all([
            client.query(
                `select o.id, o.order_code, o.account_name, o.status, o.po_number,
                        o.shipment_method, o.shipped_carrier_name, o.shipped_tracking_reference,
                        o.requested_ship_date, o.released_at, o.picked_at, o.staged_at, o.shipped_at,
                        o.fulfillment_location_id, fl.code as warehouse_code, fl.name as warehouse_name
                 from portal_orders o
                 left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
                 where o.order_code = any($1::text[])
                 order by o.order_code`,
                [orderCodes]
            ),
            client.query(
                `select l.id, l.order_id, o.order_code, l.line_number, l.sku, l.requested_quantity,
                        i.description, i.tracking_level, i.unit_uom, i.units_per_case
                 from portal_order_lines l
                 join portal_orders o on o.id = l.order_id
                 left join item_catalog i on i.account_name = o.account_name and i.sku = l.sku
                 where o.order_code = any($1::text[])
                 order by o.order_code, l.line_number, l.id`,
                [orderCodes]
            ),
            client.query(
                `select a.id, a.order_id, o.order_code, a.order_line_id, a.inventory_line_id,
                        a.sku, a.location, a.allocated_quantity, a.tracking_level,
                        inv.account_name as inventory_account_name, inv.sku as inventory_sku,
                        inv.location as inventory_location, inv.quantity as inventory_quantity,
                        coalesce(bl.is_pickable, true) as bin_is_pickable,
                        coalesce(bl.location_type, 'STORAGE') as bin_location_type,
                        bl.fulfillment_location_id as bin_fulfillment_location_id,
                        coalesce((
                            select sum(a2.allocated_quantity)
                            from portal_order_allocations a2
                            join portal_orders o2 on o2.id = a2.order_id
                            where a2.inventory_line_id = a.inventory_line_id
                              and o2.status = any($2::text[])
                        ), 0)::integer as active_inventory_commitment
                 from portal_order_allocations a
                 join portal_orders o on o.id = a.order_id
                 left join inventory_lines inv on inv.id = a.inventory_line_id
                 left join bin_locations bl on upper(bl.code) = upper(inv.location)
                 where o.order_code = any($1::text[])
                 order by o.order_code, a.order_line_id, a.id`,
                [orderCodes, [...ACTIVE_STATUSES]]
            ),
            client.query(
                `select ws.id, ws.order_id, o.order_code, ws.shipment_code, ws.account_name,
                        ws.status, ws.shipment_method, ws.carrier_name, ws.tracking_reference,
                        ws.shipped_at, ws.fulfillment_location_id, fl.code as warehouse_code,
                        fl.name as warehouse_name
                 from warehouse_shipments ws
                 join portal_orders o on o.id = ws.order_id
                 left join fulfillment_locations fl on fl.id = ws.fulfillment_location_id
                 where o.order_code = any($1::text[])
                 order by o.order_code, ws.id`,
                [orderCodes]
            ),
            client.query(
                `select ws.order_id, o.order_code, wsl.shipment_id, wsl.order_line_id,
                        wsl.sku, wsl.ordered_quantity, wsl.shipped_quantity
                 from warehouse_shipment_lines wsl
                 join warehouse_shipments ws on ws.id = wsl.shipment_id
                 join portal_orders o on o.id = ws.order_id
                 where o.order_code = any($1::text[])
                 order by o.order_code, wsl.id`,
                [orderCodes]
            ),
            client.query(
                `select soi.portal_order_id, o.order_code, soi.external_order_id,
                        si.id as integration_id, si.account_name as integration_account_name,
                        si.provider, si.integration_name, si.store_identifier
                 from store_order_imports soi
                 join portal_orders o on o.id = soi.portal_order_id
                 join store_integrations si on si.id = soi.integration_id
                 where o.order_code = any($1::text[])
                 order by o.order_code`,
                [orderCodes]
            ),
            client.query(
                `select status, count(*)::integer as order_count
                 from portal_orders
                 where account_name = $1
                 group by status
                 order by status`,
                [ACCOUNT]
            ),
            client.query(
                `select order_code, account_name, status, po_number
                 from portal_orders
                 where po_number = any($1::text[])
                 order by po_number, account_name, order_code`,
                [poNumbers]
            ),
            client.query(
                `select order_code, account_name, status, shipped_carrier_name, shipped_tracking_reference
                 from portal_orders
                 where shipped_tracking_reference = any($1::text[])
                 order by shipped_tracking_reference, account_name, order_code`,
                [trackingValues]
            ),
            client.query(
                `select o.order_code, ws.account_name, ws.status, ws.carrier_name,
                        ws.tracking_reference, ws.shipment_code
                 from warehouse_shipments ws
                 join portal_orders o on o.id = ws.order_id
                 where ws.tracking_reference = any($1::text[])
                 order by ws.tracking_reference, ws.account_name, o.order_code`,
                [trackingValues]
            ),
            client.query(
                `select c.account_name, c.allow_outbound, c.is_primary,
                        fl.id as fulfillment_location_id, fl.code as warehouse_code,
                        fl.name as warehouse_name, fl.is_active
                 from company_fulfillment_locations c
                 join fulfillment_locations fl on fl.id = c.fulfillment_location_id
                 where c.account_name = $1
                 order by c.is_primary desc, fl.code`,
                [ACCOUNT]
            )
        ]);

        const ordersByCode = groupBy(orderResult.rows, (row) => text(row.order_code));
        const linesByOrder = groupBy(lineResult.rows, (row) => text(row.order_code));
        const allocationsByOrder = groupBy(allocationResult.rows, (row) => text(row.order_code));
        const shipmentsByOrder = groupBy(shipmentResult.rows, (row) => text(row.order_code));
        const shipmentLinesByOrder = groupBy(shipmentLineResult.rows, (row) => text(row.order_code));
        const importsByOrder = groupBy(importResult.rows, (row) => text(row.order_code));
        const poMatches = groupBy(poMatchResult.rows, (row) => text(row.po_number));
        const trackingOrderMatches = groupBy(trackingOrderResult.rows, (row) => text(row.shipped_tracking_reference));
        const trackingShipmentMatches = groupBy(trackingShipmentResult.rows, (row) => text(row.tracking_reference));
        const sourceTrackingGroups = groupBy(sourceRows.filter((row) => text(row.tracking)), (row) => text(row.tracking));
        const sourceOrderGroups = groupBy(sourceRows, (row) => text(row.orderCode));
        const sourcePoGroups = groupBy(sourceRows, (row) => text(row.poNumber));

        const audits = sourceRows.map((sourceRow) => {
            const code = text(sourceRow.orderCode);
            const orders = ordersByCode.get(code) || [];
            const order = orders.length === 1 ? orders[0] : null;
            const lines = linesByOrder.get(code) || [];
            const allocations = allocationsByOrder.get(code) || [];
            const shipments = shipmentsByOrder.get(code) || [];
            const shipmentLines = shipmentLinesByOrder.get(code) || [];
            const imports = importsByOrder.get(code) || [];
            const expectedQuantity = asNumber(sourceRow.itemQuantityEa);
            const orderQuantity = lines.reduce((sum, row) => sum + asNumber(row.requested_quantity), 0);
            const allocationQuantity = allocations.reduce((sum, row) => sum + asNumber(row.allocated_quantity), 0);
            const issues = [];
            const warnings = [];

            if (orders.length !== 1) issues.push(orders.length ? `order code matched ${orders.length} records` : "order not found");
            if (order && upper(order.account_name) !== ACCOUNT) issues.push(`wrong owner: ${order.account_name}`);
            if (order && text(order.po_number) !== text(sourceRow.poNumber)) issues.push(`PO mismatch: WMS ${order.po_number || "blank"}, sheet ${sourceRow.poNumber || "blank"}`);
            if ((poMatches.get(text(sourceRow.poNumber)) || []).filter((row) => upper(row.account_name) === ACCOUNT).length !== 1) {
                issues.push(`PO ${sourceRow.poNumber || "blank"} is not unique for Rancher's Chips`);
            }
            if (orderQuantity !== expectedQuantity) issues.push(`quantity mismatch: WMS ${orderQuantity} EA, sheet ${expectedQuantity} EA`);
            if (!lines.length) issues.push("no order lines");
            if (lines.some((line) => upper(line.sku) !== "RTC-4OZ-EA")) {
                issues.push(`unexpected WMS SKU: ${[...new Set(lines.map((line) => text(line.sku)))].join(", ")}`);
            }
            if (lines.some((line) => upper(line.tracking_level) !== "UNIT" || upper(line.unit_uom) !== "EA")) {
                issues.push("item UOM is not UNIT/EA");
            }
            if (allocationQuantity !== orderQuantity) issues.push(`allocation mismatch: allocated ${allocationQuantity}, ordered ${orderQuantity}`);
            if (allocations.some((row) => !row.inventory_line_id || !row.inventory_account_name)) issues.push("allocation references missing inventory");
            if (allocations.some((row) => upper(row.inventory_account_name) !== ACCOUNT)) issues.push("allocation crosses customer ownership");
            if (allocations.some((row) => upper(row.sku) !== upper(row.inventory_sku))) issues.push("allocation SKU does not match inventory SKU");
            if (allocations.some((row) => upper(row.location) !== upper(row.inventory_location))) issues.push("allocation location does not match inventory location");
            if (allocations.some((row) => row.bin_is_pickable !== true || ["HOLD", "INVESTIGATION", "DAMAGED", "QC"].includes(upper(row.bin_location_type)))) {
                issues.push("allocation uses a non-pickable or restricted bin");
            }
            if (order && allocations.some((row) => row.bin_fulfillment_location_id && String(row.bin_fulfillment_location_id) !== String(order.fulfillment_location_id))) {
                issues.push("allocation warehouse does not match order warehouse");
            }
            if (allocations.some((row) => asNumber(row.active_inventory_commitment) > asNumber(row.inventory_quantity))) {
                issues.push("inventory line is overcommitted across active orders");
            }
            if (order && upper(order.warehouse_code) !== EXPECTED_WAREHOUSE) issues.push(`wrong warehouse: ${order.warehouse_code || "blank"}`);
            if (shipments.length !== 1) issues.push(`expected one warehouse shipment, found ${shipments.length}`);
            if (shipments.some((shipment) => upper(shipment.account_name) !== ACCOUNT)) issues.push("warehouse shipment owner mismatch");
            if (shipments.some((shipment) => upper(shipment.warehouse_code) !== EXPECTED_WAREHOUSE)) issues.push("warehouse shipment assigned to wrong warehouse");
            if (shipmentLines.reduce((sum, row) => sum + asNumber(row.ordered_quantity), 0) !== orderQuantity) {
                issues.push("warehouse shipment quantity does not match order quantity");
            }
            if (imports.length !== 1) issues.push(`expected one Shopify import relationship, found ${imports.length}`);
            if (imports.some((entry) => upper(entry.integration_account_name) !== ACCOUNT || upper(entry.provider) !== "SHOPIFY")) {
                issues.push("Shopify import ownership/provider mismatch");
            }
            if (sourceOrderGroups.get(code)?.length > 1) issues.push("duplicate order code in spreadsheet source");
            if (sourcePoGroups.get(text(sourceRow.poNumber))?.length > 1) issues.push("duplicate PO in spreadsheet source");
            if (text(sourceRow.tracking) && sourceTrackingGroups.get(text(sourceRow.tracking))?.length > 1) issues.push("duplicate tracking number in spreadsheet source");
            if (!text(sourceRow.carrier)) issues.push("carrier missing from spreadsheet");
            if (!text(sourceRow.tracking)) issues.push("tracking missing from spreadsheet");

            if (order && text(order.shipped_carrier_name) && upper(order.shipped_carrier_name) !== upper(sourceRow.carrier)) {
                issues.push(`existing carrier conflict: WMS ${order.shipped_carrier_name}, sheet ${sourceRow.carrier || "blank"}`);
            }
            if (order && text(order.shipped_tracking_reference) && text(order.shipped_tracking_reference) !== text(sourceRow.tracking)) {
                issues.push(`existing tracking conflict: WMS ${order.shipped_tracking_reference}, sheet ${sourceRow.tracking || "blank"}`);
            }
            for (const shipment of shipments) {
                if (text(shipment.carrier_name) && upper(shipment.carrier_name) !== upper(sourceRow.carrier)) {
                    issues.push(`shipment carrier conflict: WMS ${shipment.carrier_name}, sheet ${sourceRow.carrier || "blank"}`);
                }
                if (text(shipment.tracking_reference) && text(shipment.tracking_reference) !== text(sourceRow.tracking)) {
                    issues.push(`shipment tracking conflict: WMS ${shipment.tracking_reference}, sheet ${sourceRow.tracking || "blank"}`);
                }
            }

            const otherOrderTracking = (trackingOrderMatches.get(text(sourceRow.tracking)) || [])
                .filter((entry) => text(entry.order_code) !== code);
            const otherShipmentTracking = (trackingShipmentMatches.get(text(sourceRow.tracking)) || [])
                .filter((entry) => text(entry.order_code) !== code);
            if (text(sourceRow.tracking) && (otherOrderTracking.length || otherShipmentTracking.length)) {
                issues.push(`tracking already used by another WMS order: ${[...new Set([...otherOrderTracking, ...otherShipmentTracking].map((entry) => text(entry.order_code)))].join(", ")}`);
            }

            if (text(sourceRow.dataCheck)) warnings.push(`spreadsheet warning: ${sourceRow.dataCheck}`);
            if (order && upper(order.status) !== upper(sourceRow.sourceStatus)) {
                warnings.push(`status changed since export: WMS ${order.status}, sheet ${sourceRow.sourceStatus}`);
            }
            if (order && !ACTIVE_STATUSES.has(upper(order.status))) issues.push(`status ${order.status} is not an active shippable status`);
            if (order && upper(order.status) !== "STAGED") warnings.push(`normal WMS workflow is not yet STAGED (currently ${order.status})`);
            if (shipments.length === 1 && upper(shipments[0].status) !== "STAGED") {
                warnings.push(`warehouse shipment is not yet STAGED (currently ${shipments[0].status})`);
            }

            return {
                sheetRow: sourceRow.sheetRow,
                orderCode: code,
                poNumber: sourceRow.poNumber,
                sourceQuantityEa: expectedQuantity,
                wmsQuantityEa: orderQuantity,
                allocatedQuantityEa: allocationQuantity,
                accountName: order?.account_name || "",
                status: order?.status || "",
                warehouseCode: order?.warehouse_code || "",
                carrier: sourceRow.carrier,
                tracking: sourceRow.tracking,
                existingCarrier: order?.shipped_carrier_name || "",
                existingTracking: order?.shipped_tracking_reference || "",
                shopifyExternalOrderId: imports[0]?.external_order_id || "",
                dataReady: issues.length === 0,
                normalWorkflowReady: issues.length === 0 && upper(order?.status) === "STAGED" && shipments.length === 1 && upper(shipments[0].status) === "STAGED",
                issues: [...new Set(issues)],
                warnings: [...new Set(warnings)]
            };
        });

        const statusBreakdown = Object.fromEntries(statusResult.rows.map((row) => [row.status, Number(row.order_count)]));
        const totalRanchersOrders = Object.values(statusBreakdown).reduce((sum, count) => sum + count, 0);
        const duplicateTrackingInSource = [...sourceTrackingGroups.entries()]
            .filter(([, rows]) => rows.length > 1)
            .map(([tracking, rows]) => ({ tracking, orderCodes: rows.map((row) => row.orderCode) }));
        const duplicateOrdersInSource = [...sourceOrderGroups.entries()]
            .filter(([, rows]) => rows.length > 1)
            .map(([orderCode, rows]) => ({ orderCode, sheetRows: rows.map((row) => row.sheetRow) }));
        const duplicatePosInSource = [...sourcePoGroups.entries()]
            .filter(([, rows]) => rows.length > 1)
            .map(([poNumber, rows]) => ({ poNumber, orderCodes: rows.map((row) => row.orderCode) }));

        const output = {
            auditedAt: new Date().toISOString(),
            mode: "READ_ONLY",
            source: source.source,
            expectedAccount: ACCOUNT,
            expectedWarehouse: EXPECTED_WAREHOUSE,
            sourceRowCount: sourceRows.length,
            totalRanchersOrders,
            statusBreakdown,
            warehouseConfiguration: warehouseConfigResult.rows,
            summary: {
                exactOrderMatches: audits.filter((row) => row.accountName && !row.issues.some((issue) => issue.startsWith("order ") || issue.startsWith("wrong owner"))).length,
                dataReadyCount: audits.filter((row) => row.dataReady).length,
                normalWorkflowReadyCount: audits.filter((row) => row.normalWorkflowReady).length,
                excludedCount: audits.filter((row) => !row.dataReady).length,
                warningCount: audits.filter((row) => row.warnings.length > 0).length,
                missingCarrierOrTrackingCount: audits.filter((row) => !text(row.carrier) || !text(row.tracking)).length
            },
            sourceDuplicates: {
                orders: duplicateOrdersInSource,
                poNumbers: duplicatePosInSource,
                tracking: duplicateTrackingInSource
            },
            exclusions: audits.filter((row) => !row.dataReady),
            workflowNotStaged: audits.filter((row) => row.dataReady && !row.normalWorkflowReady).map((row) => ({
                orderCode: row.orderCode,
                status: row.status,
                warnings: row.warnings.filter((warning) => warning.includes("STAGED"))
            })),
            warnings: audits.filter((row) => row.warnings.length > 0).map((row) => ({
                orderCode: row.orderCode,
                warnings: row.warnings
            })),
            audits
        };

        console.log(JSON.stringify(output, null, 2));
        await client.query("rollback");
    } catch (error) {
        try {
            await client.query("rollback");
        } catch {}
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
