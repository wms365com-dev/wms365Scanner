const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const { Client } = require("pg");

const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const EXPECTED_DATE = "2026-10-05";
const SOURCE_DIR = "C:\\Users\\T470\\Desktop";
const ACTOR = { role: "super_admin", email: "operations@wms365.co", full_name: "WMS365 Operations" };

const inbounds = [
    {
        file: "GW-PS-1308-26.pdf", reference: "GW/1308/26", printedReference: "GW/1308/26",
        po: "NAV/TOR/11649", skids: 10,
        lines: [{ sku: "SPECTRUM VIOLET K 3", description: "Pigment Violet 3", uom: "BOX",
            quantity: 100, kgPerUnit: 30, lot: "DD/CS/252/26" }]
    },
    {
        file: "GW-PS-1310-26.pdf", reference: "GW/1310/26", printedReference: "GW/1310/26",
        po: "SMCU-7017290", skids: 1,
        lines: [
            { sku: "SPECTRUM RED 185 SDB", description: "Pigment Red 185", uom: "BAG",
                quantity: 10, kgPerUnit: 10, lot: "260612" },
            { sku: "SPECTRUM YELLOW 83", description: "Pigment Yellow 83", uom: "BAG",
                quantity: 8, kgPerUnit: 25, lot: "26330004" }
        ]
    },
    {
        file: "GW-PS-1307-26-4.pdf", reference: "GW/1307/26", printedReference: "GW/1307/26",
        po: "UETU-7864700", skids: 4,
        lines: [{ sku: "SPECTRUM BLUE 15:4 CCS", description: "Pigment Blue 15:4", uom: "BAG",
            quantity: 100, kgPerUnit: 20, lot: "CC-26-8197-26" }]
    },
    {
        file: "GW-PS-1309-26.pdf", reference: "FANU-3348552", printedReference: "GW/1308/27",
        po: "FANU-3348552", skids: 2,
        lines: [{ sku: "SPECTRUM VIOLET 23 PL 3645", description: "Pigment Violet 23", uom: "BOX",
            quantity: 24, kgPerUnit: 20, lot: "MPC 0639/2026" }]
    }
];

function loadInboundWorkflow() {
    // The checkout has unrelated uncommitted server edits; load its checked-in version in memory.
    const source = execFileSync("git", ["show", "HEAD:server.js"], {
        cwd: path.resolve(__dirname, ".."), encoding: "utf8", maxBuffer: 50 * 1024 * 1024
    });
    const filename = path.resolve(__dirname, "..", "server.js");
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(source, filename);
    if (typeof loaded.exports.savePortalInboundForAccount !== "function") {
        throw new Error("Checked-in inbound workflow is unavailable.");
    }
    return loaded.exports;
}

function sourceDocuments() {
    return inbounds.map((inbound) => {
        const filename = path.join(SOURCE_DIR, inbound.file);
        const fileBuffer = fs.readFileSync(filename);
        if (!fileBuffer.length || fileBuffer.length >= 10 * 1024 * 1024) {
            throw new Error(`Packing slip size is invalid: ${inbound.file}`);
        }
        const text = execFileSync("pdftotext", ["-layout", filename, "-"], { encoding: "utf8" });
        if (!text.includes("Spectrum Dyes & Pigments Inc.")
            || !text.includes(inbound.po)
            || !text.includes(inbound.printedReference)) {
            throw new Error(`Packing slip identity did not match: ${inbound.file}`);
        }
        return { ...inbound, fileBuffer };
    });
}

