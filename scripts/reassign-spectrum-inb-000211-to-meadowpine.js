const { Client } = require("pg");

const CODE = "INB-000211";
const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const SOURCE_ID = 1;
const SOURCE_CODE = "GW3PL-MISS";
const TARGET_ID = 258;
const TARGET_CODE = "GW3PL-MEADOWPINE";
const APPLY = process.argv.includes("--apply");

async function inspect(db, lock = false) {
    const inboundResult = await db.query(
        `select i.*, fl.code warehouse_code
         from portal_inbounds i
         left join fulfillment_locations fl on fl.id=i.fulfillment_location_id
         where i.inbound_code=$1 ${lock ? "for update of i" : ""}`,
        [CODE]
    );
    if (inboundResult.rowCount !== 1) throw new Error(`${CODE}: expected exactly one inbound.`);
    const inbound = inboundResult.rows[0];
    if (inbound.account_name !== ACCOUNT) throw new Error(`${CODE}: company identity mismatch.`);

    const targetResult = await db.query(
        `select fl.id,fl.code,fl.is_active,cfl.allow_inbound,cfl.allow_storage,
                cfl.customer_portal_visible
         from company_fulfillment_locations cfl
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and fl.id=$2 and fl.code=$3`,
        [ACCOUNT, TARGET_ID, TARGET_CODE]
    );
    const target = targetResult.rows[0];
    if (targetResult.rowCount !== 1 || !target.is_active || !target.allow_inbound
        || !target.allow_storage || !target.customer_portal_visible) {
        throw new Error("Spectrum Meadowpine warehouse access is not fully enabled.");
    }

    const [allocations, ledger, tasks] = await Promise.all([
        db.query("select count(*)::integer count from portal_inbound_receipt_allocations where inbound_id=$1", [inbound.id]),
        db.query(
            `select count(*)::integer count from inventory_transactions
             where source_type='PORTAL_INBOUND' and source_id=$1::text`,
            [String(inbound.id)]
        ),
        db.query(
            `select id,status,fulfillment_location_id from warehouse_tasks
             where source_type='PORTAL_INBOUND' and source_id=$1 order by id`,
            [inbound.id]
        )
    ]);
    return {
        inbound,
        target,
        allocationCount: allocations.rows[0].count,
        ledgerCount: ledger.rows[0].count,
        tasks: tasks.rows
    };
}

async function main() {
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const db = new Client({
        connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
        ssl: false
    });
    await db.connect();
    try {
        await db.query("begin");
        await db.query("set transaction read only");
        const before = await inspect(db);
        await db.query("rollback");
        console.log(JSON.stringify({
            phase: "preflight",
            inbound: CODE,
            account: before.inbound.account_name,
            status: before.inbound.status,
            currentWarehouse: before.inbound.warehouse_code,
            targetWarehouse: TARGET_CODE,
            allocationCount: before.allocationCount,
            ledgerCount: before.ledgerCount,
            taskCount: before.tasks.length
        }));
        if (!APPLY) return;

        await db.query("begin");
        const current = await inspect(db, true);
        if (current.inbound.status !== "SUBMITTED" || current.inbound.received_at
            || current.allocationCount !== 0 || current.ledgerCount !== 0) {
            throw new Error(`${CODE}: receipt evidence or status blocks warehouse reassignment.`);
        }
        if (Number(current.inbound.fulfillment_location_id) !== SOURCE_ID
            || current.inbound.warehouse_code !== SOURCE_CODE) {
            throw new Error(`${CODE}: source warehouse changed; no update applied.`);
        }
        await db.query(
            `update portal_inbounds set fulfillment_location_id=$2,updated_at=now() where id=$1`,
            [current.inbound.id, TARGET_ID]
        );
        const taskUpdate = await db.query(
            `update warehouse_tasks set fulfillment_location_id=$2,updated_at=now()
             where source_type='PORTAL_INBOUND' and source_id=$1
               and status not in ('COMPLETED','CANCELLED')`,
            [current.inbound.id, TARGET_ID]
        );
        await db.query(
            `insert into activity_log(type,title,details)
             values('receipt',$1,$2)`,
            [
                `Reassigned inbound ${CODE} to Meadowpine`,
                `${ACCOUNT} | ${SOURCE_CODE} -> ${TARGET_CODE} | Owner requested warehouse correction before receipt`
            ]
        );
        await db.query("commit");

        await db.query("begin read only");
        const after = await inspect(db);
        await db.query("rollback");
        if (after.inbound.status !== "SUBMITTED"
            || Number(after.inbound.fulfillment_location_id) !== TARGET_ID
            || after.inbound.warehouse_code !== TARGET_CODE
            || after.allocationCount !== 0 || after.ledgerCount !== 0
            || after.tasks.some((task) => !["COMPLETED", "CANCELLED"].includes(task.status)
                && Number(task.fulfillment_location_id) !== TARGET_ID)) {
            throw new Error(`${CODE}: post-update verification failed.`);
        }
        console.log(JSON.stringify({
            phase: "verified",
            inbound: CODE,
            account: after.inbound.account_name,
            status: after.inbound.status,
            warehouse: after.inbound.warehouse_code,
            allocationCount: after.allocationCount,
            ledgerCount: after.ledgerCount,
            tasksUpdated: taskUpdate.rowCount,
            customerVisible: after.target.customer_portal_visible
        }));
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
