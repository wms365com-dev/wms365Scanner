const crypto = require("crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const ACCOUNT = "WELLFORIA HEALTH INC";
const SKU = "WW-6PK-EA";
const ORDER_CODES = [
    "S-ORD101186",
    "S-ORD101188",
    "S-ORD101206",
    "S-ORD101209",
    "S-ORD101210"
];
const APPLY = process.argv.includes("--apply");

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function createTemporaryPortalSession(pool, accessId) {
    const token = crypto.randomBytes(32).toString("hex");
    const result = await pool.query(
        `insert into portal_sessions (portal_access_id, token_hash, expires_at)
         values ($1,$2,now() + interval '10 minutes') returning id`,
        [accessId, hashToken(token)]
    );
    return { id: result.rows[0].id, token };
}

async function callPortal(orderId, token) {
    const response = await fetch(`${API_ORIGIN}/api/portal/orders/${orderId}/release`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Cookie: `wms365_portal_session=${encodeURIComponent(token)}`
        },
        body: JSON.stringify({
            notifyWarehouse: true,
            shippingLabelAttached: false,
            ccEmails: [],
            rushApproved: false,
            rushExempt: false,
            splitFulfillmentApproved: false
        }),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(`${response.status}: ${payload.error || payload.message || "release failed"}`);
    }
    return payload;
}

async function loadOrders(pool) {
    const result = await pool.query(
        `select o.id, o.order_code, o.status, o.account_name, o.portal_access_id,
                o.fulfillment_location_id, p.email as portal_user_email, p.is_active as portal_user_active,
                l.id as line_id, l.sku, l.requested_quantity
         from portal_orders o
         join portal_order_lines l on l.order_id=o.id
         left join portal_vendor_access p on p.id=o.portal_access_id
         where o.account_name=$1 and o.order_code=any($2::text[])
         order by o.order_code,l.line_number,l.id`,
        [ACCOUNT, ORDER_CODES]
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
        `select o.status, l.sku, l.requested_quantity,
                coalesce(sum(a.allocated_quantity),0)::int as allocated_quantity,
                array_agg(distinct a.location order by a.location) filter (where a.location<>'') as locations
         from portal_orders o
         join portal_order_lines l on l.order_id=o.id
         left join portal_order_allocations a on a.order_line_id=l.id
         where o.id=$1
         group by o.status,l.id,l.sku,l.requested_quantity`,
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
        const missing = ORDER_CODES.filter((code) => !orders.has(code));
        if (missing.length) throw new Error(`Missing Wellforia orders: ${missing.join(", ")}`);

        const preflight = [];
        for (const code of ORDER_CODES) {
            const order = orders.get(code);
            if (!order.portal_access_id || order.portal_user_active !== true) {
                throw new Error(`${code} does not have an active originating portal user.`);
            }
            if (order.lines.length !== 1 || order.lines[0].sku !== SKU || order.lines[0].quantity !== 1) {
                throw new Error(`${code} is not exactly one ${SKU} unit.`);
            }
            if (!["DRAFT", "RELEASED"].includes(order.status)) {
                throw new Error(`${code} is ${order.status}, not releasable or already released.`);
            }
            preflight.push({ code, status: order.status, sku: SKU, quantity: 1, portalUser: order.portal_user_email });
        }
        if (!APPLY) {
            console.log(JSON.stringify({ mode: "PREVIEW", preflight }, null, 2));
            return;
        }

        const results = [];
        for (const code of ORDER_CODES) {
            const order = orders.get(code);
            if (order.status === "DRAFT") {
                const session = await createTemporaryPortalSession(pool, order.portal_access_id);
                sessions.push(session.id);
                const response = await callPortal(order.id, session.token);
                results.push({ code, released: true, releaseActions: response.releaseActions || null });
            } else {
                results.push({ code, released: false, alreadyReleased: true });
            }
            const lines = await verifyReleased(pool, order.id);
            if (lines.length !== 1 || lines[0].status !== "RELEASED" || lines[0].sku !== SKU
                || Number(lines[0].requested_quantity) !== 1 || Number(lines[0].allocated_quantity) !== 1) {
                throw new Error(`${code} did not reconcile as one released and allocated ${SKU} unit.`);
            }
            results[results.length - 1].verification = lines[0];
        }
        console.log(JSON.stringify({ mode: "APPLIED", results }, null, 2));
    } finally {
        for (const sessionId of sessions) {
            await pool.query("delete from portal_sessions where id=$1", [sessionId]).catch(() => {});
        }
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
