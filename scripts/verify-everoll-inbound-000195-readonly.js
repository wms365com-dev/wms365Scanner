const { Client } = require("pg");

async function main() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000
    });
    await client.connect();
    try {
        const inbound = await client.query(
            `select id, inbound_code, account_name, status, reference_number, carrier_name,
                    expected_date, fulfillment_location_id, received_at, notes
             from portal_inbounds where inbound_code='INB-000195'`
        );
        if (inbound.rowCount !== 1 || inbound.rows[0].account_name !== "EVEROLL INDUSTRIES LTD"
            || inbound.rows[0].status !== "PUTAWAY_COMPLETE"
            || Number(inbound.rows[0].fulfillment_location_id) !== 143) {
            throw new Error("Inbound identity, tenant, warehouse, or status did not verify.");
        }
        const id = inbound.rows[0].id;
        const assignments = await client.query(
            `select fl.code, cfl.is_primary, cfl.allow_inbound, cfl.allow_outbound,
                    cfl.allow_storage, cfl.customer_portal_visible
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name='EVEROLL INDUSTRIES LTD' order by fl.code`
        );
        if (assignments.rowCount !== 2
            || !assignments.rows.some((row) => row.code === "GW3PL-MISS" && row.is_primary)
            || !assignments.rows.some((row) => row.code === "WHS01" && !row.is_primary
                && row.allow_inbound && row.allow_outbound && row.allow_storage && row.customer_portal_visible)) {
            throw new Error("Everoll warehouse assignments did not verify.");
        }
        const lines = await client.query(
            `select line_number, sku, expected_quantity, received_quantity, received_location, pallet_count
             from portal_inbound_lines where inbound_id=$1 order by line_number`, [id]
        );
        const expected = ["ESP72-47-WHT", "ESP72-47-WHT", "ESP72-36-WHT",
            "ESP72-47-BLK", "ESP72-36-BLK", "ESP72-36-BLK"];
        if (lines.rowCount !== 6 || lines.rows.some((line, index) =>
            line.sku !== expected[index] || line.expected_quantity !== 100
            || line.received_quantity !== 100 || line.received_location !== "WHS01-EVEROLL-REC"
            || line.pallet_count !== 1)) {
            throw new Error("Six-skid inbound lines did not verify.");
        }
        const allocations = await client.query(
            `select a.allocation_number, l.line_number, a.quantity, a.location,
                    a.pallet_reference, a.pallet_size_type, a.pallet_weight, a.pallet_weight_uom
             from portal_inbound_receipt_allocations a
             join portal_inbound_lines l on l.id=a.line_id
             where a.inbound_id=$1 order by l.line_number`, [id]
        );
        if (allocations.rowCount !== 6 || allocations.rows.some((row, index) =>
            row.line_number !== index + 1 || row.quantity !== 100
            || row.location !== "WHS01-EVEROLL-REC"
            || row.pallet_reference !== `EVEROLL-IWF-KTS-20260918-6SKIDS-S${index + 1}`
            || row.pallet_size_type !== "NON_STANDARD"
            || Number(row.pallet_weight) !== 2000 || row.pallet_weight_uom !== "LB")) {
            throw new Error("Six received skid allocations did not verify.");
        }
        const inventory = await client.query(
            `select sku, sum(quantity)::integer as pieces from inventory_lines
             where account_name='EVEROLL INDUSTRIES LTD' and location='WHS01-EVEROLL-BULK'
             group by sku order by sku`
        );
        const quantities = Object.fromEntries(inventory.rows.map((row) => [row.sku, row.pieces]));
        if (JSON.stringify(quantities) !== JSON.stringify({
            "ESP72-36-BLK": 200, "ESP72-36-WHT": 100,
            "ESP72-47-BLK": 100, "ESP72-47-WHT": 200
        })) throw new Error("Committed inventory quantities did not verify.");
        const bin = await client.query(
            `select code, location_type, is_pickable from bin_locations
             where code in ('WHS01-EVEROLL-REC','WHS01-EVEROLL-BULK') order by code`
        );
        const bulk = bin.rows.find((row) => row.code === "WHS01-EVEROLL-BULK");
        const stage = bin.rows.find((row) => row.code === "WHS01-EVEROLL-REC");
        if (bin.rowCount !== 2 || !bulk || bulk.location_type !== "STORAGE" || !bulk.is_pickable
            || !stage || stage.location_type !== "RECEIVING_STAGE" || stage.is_pickable) {
            throw new Error("Everoll receiving/bulk pickable settings did not verify.");
        }
        const stageStock = await client.query(
            `select coalesce(sum(quantity),0)::integer as pieces from inventory_lines
             where account_name='EVEROLL INDUSTRIES LTD' and location='WHS01-EVEROLL-REC'`
        );
        if (stageStock.rows[0].pieces !== 0) throw new Error("Received stock remains in the staging bin.");
        const movements = await client.query(
            `select movement_key, sku, quantity, from_location, to_location from inventory_movements
             where movement_key like 'INB-000195-PUTAWAY-%' order by movement_key`
        );
        if (movements.rowCount !== 6 || movements.rows.some((row, index) =>
            row.movement_key !== `INB-000195-PUTAWAY-S${index + 1}` || Number(row.quantity) !== 100
            || row.sku !== expected[index] || row.from_location !== "WHS01-EVEROLL-REC"
            || row.to_location !== "WHS01-EVEROLL-BULK")) {
            throw new Error("Six-skid movement history did not verify.");
        }
        const ledger = await client.query(
            `select count(*)::integer as entries, sum(quantity_delta)::integer as pieces
             from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1`, [String(id)]
        );
        if (ledger.rows[0].entries !== 6 || ledger.rows[0].pieces !== 600) {
            throw new Error("Inventory transaction ledger did not verify.");
        }
        const putawayLedger = await client.query(
            `select count(*)::integer as entries, coalesce(sum(quantity_delta),0)::integer as net_pieces
             from inventory_transactions where source_type='PORTAL_INBOUND_PUTAWAY'
               and source_id like 'EVEROLL-IWF-KTS-20260918-6SKIDS-S%'`
        );
        if (putawayLedger.rows[0].entries !== 12 || putawayLedger.rows[0].net_pieces !== 0) {
            throw new Error("Putaway ledger did not verify.");
        }
        const billing = await client.query(
            `select id, charge_type, fee_code, source_type, source_ref, quantity, status from billing_events
             where account_name='EVEROLL INDUSTRIES LTD'
               and (source_ref=$1 or source_reference=$2 or source_ref=$2)`,
            [String(id), inbound.rows[0].inbound_code]
        );
        console.log(JSON.stringify({
            inboundCode: inbound.rows[0].inbound_code,
            status: inbound.rows[0].status,
            warehouse: "WHS01",
            originalWarehousePreserved: true,
            skidCount: allocations.rowCount,
            totalPieces: Object.values(quantities).reduce((sum, value) => sum + value, 0),
            weightLb: 12000,
            inventoryBySku: quantities,
            receivingStagePieces: stageStock.rows[0].pieces,
            bulkLocation: bulk.code,
            bulkPickable: bulk.is_pickable,
            movementCount: movements.rowCount,
            receiptLedgerEntries: ledger.rows[0].entries,
            putawayLedgerEntries: putawayLedger.rows[0].entries,
            billingEvents: billing.rows.map((row) => ({ chargeType: row.charge_type, feeCode: row.fee_code,
                sourceType: row.source_type, quantity: row.quantity, status: row.status }))
        }));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
});
