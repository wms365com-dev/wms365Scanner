const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const SOURCE_SKU = "WW-12PK";
const TARGET_SKU = "WW-12PK-EA";
const SOURCE_CASES = 1;
const PACKS_PER_CASE = 4;
const TARGET_EACHES = 4;
const REFERENCE = "WF-ONLINE-12PK-EACH-20261103-01";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false, max: 2 });
    const client = await pool.connect();
    try {
        await client.query("begin");
        if (!APPLY) await client.query("set transaction read only");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [REFERENCE]);
        const [account, warehouse, items, duplicate, sourceInventory] = await Promise.all([
            client.query("select name,is_active from owner_accounts where name=$1", [ACCOUNT]),
            client.query(`
                select fl.id,fl.code,fl.is_active,cfl.allow_storage
                from company_fulfillment_locations cfl
                join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                where cfl.account_name=$1 and fl.code=$2
            `, [ACCOUNT, WAREHOUSE]),
            client.query(`
                select sku,upc,tracking_level,unit_uom,units_per_case,blocked
                from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku
            `, [ACCOUNT, [SOURCE_SKU, TARGET_SKU]]),
            client.query(`
                select id,request_code,status from portal_kitting_requests
                where account_name=$1 and purchase_order_reference=$2
            `, [ACCOUNT, REFERENCE]),
            client.query(`
                select i.id,i.location,i.quantity,i.upc,i.lot_number,i.expiration_date,i.tracking_level,
                       b.is_pickable,b.fulfillment_location_id,
                       coalesce((select sum(a.allocated_quantity)
                                 from portal_order_allocations a
                                 join portal_orders o on o.id=a.order_id
                                 where a.inventory_line_id=i.id
                                   and o.status in ('RELEASED','PICKED','STAGED')),0)::int
                       + coalesce((select sum(a.allocated_quantity)
                                   from portal_kitting_allocations a
                                   join portal_kitting_requests k on k.id=a.kitting_request_id
                                   where a.inventory_line_id=i.id
                                     and k.status in ('SUBMITTED','IN_PROGRESS')),0)::int as committed
                from inventory_lines i
                join bin_locations b on b.code=i.location
                join fulfillment_locations fl on fl.id=b.fulfillment_location_id
                where i.account_name=$1 and i.sku=$2 and fl.code=$3 and b.is_pickable=true
                order by i.expiration_date nulls last,i.id
                ${APPLY ? "for update of i" : ""}
            `, [ACCOUNT, SOURCE_SKU, WAREHOUSE])
        ]);
        if (account.rowCount !== 1 || account.rows[0].is_active !== true) throw new Error("Exact active Wellforia tenant verification failed.");
        if (warehouse.rowCount !== 1 || warehouse.rows[0].is_active !== true || warehouse.rows[0].allow_storage !== true) {
            throw new Error("Exact active Mississauga warehouse verification failed.");
        }
        if (items.rowCount !== 2 || items.rows.some((row) => row.blocked)) throw new Error("Required item verification failed.");
        const sourceItem = items.rows.find((row) => row.sku === SOURCE_SKU);
        const targetItem = items.rows.find((row) => row.sku === TARGET_SKU);
        if (sourceItem.tracking_level !== "CASE" || Number(sourceItem.units_per_case) !== PACKS_PER_CASE) {
            throw new Error("WW-12PK is not configured as a four-pack case.");
        }
        if (targetItem.tracking_level !== "UNIT" || Number(targetItem.units_per_case) !== 1) {
            throw new Error("WW-12PK-EA is not configured as an each-level item.");
        }
        if (duplicate.rowCount) {
            await client.query("rollback");
            console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "PREFLIGHT", alreadyExists: true, request: duplicate.rows[0] }, null, 2));
            return;
        }
        const sourceLine = sourceInventory.rows.find((row) => Number(row.quantity) - Number(row.committed) >= SOURCE_CASES);
        if (!sourceLine) throw new Error("No uncommitted pickable WW-12PK case is available.");
        const summary = {
            mode: APPLY ? "APPLY" : "PREFLIGHT",
            account: ACCOUNT,
            warehouse: WAREHOUSE,
            source: { sku: SOURCE_SKU, cases: SOURCE_CASES, packsPerCase: PACKS_PER_CASE },
            target: { sku: TARGET_SKU, eaches: TARGET_EACHES },
            reference: REFERENCE
        };
        if (!APPLY) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return;
        }

        const inserted = await client.query(`
            insert into portal_kitting_requests (
                account_name,portal_access_id,status,sales_order_reference,purchase_order_reference,
                source_sku,source_quantity,components_json,target_sku,target_quantity,
                requested_completion_date,requested_by_name,requested_by_email,notes,
                fulfillment_location_id,processing_business_days,earliest_completion_date,holiday_closures_json
            ) values ($1,null,'SUBMITTED',$2,$3,$4,$5,$6::jsonb,$7,$8,current_date,$9,'',$10,$11,1,current_date,'[]'::jsonb)
            returning id
        `, [
            ACCOUNT, "Online order each-stock preparation", REFERENCE, SOURCE_SKU, SOURCE_CASES,
            JSON.stringify([{ sku: SOURCE_SKU, totalQuantity: SOURCE_CASES, quantityPerUnit: PACKS_PER_CASE,
                description: "WHOOPSIE WIPES 12 PACK master case" }]),
            TARGET_SKU, TARGET_EACHES, "Warehouse operations",
            "Break one WHOOPSIE WIPES 12 PACK master case containing four consumer packs into four individually pickable eaches for online shipping.",
            warehouse.rows[0].id
        ]);
        const requestId = inserted.rows[0].id;
        const requestCode = `KIT-${String(requestId).padStart(6, "0")}`;
        await client.query("update portal_kitting_requests set request_code=$2,updated_at=now() where id=$1", [requestId, requestCode]);
        await client.query(`
            insert into portal_kitting_allocations (
                kitting_request_id,inventory_line_id,sku,location,lot_number,expiration_date,tracking_level,allocated_quantity
            ) values ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [requestId, sourceLine.id, SOURCE_SKU, sourceLine.location, sourceLine.lot_number || "",
            sourceLine.expiration_date || "", sourceLine.tracking_level, SOURCE_CASES]);

        const sourceBefore = Number(sourceLine.quantity);
        await client.query("update inventory_lines set quantity=quantity-1,updated_at=now() where id=$1", [sourceLine.id]);
        const targetBeforeResult = await client.query(`
            select id,quantity from inventory_lines
            where account_name=$1 and location=$2 and sku=$3 and lot_number='' and expiration_date=''
            limit 1 for update
        `, [ACCOUNT, sourceLine.location, TARGET_SKU]);
        const targetBefore = targetBeforeResult.rowCount ? Number(targetBeforeResult.rows[0].quantity) : 0;
        const targetResult = await client.query(`
            insert into inventory_lines (account_name,location,sku,upc,lot_number,expiration_date,tracking_level,quantity)
            values ($1,$2,$3,$4,'','','UNIT',$5)
            on conflict (account_name,location,sku,lot_number,expiration_date)
            do update set quantity=inventory_lines.quantity+$5,tracking_level='UNIT',updated_at=now()
            returning quantity
        `, [ACCOUNT, sourceLine.location, TARGET_SKU, targetItem.upc || "", TARGET_EACHES]);
        const targetAfter = Number(targetResult.rows[0].quantity);
        await client.query(`
            insert into inventory_transactions (
                account_name,warehouse_id,fulfillment_location_id,location,sku,upc,lot_number,expiration_date,
                transaction_type,quantity_delta,quantity_before,quantity_after,source_type,source_id,idempotency_key,source
            ) values
            ($1,$2,$3,$4,$5,$6,$7,$8,'CONVERSION',-1,$9,$10,'PORTAL_KITTING_REQUEST',$11,$12,'kitting_completion'),
            ($1,$2,$3,$4,$13,$14,'','','CONVERSION',$15,$16,$17,'PORTAL_KITTING_REQUEST',$11,$18,'kitting_completion')
        `, [
            ACCOUNT, WAREHOUSE, warehouse.rows[0].id, sourceLine.location, SOURCE_SKU, sourceLine.upc || "",
            sourceLine.lot_number || "", sourceLine.expiration_date || "", sourceBefore, sourceBefore - 1,
            requestCode, `${requestCode}-source-1`, TARGET_SKU, targetItem.upc || "", TARGET_EACHES,
            targetBefore, targetAfter, `${requestCode}-target-1`
        ]);
        await client.query("delete from portal_kitting_allocations where kitting_request_id=$1", [requestId]);
        const note = `Completed one-case break: consumed 1 ${SOURCE_SKU} case and produced 4 individually pickable ${TARGET_SKU} eaches.`;
        await client.query(`
            update portal_kitting_requests
            set status='COMPLETED',warehouse_note=$2,completed_at=now(),
                completed_by='Warehouse operations',updated_at=now()
            where id=$1
        `, [requestId, note]);
        await client.query(`
            insert into activity_log(type,title,details) values('kitting',$1,$2)
        `, [`Created and completed kitting request ${requestCode}`, `${ACCOUNT} | ${note} | ${REFERENCE}`]);
        await client.query("commit");

        const [request, ledger, allocation, pickable] = await Promise.all([
            pool.query(`
                select request_code,status,source_sku,source_quantity,target_sku,target_quantity,completed_at,completed_by
                from portal_kitting_requests where id=$1
            `, [requestId]),
            pool.query(`
                select sku,quantity_delta,quantity_before,quantity_after,location,idempotency_key
                from inventory_transactions
                where account_name=$1 and source_type='PORTAL_KITTING_REQUEST' and source_id=$2 order by id
            `, [ACCOUNT, requestCode]),
            pool.query("select count(*)::int count from portal_kitting_allocations where kitting_request_id=$1", [requestId]),
            pool.query(`
                select coalesce(sum(i.quantity),0)::int on_hand
                from inventory_lines i join bin_locations b on b.code=i.location
                where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=$3 and b.is_pickable=true
            `, [ACCOUNT, TARGET_SKU, warehouse.rows[0].id])
        ]);
        const sourceDelta = ledger.rows.filter((row) => row.sku === SOURCE_SKU).reduce((sum, row) => sum + Number(row.quantity_delta), 0);
        const targetDelta = ledger.rows.filter((row) => row.sku === TARGET_SKU).reduce((sum, row) => sum + Number(row.quantity_delta), 0);
        if (request.rows[0]?.status !== "COMPLETED" || sourceDelta !== -1 || targetDelta !== 4
            || Number(allocation.rows[0].count) !== 0) throw new Error("Post-commit verification failed.");
        console.log(JSON.stringify({
            ...summary, requestCode, request: request.rows[0], ledger: ledger.rows,
            pickableTargetOnHand: Number(pickable.rows[0].on_hand),
            sideEffects: { ordersReleased: 0, emailsSent: 0, labelsCreated: 0 }
        }, null, 2));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
