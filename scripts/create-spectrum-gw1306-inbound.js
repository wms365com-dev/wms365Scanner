const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const {
    APP_USER_ROLES,
    savePortalInboundForAccount,
    PORTAL_ORDER_DOCUMENT_CATEGORIES
} = require("../server");

const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const REFERENCE = "GW/1306/26";
const PO_REFERENCE = "TRF Sept 1";
const EXPECTED_DATE = "2026-09-01";
const SOURCE_PATH = "C:\\Users\\T470\\Desktop\\GW-1306-26-13 skids Transfer to Grey Wolf.pdf";
const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "operations@wms365.co",
    full_name: "WMS365 Operations"
};

const items = [
    {
        sku: "SPECTRUM BLUE 1003",
        description: "Pigment Blue 15:3",
        lotNumber: "CO-25-2285-12",
        bagCount: 100,
        weightKg: 2000,
        pallets: 4,
        bagsPerPallet: 25,
        kgPerPallet: 500,
        kgPerBag: 20
    },
    {
        sku: "SPECTRUM RED 2 DCI",
        description: "Pigment Red 2",
        lotNumber: "2602221",
        bagCount: 18,
        weightKg: 360,
        pallets: 1,
        bagsPerPallet: 18,
        kgPerPallet: 360,
        kgPerBag: 20
    },
    {
        sku: "SPECTRUM VIOLET 23 BL SI 3672",
        description: "Pigment Violet 23",
        lotNumber: "MPC 0455/2026",
        bagCount: 96,
        weightKg: 2880,
        pallets: 8,
        bagsPerPallet: 12,
        kgPerPallet: 360,
        kgPerBag: 30
    }
];

function buildPallets() {
    const pallets = [];
    let sequence = 1;
    for (const item of items) {
        for (let index = 0; index < item.pallets; index += 1) {
            pallets.push({
                ...item,
                palletCode: `PLT-GW130626-${String(sequence).padStart(2, "0")}`
            });
            sequence += 1;
        }
    }
    return pallets;
}

