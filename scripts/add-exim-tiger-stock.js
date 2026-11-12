const { Pool } = require("pg");
const { APP_USER_ROLES, upsertInventoryLine } = require("../server");

const ACCOUNT = "EXIM WORLD CONNECT INC.";
const SKU = "TIGER";
const DESCRIPTION = "Royal Tiger 250 ml";
const RECEIPT_DATE = "2026-09-02";
const OPERATION_KEY = "EXIM-TIGER-13-PALLETS-1220-CASES-20260902";
const PALLET_CASES = [100, 100, 100, 100, 100, 100, 60, 100, 100, 100, 100, 60, 100];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        await client.query("begin");
        const warehouseResult = await client.query(
            `select fl.id, fl.code, fl.name
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and fl.is_active=true and cfl.allow_storage=true
             order by cfl.is_primary desc, fl.id`,
            [ACCOUNT]
        );
        if (warehouseResult.rowCount !== 1) {
            throw new Error(`Expected one active EXIM storage warehouse; found ${warehouseResult.rowCount}.`);
        }
        const warehouse = warehouseResult.rows[0];
        const itemResult = await client.query(
            "select * from item_catalog where account_name=$1 and sku=$2 for update",
            [ACCOUNT, SKU]
        );
        if (itemResult.rowCount !== 1) throw new Error("EXIM item TIGER is not set up.");
        if (String(itemResult.rows[0].tracking_level || "").toUpperCase() !== "CASE") {
            throw new Error("EXIM item TIGER is not tracked in cases.");
        }

        const priorOperation = await client.query(
            "select count(*)::integer count from inventory_transactions where source_type='EXIM_INITIAL_STOCK' and source_id=$1",
            [OPERATION_KEY]
        );
        if (Number(priorOperation.rows[0]?.count) > 0) {
            throw new Error("This EXIM TIGER stock load was already posted; no duplicate quantity was added.");
        }
        const beforeResult = await client.query(
            "select coalesce(sum(quantity),0)::integer quantity from inventory_lines where account_name=$1 and sku=$2",
            [ACCOUNT, SKU]
        );
        const quantityBefore = Number(beforeResult.rows[0]?.quantity || 0);
        if (quantityBefore !== 0) {
            throw new Error(`EXIM TIGER already has ${quantityBefore} cases on hand. Stock was not changed.`);
        }

        const actor = { role: APP_USER_ROLES.SUPER_ADMIN, email: "k.prathab@gmail.com", full_name: "WMS365 Administration" };
        for (const [index, quantity] of PALLET_CASES.entries()) {
            const palletNumber = index + 1;
            const numberText = String(palletNumber).padStart(2, "0");
            const location = `${warehouse.code}-EXIM-P${numberText}`;
            const palletCode = `EXIM-TIGER-P${numberText}`;
            await client.query(
                `insert into bin_locations (code, note, location_type, is_pickable)
                 values ($1,$2,'STORAGE',true)
                 on conflict (code) do update set note=excluded.note, location_type='STORAGE', is_pickable=true, updated_at=now()`,
                [location, `EXIM dedicated pickable pallet location ${numberText}`]
            );
            await upsertInventoryLine(client, {
                accountName: ACCOUNT,
                location,
                sku: SKU,
                upc: itemResult.rows[0].upc || "",
                quantity,
                trackingLevel: "CASE"
            }, {
                transactionType: "RECEIVING",
                sourceType: "EXIM_INITIAL_STOCK",
                sourceId: OPERATION_KEY,
                fulfillmentLocationId: warehouse.id,
                appUser: actor,
                idempotencyKey: `${OPERATION_KEY}-P${numberText}`,
                source: "admin_confirmed_stock_load"
            });
            await client.query(
                `insert into pallet_records (
                    pallet_code, account_name, sku, upc, description, cases_on_pallet,
                    label_date, location, inventory_tracking_level, inventory_quantity
                 ) values ($1,$2,$3,$4,$5,$6,$7,$8,'CASE',$6)
                 on conflict (pallet_code) do update set
                    account_name=excluded.account_name, sku=excluded.sku, upc=excluded.upc,
                    description=excluded.description, cases_on_pallet=excluded.cases_on_pallet,
                    label_date=excluded.label_date, location=excluded.location,
                    inventory_tracking_level='CASE', inventory_quantity=excluded.inventory_quantity,
                    updated_at=now()`,
                [palletCode, ACCOUNT, SKU, itemResult.rows[0].upc || "", DESCRIPTION, quantity, RECEIPT_DATE, location]
            );
        }
        await client.query(
            `insert into activity_log (type,title,details)
             values ('receive',$1,$2)`,
            [
                `Added 1,220 cases of ${ACCOUNT} / ${SKU}`,
                `13 pallets | ${DESCRIPTION} | ${warehouse.name} | Pickable | ${OPERATION_KEY}`
            ]
        );
        await client.query("commit");

        const verification = await pool.query(
            `select coalesce(sum(i.quantity),0)::integer on_hand,
                    coalesce(sum(case when coalesce(bl.is_pickable,true)=true and coalesce(bl.location_type,'STORAGE') not in ('HOLD','INVESTIGATION','DAMAGED','QUARANTINE','QA_HOLD','RECEIVING_STAGE') then i.quantity else 0 end),0)::integer pickable,
                    count(*)::integer location_count
             from inventory_lines i left join bin_locations bl on bl.code=i.location
             where i.account_name=$1 and i.sku=$2`,
            [ACCOUNT, SKU]
        );
        const palletVerification = await pool.query(
            "select count(*)::integer pallet_count, coalesce(sum(inventory_quantity),0)::integer cases from pallet_records where account_name=$1 and sku=$2",
            [ACCOUNT, SKU]
        );
        const verified = verification.rows[0];
        const pallets = palletVerification.rows[0];
        if (Number(verified.on_hand) !== 1220 || Number(verified.pickable) !== 1220 || Number(pallets.pallet_count) !== 13 || Number(pallets.cases) !== 1220) {
            throw new Error(`Verification failed: ${JSON.stringify({ verified, pallets })}`);
        }
        console.log(JSON.stringify({
            accountName: ACCOUNT,
            sku: SKU,
            description: DESCRIPTION,
            warehouse: warehouse.name,
            warehouseCode: warehouse.code,
            quantityBefore,
            quantityAfter: Number(verified.on_hand),
            pickableQuantity: Number(verified.pickable),
            palletCount: Number(pallets.pallet_count),
            palletCases: PALLET_CASES,
            operationKey: OPERATION_KEY
        }, null, 2));
    } catch (error) {
        try { await client.query("rollback"); } catch (_rollbackError) {}
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
