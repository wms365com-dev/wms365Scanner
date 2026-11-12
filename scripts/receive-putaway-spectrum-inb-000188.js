const { Client } = require("pg");
const {
    APP_USER_ROLES,
    updateAdminPortalInboundStatus
} = require("../server");

const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const INBOUND_CODE = "INB-000188";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const RECEIPT_DATE = "2026-09-01";
const DESTINATION = "GW3PL-MISS-SPECTRUM-BULK";
const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "operations@wms365.co",
    full_name: "WMS365 Operations"
};

const receiptPlan = [
    { sku: "SPECTRUM BLUE 1003", lot: "CO-25-2285-12", pallets: 4, bagsPerPallet: 25, kgPerPallet: 500 },
    { sku: "SPECTRUM RED 2 DCI", lot: "2602221", pallets: 1, bagsPerPallet: 18, kgPerPallet: 360 },
    { sku: "SPECTRUM VIOLET 23 BL SI 3672", lot: "MPC 0455/2026", pallets: 8, bagsPerPallet: 12, kgPerPallet: 360 }
];

function buildAllocations(inbound) {
    const lineBySku = new Map(inbound.lines.map((line) => [line.sku, line]));
    const allocations = [];
    let palletNumber = 1;
    for (const item of receiptPlan) {
        const line = lineBySku.get(item.sku);
        if (!line) throw new Error(`Inbound line is missing for ${item.sku}.`);
        for (let index = 0; index < item.pallets; index += 1) {
            allocations.push({
                id: line.id,
                sku: item.sku,
                receivedQuantity: item.bagsPerPallet,
                receivedLocation: DESTINATION,
                lotNumber: item.lot,
                palletReference: `GW130626-P${String(palletNumber).padStart(2, "0")}`,
                palletSizeType: "STANDARD_40_48_55",
                palletWeight: item.kgPerPallet,
                palletWeightUom: "KG"
            });
            palletNumber += 1;
        }
    }
    return allocations;
}

