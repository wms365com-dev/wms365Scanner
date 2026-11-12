const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const ACCOUNT = "NORTH HIMALAYAN TRADERS";
const EMAIL = "info@northhimalayantraders.com";
const SESSION_FILE = path.join(__dirname, "..", ".tmp", "nht-order-guide-session.json");

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        const accessResult = await client.query(
            `select id, account_name, email, is_active, portal_permissions
             from portal_vendor_access
             where account_name = $1 and lower(email) = lower($2)
             limit 1`,
            [ACCOUNT, EMAIL]
        );
        if (accessResult.rowCount !== 1) throw new Error("North Himalayan Traders portal user was not found.");
        const access = accessResult.rows[0];
        if (!access.is_active) throw new Error("North Himalayan Traders portal user is inactive.");
        if (access.portal_permissions?.["order-entry"] !== true) throw new Error("North Himalayan Traders user does not have order-entry permission.");

        const warehouseResult = await client.query(
            `select fl.id, fl.code, fl.name, fl.city, fl.state
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id
             where cfl.account_name = $1 and fl.is_active = true
             order by fl.name`,
            [ACCOUNT]
        );
        if (warehouseResult.rowCount !== 1 || warehouseResult.rows[0].code !== "WHS01") {
            throw new Error("North Himalayan Traders is not isolated to the Edwards warehouse.");
        }

        const itemResult = await client.query(
            `select sku, description, tracking_level, coalesce(unit_uom, '') as unit_uom
             from item_catalog
             where account_name = $1
             order by sku`,
            [ACCOUNT]
        );
        if (!itemResult.rowCount) throw new Error("North Himalayan Traders has no items configured.");

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const expiresAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
        const sessionResult = await client.query(
            `insert into portal_sessions (portal_access_id, token_hash, expires_at)
             values ($1, $2, $3)
             returning id`,
            [access.id, tokenHash, expiresAt]
        );

        fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
        fs.writeFileSync(SESSION_FILE, JSON.stringify({
            token,
            tokenHash,
            sessionId: String(sessionResult.rows[0].id),
            accountName: ACCOUNT,
            email: EMAIL,
            expiresAt,
            exampleSku: itemResult.rows[0].sku,
            exampleDescription: itemResult.rows[0].description
        }), { mode: 0o600 });

        console.log(JSON.stringify({
            accountName: ACCOUNT,
            email: EMAIL,
            warehouse: warehouseResult.rows[0],
            exampleItem: itemResult.rows[0],
            itemCount: itemResult.rowCount,
            guideSessionCreated: true,
            guideSessionExpiresAt: expiresAt
        }, null, 2));
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
