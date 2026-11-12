const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const ACCOUNT = "EXIM WORLD CONNECT INC.";
const EMAIL = "mynurrashid@eximworldconnect.com";
const SESSION_FILE = path.join(__dirname, "..", ".tmp", "exim-outbound-guide-session.json");

function databaseUrl() {
    return process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
}

async function main() {
    if (!databaseUrl()) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString: databaseUrl(), ssl: false });
    const client = await pool.connect();
    try {
        const accessResult = await client.query(
            `select id, account_name, email, is_active, portal_permissions
             from portal_vendor_access
             where account_name = $1 and lower(email) = lower($2)
             limit 1`,
            [ACCOUNT, EMAIL]
        );
        if (accessResult.rowCount !== 1) throw new Error("EXIM portal user was not found.");
        const access = accessResult.rows[0];
        if (!access.is_active) throw new Error("EXIM portal user is inactive.");

        const itemResult = await client.query(
                `select sku, description, tracking_level, coalesce(unit_uom, '') as unit_uom
                 from item_catalog
                 where account_name = $1
                 order by sku`,
                [ACCOUNT]
            );
        const inventoryResult = await client.query(
                `select i.sku, i.location, i.quantity, i.tracking_level,
                        coalesce(b.is_pickable, true) as is_pickable,
                        coalesce(b.location_type, 'STORAGE') as location_type
                 from inventory_lines i
                 left join bin_locations b on b.code = i.location
                 where i.account_name = $1
                 order by i.sku, i.location`,
                [ACCOUNT]
            );
        const warehouseResult = await client.query(
                `select fl.id, fl.code, fl.name, fl.city, fl.state
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id = cfl.fulfillment_location_id
                 where cfl.account_name = $1 and fl.is_active = true
                 order by fl.name`,
                [ACCOUNT]
            );

        const availableBySku = new Map();
        for (const row of inventoryResult.rows) {
            if (!row.is_pickable || ["HOLD", "INVESTIGATION", "DAMAGED", "QUARANTINE"].includes(String(row.location_type).toUpperCase())) continue;
            availableBySku.set(row.sku, (availableBySku.get(row.sku) || 0) + Number(row.quantity || 0));
        }

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
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
            expiresAt
        }), { mode: 0o600 });

        console.log(JSON.stringify({
            accountName: ACCOUNT,
            email: EMAIL,
            active: access.is_active,
            warehouses: warehouseResult.rows,
            items: itemResult.rows.map((row) => ({
                ...row,
                availablePickable: availableBySku.get(row.sku) || 0
            })),
            inventoryLines: inventoryResult.rows,
            guideSessionCreated: true,
            guideSessionExpiresAt: expiresAt
        }, null, 2));
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
