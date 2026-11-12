const crypto = require("node:crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE_ID = "1";
const SKU = "WW-12PK-EA";
const PORTAL_USER_EMAIL = "usman.tahir@wellforia.com";
const EXPECTED = new Map([
    ["S-ORD101184", 1], ["S-ORD101185", 1], ["S-ORD101187", 1], ["S-ORD101189", 1],
    ["S-ORD101190", 2], ["S-ORD101191", 1], ["S-ORD101192", 1], ["S-ORD101193", 1],
    ["S-ORD101194", 1], ["S-ORD101195", 1], ["S-ORD101196", 1], ["S-ORD101197", 1],
    ["S-ORD101198", 1], ["S-ORD101199", 1], ["S-ORD101200", 1], ["S-ORD101201", 1],
    ["S-ORD101202", 1], ["S-ORD101203", 2], ["S-ORD101204", 1], ["S-ORD101205", 1],
    ["S-ORD101207", 1], ["S-ORD101208", 1], ["S-ORD101211", 1]
]);
const APPLY = process.argv.includes("--apply");

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function createTemporaryPortalSession(pool, accessId) {
    const token = crypto.randomBytes(32).toString("hex");
    const result = await pool.query(
        `insert into portal_sessions (portal_access_id,token_hash,expires_at)
         values ($1,$2,now() + interval '15 minutes') returning id`,
        [accessId, hashToken(token)]
    );
    return { id: result.rows[0].id, token };
}

async function callPortal(orderId, token) {
    const response = await fetch(`${API_ORIGIN}/api/portal/orders/${orderId}/release`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: `wms365_portal_session=${encodeURIComponent(token)}` },
        body: JSON.stringify({ notifyWarehouse: true, shippingLabelAttached: false, ccEmails: [], rushApproved: false,
            rushExempt: false, splitFulfillmentApproved: false }),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) throw new Error(`${response.status}: ${payload.error || payload.message || "release failed"}`);
    return payload;
}

async function loadOrders(pool) {
    const result = await pool.query(
        `select o.id,o.order_code,o.status,o.account_name,o.portal_access_id,o.fulfillment_location_id,
                p.email as portal_user_email,p.is_active as portal_user_active,
                l.id as line_id,l.sku,l.requested_quantity
         from portal_orders o join portal_order_lines l on l.order_id=o.id
         left join portal_vendor_access p on p.id=o.portal_access_id
         where o.account_name=$1 and o.order_code=any($2::text[])
         order by o.order_code,l.line_number,l.id`,
        [ACCOUNT, [...EXPECTED.keys()]]
    );
    const grouped = new Map();
    for (const row of result.rows) {
        if (!grouped.has(row.order_code)) grouped.set(row.order_code, { ...row, lines: [] });
        grouped.get(row.order_code).lines.push({ id: row.line_id, sku: row.sku, quantity: Number(row.requested_quantity) });
    }
    return grouped;
}

