const { Pool } = require("pg");

const ORDERS = ["ORD-001899", "ORD-001902", "ORD-001995", "ORD-002090"];
const EXPECTED_TO = ["shipping.receiving@nutem.com"];
const EXPECTED_CC = [
    "smit@alconatradingltd.ca",
    "d.jain@emotrans-canada.com",
    "prathab@greywolf3pl.com",
    "gworders@greywolf3pl.com"
];

function sameAddresses(actual, expected) {
    const normalize = (values) => (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim().toLowerCase()).sort();
    return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
    const pool = new Pool({ connectionString, max: 1 });
    try {
        const result = await pool.query(`
            select source_ref, status, message_id, to_addresses, cc_addresses, bcc_addresses
            from email_delivery_log
            where source_type='ORDER_ROUTING_REMINDER'
              and delivery_key like 'order-routing-reminder-2:%'
              and source_ref = any($1::text[])
            order by source_ref
        `, [ORDERS]);
        const checks = [];
        for (const row of result.rows) {
            const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(row.message_id)}`, {
                headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
                signal: AbortSignal.timeout(30000)
            });
            const provider = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(`Resend lookup failed for ${row.source_ref}`);
            checks.push({
                orderCode: row.source_ref,
                wmsStatus: row.status,
                providerEvent: provider.last_event || "unknown",
                savedToExact: sameAddresses(row.to_addresses, EXPECTED_TO),
                savedCcExact: sameAddresses(row.cc_addresses, EXPECTED_CC),
                providerToExact: sameAddresses(provider.to, EXPECTED_TO),
                providerCcExact: sameAddresses(provider.cc, EXPECTED_CC),
                toCount: Array.isArray(row.to_addresses) ? row.to_addresses.length : 0,
                ccCount: Array.isArray(row.cc_addresses) ? row.cc_addresses.length : 0,
                bccCount: Array.isArray(row.bcc_addresses) ? row.bcc_addresses.length : 0
            });
        }
        if (checks.length !== ORDERS.length
            || checks.some((row) => row.wmsStatus !== "SENT"
                || !["sent", "delivered"].includes(String(row.providerEvent).toLowerCase())
                || !row.savedToExact || !row.savedCcExact
                || !row.providerToExact || !row.providerCcExact
                || row.toCount !== 1 || row.ccCount !== 4 || row.bccCount !== 0)) {
            throw new Error("Second-reminder verification failed.");
        }
        console.log(JSON.stringify({ verified: true, checks }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
