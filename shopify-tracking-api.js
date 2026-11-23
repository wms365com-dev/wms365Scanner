"use strict";

const crypto = require("node:crypto");

function decrypt(value, env = process.env) {
    if (!value || !String(value).startsWith("enc:v1:")) return value || "";
    const secret = (env.INTEGRATION_SECRET_KEY || env.APP_SECRET || env.SESSION_SECRET || "").trim();
    if (!secret) throw new Error("INTEGRATION_KEY_REQUIRED");
    const parts = value.split(":");
    if (parts.length !== 5) throw new Error("INVALID_ENCRYPTED_CREDENTIAL");
    const cipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), Buffer.from(parts[2], "base64"));
    cipher.setAuthTag(Buffer.from(parts[3], "base64"));
    return Buffer.concat([cipher.update(Buffer.from(parts[4], "base64")), cipher.final()]).toString("utf8");
}

function createShopifyTrackingApi({ fetchImpl = fetch, env = process.env } = {}) {
    const cache = new Map();
    const verified = new Set();
    async function token(row) {
        if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(row.store_identifier)) throw new Error("STORE_HOST_RESTRICTED");
        const key = `${row.id}:${row.store_identifier}`;
        if (cache.get(key)?.expires > Date.now() + 60000) return cache.get(key).token;
        let access = decrypt(row.access_token, env);
        let expires = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : Infinity;
        if (!access || expires <= Date.now() + 60000) {
            const response = await fetchImpl(`https://${row.store_identifier}/admin/oauth/access_token`, {
                method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
                headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials",
                    client_id: row.auth_client_id, client_secret: decrypt(row.auth_client_secret, env) })
            });
            const data = await response.json();
            if (!response.ok || !data.access_token || !Number.isFinite(data.expires_in)) throw new Error("SHOPIFY_AUTH_UNAVAILABLE");
            access = data.access_token; expires = Date.now() + data.expires_in * 1000;
        }
        cache.set(key, { token: access, expires });
        return access;
    }
    async function request(row, suffix, options = {}) {
        if (suffix !== "/graphql.json") throw new Error("TRACKING_API_PATH_RESTRICTED");
        const access = await token(row);
        const response = await fetchImpl(`https://${row.store_identifier}/admin/api/2026-07/graphql.json`, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": access }, body: JSON.stringify(options.body)
        });
        const payload = await response.json();
        if (!response.ok || payload.errors?.length || !payload.data) throw new Error("SHOPIFY_TRACKING_REQUEST_FAILED");
        return { payload };
    }
    async function verify(row) {
        const key = `${row.id}:${row.store_identifier}`;
        if (verified.has(key)) return;
        const result = await request(row, "/graphql.json", { body: { query: `query TrackingPermission {
            shop { id myshopifyDomain } currentAppInstallation { accessScopes { handle } }
        }` } });
        const data = result.payload.data;
        if (data.shop?.myshopifyDomain !== row.store_identifier) throw new Error("SHOPIFY_STORE_OWNERSHIP_MISMATCH");
        if (!data.currentAppInstallation?.accessScopes?.some((s) => s.handle === "write_fulfillments")) throw new Error("WRITE_FULFILLMENTS_REQUIRED");
        verified.add(key);
    }
    return { request, verify };
}

module.exports = { decrypt, createShopifyTrackingApi };
