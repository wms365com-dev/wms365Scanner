const crypto = require("crypto");
const { Pool } = require("pg");

const SHOP = "f1acxk-dc.myshopify.com";

function readEnv(name) {
    return String(process.env[name] || "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

function decryptSecret(value, secretKey) {
    const text = String(value || "");
    if (!text || !text.startsWith("enc:v1:")) return text;
    if (!secretKey) throw new Error("Integration encryption key is unavailable.");
    const [, version, ivText, tagText, ciphertextText] = text.split(":");
    if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
        throw new Error("Encrypted integration credential is malformed.");
    }
    const key = crypto.createHash("sha256").update(secretKey).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64")),
        decipher.final()
    ]).toString("utf8");
}

async function testSavedToken(accessToken) {
    if (!accessToken) return { present: false, usable: false, status: null };
    const response = await fetch(`https://${SHOP}/admin/oauth/access_scopes.json`, {
        headers: { Accept: "application/json", "X-Shopify-Access-Token": accessToken },
        signal: AbortSignal.timeout(30000)
    });
    return { present: true, usable: response.ok, status: response.status };
}

async function testClientCredentials(clientId, clientSecret) {
    if (!clientId || !clientSecret) return { present: false, usable: false, status: null };
    const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret
        }),
        signal: AbortSignal.timeout(30000)
    });
    return { present: true, usable: response.ok, status: response.status };
}

async function main() {
    const databaseUrl = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL");
    const secretKey = readEnv("INTEGRATION_SECRET_KEY") || readEnv("APP_SECRET") || readEnv("SESSION_SECRET");
    if (!databaseUrl || !secretKey) throw new Error("Production integration configuration is unavailable.");
    const pool = new Pool({
        connectionString: databaseUrl,
        ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? false : { rejectUnauthorized: false }
    });
    try {
        const result = await pool.query(
            `select id, account_name, store_identifier, access_token, access_token_expires_at,
                    auth_client_id, auth_client_secret, is_active, import_status,
                    last_synced_at, last_sync_status, last_sync_message, updated_at
             from store_integrations
             where provider = 'SHOPIFY' and lower(store_identifier) = $1
             order by updated_at desc`,
            [SHOP]
        );
        const integrations = [];
        for (const row of result.rows) {
            const accessToken = decryptSecret(row.access_token || "", secretKey);
            const clientSecret = decryptSecret(row.auth_client_secret || "", secretKey);
            const [savedToken, clientCredentials] = await Promise.all([
                testSavedToken(accessToken),
                testClientCredentials(String(row.auth_client_id || "").trim(), clientSecret)
            ]);
            integrations.push({
                id: row.id,
                accountName: row.account_name,
                storeIdentifier: row.store_identifier,
                isActive: row.is_active === true,
                importStatus: row.import_status,
                accessTokenExpiresAt: row.access_token_expires_at,
                savedToken,
                clientCredentials,
                lastSyncedAt: row.last_synced_at,
                lastSyncStatus: row.last_sync_status,
                lastSyncMessage: row.last_sync_message,
                updatedAt: row.updated_at
            });
        }
        console.log(JSON.stringify({ shop: SHOP, integrationCount: integrations.length, integrations }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
