const { Client } = require("pg");
const {
    APP_USER_ROLES,
    savePortalInboundForAccount,
    updateAdminPortalInboundStatus
} = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const OWNER_ID = 5062;
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const SKU = "RTC-4OZ-EA";
const RECEIPT_DATE = "2026-10-19";
const REFERENCE = "RANCHERS-20261019-9PAL-LOT061026";
const LOT = "061026";
const EXPIRY = "2027-03-02";
const PALLETS = 9;
const CASES_PER_PALLET = 64;
const UNITS_PER_CASE = 12;
const UNITS_PER_PALLET = CASES_PER_PALLET * UNITS_PER_CASE;
const TOTAL_CASES = PALLETS * CASES_PER_PALLET;
const TOTAL_UNITS = PALLETS * UNITS_PER_PALLET;
const DESTINATION = "GW3PL-MISS-RANCH-BULK";
const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    full_name: "WMS365 Operations",
    email: "k.prathab@gmail.com"
};

async function verify(db, inboundId) {
    const inbound = (await db.query(
        `select i.id,i.inbound_code,i.status,i.account_name,i.reference_number,
                i.fulfillment_location_id,
                to_char(i.received_at at time zone 'America/New_York','YYYY-MM-DD') as receipt_date
         from portal_inbounds i where i.id=$1`,
        [inboundId]
    )).rows[0];
    const line = (await db.query(
        `select sku,expected_quantity,received_quantity,received_location,lot_number,
                expiration_date::text as expiration_date
         from portal_inbound_lines where inbound_id=$1`,
        [inboundId]
    )).rows[0];
    const allocations = (await db.query(
        `select count(*)::integer as pallets,coalesce(sum(quantity),0)::integer as quantity,
                count(distinct pallet_reference)::integer as pallet_references
         from portal_inbound_receipt_allocations where inbound_id=$1`,
        [inboundId]
    )).rows[0];
    const ledger = (await db.query(
        `select count(*)::integer as entries,coalesce(sum(quantity_delta),0)::integer as quantity
         from inventory_transactions
         where source_type='PORTAL_INBOUND' and source_id=$1 and transaction_type='RECEIVING'`,
        [String(inboundId)]
    )).rows[0];
    const stock = (await db.query(
        `select coalesce(sum(i.quantity),0)::integer as quantity
         from inventory_lines i join bin_locations b on b.code=i.location
         where i.account_name=$1 and i.sku=$2 and i.location=$3 and i.lot_number=$4
           and i.expiration_date=$5 and b.fulfillment_location_id=$6
           and b.account_name=$1 and b.location_type='STORAGE' and b.is_pickable=true`,
        [ACCOUNT, SKU, DESTINATION, LOT, EXPIRY, WAREHOUSE_ID]
    )).rows[0];

    const valid = inbound
        && inbound.account_name === ACCOUNT
        && inbound.reference_number === REFERENCE
        && Number(inbound.fulfillment_location_id) === WAREHOUSE_ID
        && inbound.status === "PUTAWAY_COMPLETE"
        && inbound.receipt_date === RECEIPT_DATE
        && line?.sku === SKU
        && Number(line.expected_quantity) === TOTAL_UNITS
        && Number(line.received_quantity) === TOTAL_UNITS
        && line.received_location === DESTINATION
        && line.lot_number === LOT
        && line.expiration_date === EXPIRY
        && Number(allocations.pallets) === PALLETS
        && Number(allocations.pallet_references) === PALLETS
        && Number(allocations.quantity) === TOTAL_UNITS
        && Number(ledger.entries) === PALLETS
        && Number(ledger.quantity) === TOTAL_UNITS
        && Number(stock.quantity) >= TOTAL_UNITS;
    if (!valid) throw new Error(`Receipt verification failed: ${JSON.stringify({ inbound, line, allocations, ledger, stock })}`);

    return {
        inboundCode: inbound.inbound_code,
        status: inbound.status,
        receiptDate: inbound.receipt_date,
        sku: SKU,
        lot: LOT,
        expirationDate: EXPIRY,
        pallets: PALLETS,
        casesPerPallet: CASES_PER_PALLET,
        totalCases: TOTAL_CASES,
        unitsPerCase: UNITS_PER_CASE,
        receivedUnits: TOTAL_UNITS,
        location: DESTINATION,
        pickableLotUnits: Number(stock.quantity)
    };
}