async function assertScopeAndLock(client) {
    const result = await client.query(
        `select i.id,i.inbound_code,i.status,i.account_name,i.fulfillment_location_id,i.received_at,
                i.reference_number,i.expected_date
         from portal_inbounds i
         where i.inbound_code=$1 and i.account_name=$2
         for update`,
        [INBOUND_CODE, ACCOUNT]
    );
    if (result.rowCount !== 1) throw new Error(`${INBOUND_CODE} was not found once under Spectrum.`);
    const inbound = result.rows[0];
    if (inbound.status !== "SUBMITTED" || inbound.received_at) {
        throw new Error(`${INBOUND_CODE} is already ${inbound.status}; stopping to prevent duplicate receipt.`);
    }
    if (String(inbound.fulfillment_location_id) !== String(WAREHOUSE_ID)) {
        throw new Error(`${INBOUND_CODE} is not assigned to ${WAREHOUSE_CODE}.`);
    }
    const warehouse = await client.query(
        `select fl.id,fl.code,fl.name,cfl.allow_inbound,cfl.allow_storage
         from company_fulfillment_locations cfl
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and fl.id=$2 and fl.code=$3
           and cfl.allow_inbound=true and cfl.allow_storage=true and fl.is_active=true`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    if (warehouse.rowCount !== 1) throw new Error("Spectrum warehouse access is not valid for receiving and storage.");
    return inbound.id;
}

async function ensureDestinationIsSafe(client) {
    const foreignInventory = await client.query(
        `select account_name,sku,quantity from inventory_lines
         where location=$1 and account_name<>$2 and quantity<>0
         for update`,
        [DESTINATION, ACCOUNT]
    );
    if (foreignInventory.rowCount) throw new Error(`${DESTINATION} contains another customer's inventory.`);

    const existing = await client.query("select * from bin_locations where code=$1 for update", [DESTINATION]);
    if (existing.rowCount) {
        const bin = existing.rows[0];
        if ((bin.account_name && bin.account_name !== ACCOUNT)
            || (bin.fulfillment_location_id && String(bin.fulfillment_location_id) !== String(WAREHOUSE_ID))) {
            throw new Error(`${DESTINATION} is assigned to another company or warehouse.`);
        }
    }
    await client.query(
        `insert into bin_locations (code,note,location_type,is_pickable,account_name,fulfillment_location_id)
         values ($1,$2,'STORAGE',true,$3,$4)
         on conflict (code) do update set note=excluded.note,location_type='STORAGE',is_pickable=true,
             account_name=excluded.account_name,fulfillment_location_id=excluded.fulfillment_location_id,updated_at=now()`,
        [DESTINATION, "Spectrum Dyes & Pigments pickable bulk storage.", ACCOUNT, WAREHOUSE_ID]
    );
}

async function backdateReceipt(client, inboundId) {
    await client.query(
        `update portal_inbounds
         set arrived_at=($2::date + time '12:00') at time zone 'America/Toronto',
             received_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now()
         where id=$1`,
        [inboundId, RECEIPT_DATE]
    );
    await client.query(
        `update portal_inbound_pallet_labels
         set label_date=$2::date,confirmed_at=($2::date + time '12:00') at time zone 'America/Toronto',updated_at=now()
         where inbound_id=$1`,
        [inboundId, RECEIPT_DATE]
    );
}

async function verify(client, inboundId) {
    const [inboundResult, linesResult, allocationsResult, labelsResult, inventoryResult, binResult, ledgerResult, documentsResult, activeAllocationsResult] = await Promise.all([
        client.query(
            `select id,inbound_code,status,account_name,fulfillment_location_id,arrived_at,received_at,
                    to_char(received_at at time zone 'America/Toronto','YYYY-MM-DD') received_date
             from portal_inbounds where id=$1`,
            [inboundId]
        ),
        client.query(
            `select sku,expected_quantity,received_quantity,received_location,lot_number
             from portal_inbound_lines where inbound_id=$1 order by line_number`,
            [inboundId]
        ),
        client.query(
            `select count(*)::integer count,sum(quantity)::integer quantity,
                    count(distinct pallet_reference)::integer pallets,
                    count(distinct lot_number)::integer lots
             from portal_inbound_receipt_allocations where inbound_id=$1`,
            [inboundId]
        ),
        client.query(
            `select count(*)::integer count,sum(actual_quantity)::integer quantity,
                    count(*) filter (where pallet_status='RECEIVED')::integer received
             from portal_inbound_pallet_labels where inbound_id=$1`,
            [inboundId]
        ),
        client.query(
            `select sku,lot_number,sum(quantity)::integer quantity
             from inventory_lines where account_name=$1 and location=$2 and quantity>0
             group by sku,lot_number order by sku`,
            [ACCOUNT, DESTINATION]
        ),
        client.query(
            `select code,location_type,is_pickable,account_name,fulfillment_location_id
             from bin_locations where code=$1`,
            [DESTINATION]
        ),
        client.query(
            `select transaction_type,count(*)::integer count,sum(quantity_delta)::integer quantity
             from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text
             group by transaction_type order by transaction_type`,
            [String(inboundId)]
        ),
        client.query(
            `select count(*)::integer count from portal_inbound_documents where inbound_id=$1`,
            [inboundId]
        ),
        client.query(
            `select coalesce(sum(a.allocated_quantity),0)::integer quantity
             from portal_order_allocations a
             join portal_orders o on o.id=a.order_id
             where o.account_name=$1 and o.status in ('RELEASED','PICKED','STAGED')
               and a.sku=any($2::text[])`,
            [ACCOUNT, receiptPlan.map((item) => item.sku)]
        )
    ]);

    const inbound = inboundResult.rows[0];
    const allocations = allocationsResult.rows[0];
    const labels = labelsResult.rows[0];
    const bin = binResult.rows[0];
    const expected = new Map(receiptPlan.map((item) => [item.sku, item.pallets * item.bagsPerPallet]));
    const inventory = new Map(inventoryResult.rows.map((row) => [row.sku, Number(row.quantity)]));
    const receiptLedger = ledgerResult.rows.find((row) => row.transaction_type === "RECEIVING");
    if (!inbound
        || inbound.status !== "PUTAWAY_COMPLETE"
        || inbound.account_name !== ACCOUNT
        || String(inbound.fulfillment_location_id) !== String(WAREHOUSE_ID)
        || inbound.received_date !== RECEIPT_DATE
        || linesResult.rowCount !== receiptPlan.length
        || linesResult.rows.some((line) => Number(line.received_quantity) !== expected.get(line.sku))
        || linesResult.rows.some((line) => line.received_location !== DESTINATION)
        || Number(allocations.count) !== 13
        || Number(allocations.quantity) !== 214
        || Number(allocations.pallets) !== 13
        || Number(allocations.lots) !== 3
        || Number(labels.count) !== 13
        || Number(labels.received) !== 13
        || Number(labels.quantity) !== 214
        || inventoryResult.rowCount !== receiptPlan.length
        || [...expected].some(([sku, quantity]) => inventory.get(sku) !== quantity)
        || !bin
        || bin.location_type !== "STORAGE"
        || !bin.is_pickable
        || bin.account_name !== ACCOUNT
        || String(bin.fulfillment_location_id) !== String(WAREHOUSE_ID)
        || Number(receiptLedger?.quantity || 0) !== 214
        || Number(documentsResult.rows[0].count) !== 1
        || Number(activeAllocationsResult.rows[0].quantity) !== 0) {
        throw new Error(`Verification failed: ${JSON.stringify({ inbound, lines: linesResult.rows, allocations, labels, inventory: inventoryResult.rows, bin, ledger: ledgerResult.rows, documents: documentsResult.rows[0], activeAllocations: activeAllocationsResult.rows[0] })}`);
    }
    return {
        inbound,
        lines: linesResult.rows,
        allocations,
        labels,
        inventory: inventoryResult.rows,
        bin,
        ledger: ledgerResult.rows,
        availableQuantity: 214
    };
}

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const inboundId = await assertScopeAndLock(client);
        await ensureDestinationIsSafe(client);

        let inbound = await updateAdminPortalInboundStatus(client, inboundId, "ARRIVED", ACTOR, {
            note: `Received September 1, 2026 from packing slip GW/1306/26.`
        });
        inbound = await updateAdminPortalInboundStatus(client, inboundId, "RECEIVED", ACTOR, {
            lines: buildAllocations(inbound)
        });

        // Receiving temporarily marks the destination as a receiving stage. Completing putaway
        // restores this verified Spectrum-only destination to pickable storage.
        await client.query(
            `update bin_locations set location_type='STORAGE',is_pickable=true,account_name=$2,
                    fulfillment_location_id=$3,note=$4,updated_at=now() where code=$1`,
            [DESTINATION, ACCOUNT, WAREHOUSE_ID, "Spectrum Dyes & Pigments pickable bulk storage."]
        );
        await updateAdminPortalInboundStatus(client, inboundId, "PUTAWAY_COMPLETE", ACTOR, {
            note: `All 13 skids put away to ${DESTINATION}; inventory is pickable.`
        });
        await backdateReceipt(client, inboundId);

        const result = await verify(client, inboundId);
        await client.query("commit");
        console.log(JSON.stringify({ success: true, ...result }, null, 2));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
