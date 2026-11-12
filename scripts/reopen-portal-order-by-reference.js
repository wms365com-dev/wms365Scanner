const crypto = require("crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const reference = String(process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]) || "").trim();
const APPLY = process.argv.includes("--apply");

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

async function main() {
    if (!reference) throw new Error("Provide an order reference.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    try {
        const matches = await pool.query(
            `select o.id, o.order_code, o.account_name, o.status, o.po_number, o.shipping_reference,
                    o.fulfillment_location_id, o.released_at, o.picked_at, o.staged_at,
                    count(distinct l.id)::int as line_count,
                    coalesce(sum(l.requested_quantity),0)::int as requested_quantity,
                    count(distinct a.id)::int as allocation_count,
                    coalesce(sum(a.allocated_quantity),0)::int as allocated_quantity
             from portal_orders o
             left join portal_order_lines l on l.order_id=o.id
             left join portal_order_allocations a on a.order_id=o.id
             where upper(o.order_code)=upper($1)
                or upper(o.po_number)=upper($1)
                or upper(o.shipping_reference)=upper($1)
             group by o.id
             order by o.id desc`,
            [reference]
        );
        if (matches.rowCount !== 1) {
            throw new Error(matches.rowCount ? `${reference} matched ${matches.rowCount} orders; no change was made.` : `${reference} was not found.`);
        }
        const before = matches.rows[0];
        if (!APPLY) {
            console.log(JSON.stringify({ mode: "PREVIEW", order: before }, null, 2));
            return;
        }
        if (before.status === "DRAFT") {
            console.log(JSON.stringify({ mode: "APPLIED", alreadyDraft: true, order: before }, null, 2));
            return;
        }
        if (before.status !== "RELEASED") {
            throw new Error(`${before.order_code} is ${before.status}. Only a released order that has not been picked can be reopened.`);
        }
        const admin = await pool.query(
            "select id from app_users where lower(email)=lower($1) and is_active=true and role='super_admin' limit 1",
            ["k.prathab@gmail.com"]
        );
        if (admin.rowCount !== 1) throw new Error("The authorized platform administrator was not found.");
        const token = crypto.randomBytes(32).toString("hex");
        const session = await pool.query(
            `insert into app_sessions (app_user_id, token_hash, expires_at)
             values ($1,$2,now() + interval '10 minutes') returning id`,
            [admin.rows[0].id, hashToken(token)]
        );
        sessionId = session.rows[0].id;
        const response = await fetch(`${API_ORIGIN}/api/admin/portal-orders/${before.id}/reopen`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: `wms365_app_session=${encodeURIComponent(token)}` },
            body: "{}",
            signal: AbortSignal.timeout(30000)
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.success !== true) {
            throw new Error(`WMS365 reopen failed (${response.status}): ${payload.error || payload.message || "request failed"}`);
        }
        const afterResult = await pool.query(
            `select o.id, o.order_code, o.account_name, o.status, o.po_number, o.shipping_reference,
                    o.fulfillment_location_id, o.released_at, o.picked_at, o.staged_at,
                    count(distinct l.id)::int as line_count,
                    coalesce(sum(l.requested_quantity),0)::int as requested_quantity,
                    count(distinct a.id)::int as allocation_count,
                    coalesce(sum(a.allocated_quantity),0)::int as allocated_quantity
             from portal_orders o
             left join portal_order_lines l on l.order_id=o.id
             left join portal_order_allocations a on a.order_id=o.id
             where o.id=$1 group by o.id`,
            [before.id]
        );
        const after = afterResult.rows[0];
        if (after.status !== "DRAFT" || after.released_at || after.picked_at || after.staged_at
            || Number(after.allocation_count) !== 0 || Number(after.allocated_quantity) !== 0) {
            throw new Error("The order did not verify as a clean editable draft. Review it immediately.");
        }
        console.log(JSON.stringify({ mode: "APPLIED", before, after }, null, 2));
    } finally {
        if (sessionId) await pool.query("delete from app_sessions where id=$1", [sessionId]).catch(() => {});
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
