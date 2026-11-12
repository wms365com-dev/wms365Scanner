const { Client } = require("pg");
const {
    APP_USER_ROLES,
    savePortalInboundForAccount,
    updateAdminPortalInboundStatus
} = require("../server");

const ACCOUNT = "NORTH HIMALAYAN TRADERS";
const WAREHOUSE_ID = 143;
const WAREHOUSE_CODE = "WHS01";
const RECEIPT_DATE = "2026-09-09";
const CONTAINER = "HASU4221578";
const REFERENCE = "269845896";
const RR_PICKUP = "179008";
const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "operations@wms365.co",
    full_name: "WMS365 Operations"
};

const pallets = [
    { location: "DE02AA", sku: "SALTEREX-CMPRSD2026/04", description: "Himalayan Compressed Salt", quantity: 66 },
    { location: "DE04AA", sku: "SALTEREX-CMPRSD2026/04", description: "Himalayan Compressed Salt", quantity: 64 },
    { location: "DE06AA", sku: "SALTEREX-CMPRSD2026/04", description: "Himalayan Compressed Salt", quantity: 65 },
    { location: "DE08AA", sku: "SALTEREX-CMPRSD2026/04", description: "Himalayan Compressed Salt", quantity: 64 },
    { location: "DE10AA", sku: "SALTEREX-CMPRSD2026/04", description: "Himalayan Compressed Salt", quantity: 66 },
    { location: "DE12AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE14AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE16AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE18AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE20AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE22AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE24AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE26AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE28AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE30AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE32AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE34AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 91 },
    { location: "DE36AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 87 },
    { location: "DE38AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 78 },
    { location: "DE40AA", sku: "SALTEREX-NATRL2026/04", description: "Himalayan Rock Salt", quantity: 77 }
].map((pallet, index) => ({
    ...pallet,
    lotNumber: pallet.sku,
    palletReference: `${CONTAINER}-P${String(index + 1).padStart(2, "0")}`,
    palletCode: `PLT-${CONTAINER}-${String(index + 1).padStart(2, "0")}`
}));

function summarize(rows) {
    return rows.reduce((result, row) => {
        result[row.sku] = (result[row.sku] || 0) + row.quantity;
        return result;
    }, {});
}

async function assertLiveScope(client) {
    const result = await client.query(
        `select oa.name,fl.id warehouse_id,fl.code warehouse_code,fl.name warehouse_name
         from owner_accounts oa
         join company_fulfillment_locations cfl on cfl.account_name=oa.name
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where oa.name=$1 and fl.id=$2 and fl.code=$3 and cfl.allow_inbound=true`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    if (result.rowCount !== 1) {
        throw new Error("North Himalayan Traders is not exclusively configured for the expected Edwards warehouse.");
    }
    const extra = await client.query(
        "select count(*)::integer count from company_fulfillment_locations where account_name=$1 and fulfillment_location_id<>$2",
        [ACCOUNT, WAREHOUSE_ID]
    );
    if (Number(extra.rows[0].count) !== 0) {
        throw new Error("North Himalayan Traders has another warehouse assignment; stopping to protect warehouse isolation.");
    }
}

async function assertNoDuplicate(client) {
    const result = await client.query(
        `select id,inbound_code,status,reference_number,notes from portal_inbounds
         where account_name=$1 and (upper(reference_number)=upper($2) or upper(notes) like '%' || upper($3) || '%')
         order by id for update`,
        [ACCOUNT, REFERENCE, CONTAINER]
    );
    if (result.rowCount) {
        throw new Error(`Inbound already exists: ${result.rows.map((row) => `${row.inbound_code} (${row.status})`).join(", ")}`);
    }
}

async function ensureItems(client) {
    const items = [...new Map(pallets.map((row) => [row.sku, row])).values()];
    for (const item of items) {
        await client.query(
            `insert into item_catalog (
                account_name,sku,upc,description,tracking_level,uom_label,unit_uom,
                lot_tracked,expiration_tracked,item_type,item_category,blocked
             ) values ($1,$2,'',$3,'CASE','cases','CASE',true,false,'INVENTORY','Salt',false)
             on conflict (account_name,sku) do update set
                description=excluded.description,
                tracking_level='CASE',uom_label='cases',unit_uom='CASE',
                lot_tracked=true,expiration_tracked=false,blocked=false,updated_at=now()`,
            [ACCOUNT, item.sku, item.description]
        );
    }
}

async function ensureExclusiveLocations(client) {
    for (const pallet of pallets) {
        const existing = await client.query(
            "select * from bin_locations where code=$1 for update",
            [pallet.location]
        );
        if (existing.rowCount) {
            const row = existing.rows[0];
            if ((row.account_name && row.account_name !== ACCOUNT)
                || (row.fulfillment_location_id && Number(row.fulfillment_location_id) !== WAREHOUSE_ID)) {
                throw new Error(`Location ${pallet.location} belongs to another customer or warehouse.`);
            }
            const stock = await client.query(
                "select account_name,sku,quantity from inventory_lines where location=$1 and account_name<>$2 and quantity<>0",
                [pallet.location, ACCOUNT]
            );
            if (stock.rowCount) throw new Error(`Location ${pallet.location} contains another customer's inventory.`);
        }
        await client.query(
            `insert into bin_locations (code,note,location_type,is_pickable,account_name,fulfillment_location_id)
             values ($1,$2,'STORAGE',true,$3,$4)
             on conflict (code) do update set note=excluded.note,location_type='STORAGE',is_pickable=true,
                 account_name=excluded.account_name,fulfillment_location_id=excluded.fulfillment_location_id,updated_at=now()`,
            [pallet.location, `North Himalayan Traders pickable storage - ${CONTAINER}`, ACCOUNT, WAREHOUSE_ID]
        );
    }
}

async function addPalletLabels(client, inbound) {
    const lineBySku = new Map(inbound.lines.map((line) => [line.sku, line]));
    for (const pallet of pallets) {
        const line = lineBySku.get(pallet.sku);
        if (!line) throw new Error(`Inbound line is missing for ${pallet.sku}.`);
        const existing = await client.query(
            "select 1 from portal_inbound_pallet_labels where pallet_code=$1",
            [pallet.palletCode]
        );
        if (existing.rowCount) throw new Error(`Pallet code ${pallet.palletCode} already exists.`);
        const label = await client.query(
            `insert into portal_inbound_pallet_labels (
                inbound_id,line_id,pallet_code,account_name,sku,upc,description,cases_on_pallet,
                expected_quantity,pallet_type,pallet_status,is_mixed,billable,pallet_size_type,
                pallet_length_inches,pallet_width_inches,pallet_height_inches,pallet_size_note,
                label_date,created_by,notes
             ) values ($1,$2,$3,$4,$5,'',$6,$7,$7,'SINGLE_SKU','PLANNED',false,true,
                       'STANDARD_40_48_55',40,48,55,'',$8,$9,$10) returning id`,
            [inbound.id, line.id, pallet.palletCode, ACCOUNT, pallet.sku, pallet.description,
                pallet.quantity, RECEIPT_DATE, ACTOR.email, `Container ${CONTAINER}; location ${pallet.location}`]
        );
        await client.query(
            `insert into portal_inbound_pallet_label_contents
                (pallet_label_id,inbound_id,line_id,sku,quantity,lot_number,expiration_date)
             values ($1,$2,$3,$4,$5,$6,null)`,
            [label.rows[0].id, inbound.id, line.id, pallet.sku, pallet.quantity, pallet.lotNumber]
        );
    }
}

async function verify(client, inboundId) {
    const inbound = await client.query("select id,inbound_code,status,reference_number,carrier_name,expected_date,received_at,fulfillment_location_id,notes from portal_inbounds where id=$1", [inboundId]);
    const stock = await client.query(`select sku,sum(quantity)::integer quantity,count(*)::integer location_count
                      from inventory_lines where account_name=$1 and location=any($2::text[]) and quantity>0
                      group by sku order by sku`, [ACCOUNT, pallets.map((row) => row.location)]);
    const bins = await client.query(`select count(*)::integer total,
                             count(*) filter (where is_pickable=true and location_type='STORAGE' and account_name=$1 and fulfillment_location_id=$2)::integer correct
                      from bin_locations where code=any($3::text[])`, [ACCOUNT, WAREHOUSE_ID, pallets.map((row) => row.location)]);
    const allocations = await client.query("select count(*)::integer count,sum(quantity)::integer quantity,count(distinct pallet_reference)::integer pallets from portal_inbound_receipt_allocations where inbound_id=$1", [inboundId]);
    const labels = await client.query("select count(*)::integer count,sum(actual_quantity)::integer quantity,count(*) filter (where pallet_status='RECEIVED')::integer received from portal_inbound_pallet_labels where inbound_id=$1", [inboundId]);
    const ledger = await client.query("select count(*)::integer count,sum(quantity_delta)::integer quantity from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text", [String(inboundId)]);
    return {
        inbound: inbound.rows[0],
        stock: stock.rows,
        bins: bins.rows[0],
        allocations: allocations.rows[0],
        labels: labels.rows[0],
        ledger: ledger.rows[0]
    };
}

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        console.error("step:scope");
        await assertLiveScope(client);
        console.error("step:duplicate");
        await assertNoDuplicate(client);
        console.error("step:items");
        await ensureItems(client);
        console.error("step:locations");
        await ensureExclusiveLocations(client);

        const expectedBySku = summarize(pallets);
        console.error("step:create-inbound");
        let inbound = await savePortalInboundForAccount(client, ACCOUNT, {
            fulfillmentLocationId: WAREHOUSE_ID,
            referenceNumber: REFERENCE,
            carrierName: "Maersk",
            expectedDate: RECEIPT_DATE,
            contactName: "North Himalayan Traders Inc.",
            notes: `Container ${CONTAINER} | Shipment ${REFERENCE} | RR pickup ${RR_PICKUP} | 20 skids`,
            lines: Object.entries(expectedBySku).map(([sku, quantity]) => ({ sku, quantity }))
        }, {
            activityTitlePrefix: "warehouse",
            activityActor: ACTOR.full_name,
            creatorEmail: "info@northhimalayantraders.com",
            taskAppUser: ACTOR
        });

        console.error(`step:labels:${inbound.inboundCode}`);
        await addPalletLabels(client, inbound);
        console.error("step:arrived");
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "ARRIVED", ACTOR, {
            note: `Container ${CONTAINER} arrived and was checked in.`
        });
        console.error("step:received");
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", ACTOR, {
            lines: pallets.map((pallet) => ({
                id: inbound.lines.find((line) => line.sku === pallet.sku).id,
                receivedQuantity: pallet.quantity,
                receivedLocation: pallet.location,
                lotNumber: pallet.lotNumber,
                palletReference: pallet.palletReference,
                palletSizeType: "STANDARD_40_48_55"
            }))
        });
        console.error("step:putaway");
        inbound = await updateAdminPortalInboundStatus(client, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
            note: "All 20 skids put away to customer-exclusive Edwards pickable storage locations."
        });
        await client.query(
            `update portal_inbounds set arrived_at=$2::date + time '12:00', received_at=$2::date + time '12:00', updated_at=now() where id=$1`,
            [inbound.id, RECEIPT_DATE]
        );

        console.error("step:verify");
        const result = await verify(client, inbound.id);
        const expectedTotal = pallets.reduce((sum, row) => sum + row.quantity, 0);
        if (result.inbound.status !== "PUTAWAY_COMPLETE"
            || Number(result.bins.total) !== pallets.length
            || Number(result.bins.correct) !== pallets.length
            || Number(result.allocations.pallets) !== pallets.length
            || Number(result.allocations.quantity) !== expectedTotal
            || Number(result.labels.count) !== pallets.length
            || Number(result.labels.received) !== pallets.length
            || Number(result.labels.quantity) !== expectedTotal
            || Number(result.ledger.quantity) !== expectedTotal) {
            throw new Error(`Verification failed: ${JSON.stringify(result)}`);
        }
        const stockSummary = Object.fromEntries(result.stock.map((row) => [row.sku, Number(row.quantity)]));
        for (const [sku, quantity] of Object.entries(expectedBySku)) {
            if (stockSummary[sku] !== quantity) throw new Error(`Pickable stock verification failed for ${sku}.`);
        }

        console.error("step:commit");
        await client.query("commit");
        console.log(JSON.stringify({
            success: true,
            inbound: result.inbound,
            palletCount: pallets.length,
            caseCount: expectedTotal,
            stock: result.stock,
            locations: pallets.map((row) => ({ location: row.location, sku: row.sku, cases: row.quantity, lot: row.lotNumber })),
            verification: { bins: result.bins, allocations: result.allocations, labels: result.labels, ledger: result.ledger }
        }, null, 2));
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
