const { Client } = require("pg");

const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const ACCOUNT_ID = 3918;
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";

const ITEMS = [
    {
        sku: "SPECTRUM BLUE 15:4 CCS",
        description: "Pigment Blue 15:4",
        unitUom: "BAG",
        sourceReference: "GW/1312/26"
    },
    {
        sku: "SPECTRUM BLUE SP 1020",
        description: "Pigment Blue 15:3",
        unitUom: "BAG",
        sourceReference: "GW/1313/26"
    },
    {
        sku: "SPECTRUM VIOLET 23 SI 3618",
        description: "Pigment Violet 23",
        unitUom: "BOX",
        sourceReference: "GW-1315/26"
    }
];

function compatible(row, expected) {
    return row.description === expected.description
        && row.tracking_level === "UNIT"
        && row.unit_uom === expected.unitUom
        && Number(row.units_per_case) === 1
        && row.lot_tracked === true
        && row.expiration_tracked === false
        && row.item_type === "INVENTORY"
        && row.item_category === "Pigment"
        && row.blocked === false;
}

async function verifyScope(client) {
    const result = await client.query(
        `select oa.id, oa.name, oa.is_active,
                fl.id as warehouse_id, fl.code as warehouse_code, fl.is_active as warehouse_active,
                cfl.allow_inbound, cfl.allow_outbound
         from owner_accounts oa
         join company_fulfillment_locations cfl on cfl.account_name=oa.name
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where oa.id=$1 and oa.name=$2 and fl.id=$3 and fl.code=$4`,
        [ACCOUNT_ID, ACCOUNT, WAREHOUSE_ID, WAREHOUSE_CODE]
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row.is_active || !row.warehouse_active
        || !row.allow_inbound || !row.allow_outbound) {
        throw new Error("Spectrum account or warehouse scope changed.");
    }
}

async function readItems(client) {
    return (await client.query(
        `select account_name, sku, upc, description, tracking_level, uom_label, unit_uom,
                units_per_case, lot_tracked, expiration_tracked, item_type, item_category,
                blocked, costing_method, replenishment_system
         from item_catalog
         where account_name=$1 and sku=any($2::text[])
         order by sku`,
        [ACCOUNT, ITEMS.map((item) => item.sku)]
    )).rows;
}

async function main() {
    const apply = process.argv.includes("--apply");
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");

    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 10000 });
    await client.connect();
    try {
        await client.query(apply ? "begin" : "begin read only");
        if (apply) {
            const lock = await client.query(
                "select pg_try_advisory_xact_lock(hashtext('spectrum-gw1312-gw1313-gw1315-items'),3918) as locked"
            );
            if (!lock.rows[0].locked) throw new Error("Another Spectrum item setup is active.");
        }
        await verifyScope(client);
        const before = await readItems(client);
        for (const row of before) {
            const expected = ITEMS.find((item) => item.sku === row.sku);
            if (!expected || !compatible(row, expected)) {
                throw new Error(`Existing item conflicts with reviewed source: ${row.sku}`);
            }
        }

        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify({
                mode: "READ_ONLY",
                account: ACCOUNT,
                accountId: ACCOUNT_ID,
                warehouse: WAREHOUSE_CODE,
                existing: before.map((row) => row.sku),
                toCreate: ITEMS.filter((item) => !before.some((row) => row.sku === item.sku))
                    .map((item) => item.sku)
            }));
            return;
        }

        for (const item of ITEMS) {
            await client.query(
                `insert into item_catalog (
                    account_name, sku, upc, description, tracking_level, uom_label, unit_uom,
                    units_per_case, lot_tracked, expiration_tracked, item_type, item_category,
                    blocked, costing_method, replenishment_system
                 ) values ($1,$2,'',$3,'UNIT',$4,$5,1,true,false,'INVENTORY','Pigment',false,'FIFO','PURCHASE')
                 on conflict (account_name,sku) do nothing`,
                [ACCOUNT, item.sku, item.description, item.unitUom === "BAG" ? "bags" : "boxes", item.unitUom]
            );
        }

        const after = await readItems(client);
        if (after.length !== ITEMS.length) throw new Error("Not every reviewed item is present after setup.");
        for (const row of after) {
            const expected = ITEMS.find((item) => item.sku === row.sku);
            if (!compatible(row, expected)) throw new Error(`Post-write verification failed: ${row.sku}`);
        }
        await client.query("commit");
        console.log(JSON.stringify({
            mode: "APPLIED",
            account: ACCOUNT,
            warehouse: WAREHOUSE_CODE,
            created: ITEMS.filter((item) => !before.some((row) => row.sku === item.sku)).map((item) => item.sku),
            preserved: ITEMS.filter((item) => before.some((row) => row.sku === item.sku)).map((item) => item.sku),
            verified: after.map((row) => ({ sku: row.sku, uom: row.unit_uom, lotTracked: row.lot_tracked, blocked: row.blocked }))
        }));
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
