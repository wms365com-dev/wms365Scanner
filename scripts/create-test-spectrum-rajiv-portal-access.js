const crypto = require("crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const EMAIL = "rajiv.u@spectrumpigments.com";
const EXPECTED_WAREHOUSE = "GW3PL-MISS";
const PERMISSIONS = Object.freeze({
    admin: false,
    billing: false,
    "order-entry": true,
    "inbound-entry": true,
    "inventory-only": true,
    "document-access": true
});

function hashToken(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function makeTemporaryPassword() {
    return `WMS365-${crypto.randomBytes(12).toString("base64url")}-A9!`;
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let appSessionId = null;
    let portalAccessId = null;
    let portalSessionTokenHash = "";
    try {
        const companyResult = await pool.query(
            `select name, is_active, feature_flags
             from owner_accounts where name=$1 limit 1`,
            [ACCOUNT]
        );
        const company = companyResult.rows[0];
        if (!company?.is_active || company.feature_flags?.CUSTOMER_PORTAL !== true) {
            throw new Error("Spectrum Pigments is not active for customer portal access.");
        }

        const warehouseResult = await pool.query(
            `select fl.id, fl.code, fl.name, fl.is_active, cfl.is_primary,
                    cfl.allow_inbound, cfl.allow_outbound, cfl.allow_storage
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1
             order by cfl.is_primary desc, fl.id`,
            [ACCOUNT]
        );
        if (warehouseResult.rowCount !== 1
            || warehouseResult.rows[0].code !== EXPECTED_WAREHOUSE
            || warehouseResult.rows[0].is_active !== true
            || warehouseResult.rows[0].allow_inbound !== true
            || warehouseResult.rows[0].allow_outbound !== true
            || warehouseResult.rows[0].allow_storage !== true) {
            throw new Error("Spectrum Pigments no longer has the reviewed single-warehouse assignment.");
        }

        const existingResult = await pool.query(
            "select id, account_name, is_active from portal_vendor_access where lower(email)=lower($1) limit 1",
            [EMAIL]
        );
        if (existingResult.rowCount) {
            throw new Error(`${EMAIL} already exists; refusing to reset or reassign it automatically.`);
        }

        const adminResult = await pool.query(
            `select id from app_users
             where lower(email)=lower($1) and is_active=true and role='super_admin'
             limit 1`,
            ["k.prathab@gmail.com"]
        );
        if (adminResult.rowCount !== 1) throw new Error("The authorized platform administrator was not found.");
        const appToken = crypto.randomBytes(32).toString("hex");
        const appSessionResult = await pool.query(
            `insert into app_sessions (app_user_id, token_hash, expires_at)
             values ($1,$2,now() + interval '10 minutes') returning id`,
            [adminResult.rows[0].id, hashToken(appToken)]
        );
        appSessionId = appSessionResult.rows[0].id;

        const temporaryPassword = makeTemporaryPassword();
        const createResult = await requestJson(`${API_ORIGIN}/api/admin/portal-access`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Cookie: `wms365_app_session=${encodeURIComponent(appToken)}`
            },
            body: JSON.stringify({
                accountName: ACCOUNT,
                email: EMAIL,
                password: temporaryPassword,
                isActive: true,
                sendWelcomeEmail: true,
                portalPermissions: PERMISSIONS
            })
        });
        if (!createResult.response.ok || createResult.payload.success !== true || createResult.payload.wasCreated !== true) {
            throw new Error(`Portal access creation failed (${createResult.response.status}): ${createResult.payload.error || createResult.payload.message || "request failed"}`);
        }
        portalAccessId = createResult.payload.access?.id || null;

        const loginResult = await requestJson(`${API_ORIGIN}/api/portal/login`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ email: EMAIL, password: temporaryPassword })
        });
        if (!loginResult.response.ok || loginResult.payload.success !== true) {
            throw new Error(`The new portal login test failed (${loginResult.response.status}).`);
        }
        const setCookie = loginResult.response.headers.get("set-cookie") || "";
        const portalCookie = setCookie.split(";")[0];
        const portalToken = decodeURIComponent((portalCookie.split("=")[1] || "").trim());
        if (!portalCookie.startsWith("wms365_portal_session=") || !portalToken) {
            throw new Error("The new portal login did not return a valid session cookie.");
        }
        portalSessionTokenHash = hashToken(portalToken);

        const commonHeaders = { Accept: "application/json", Cookie: portalCookie };
        const [meResult, warehouseApiResult, inventoryResult, ordersResult] = await Promise.all([
            requestJson(`${API_ORIGIN}/api/portal/me`, { headers: commonHeaders }),
            requestJson(`${API_ORIGIN}/api/portal/fulfillment-locations`, { headers: commonHeaders }),
            requestJson(`${API_ORIGIN}/api/portal/inventory?fulfillmentLocationId=${warehouseResult.rows[0].id}`, { headers: commonHeaders }),
            requestJson(`${API_ORIGIN}/api/portal/orders`, { headers: commonHeaders })
        ]);
        if (![meResult, warehouseApiResult, inventoryResult, ordersResult].every((result) => result.response.ok)) {
            throw new Error("One or more customer portal permission checks failed.");
        }
        if (meResult.payload.account?.accountName !== ACCOUNT
            || meResult.payload.account?.email !== EMAIL) {
            throw new Error("The portal session is not scoped to the expected Spectrum account.");
        }
        const returnedWarehouses = warehouseApiResult.payload.locations || [];
        if (returnedWarehouses.length !== 1 || returnedWarehouses[0].locationCode !== EXPECTED_WAREHOUSE) {
            throw new Error("The portal exposed an unexpected warehouse assignment.");
        }
        const exposedOrders = ordersResult.payload.orders || [];
        if (exposedOrders.some((order) => order.accountName !== ACCOUNT)) {
            throw new Error("The portal order list exposed another customer's order.");
        }

        const foreignDocumentResult = await pool.query(
            `select d.id
             from portal_order_documents d
             join portal_orders o on o.id=d.order_id
             where o.account_name<>$1
             order by d.id desc limit 1`,
            [ACCOUNT]
        );
        let crossCustomerDocumentBlocked = null;
        if (foreignDocumentResult.rowCount === 1) {
            const foreignResult = await requestJson(
                `${API_ORIGIN}/api/portal/order-documents/${foreignDocumentResult.rows[0].id}`,
                { headers: commonHeaders }
            );
            crossCustomerDocumentBlocked = foreignResult.response.status === 404;
            if (!crossCustomerDocumentBlocked) {
                throw new Error("The cross-customer document denial test failed.");
            }
        }

        const savedResult = await pool.query(
            `select id, account_name, email, is_active, portal_permissions, last_login_at
             from portal_vendor_access where lower(email)=lower($1) limit 1`,
            [EMAIL]
        );
        const saved = savedResult.rows[0];
        if (!saved || saved.account_name !== ACCOUNT || saved.is_active !== true) {
            throw new Error("The saved portal account did not pass final verification.");
        }
        const emailLogResult = await pool.query(
            `select status, provider, subject, message_id, sent_at
             from email_delivery_log
             where source_type='PORTAL_ACCESS' and lower(source_ref)=lower($1)
             order by id desc limit 1`,
            [EMAIL]
        );

        console.log(JSON.stringify({
            created: true,
            email: saved.email,
            accountName: saved.account_name,
            active: saved.is_active,
            permissions: saved.portal_permissions,
            warehouse: returnedWarehouses[0],
            loginTest: "PASSED",
            inventoryAccessTest: inventoryResult.response.ok ? "PASSED" : "FAILED",
            orderAccessTest: ordersResult.response.ok ? "PASSED" : "FAILED",
            crossCustomerDocumentBlocked,
            welcomeEmail: {
                attempted: createResult.payload.welcomeEmail?.attempted === true,
                sent: createResult.payload.welcomeEmail?.sent === true,
                provider: createResult.payload.welcomeEmail?.provider || "",
                deliveryLog: emailLogResult.rows[0] || null
            }
        }, null, 2));
    } finally {
        if (portalSessionTokenHash) {
            await pool.query("delete from portal_sessions where token_hash=$1", [portalSessionTokenHash]).catch(() => {});
        } else if (portalAccessId) {
            await pool.query("delete from portal_sessions where portal_access_id=$1", [portalAccessId]).catch(() => {});
        }
        if (appSessionId) await pool.query("delete from app_sessions where id=$1", [appSessionId]).catch(() => {});
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
