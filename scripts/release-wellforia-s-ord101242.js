const crypto = require("node:crypto");
const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const API_ORIGIN = "https://app.wms365.co";
const ACCOUNT = "WELLFORIA HEALTH INC";
const ORDER = "S-ORD101242";
const SKU = "WW-12PK-EA";
const QUANTITY = 2;

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    try {
        const result = await pool.query(`
            select o.id,o.order_code,o.status,o.account_name,o.portal_access_id,o.fulfillment_location_id,
                   p.account_name as portal_account,p.is_active as portal_active,p.email,
                   l.id as line_id,l.sku,l.requested_quantity
            from portal_orders o
            join portal_order_lines l on l.order_id=o.id
            join portal_vendor_access p on p.id=o.portal_access_id
            where o.account_name=$1 and o.order_code=$2
            order by l.line_number,l.id
        `, [ACCOUNT, ORDER]);
        if (result.rowCount !== 1) throw new Error("Expected one exact Wellforia order line.");
        const row = result.rows[0];
        if (row.status !== "DRAFT" || row.account_name !== ACCOUNT || row.portal_account !== ACCOUNT
            || row.portal_active !== true || Number(row.fulfillment_location_id) !== 1
            || row.sku !== SKU || Number(row.requested_quantity) !== QUANTITY) {
            throw new Error("Wellforia order identity, ownership, warehouse, status, or quantity changed.");
        }
        const kit = await pool.query(`
            select status,source_sku,source_quantity,target_sku,target_quantity
            from portal_kitting_requests where account_name=$1 and request_code='KIT-000031'
        `, [ACCOUNT]);
        if (kit.rowCount !== 1 || kit.rows[0].status !== "COMPLETED"
            || kit.rows[0].source_sku !== "WW-12PK" || Number(kit.rows[0].source_quantity) !== 1
            || kit.rows[0].target_sku !== SKU || Number(kit.rows[0].target_quantity) !== 4) {
            throw new Error("KIT-000031 completion verification failed.");
        }
        const stock = await pool.query(`
            select coalesce(sum(i.quantity),0)::int
                   - coalesce((select sum(a.allocated_quantity)::int
                               from portal_order_allocations a
                               join portal_order_lines l on l.id=a.order_line_id
                               join portal_orders o on o.id=l.order_id
                               where o.account_name=$1 and o.status in ('RELEASED','PICKED','STAGED')
                                 and l.sku=$2),0)::int as available
            from inventory_lines i join bin_locations b on b.code=i.location
            where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=1 and b.is_pickable=true
        `, [ACCOUNT, SKU]);
        const available = Number(stock.rows[0].available);
        if (available < QUANTITY) throw new Error(`Only ${available} eaches are available for the requested ${QUANTITY}.`);
        if (!APPLY) {
            console.log(JSON.stringify({
                mode: "PREFLIGHT", order: ORDER, status: row.status,
                line: { sku: SKU, quantity: QUANTITY }, available, kit: "KIT-000031"
            }, null, 2));
            return;
        }
        const token = crypto.randomBytes(32).toString("hex");
        const session = await pool.query(`
            insert into portal_sessions(portal_access_id,token_hash,expires_at)
            values($1,$2,now()+interval '15 minutes') returning id
        `, [row.portal_access_id, hashToken(token)]);
        sessionId = session.rows[0].id;
        const response = await fetch(`${API_ORIGIN}/api/portal/orders/${row.id}/release`, {
            method: "POST",
            headers: {
                Accept: "application/json", "Content-Type": "application/json",
                Cookie: `wms365_portal_session=${encodeURIComponent(token)}`
            },
            body: JSON.stringify({
                notifyWarehouse: true, shippingLabelAttached: false, ccEmails: [],
                rushApproved: false, rushExempt: false, splitFulfillmentApproved: false
            }),
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.success === false) {
            throw new Error(`${response.status}: ${payload.error || payload.message || "release failed"}`);
        }
        const verification = await pool.query(`
            select o.status,l.sku,l.requested_quantity,
                   coalesce(sum(a.allocated_quantity),0)::int allocated_quantity,
                   array_agg(distinct a.location order by a.location) filter (where a.location<>'') locations
            from portal_orders o join portal_order_lines l on l.order_id=o.id
            left join portal_order_allocations a on a.order_line_id=l.id
            where o.id=$1 group by o.status,l.id,l.sku,l.requested_quantity
        `, [row.id]);
        const final = verification.rows[0];
        if (verification.rowCount !== 1 || final.status !== "RELEASED" || final.sku !== SKU
            || Number(final.requested_quantity) !== QUANTITY || Number(final.allocated_quantity) !== QUANTITY) {
            throw new Error("Released order did not reconcile as fully allocated.");
        }
        console.log(JSON.stringify({
            mode: "APPLIED", order: ORDER, released: true, verification: final,
            releaseActions: payload.releaseActions || null
        }, null, 2));
    } finally {
        if (sessionId) await pool.query("delete from portal_sessions where id=$1", [sessionId]).catch(() => {});
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
