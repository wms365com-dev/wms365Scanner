const { Client } = require("pg");
const { APP_USER_ROLES, releasePortalOrderForAccount } = require("../server");

const ORDER_CODE = "ORD-000812";
const ACCOUNT = "NORTH HIMALAYAN TRADERS";
const WAREHOUSE_ID = 143;
const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "operations@wms365.co",
    full_name: "Prathab Kandasamy (RUSH approved)"
};

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const current = await client.query(
            `select id,account_name,status,fulfillment_location_id,rush_approved
             from portal_orders where order_code=$1 for update`,
            [ORDER_CODE]
        );
        if (current.rowCount !== 1) throw new Error(`${ORDER_CODE} was not found.`);
        const row = current.rows[0];
        if (row.account_name !== ACCOUNT || Number(row.fulfillment_location_id) !== WAREHOUSE_ID) {
            throw new Error("Order customer or Edwards warehouse assignment does not match the approved request.");
        }
        if (!["DRAFT", "RELEASED"].includes(row.status)) throw new Error(`${ORDER_CODE} cannot be released from ${row.status}.`);

        const order = await releasePortalOrderForAccount(client, ACCOUNT, row.id, {
            activityTitlePrefix: "warehouse sales",
            activityActor: ACTOR.full_name,
            rushApproved: true,
            rushApprovedBy: ACTOR.full_name
        });
        const check = await client.query(
            `select o.id,o.order_code,o.status,o.released_at,o.fulfillment_location_id,o.rush_approved,
                    o.rush_fee_minimum,o.rush_approved_by,
                    count(distinct l.id)::integer line_count,
                    sum(l.requested_quantity)::integer requested_quantity,
                    coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity,
                    array_agg(distinct a.location) filter (where a.location is not null) allocation_locations
             from portal_orders o
             join portal_order_lines l on l.order_id=o.id
             left join portal_order_allocations a on a.order_line_id=l.id
             where o.id=$1 group by o.id`,
            [order.id]
        );
        const saved = check.rows[0];
        if (saved.status !== "RELEASED" || saved.rush_approved !== true
            || Number(saved.fulfillment_location_id) !== WAREHOUSE_ID
            || Number(saved.requested_quantity) !== 2
            || Number(saved.allocated_quantity) !== 2) {
            throw new Error(`Release verification failed: ${JSON.stringify(saved)}`);
        }
        const foreignLocation = await client.query(
            `select a.location,b.account_name,b.fulfillment_location_id
             from portal_order_allocations a
             join portal_order_lines l on l.id=a.order_line_id
             left join bin_locations b on b.code=a.location
             where l.order_id=$1 and (b.account_name<>$2 or b.fulfillment_location_id<>$3)`,
            [order.id, ACCOUNT, WAREHOUSE_ID]
        );
        if (foreignLocation.rowCount) throw new Error("Allocation escaped the customer or Edwards warehouse boundary.");

        await client.query("commit");
        console.log(JSON.stringify({ success: true, order: saved }, null, 2));
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
