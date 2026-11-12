const { Pool } = require("pg");
const { completePortalKittingInventory } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "PURE FOODS BY ESTEE";
const ACCOUNT_ID = "1";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const LOCATION = "GW3PL-MISS-PUREFOODS-BULK";
const TARGET_SKU = "174";
const TARGET_DESCRIPTION = "3 Case Pre-Filled Holiday Shipper";
const QUANTITY = 116;
const REFERENCE = "HOLIDAY-SHIPPER-174-116-20261026";
const COMPONENTS = [
    { sku: "141", description: "Holiday Candy Coated Mini Chocolate Chips - 12 Pack Case (12X5 OZ)", totalQuantity: QUANTITY, quantityPerUnit: 1 },
    { sku: "144", description: "Holiday Jimmies - 12 Pack Case (12X5 OZ)", totalQuantity: QUANTITY, quantityPerUnit: 1 },
    { sku: "149", description: "Chocolate Mint Jimmies - 12 Pack Case (12X5 OZ)", totalQuantity: QUANTITY, quantityPerUnit: 1 },
];
const ACTOR = "WMS365 Owner-Approved Kitting";

async function getCommitment(client, inventoryLineId) {
    const result = await client.query(
        `select
            coalesce((select sum(a.allocated_quantity) from portal_order_allocations a
                      join portal_orders o on o.id=a.order_id
                      where a.inventory_line_id=$1 and o.status in ('RELEASED','PICKING','PICKED','STAGED')),0)::int
          + coalesce((select sum(a.allocated_quantity) from portal_kitting_allocations a
                      join portal_kitting_requests k on k.id=a.kitting_request_id
                      where a.inventory_line_id=$1 and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as quantity`,
        [inventoryLineId]
    );
    return Number(result.rows[0].quantity);
}