async function assertScope(client) {
    const result = await client.query(
        `select oa.name, fl.id warehouse_id, fl.code warehouse_code, fl.name warehouse_name
         from owner_accounts oa
         join company_fulfillment_locations cfl on cfl.account_name=oa.name
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where oa.name=$1 and fl.id=$2 and fl.code=$3 and cfl.allow_inbound=true and fl.is_active=true`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    if (result.rowCount !== 1) {
        throw new Error("Spectrum is not configured for inbound receiving at Grey Wolf Mississauga.");
    }
}

async function assertNoDuplicate(client) {
    const result = await client.query(
        `select id,inbound_code,status,reference_number
         from portal_inbounds
         where account_name=$1
           and (upper(reference_number)=upper($2) or upper(notes) like '%' || upper($3) || '%')
         order by id
         for update`,
        [ACCOUNT, REFERENCE, PO_REFERENCE]
    );
    if (result.rowCount) {
        throw new Error(`Inbound already exists: ${result.rows.map((row) => `${row.inbound_code} (${row.status})`).join(", ")}`);
    }
}

async function ensureItems(client) {
    for (const item of items) {
        await client.query(
            `insert into item_catalog (
                account_name,sku,upc,description,tracking_level,uom_label,unit_uom,
                units_per_case,lot_tracked,expiration_tracked,item_type,item_category,blocked
             ) values ($1,$2,'',$3,'UNIT','bags','BAG',1,true,false,'INVENTORY','Pigment',false)
             on conflict (account_name,sku) do update set
                description=excluded.description,
                tracking_level='UNIT',uom_label='bags',unit_uom='BAG',units_per_case=1,
                lot_tracked=true,expiration_tracked=false,blocked=false,updated_at=now()`,
            [ACCOUNT, item.sku, item.description]
        );
    }
}

async function addPalletLabels(client, inbound) {
    const lineBySku = new Map(inbound.lines.map((line) => [line.sku, line]));
    for (const pallet of buildPallets()) {
        const line = lineBySku.get(pallet.sku);
        if (!line) throw new Error(`Inbound line is missing for ${pallet.sku}.`);
        const insertResult = await client.query(
            `insert into portal_inbound_pallet_labels (
                inbound_id,line_id,pallet_code,account_name,sku,upc,description,cases_on_pallet,
                expected_quantity,pallet_type,pallet_status,is_mixed,billable,pallet_size_type,
                pallet_length_inches,pallet_width_inches,pallet_height_inches,pallet_size_note,
                label_date,created_by,notes
             ) values (
                $1,$2,$3,$4,$5,'',$6,$7,$7,'SINGLE_SKU','PLANNED',false,false,
                'STANDARD_40_48_55',40,48,55,'',$8,$9,$10
             ) returning id`,
            [
                inbound.id,
                line.id,
                pallet.palletCode,
                ACCOUNT,
                pallet.sku,
                pallet.description,
                pallet.bagsPerPallet,
                EXPECTED_DATE,
                ACTOR.email,
                `${pallet.bagsPerPallet} bags x ${pallet.kgPerBag} kg; ${pallet.kgPerPallet} kg; lot ${pallet.lotNumber}`
            ]
        );
        await client.query(
            `insert into portal_inbound_pallet_label_contents
                (pallet_label_id,inbound_id,line_id,sku,quantity,lot_number,expiration_date)
             values ($1,$2,$3,$4,$5,$6,null)`,
            [insertResult.rows[0].id, inbound.id, line.id, pallet.sku, pallet.bagsPerPallet, pallet.lotNumber]
        );
    }
}

async function verify(client, inboundId, sourceSize) {
    const inboundResult = await client.query(
        `select id,inbound_code,account_name,status,reference_number,expected_date,
                fulfillment_location_id,received_at,notes
         from portal_inbounds where id=$1`,
        [inboundId]
    );
    const linesResult = await client.query(
        `select l.line_number,l.sku,l.expected_quantity,c.description,c.tracking_level,c.uom_label,c.unit_uom,
                c.lot_tracked,c.expiration_tracked
         from portal_inbound_lines l
         join item_catalog c on c.account_name=$2 and c.sku=l.sku
         where l.inbound_id=$1 order by l.line_number`,
        [inboundId, ACCOUNT]
    );
    const labelsResult = await client.query(
        `select count(*)::integer count,sum(expected_quantity)::integer bags,
                count(*) filter (where pallet_status='PLANNED')::integer planned,
                count(distinct plc.lot_number)::integer lot_count
         from portal_inbound_pallet_labels pl
         join portal_inbound_pallet_label_contents plc on plc.pallet_label_id=pl.id
         where pl.inbound_id=$1`,
        [inboundId]
    );
    const documentResult = await client.query(
        `select count(*)::integer count,max(file_name) file_name,max(file_type) file_type,
                max(file_size)::integer file_size,max(document_category) document_category
         from portal_inbound_documents where inbound_id=$1`,
        [inboundId]
    );
    const stockResult = await client.query(
        `select count(*)::integer inventory_rows,
                coalesce(sum(quantity_delta),0)::integer inventory_quantity
         from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1::text`,
        [String(inboundId)]
    );

    const inbound = inboundResult.rows[0];
    const labels = labelsResult.rows[0];
    const document = documentResult.rows[0];
    const stock = stockResult.rows[0];
    const expectedBySku = new Map(items.map((item) => [item.sku, item.bagCount]));
    if (!inbound
        || inbound.account_name !== ACCOUNT
        || inbound.status !== "SUBMITTED"
        || inbound.reference_number !== REFERENCE
        || String(inbound.fulfillment_location_id) !== String(WAREHOUSE_ID)
        || new Date(inbound.expected_date).toISOString().slice(0, 10) !== EXPECTED_DATE
        || inbound.received_at
        || linesResult.rowCount !== items.length
        || linesResult.rows.some((line) => Number(line.expected_quantity) !== expectedBySku.get(line.sku))
        || linesResult.rows.some((line) => line.tracking_level !== "UNIT" || line.unit_uom !== "BAG" || !line.lot_tracked)
        || Number(labels.count) !== 13
        || Number(labels.planned) !== 13
        || Number(labels.bags) !== 214
        || Number(labels.lot_count) !== 3
        || Number(document.count) !== 1
        || Number(document.file_size) !== sourceSize
        || document.file_type !== "application/pdf"
        || document.document_category !== PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_PACKING_SLIP
        || Number(stock.inventory_rows) !== 0
        || Number(stock.inventory_quantity) !== 0) {
        throw new Error(`Verification failed: ${JSON.stringify({ inbound, lines: linesResult.rows, labels, document, stock })}`);
    }
    return { inbound, lines: linesResult.rows, labels, document, stock };
}

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const sourceBuffer = fs.readFileSync(SOURCE_PATH);
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        await assertScope(client);
        await assertNoDuplicate(client);
        await ensureItems(client);

        const notes = [
            `Packing slip ${REFERENCE}; P.O. ${PO_REFERENCE}; dated ${EXPECTED_DATE}.`,
            "13 skids; 214 bags; 5,240 kg total.",
            "Blue: 100 bags / 2,000 kg / 4 skids / lot CO-25-2285-12.",
            "Red: 18 bags / 360 kg / 1 skid / lot 2602221.",
            "Violet: 96 bags / 2,880 kg / 8 skids / lot MPC 0455/2026.",
            "Source lists violet as 96 bags x 30 kg and 360 kg per skid; 12 bags per skid is derived across 8 skids."
        ].join(" ");

        const inbound = await savePortalInboundForAccount(client, ACCOUNT, {
            fulfillmentLocationId: WAREHOUSE_ID,
            referenceNumber: REFERENCE,
            carrierName: "",
            expectedDate: EXPECTED_DATE,
            contactName: "Spectrum Dyes & Pigments Inc.",
            contactPhone: "905-238-5954",
            notes,
            lines: items.map((item) => ({ sku: item.sku, quantity: item.bagCount }))
        }, {
            activityTitlePrefix: "warehouse",
            activityActor: ACTOR.full_name,
            creatorEmail: "rajiv.u@spectrumpigments.com",
            taskAppUser: ACTOR,
            requiredDocuments: [{
                fileName: path.basename(SOURCE_PATH),
                fileType: "application/pdf",
                fileSize: sourceBuffer.length,
                fileBuffer: sourceBuffer,
                documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_PACKING_SLIP
            }]
        });
        await addPalletLabels(client, inbound);
        const result = await verify(client, inbound.id, sourceBuffer.length);
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