async function verifyReleased(pool, orderId) {
    const result = await pool.query(
        `select o.status,l.sku,l.requested_quantity,
                coalesce(sum(a.allocated_quantity),0)::int as allocated_quantity,
                array_agg(distinct a.location order by a.location) filter (where a.location<>'') as locations
         from portal_orders o join portal_order_lines l on l.order_id=o.id
         left join portal_order_allocations a on a.order_line_id=l.id
         where o.id=$1 group by o.status,l.id,l.sku,l.requested_quantity`,
        [orderId]
    );
    return result.rows;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const sessions = [];
    try {
        const orders = await loadOrders(pool);
        const portalUserResult = await pool.query(
            `select id,email,is_active from portal_vendor_access
             where account_name=$1 and lower(email)=lower($2)`,
            [ACCOUNT, PORTAL_USER_EMAIL]
        );
        if (portalUserResult.rowCount !== 1 || portalUserResult.rows[0].is_active !== true) {
            throw new Error("The exact active Wellforia portal owner could not be verified.");
        }
        const portalUser = portalUserResult.rows[0];
        const missing = [...EXPECTED.keys()].filter((code) => !orders.has(code));
        if (missing.length) throw new Error(`Missing Wellforia orders: ${missing.join(", ")}`);
        let totalRequested = 0;
        const preflight = [];
        for (const [code, expectedQuantity] of EXPECTED) {
            const order = orders.get(code);
            if (order.portal_access_id && String(order.portal_access_id) !== String(portalUser.id)) {
                throw new Error(`${code} belongs to a different portal user.`);
            }
            if (String(order.fulfillment_location_id) !== WAREHOUSE_ID) throw new Error(`${code} is not assigned to GW3PL-MISS.`);
            if (order.lines.length !== 1 || order.lines[0].sku !== SKU || order.lines[0].quantity !== expectedQuantity) {
                throw new Error(`${code} does not match the expected ${SKU} quantity ${expectedQuantity}.`);
            }
            if (!["DRAFT", "RELEASED"].includes(order.status)) throw new Error(`${code} is ${order.status}, not releasable or already released.`);
            totalRequested += expectedQuantity;
            preflight.push({ code, status: order.status, quantity: expectedQuantity });
        }
        if (totalRequested !== 25 || preflight.length !== 23) throw new Error("Pinned batch no longer totals 23 orders and 25 packs.");
        const availableResult = await pool.query(
            `select coalesce(sum(i.quantity),0)::int - coalesce((select sum(a.allocated_quantity)::int
                    from portal_order_allocations a join portal_order_lines l on l.id=a.order_line_id
                    join portal_orders o on o.id=l.order_id
                    where o.account_name=$1 and o.status in ('RELEASED','PICKED','STAGED') and l.sku=$2),0)::int as available
             from inventory_lines i join bin_locations b on b.code=i.location
             where i.account_name=$1 and i.sku=$2 and b.fulfillment_location_id=$3 and b.is_pickable=true`,
            [ACCOUNT, SKU, WAREHOUSE_ID]
        );
        const available = Number(availableResult.rows[0].available);
        const remainingDraftDemand = preflight.filter((row) => row.status === "DRAFT").reduce((sum, row) => sum + row.quantity, 0);
        if (available < remainingDraftDemand) throw new Error(`Only ${available} uncommitted packs are available for ${remainingDraftDemand} remaining draft demand.`);
        if (!APPLY) {
            console.log(JSON.stringify({ mode: "PREFLIGHT", account: ACCOUNT, warehouseId: WAREHOUSE_ID,
                portalOwner: portalUser.email, ownershipAssignmentsRequired: preflight.filter((row) => !orders.get(row.code).portal_access_id).length,
                orderCount: preflight.length, totalRequested, remainingDraftDemand, available, orders: preflight }, null, 2));
            return;
        }
        const ownershipResult = await pool.query(
            `update portal_orders set portal_access_id=$3,updated_at=now()
             where account_name=$1 and order_code=any($2::text[]) and portal_access_id is null
             returning order_code`,
            [ACCOUNT, [...EXPECTED.keys()], portalUser.id]
        );
        if (ownershipResult.rowCount) {
            await pool.query(
                `insert into activity_log (type,title,details) values ('order',$1,$2)`,
                ["Corrected Wellforia consumer-order ownership",
                    `${ownershipResult.rowCount} pinned consumer orders assigned to the verified active Wellforia portal account before release.`]
            );
        }
        const results = [];
        for (const [code, expectedQuantity] of EXPECTED) {
            const order = orders.get(code);
            if (order.status === "DRAFT") {
                const session = await createTemporaryPortalSession(pool, portalUser.id);
                sessions.push(session.id);
                const response = await callPortal(order.id, session.token);
                results.push({ code, quantity: expectedQuantity, released: true, releaseActions: response.releaseActions || null });
            } else {
                results.push({ code, quantity: expectedQuantity, released: false, alreadyReleased: true });
            }
            const lines = await verifyReleased(pool, order.id);
            if (lines.length !== 1 || lines[0].status !== "RELEASED" || lines[0].sku !== SKU
                || Number(lines[0].requested_quantity) !== expectedQuantity || Number(lines[0].allocated_quantity) !== expectedQuantity) {
                throw new Error(`${code} did not reconcile as fully released and allocated.`);
            }
            results[results.length - 1].verification = lines[0];
        }
        const final = await pool.query(
            `select o.status,count(*)::int as order_count,coalesce(sum(l.requested_quantity),0)::int as quantity
             from portal_orders o join portal_order_lines l on l.order_id=o.id
             where o.account_name=$1 and o.order_code=any($2::text[]) group by o.status`,
            [ACCOUNT, [...EXPECTED.keys()]]
        );
        if (final.rowCount !== 1 || final.rows[0].status !== "RELEASED" || Number(final.rows[0].order_count) !== 23 || Number(final.rows[0].quantity) !== 25) {
            throw new Error("Final batch verification failed.");
        }
        console.log(JSON.stringify({ mode: "APPLIED", final: final.rows[0], results }, null, 2));
    } finally {
        for (const sessionId of sessions) await pool.query("delete from portal_sessions where id=$1", [sessionId]).catch(() => {});
        await pool.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
