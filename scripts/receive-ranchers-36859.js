const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const {
    APP_USER_ROLES, savePortalInboundForAccount, updateAdminPortalInboundStatus,
    PORTAL_ORDER_DOCUMENT_CATEGORIES: CATEGORIES
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const SKU = "RTC-4OZ-EA";
const REFERENCE = "36859";
const DATE = "2026-09-18";
const LOT = "100926";
const EXPIRY = "2027-02-06";
const QUANTITY = 4608;
const BIN = "GW3PL-MISS-RANCH-BULK";
const ACTOR = { role: APP_USER_ROLES.SUPER_ADMIN, full_name: "WMS365 Operations", email: "k.prathab@gmail.com" };
const ALBUM = "https://photos.app.goo.gl/nA3MiVPWRkbXD8T78";
const ASSET_DIRECTORY = "C:/Users/T470/AppData/Local/Temp/browser-use/assets/9d5ea3b2-94f7-420d-a203-a7fff959b6bd";
const PHOTOS = [
    ["9bdbf7c2d93c32d2", "Ranchers-36859-BOL-1.jpg", CATEGORIES.SHIPMENT_BOL],
    ["a9c9d41987cf93fb", "Ranchers-36859-Case-Label.jpg", CATEGORIES.SHIPMENT_PACKING_SLIP],
    ["24c77d284b44a54e", "Ranchers-36859-Freight-Label.jpg", CATEGORIES.SHIPMENT_PACKING_SLIP],
    ["0f604bf91aad55bf", "Ranchers-36859-BOL-2.jpg", CATEGORIES.SHIPMENT_BOL]
];

async function verify(client, id) {
    const receipt = (await client.query(`select inbound_code,status,account_name,reference_number,
        fulfillment_location_id,to_char(received_at at time zone 'America/New_York','YYYY-MM-DD') receipt_date
        from portal_inbounds where id=$1`, [id])).rows[0];
    const lines = (await client.query("select sku,expected_quantity,received_quantity,lot_number,expiration_date::text expiry from portal_inbound_lines where inbound_id=$1", [id])).rows;
    const ledger = (await client.query("select count(*) count,sum(quantity_delta) quantity from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1 and transaction_type='RECEIVING'", [String(id)])).rows[0];
    const stock = (await client.query(`select coalesce(sum(i.quantity),0) quantity from inventory_lines i
        join bin_locations b on b.code=i.location where i.account_name=$1 and i.sku=$2 and i.location=$3
        and i.lot_number=$4 and i.expiration_date=$5 and b.account_name=$1 and b.fulfillment_location_id=1
        and b.location_type='STORAGE' and b.is_pickable=true`, [ACCOUNT, SKU, BIN, LOT, EXPIRY])).rows[0];
    const documents = (await client.query("select count(*) count from portal_inbound_documents where inbound_id=$1", [id])).rows[0];
    if (!receipt || receipt.account_name !== ACCOUNT || receipt.reference_number !== REFERENCE
        || String(receipt.fulfillment_location_id) !== "1" || receipt.status !== "PUTAWAY_COMPLETE"
        || receipt.receipt_date !== DATE || lines.length !== 1 || lines[0].sku !== SKU
        || Number(lines[0].expected_quantity) !== QUANTITY || Number(lines[0].received_quantity) !== QUANTITY
        || lines[0].lot_number !== LOT || lines[0].expiry !== EXPIRY
        || Number(ledger.count) !== 1 || Number(ledger.quantity) !== QUANTITY
        || Number(documents.count) !== PHOTOS.length) throw new Error("Receipt verification failed.");
    return { ...receipt, sku: SKU, pallets: 6, cartons: 384, unitsPerCarton: 12,
        receivedEaches: QUANTITY, lot: LOT, bestBefore: EXPIRY, location: BIN,
        currentPickableLotEaches: Number(stock.quantity), backupPhotos: Number(documents.count) };
}

async function main() {
    if (!["RECEIVE_384_CARTONS", "VERIFY_ONLY"].includes(process.env.CONFIRM_RANCHERS_36859)) {
        throw new Error("Explicit receipt authorization is required.");
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    await client.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${ACCOUNT}:inbound:${REFERENCE}`]);
        const scope = await client.query(`select oa.id from owner_accounts oa
            join company_fulfillment_locations cfl on cfl.account_name=oa.name
            join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
            where oa.id=5062 and oa.name=$1 and fl.id=1 and fl.code='GW3PL-MISS'
            and fl.is_active=true and cfl.allow_inbound=true and cfl.allow_storage=true`, [ACCOUNT]);
        if (scope.rowCount !== 1) throw new Error("Customer or warehouse scope mismatch.");
        const matches = await client.query("select id,status from portal_inbounds where account_name=$1 and (reference_number=$2 or notes like '%BOL 36859%') for update", [ACCOUNT, REFERENCE]);
        if (matches.rowCount) {
            if (matches.rowCount !== 1) throw new Error("Multiple matching inbounds; duplicate blocked.");
            const verified = await verify(client, matches.rows[0].id);
            await client.query("rollback");
            console.log(JSON.stringify({ outcome: "verified-existing", inventoryAdded: 0, ...verified }));
            return;
        }
        if (process.env.CONFIRM_RANCHERS_36859 === "VERIFY_ONLY") throw new Error("Receipt not found.");
        const today = (await client.query("select to_char(now() at time zone 'America/New_York','YYYY-MM-DD') today")).rows[0].today;
        if (today !== DATE) throw new Error("Receipt date changed; stop for review.");
        const item = (await client.query("select tracking_level,units_per_case,upc,blocked,lot_tracked,expiration_tracked from item_catalog where account_name=$1 and sku=$2", [ACCOUNT, SKU])).rows[0];
        if (!item || item.blocked || item.tracking_level !== "UNIT" || Number(item.units_per_case) !== 12
            || item.upc !== "199284767607" || !item.lot_tracked || !item.expiration_tracked) throw new Error("Item setup mismatch.");
        const bin = (await client.query("select * from bin_locations where code=$1 for update", [BIN])).rows[0];
        if (!bin || bin.account_name !== ACCOUNT || String(bin.fulfillment_location_id) !== "1"
            || !bin.is_pickable || bin.location_type !== "STORAGE") throw new Error("Pickable bin scope mismatch.");
        const foreign = await client.query("select id from inventory_lines where location=$1 and account_name<>$2 and quantity<>0 for update", [BIN, ACCOUNT]);
        if (foreign.rowCount) throw new Error("Destination contains foreign inventory.");
        const before = Number((await client.query("select coalesce(sum(quantity),0) quantity from inventory_lines where account_name=$1 and sku=$2", [ACCOUNT, SKU])).rows[0].quantity);
        const documents = PHOTOS.map(([asset, fileName, documentCategory]) => {
            const fileBuffer = fs.readFileSync(path.join(ASSET_DIRECTORY, asset));
            return { fileName, documentCategory, fileType: "image/jpeg", fileSize: fileBuffer.length, fileBuffer };
        });
        const inbound = await savePortalInboundForAccount(client, ACCOUNT, {
            fulfillmentLocationId: 1, referenceNumber: REFERENCE, carrierName: "MJW Transport Inc",
            expectedDate: DATE, contactName: "Rancher's Chips", contactPhone: "6477748030",
            notes: `User-authorized receipt ${DATE}. BOL 36859; LTL van; Do Not Stack. 6 pallets; 384 cartons x 12 bags = 4608 eaches. Rancher's Tallow Chips 4 oz. UPC 199284767607; lot ${LOT}; best before ${EXPIRY}. Shipment weight 3000 lb (1361 kg as printed on BOL). Shipped September 17 from Ranchers Chips (NY), c/o Remix Logistics / ARCA, 1130 Military Rd, Tonawanda NY 14217. Delivered to 1330 Courtney Park Drive East, Dock 17, Mississauga. Individual pallet carton distribution and weights not provided and not inferred. Putaway ${BIN}. Backup album: ${ALBUM}`,
            lines: [{ sku: SKU, quantity: QUANTITY }]
        }, { activityTitlePrefix: "warehouse", activityActor: ACTOR.full_name,
            creatorEmail: ACTOR.email, taskAppUser: ACTOR, requiredDocuments: documents });
        await updateAdminPortalInboundStatus(client, inbound.id, "ARRIVED", ACTOR, { note: "6 pallets / 384 cartons arrived September 18, 2026; BOL 36859." });
        await updateAdminPortalInboundStatus(client, inbound.id, "RECEIVED", ACTOR, { receivingLocation: BIN,
            lines: [{ id: inbound.lines[0].id, sku: SKU, receivedQuantity: QUANTITY,
                receivedLocation: BIN, lotNumber: LOT, expirationDate: EXPIRY }] });
        // Native receiving temporarily marks its destination as a receiving stage.
        await client.query("update bin_locations set location_type='STORAGE',is_pickable=true,updated_at=now() where code=$1 and account_name=$2 and fulfillment_location_id=1", [BIN, ACCOUNT]);
        await updateAdminPortalInboundStatus(client, inbound.id, "PUTAWAY_COMPLETE", ACTOR, { note: "6 pallets / 384 cartons / 4608 eaches put away to Ranchers pickable bulk storage." });
        const result = await verify(client, inbound.id);
        const after = Number((await client.query("select coalesce(sum(quantity),0) quantity from inventory_lines where account_name=$1 and sku=$2", [ACCOUNT, SKU])).rows[0].quantity);
        if (after - before !== QUANTITY || result.currentPickableLotEaches < QUANTITY) throw new Error("Inventory delta or pickability verification failed.");
        await client.query("commit");
        console.log(JSON.stringify({ outcome: "received", inventoryAdded: QUANTITY, onHandEaches: after, ...result }));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally { await client.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