async function main() {
    const mode = process.env.CONFIRM_RANCHERS_RECEIPT || "PREFLIGHT";
    if (!['PREFLIGHT', 'APPLY'].includes(mode)) throw new Error("Invalid receipt mode.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");

    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        await db.query("begin isolation level serializable");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${ACCOUNT}:inbound:${REFERENCE}`]);

        const today = (await db.query("select to_char(now() at time zone 'America/New_York','YYYY-MM-DD') as value")).rows[0].value;
        if (today !== RECEIPT_DATE) throw new Error(`Receipt date guard failed: production date is ${today}.`);

        const scope = await db.query(
            `select 1 from owner_accounts oa
             join company_fulfillment_locations cfl on cfl.account_name=oa.name
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where oa.id=$1 and oa.name=$2 and fl.id=$3 and fl.code=$4
               and fl.is_active=true and cfl.allow_inbound=true and cfl.allow_storage=true`,
            [OWNER_ID, ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
        );
        if (scope.rowCount !== 1) throw new Error("Rancher's company or warehouse identity mismatch.");

        const item = (await db.query(
            `select sku,upc,tracking_level,units_per_case,lot_tracked,expiration_tracked,blocked
             from item_catalog where account_name=$1 and sku=$2`,
            [ACCOUNT, SKU]
        )).rows[0];
        if (!item || item.blocked || item.upc !== "199284767607" || item.tracking_level !== "UNIT"
            || Number(item.units_per_case) !== UNITS_PER_CASE || !item.lot_tracked || !item.expiration_tracked) {
            throw new Error("Rancher's regular-chip item setup mismatch.");
        }

        const saltVinegar = await db.query(
            `select 1 from item_catalog where account_name=$1 and sku=$2
             and (upper(sku) like '%SV%' or upper(description) like '%SALT%VINEGAR%')`,
            [ACCOUNT, SKU]
        );
        if (saltVinegar.rowCount) throw new Error("Salt & Vinegar SKU exclusion failed.");

        const bin = (await db.query(
            `select account_name,fulfillment_location_id,location_type,is_pickable
             from bin_locations where code=$1 for update`,
            [DESTINATION]
        )).rows[0];
        if (!bin || bin.account_name !== ACCOUNT || Number(bin.fulfillment_location_id) !== WAREHOUSE_ID
            || bin.location_type !== "STORAGE" || !bin.is_pickable) throw new Error("Rancher's pickable destination mismatch.");

        const existing = await db.query(
            `select id,status from portal_inbounds
             where account_name=$1 and reference_number=$2 for update`,
            [ACCOUNT, REFERENCE]
        );
        if (existing.rowCount > 1) throw new Error("Duplicate inbound references found.");
        if (existing.rowCount === 1) {
            const result = await verify(db, existing.rows[0].id);
            await db.query("rollback");
            console.log(JSON.stringify({ outcome: "verified-existing", inventoryAdded: 0, ...result }, null, 2));
            return;
        }

        const sameReceipt = await db.query(
            `select i.id,i.inbound_code from portal_inbounds i
             join portal_inbound_lines l on l.inbound_id=i.id
             where i.account_name=$1 and i.fulfillment_location_id=$2 and l.sku=$3
               and l.lot_number=$4 and l.expiration_date=$5 and l.received_quantity=$6
               and (i.received_at at time zone 'America/New_York')::date=$7::date`,
            [ACCOUNT, WAREHOUSE_ID, SKU, LOT, EXPIRY, TOTAL_UNITS, RECEIPT_DATE]
        );
        if (sameReceipt.rowCount) throw new Error(`Possible duplicate receipt already exists: ${sameReceipt.rows.map((row) => row.inbound_code).join(", ")}.`);

        const preflight = {
            account: ACCOUNT,
            warehouse: WAREHOUSE_CODE,
            sku: SKU,
            excludedSku: "RTC-SV-EA",
            pallets: PALLETS,
            casesPerPallet: CASES_PER_PALLET,
            totalCases: TOTAL_CASES,
            unitsPerCase: UNITS_PER_CASE,
            totalUnits: TOTAL_UNITS,
            lot: LOT,
            expirationDate: EXPIRY,
            location: DESTINATION
        };
        if (mode === "PREFLIGHT") {
            await db.query("rollback");
            console.log(JSON.stringify({ outcome: "preflight-ok", ...preflight }, null, 2));
            return;
        }

        const before = Number((await db.query(
            "select coalesce(sum(quantity),0) as quantity from inventory_lines where account_name=$1 and sku=$2",
            [ACCOUNT, SKU]
        )).rows[0].quantity);

        let inbound = await savePortalInboundForAccount(db, ACCOUNT, {
            fulfillmentLocationId: WAREHOUSE_ID,
            referenceNumber: REFERENCE,
            carrierName: "",
            expectedDate: RECEIPT_DATE,
            contactName: "Rancher's Chips",
            notes: `User-authorized receipt ${RECEIPT_DATE}. 9 pallets x 64 cases = 576 cases. 12 bags per case = 6912 eaches. Regular Rancher's Tallow Chips only; Salt & Vinegar excluded. Lot ${LOT}; expiry ${EXPIRY}. Pallet weights and carrier were not provided and were not inferred.`,
            lines: [{ sku: SKU, quantity: TOTAL_UNITS }]
        }, {
            activityTitlePrefix: "warehouse",
            activityActor: ACTOR.full_name,
            creatorEmail: ACTOR.email,
            taskAppUser: ACTOR
        });
        inbound = await updateAdminPortalInboundStatus(db, inbound.id, "ARRIVED", ACTOR, {
            note: "9 pallets / 576 cases arrived October 19, 2026."
        });
        const lineId = inbound.lines.find((line) => line.sku === SKU)?.id;
        if (!lineId) throw new Error("Created inbound line could not be resolved.");
        inbound = await updateAdminPortalInboundStatus(db, inbound.id, "RECEIVED", ACTOR, {
            lines: Array.from({ length: PALLETS }, (_, index) => ({
                id: lineId,
                sku: SKU,
                receivedQuantity: UNITS_PER_PALLET,
                receivedLocation: DESTINATION,
                lotNumber: LOT,
                expirationDate: EXPIRY,
                palletReference: `RCH-20261019-${String(index + 1).padStart(2, "0")}`
            }))
        });
        await db.query(
            `update bin_locations set location_type='STORAGE',is_pickable=true,updated_at=now()
             where code=$1 and account_name=$2 and fulfillment_location_id=$3`,
            [DESTINATION, ACCOUNT, WAREHOUSE_ID]
        );
        inbound = await updateAdminPortalInboundStatus(db, inbound.id, "PUTAWAY_COMPLETE", ACTOR, {
            note: "All 9 pallets / 576 cases / 6912 bags put away to Rancher's pickable bulk storage."
        });
        await db.query(
            `update portal_inbounds
             set arrived_at=$2::date + time '12:00',received_at=$2::date + time '12:00',updated_at=now()
             where id=$1`,
            [inbound.id, RECEIPT_DATE]
        );

        const result = await verify(db, inbound.id);
        const after = Number((await db.query(
            "select coalesce(sum(quantity),0) as quantity from inventory_lines where account_name=$1 and sku=$2",
            [ACCOUNT, SKU]
        )).rows[0].quantity);
        if (after - before !== TOTAL_UNITS) throw new Error(`Inventory delta mismatch: expected ${TOTAL_UNITS}, found ${after - before}.`);

        await db.query("commit");
        console.log(JSON.stringify({ outcome: "received", inventoryAdded: TOTAL_UNITS, totalOnHandUnits: after, ...result }, null, 2));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
