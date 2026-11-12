const crypto = require("crypto");
const { Pool } = require("pg");

function readEnv(name) {
    return String(process.env[name] || "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

function encryptSecret(value, secretKey) {
    const plaintext = String(value || "");
    if (!plaintext) return "";
    const key = crypto.createHash("sha256").update(secretKey).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

async function readCredentials() {
    return new Promise((resolve, reject) => {
        let buffer = "";
        const rawModeSupported = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
        const cleanup = () => {
            process.stdin.off("data", onData);
            process.stdin.off("error", onError);
            if (rawModeSupported) process.stdin.setRawMode(false);
            process.stdin.pause();
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onData = (chunk) => {
            buffer += chunk.toString("utf8").replace(/\r/g, "\n");
            const lines = buffer.split("\n").filter((line) => line.length > 0);
            if (lines.length < 2) return;
            cleanup();
            resolve({ clientId: lines[0].trim(), clientSecret: lines[1].trim() });
        };
        if (rawModeSupported) process.stdin.setRawMode(true);
        process.stdin.on("data", onData);
        process.stdin.on("error", onError);
        process.stdin.resume();
    });
}

async function main() {
    const shop = String(process.argv[2] || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
        throw new Error("Usage: node scripts/configure-shopify-client-credentials.js store.myshopify.com");
    }
    const databaseUrl = readEnv("DATABASE_PRIVATE_URL") || readEnv("DATABASE_URL");
    const secretKey = readEnv("INTEGRATION_SECRET_KEY") || readEnv("APP_SECRET") || readEnv("SESSION_SECRET");
    if (!databaseUrl || !secretKey) throw new Error("Production database or integration encryption configuration is unavailable.");

    const { clientId, clientSecret } = await readCredentials();
    if (!clientId || !clientSecret) throw new Error("Both Shopify client ID and client secret are required on stdin.");

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret
        }),
        signal: AbortSignal.timeout(30000)
    });
    const tokenPayload = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenPayload?.access_token) {
        throw new Error(`Shopify rejected the credentials (${tokenResponse.status}): ${tokenPayload?.error_description || tokenPayload?.error || "No token returned"}`);
    }
    const accessToken = String(tokenPayload.access_token);
    const scopeResponse = await fetch(`https://${shop}/admin/oauth/access_scopes.json`, {
        headers: { Accept: "application/json", "X-Shopify-Access-Token": accessToken },
        signal: AbortSignal.timeout(30000)
    });
    const scopePayload = await scopeResponse.json().catch(() => ({}));
    if (!scopeResponse.ok) {
        throw new Error(`Shopify scope verification failed (${scopeResponse.status}).`);
    }
    const grantedScopes = Array.isArray(scopePayload?.access_scopes)
        ? scopePayload.access_scopes.map((entry) => String(entry?.handle || "")).filter(Boolean).sort()
        : [];
    if (!grantedScopes.length) {
        throw new Error("Shopify issued a token but no merchant-approved scopes are active. Install or update the published app on the store first.");
    }

    const expiresInSeconds = Number(tokenPayload.expires_in) || 86399;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    const pool = new Pool({
        connectionString: databaseUrl,
        ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? false : { rejectUnauthorized: false }
    });
    try {
        const result = await pool.query(
            `update store_integrations
             set auth_client_id = $2,
                 auth_client_secret = $3,
                 access_token = $4,
                 access_token_expires_at = $5,
                 is_active = true,
                 updated_at = now()
             where provider = 'SHOPIFY' and lower(store_identifier) = $1
             returning id, account_name`,
            [shop, clientId, encryptSecret(clientSecret, secretKey), encryptSecret(accessToken, secretKey), expiresAt]
        );
        if (result.rowCount !== 1) throw new Error(`Expected one WMS365 Shopify integration for ${shop}, found ${result.rowCount}.`);
        console.log(JSON.stringify({
            ok: true,
            shop,
            integrationId: result.rows[0].id,
            accountName: result.rows[0].account_name,
            grantedScopes
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
