const { Client } = require("pg");
const { APP_USER_ROLES, updateAdminPortalInboundStatus } = require("../server");

const ACCOUNT = "RANCHER'S CHIPS";
const CODE = "INB-000190";
const SKU = "RTC-4OZ-EA";
const DESTINATION = "GW3PL-MISS-RANCH-BULK";
const LOT = "070826";
const EXPIRY = "2026-12-05";
const QUANTITY = 2880;
const ACTOR = { role: APP_USER_ROLES.SUPER_ADMIN, full_name: "WMS365 Operations" };

async function main() {
    if (process.env.CONFIRM_RANCHERS_INB_000190 !== "APPROVED_SAME_LOT_EXPIRY") {
        throw new Error("Explicit receipt confirmation is required.");
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${ACCOUNT}:${CODE}:receipt`]);
        const result = await client.query(
            "select * from portal_inbounds where inbound_code=$1 and account_name=$2 for update", [CODE, ACCOUNT]
        );
        const row = result.rows[0];
        if (result.rowCount !== 1 || String(row.fulfillment_location_id) !== "1"
            || row.reference_number !== "RANCHERS-20260917-6PAL-240CASE") throw new Error("Inbound identity mismatch.");
        if (row.status === "PUTAWAY_COMPLETE") {
            await client.query("rollback");
            console.log(JSON.stringify({ inboundCode: CODE, outcome: "already-received", added: 0 }));
            return;
        }
        if (row.status !== "SUBMITTED" || row.received_at) throw new Error("Inbound has already advanced; duplicate receipt blocked.");
        const scope = await client.query(
            `select fl.id from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and fl.id=1 and fl.code='GW3PL-MISS'
               and fl.is_active=true and cfl.allow_inbound=true and cfl.allow_storage=true`, [ACCOUNT]
        );
        if (scope.rowCount !== 1) throw new Error("Warehouse scope mismatch.");
        const lots = await client.query(
            "select distinct lot_number,expiration_date::text expiry from inventory_lines where account_name=$1 and sku=$2 and quantity>0", [ACCOUNT, SKU]
        );
        if (lots.rowCount !== 1 || lots.rows[0].lot_number !== LOT || lots.rows[0].expiry !== EXPIRY) {
            throw new Error("Existing lot or expiry differs from the approved values.");
        }
        const item = await client.query(
            "select tracking_level,units_per_case,blocked from item_catalog where account_name=$1 and sku=$2", [ACCOUNT, SKU]
        );
        if (item.rowCount !== 1 || item.rows[0].tracking_level !== "UNIT"
            || Number(item.rows[0].units_per_case) !== 12 || item.rows[0].blocked) throw new Error("Item setup changed.");
        const lines = await client.query("select id,sku,expected_quantity as quantity from portal_inbound_lines where inbound_id=$1 order by line_number", [row.id]);
        const inbound = { lines: lines.rows };
        if (inbound.lines.length !== 1 || inbound.lines[0].sku !== SKU
            || Number(inbound.lines[0].quantity) !== QUANTITY) throw new Error("Inbound quantity mismatch.");
        const bin = await client.query("select * from bin_locations where code=$1 for update", [DESTINATION]);
        if (bin.rowCount && (bin.rows[0].account_name !== ACCOUNT || String(bin.rows[0].fulfillment_location_id) !== "1")) {
            throw new Error("Destination belongs to another customer or warehouse.");
        }
        const foreign = await client.query(
            "select id from inventory_lines where location=$1 and account_name<>$2 and quantity<>0 for update", [DESTINATION, ACCOUNT]
        );
        if (foreign.rowCount) throw new Error("Destination contains foreign inventory.");
        await client.query(
            `insert into bin_locations(code,note,location_type,is_pickable,account_name,fulfillment_location_id)
             values($1,'Ranchers pickable bulk storage.','STORAGE',true,$2,1) on conflict(code) do nothing`, [DESTINATION, ACCOUNT]
        );
        const before = await client.query("select coalesce(sum(quantity),0) quantity from inventory_lines where account_name=$1 and sku=$2", [ACCOUNT, SKU]);
        await client.query("update portal_inbounds set notes=$2,updated_at=now() where id=$1", [row.id,
            `User-authorized receipt September 17, 2026: 6 pallets, 240 cases x 12 bags = 2880 each of ${SKU}. Lot ${LOT}; best before ${EXPIRY}, same as existing stock per user approval. Putaway to ${DESTINATION}. Individual pallet case distribution not supplied and not inferred. Internal reference RANCHERS-20260917-6PAL-240CASE.`]);
        await updateAdminPortalInboundStatus(client, row.id, "ARRIVED", ACTOR, { note: "6 pallets, 240 cases arrived September 17, 2026." });
        await updateAdminPortalInboundStatus(client, row.id, "RECEIVED", ACTOR, {
            receivingLocation: DESTINATION,
            lines: [{ id: inbound.lines[0].id, sku: SKU, receivedQuantity: QUANTITY, receivedLocation: DESTINATION, lotNumber: LOT, expirationDate: EXPIRY }]
        });
        // Receiving marks its destination as a stage; completed putaway restores pickability.
        await client.query("update bin_locations set location_type='STORAGE',is_pickable=true,updated_at=now() where code=$1 and account_name=$2 and fulfillment_location_id=1", [DESTINATION, ACCOUNT]);
        await updateAdminPortalInboundStatus(client, row.id, "PUTAWAY_COMPLETE", ACTOR, { note: "6 pallets / 240 cases / 2880 bags put away to pickable Ranchers bulk storage." });
        const after = await client.query("select coalesce(sum(quantity),0) quantity from inventory_lines where account_name=$1 and sku=$2", [ACCOUNT, SKU]);
        const final = await client.query("select status,to_char(received_at at time zone 'America/New_York','YYYY-MM-DD') receipt_date from portal_inbounds where id=$1", [row.id]);
        const ledger = await client.query("select count(*) count,sum(quantity_delta) quantity from inventory_transactions where source_type='PORTAL_INBOUND' and source_id=$1 and transaction_type='RECEIVING'", [String(row.id)]);
        const stock = await client.query(
            `select sum(i.quantity) quantity from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and i.location=$3 and i.lot_number=$4 and i.expiration_date=$5
               and b.account_name=$1 and b.fulfillment_location_id=1 and b.is_pickable=true and b.location_type='STORAGE'`,
            [ACCOUNT, SKU, DESTINATION, LOT, EXPIRY]
        );
        if (final.rows[0].status !== "PUTAWAY_COMPLETE" || final.rows[0].receipt_date !== "2026-09-17"
            || Number(after.rows[0].quantity) - Number(before.rows[0].quantity) !== QUANTITY
            || Number(ledger.rows[0].quantity) !== QUANTITY || Number(ledger.rows[0].count) !== 1
            || Number(stock.rows[0].quantity) < QUANTITY) throw new Error("Receipt/inventory/ledger verification failed.");
        await client.query("commit");
        console.log(JSON.stringify({ inboundCode: CODE, status: final.rows[0].status, receiptDate: final.rows[0].receipt_date,
            pallets: 6, cases: 240, inventoryAddedEaches: QUANTITY, lot: LOT, bestBefore: EXPIRY,
            location: DESTINATION, pickable: true, newOnHandEaches: Number(after.rows[0].quantity) }));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