async function preflight(client, documents) {
    const scope = await client.query(
        `select oa.id, oa.is_active, fl.id warehouse_id, fl.code warehouse_code,
                fl.is_active warehouse_active, cfl.allow_inbound
         from owner_accounts oa
         join company_fulfillment_locations cfl on cfl.account_name=oa.name
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where oa.name=$1 and fl.id=$2 and fl.code=$3`,
        [ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    if (scope.rowCount !== 1 || !scope.rows[0].is_active
        || !scope.rows[0].warehouse_active || !scope.rows[0].allow_inbound) {
        throw new Error("Spectrum account or inbound warehouse scope changed.");
    }
    const references = documents.map((inbound) => inbound.reference);
    const pos = documents.map((inbound) => inbound.po);
    const existing = await client.query(
        `select inbound_code, reference_number from portal_inbounds
         where account_name=$1 and (
             upper(reference_number)=any($2::text[])
             or exists (select 1 from unnest($3::text[]) po
                        where notes ilike '%' || po || '%')
         )`,
        [ACCOUNT, references.map((ref) => ref.toUpperCase()), pos]
    );
    if (existing.rowCount) throw new Error("One or more source references already has an inbound.");
    const itemDefs = new Map(documents.flatMap((inbound) => inbound.lines).map((line) => [line.sku, line]));
    if (itemDefs.size !== 5) throw new Error("Unexpected item count in the source set.");
    const catalog = await client.query(
        `select sku, description, tracking_level, unit_uom, units_per_case, lot_tracked, blocked
         from item_catalog where account_name=$1 and sku=any($2::text[])`,
        [ACCOUNT, [...itemDefs.keys()]]
    );
    for (const item of catalog.rows) {
        const expected = itemDefs.get(item.sku);
        if (!expected || item.description !== expected.description || item.tracking_level !== "UNIT"
            || item.unit_uom !== expected.uom || Number(item.units_per_case) !== 1
            || !item.lot_tracked || item.blocked) {
            throw new Error(`Existing item conflicts with packing slip: ${item.sku}`);
        }
    }
    return { accountId: scope.rows[0].id, itemDefs, existingItems: catalog.rows.length };
}

async function addItems(client, itemDefs) {
    for (const item of itemDefs.values()) {
        await client.query(
            `insert into item_catalog (
                account_name, sku, upc, description, tracking_level, uom_label, unit_uom,
                units_per_case, lot_tracked, expiration_tracked, item_type, item_category, blocked
             ) values ($1,$2,'',$3,'UNIT',$4,$5,1,true,false,'INVENTORY','Pigment',false)
             on conflict (account_name,sku) do nothing`,
            [ACCOUNT, item.sku, item.description, item.uom === "BAG" ? "bags" : "boxes", item.uom]
        );
    }
}

function notesFor(inbound) {
    const lines = inbound.lines.map((line) =>
        `${line.sku}: ${line.quantity} ${line.uom.toLowerCase()} x ${line.kgPerUnit} kg; lot ${line.lot}.`
    );
    return [
        `Packing slip ${inbound.printedReference}; P.O. ${inbound.po}; slip dated 2026-10-01.`,
        `${inbound.skids} skid${inbound.skids === 1 ? "" : "s"} planned; not received.`,
        ...(inbound.reference !== inbound.printedReference
            ? [`Inbound uses P.O. reference because file ${inbound.file} prints conflicting slip number ${inbound.printedReference}.`]
            : []),
        ...lines
    ].join(" ");
}

async function verify(client, created, documents) {
    for (const [index, inbound] of created.entries()) {
        const source = documents[index];
        const head = await client.query(
            `select account_name,status,reference_number,expected_date,fulfillment_location_id,received_at
             from portal_inbounds where id=$1`, [inbound.id]
        );
        const lines = await client.query(
            `select sku,expected_quantity from portal_inbound_lines where inbound_id=$1 order by line_number`,
            [inbound.id]
        );
        const docs = await client.query(
            `select file_name,file_size,document_category from portal_inbound_documents where inbound_id=$1`,
            [inbound.id]
        );
        const stock = await client.query(
            `select count(*)::int count from inventory_transactions
             where source_type='PORTAL_INBOUND' and source_id=$1::text`, [String(inbound.id)]
        );
        const row = head.rows[0];
        if (!row || row.account_name !== ACCOUNT || row.status !== "SUBMITTED"
            || row.reference_number !== source.reference
            || String(row.fulfillment_location_id) !== String(WAREHOUSE_ID)
            || new Date(row.expected_date).toISOString().slice(0, 10) !== EXPECTED_DATE
            || row.received_at || lines.rowCount !== source.lines.length
            || lines.rows.some((line, i) => line.sku !== source.lines[i].sku
                || Number(line.expected_quantity) !== source.lines[i].quantity)
            || docs.rowCount !== 1 || docs.rows[0].file_name !== source.file
            || Number(docs.rows[0].file_size) !== source.fileBuffer.length
            || docs.rows[0].document_category !== "SHIPMENT_PACKING_SLIP"
            || Number(stock.rows[0].count) !== 0) {
            throw new Error(`Post-write verification failed for ${source.reference}.`);
        }
    }
}

async function main() {
    const apply = process.argv.includes("--apply");
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const documents = sourceDocuments();
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 10000 });
    await client.connect();
    try {
        await client.query(apply ? "begin" : "begin read only");
        if (apply) {
            const lock = await client.query(
                "select pg_try_advisory_xact_lock(hashtext('spectrum-october-2026-inbounds'),3918) locked"
            );
            if (!lock.rows[0].locked) throw new Error("Another Spectrum inbound run is active.");
        }
        const scope = await preflight(client, documents);
        if (String(scope.accountId) !== "3918") throw new Error("Spectrum account ID changed.");
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify({ mode: "READ_ONLY", account: ACCOUNT, warehouse: WAREHOUSE_CODE,
                expectedDate: EXPECTED_DATE, references: documents.map((inbound) => inbound.reference),
                newItems: scope.itemDefs.size - scope.existingItems }));
            return;
        }
        const { savePortalInboundForAccount, PORTAL_ORDER_DOCUMENT_CATEGORIES } = loadInboundWorkflow();
        await addItems(client, scope.itemDefs);
        const created = [];
        for (const inbound of documents) {
            created.push(await savePortalInboundForAccount(client, ACCOUNT, {
                fulfillmentLocationId: WAREHOUSE_ID,
                referenceNumber: inbound.reference,
                carrierName: "",
                expectedDate: EXPECTED_DATE,
                contactName: "Spectrum Dyes & Pigments Inc.",
                contactPhone: "905-238-5954",
                notes: notesFor(inbound),
                lines: inbound.lines.map((line) => ({ sku: line.sku, quantity: line.quantity }))
            }, {
                activityTitlePrefix: "warehouse",
                activityActor: ACTOR.full_name,
                creatorEmail: ACTOR.email,
                taskAppUser: ACTOR,
                requiredDocuments: [{
                    fileName: inbound.file, fileType: "application/pdf",
                    fileSize: inbound.fileBuffer.length, fileBuffer: inbound.fileBuffer,
                    documentCategory: PORTAL_ORDER_DOCUMENT_CATEGORIES.SHIPMENT_PACKING_SLIP
                }]
            }));
        }
        await verify(client, created, documents);
        await client.query("commit");
        console.log(JSON.stringify({ mode: "APPLIED", newItems: scope.itemDefs.size - scope.existingItems,
            inbounds: created.map((inbound, i) => ({ code: inbound.inboundCode, reference: documents[i].reference })) }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.code || error.message || error);
    process.exitCode = 1;
});
