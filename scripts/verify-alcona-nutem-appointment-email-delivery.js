const { Pool } = require("pg");

const ORDERS = ["ORD-001395", "ORD-001591", "ORD-001592"];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");

    const pool = new Pool({ connectionString, max: 1 });
    try {
        const result = await pool.query(`
            select source_ref, status, message_id, subject, sent_at,
                   to_addresses, cc_addresses, bcc_addresses
            from email_delivery_log
            where source_type = 'ORDER_ROUTING'
              and source_ref = any($1::text[])
            order by source_ref, created_at desc
        `, [ORDERS]);

        const latest = new Map();
        for (const row of result.rows) if (!latest.has(row.source_ref)) latest.set(row.source_ref, row);
        const checks = [];
        for (const orderCode of ORDERS) {
            const row = latest.get(orderCode);
            if (!row) {
                checks.push({ orderCode, verified: false, reason: "No WMS email delivery record" });
                continue;
            }
            if (row.status !== "SENT" || !row.message_id) {
                checks.push({ orderCode, verified: false, wmsStatus: row.status, reason: "WMS record is not SENT" });
                continue;
            }
            const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(row.message_id)}`, {
                headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
                signal: AbortSignal.timeout(30000)
            });
            const provider = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(`Resend lookup failed for ${orderCode}: ${provider.message || response.statusText}`);
            checks.push({
                orderCode,
                verified: ["delivered", "sent"].includes(String(provider.last_event || "").toLowerCase()),
                wmsStatus: row.status,
                providerEvent: provider.last_event || "unknown",
                providerCreatedAt: provider.created_at || null,
                subject: row.subject,
                envelope: {
                    toCount: Array.isArray(row.to_addresses) ? row.to_addresses.length : 0,
                    ccCount: Array.isArray(row.cc_addresses) ? row.cc_addresses.length : 0,
                    bccCount: Array.isArray(row.bcc_addresses) ? row.bcc_addresses.length : 0
                }
            });
        }
        console.log(JSON.stringify({ checks }, null, 2));
        if (checks.some((check) => !check.verified)) process.exitCode = 2;
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