async function inspect(pool) {
    const [account, items, warehouse, duplicate, target, lines] = await Promise.all([
        pool.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT]),
        pool.query(
            `select sku,description,tracking_level,units_per_case,item_type,blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [ACCOUNT, [...COMPONENTS.map((component) => component.sku), TARGET_SKU]]
        ),
        pool.query(
            `select fl.code,fl.is_active,cfl.allow_storage,b.account_name bin_account,b.fulfillment_location_id,
                    b.location_type,b.is_pickable
             from fulfillment_locations fl join company_fulfillment_locations cfl
               on cfl.fulfillment_location_id=fl.id and cfl.account_name=$1
             join bin_locations b on b.code=$2 where fl.id=$3`,
            [ACCOUNT, LOCATION, WAREHOUSE_ID]
        ),
        pool.query(
            `select * from portal_kitting_requests where account_name=$1 and purchase_order_reference=$2
             order by id desc limit 1`,
            [ACCOUNT, REFERENCE]
        ),
        pool.query(
            `select i.id,i.quantity,i.location,b.is_pickable,b.location_type,b.fulfillment_location_id
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 order by i.id`,
            [ACCOUNT, TARGET_SKU]
        ),
        pool.query(
            `select i.*,b.is_pickable,b.location_type,b.fulfillment_location_id
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=any($2::text[]) order by i.sku,i.id`,
            [ACCOUNT, COMPONENTS.map((component) => component.sku)]
        ),
    ]);
    const componentState = [];
    for (const component of COMPONENTS) {
        const matching = lines.rows.filter((line) => line.sku === component.sku);
        let available = 0;
        for (const line of matching) {
            line.committed = await getCommitment(pool, line.id);
            line.available = Math.max(Number(line.quantity) - line.committed, 0);
            if (line.is_pickable && line.location_type === "STORAGE" && Number(line.fulfillment_location_id) === WAREHOUSE_ID) available += line.available;
        }
        componentState.push({ ...component, available, lines: matching });
    }
    return { account: account.rows[0], items: items.rows, warehouse: warehouse.rows[0], duplicate: duplicate.rows[0] || null,
        target: target.rows, components: componentState };
}

function assertPreflight(state) {
    if (!state.account || String(state.account.id) !== ACCOUNT_ID || !state.account.is_active) throw new Error("Pure Foods identity mismatch.");
    if (state.items.length !== 4) throw new Error("The four required Pure Foods items were not found uniquely.");
    for (const item of state.items) {
        if (item.blocked || item.item_type !== "INVENTORY" || item.tracking_level !== "CASE") throw new Error(`Item ${item.sku} is not active case inventory.`);
    }
    for (const component of COMPONENTS) {
        const item = state.items.find((row) => row.sku === component.sku);
        if (!item || item.description !== component.description || Number(item.units_per_case) !== 12) throw new Error(`Item master mismatch for ${component.sku}.`);
        const stock = state.components.find((row) => row.sku === component.sku);
        if (!stock || stock.available < QUANTITY) throw new Error(`SKU ${component.sku} has only ${stock?.available || 0} available cases.`);
    }
    const target = state.items.find((row) => row.sku === TARGET_SKU);
    if (!target || target.description !== TARGET_DESCRIPTION || Number(target.units_per_case) !== 3) throw new Error("Target item 174 setup mismatch.");
    const wh = state.warehouse;
    if (!wh || wh.code !== WAREHOUSE_CODE || !wh.is_active || !wh.allow_storage || wh.bin_account !== ACCOUNT
        || Number(wh.fulfillment_location_id) !== WAREHOUSE_ID || wh.location_type !== "STORAGE" || !wh.is_pickable) {
        throw new Error("Pure Foods pickable destination mismatch.");
    }
    if (state.target.reduce((sum, row) => sum + Number(row.quantity), 0) !== 0) {
        throw new Error("SKU 174 already has inventory; completing 116 would not leave exactly 116 available.");
    }
    if (state.duplicate && state.duplicate.status !== "COMPLETED") throw new Error(`Existing request ${state.duplicate.request_code} is ${state.duplicate.status}.`);
}

async function transact(pool, preview) {
    if (preview.duplicate?.status === "COMPLETED") return { requestCode: preview.duplicate.request_code, alreadyCompleted: true };
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [REFERENCE]);
        const duplicate = await client.query(
            `select * from portal_kitting_requests where account_name=$1 and purchase_order_reference=$2 limit 1 for update`,
            [ACCOUNT, REFERENCE]
        );
        if (duplicate.rowCount) {
            await client.query("rollback");
            if (duplicate.rows[0].status === "COMPLETED") return { requestCode: duplicate.rows[0].request_code, alreadyCompleted: true };
            throw new Error(`Existing request ${duplicate.rows[0].request_code} blocks this transaction.`);
        }
        const existingTarget = await client.query(
            `select coalesce(sum(quantity),0)::integer quantity from inventory_lines where account_name=$1 and sku=$2`,
            [ACCOUNT, TARGET_SKU]
        );
        if (Number(existingTarget.rows[0].quantity) !== 0) throw new Error("SKU 174 inventory changed after review.");
        const reserved = [];
        for (const component of COMPONENTS) {
            const candidates = await client.query(
                `select i.*,b.is_pickable,b.location_type,b.fulfillment_location_id
                 from inventory_lines i join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.sku=$2 and i.quantity>0 and b.is_pickable=true
                   and b.location_type='STORAGE' and b.fulfillment_location_id=$3
                 order by i.id for update of i`,
                [ACCOUNT, component.sku, WAREHOUSE_ID]
            );
            let remaining = QUANTITY;
            for (const line of candidates.rows) {
                const committed = await getCommitment(client, line.id);
                const quantity = Math.min(Math.max(Number(line.quantity) - committed, 0), remaining);
                if (quantity > 0) reserved.push({ component, line, quantity });
                remaining -= quantity;
                if (!remaining) break;
            }
            if (remaining) throw new Error(`SKU ${component.sku} became short by ${remaining} cases.`);
        }
        const inserted = await client.query(
            `insert into portal_kitting_requests (
                account_name,portal_access_id,status,sales_order_reference,purchase_order_reference,
                source_sku,source_quantity,components_json,target_sku,target_quantity,
                requested_completion_date,requested_by_name,requested_by_email,notes,
                fulfillment_location_id,processing_business_days,earliest_completion_date,holiday_closures_json
             ) values ($1,null,'SUBMITTED','',$2,$3,$4,$5::jsonb,$6,$7,current_date,$8,$9,$10,$11,4,current_date,'[]'::jsonb)
             returning *`,
            [ACCOUNT, REFERENCE, COMPONENTS[0].sku, QUANTITY, JSON.stringify(COMPONENTS), TARGET_SKU, QUANTITY,
                ACTOR, "operations@wms365.co", "Convert one case each of SKUs 141, 144, and 149 into each SKU 174 three-case holiday shipper.", WAREHOUSE_ID]
        );
        const requestId = inserted.rows[0].id;
        const requestCode = `KIT-${String(requestId).padStart(6, "0")}`;
        await client.query("update portal_kitting_requests set request_code=$2,updated_at=now() where id=$1", [requestId, requestCode]);
        const request = { ...inserted.rows[0], request_code: requestCode };
        for (const reservation of reserved) {
            await client.query(
                `insert into portal_kitting_allocations (
                    kitting_request_id,inventory_line_id,sku,location,lot_number,expiration_date,tracking_level,allocated_quantity
                 ) values ($1,$2,$3,$4,$5,$6,'CASE',$7)`,
                [requestId, reservation.line.id, reservation.component.sku, reservation.line.location,
                    reservation.line.lot_number || "", reservation.line.expiration_date || "", reservation.quantity]
            );
        }
        await completePortalKittingInventory(client, request, { destinationLocation: LOCATION }, ACTOR);
        const note = `Completed ${QUANTITY} holiday shippers: one case each of 141, 144, and 149 converted into one case of 174. Finished stock posted pickable at ${LOCATION}.`;
        await client.query(
            `update portal_kitting_requests set status='COMPLETED',warehouse_note=$2,completed_at=now(),completed_by=$3,updated_at=now()
             where id=$1`,
            [requestId, note, ACTOR]
        );
        await client.query(
            `insert into activity_log(type,title,details) values('kitting',$1,$2)`,
            [`Updated kitting request ${requestCode} to COMPLETED`, `${ACCOUNT} | ${note}`]
        );
        if (APPLY) await client.query("commit"); else await client.query("rollback");
        return { requestCode, alreadyCompleted: false };
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function verify(pool, before, requestCode) {
    const request = await pool.query(
        `select request_code,status,components_json,target_sku,target_quantity,completed_at,completed_by,fulfillment_location_id
         from portal_kitting_requests where request_code=$1`,
        [requestCode]
    );
    const inventory = await pool.query(
        `select i.sku,i.quantity,i.location,b.is_pickable,b.location_type,b.fulfillment_location_id
         from inventory_lines i join bin_locations b on b.code=i.location
         where i.account_name=$1 and i.sku=any($2::text[]) order by i.sku,i.id`,
        [ACCOUNT, [...COMPONENTS.map((component) => component.sku), TARGET_SKU]]
    );
    const ledger = await pool.query(
        `select sku,location,transaction_type,quantity_delta,quantity_before,quantity_after
         from inventory_transactions where account_name=$1 and source_type='PORTAL_KITTING_REQUEST' and source_id=$2 order by id`,
        [ACCOUNT, requestCode]
    );
    const allocations = await pool.query(
        `select count(*)::integer count from portal_kitting_allocations a
         join portal_kitting_requests k on k.id=a.kitting_request_id where k.request_code=$1`,
        [requestCode]
    );
    const row = request.rows[0];
    const targetLines = inventory.rows.filter((line) => line.sku === TARGET_SKU);
    const targetAvailable = targetLines.filter((line) => line.is_pickable && line.location_type === "STORAGE"
        && Number(line.fulfillment_location_id) === WAREHOUSE_ID).reduce((sum, line) => sum + Number(line.quantity), 0);
    if (!row || row.status !== "COMPLETED" || row.target_sku !== TARGET_SKU || Number(row.target_quantity) !== QUANTITY
        || Number(row.fulfillment_location_id) !== WAREHOUSE_ID || Number(allocations.rows[0].count) !== 0
        || ledger.rowCount !== 4 || targetAvailable !== QUANTITY) throw new Error("Kitting post-completion verification failed.");
    const components = [];
    for (const component of COMPONENTS) {
        const beforeQuantity = before.components.find((entry) => entry.sku === component.sku).lines.reduce((sum, line) => sum + Number(line.quantity), 0);
        const afterQuantity = inventory.rows.filter((line) => line.sku === component.sku).reduce((sum, line) => sum + Number(line.quantity), 0);
        if (beforeQuantity - afterQuantity !== QUANTITY) throw new Error(`SKU ${component.sku} did not decrease by ${QUANTITY}.`);
        components.push({ sku: component.sku, consumed: QUANTITY, onHandAfter: afterQuantity });
    }
    return { requestCode, status: row.status, components, finished: { sku: TARGET_SKU, produced: QUANTITY,
        location: LOCATION, pickableAvailable: targetAvailable }, ledger: ledger.rows };
}

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    try {
        const before = await inspect(pool);
        assertPreflight(before);
        if (!APPLY) {
            const result = await transact(pool, before);
            return console.log(JSON.stringify({ mode: "PREVIEW", outcome: "dry_run_rolled_back", requestCode: result.requestCode,
                account: ACCOUNT, components: before.components.map((item) => ({ sku: item.sku, available: item.available, consume: QUANTITY })),
                finished: { sku: TARGET_SKU, produce: QUANTITY, finalPickableAvailable: QUANTITY } }));
        }
        const result = await transact(pool, before);
        const verified = await verify(pool, before, result.requestCode);
        console.log(JSON.stringify({ mode: "APPLY", outcome: result.alreadyCompleted ? "already_completed" : "completed", ...verified }));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
