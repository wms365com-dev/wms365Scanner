const crypto = require("crypto");
const { Pool } = require("pg");

const API_ORIGIN = "https://app.wms365.co";
const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const EMAIL = "rajiv.u@spectrumpigments.com";
const EXPECTED_WAREHOUSE = "GW3PL-MISS";

function hashToken(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

async function request(url, cookie) {
    const response = await fetch(url, {
        headers: { Accept: "application/json", Cookie: cookie },
        signal: AbortSignal.timeout(30000)
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : null;
    return { response, payload };
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    let sessionId = null;
    try {
        const accessResult = await pool.query(
            `select id, account_name, email, is_active, portal_permissions, last_login_at
             from portal_vendor_access where lower(email)=lower($1) limit 1`,
            [EMAIL]
        );
        const access = accessResult.rows[0];
        if (!access || !access.is_active || access.account_name !== ACCOUNT) {
            throw new Error("Rajiv's Spectrum portal account is not active and correctly scoped.");
        }
        const token = crypto.randomBytes(32).toString("hex");
        const sessionResult = await pool.query(
            `insert into portal_sessions (portal_access_id, token_hash, expires_at)
             values ($1,$2,now() + interval '5 minutes') returning id`,
            [access.id, hashToken(token)]
        );
        sessionId = sessionResult.rows[0].id;
        const cookie = `wms365_portal_session=${encodeURIComponent(token)}`;

        const [me, warehouses, inventory, orders] = await Promise.all([
            request(`${API_ORIGIN}/api/portal/me`, cookie),
            request(`${API_ORIGIN}/api/portal/fulfillment-locations`, cookie),
            request(`${API_ORIGIN}/api/portal/inventory?fulfillmentLocationId=1`, cookie),
            request(`${API_ORIGIN}/api/portal/orders`, cookie)
        ]);
        if (![me, warehouses, inventory, orders].every((result) => result.response.ok)) {
            throw new Error("A Spectrum portal feature test failed.");
        }
        if (me.payload?.account?.accountName !== ACCOUNT || me.payload?.account?.email !== EMAIL) {
            throw new Error("The portal session exposed the wrong customer account.");
        }
        const locationRows = warehouses.payload?.locations || [];
        if (locationRows.length !== 1 || locationRows[0].locationCode !== EXPECTED_WAREHOUSE) {
            throw new Error("The portal exposed the wrong warehouse scope.");
        }
        const orderRows = orders.payload?.orders || [];
        if (orderRows.some((order) => order.accountName !== ACCOUNT)) {
            throw new Error("The order API exposed another customer's data.");
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
            const foreignDocument = await request(
                `${API_ORIGIN}/api/portal/order-documents/${foreignDocumentResult.rows[0].id}`,
                cookie
            );
            crossCustomerDocumentBlocked = foreignDocument.response.status === 404;
            if (!crossCustomerDocumentBlocked) throw new Error("Cross-customer document access was not blocked.");
        }

        const emailResult = await pool.query(
            `select status, provider, subject, message_id, sent_at, error_message
             from email_delivery_log
             where source_type='PORTAL_ACCESS' and lower(source_ref)=lower($1)
             order by id desc limit 1`,
            [EMAIL]
        );
        const email = emailResult.rows[0] || null;
        if (!email || email.status !== "SENT") throw new Error("The portal welcome email does not have a successful delivery record.");

        console.log(JSON.stringify({
            email: access.email,
            accountName: access.account_name,
            active: access.is_active,
            permissions: access.portal_permissions,
            lastLoginAt: access.last_login_at,
            warehouse: locationRows[0],
            checks: {
                accountScope: "PASSED",
                warehouseScope: "PASSED",
                inventoryAccess: "PASSED",
                orderAccess: "PASSED",
                crossCustomerDocumentBlocked
            },
            welcomeEmail: email
        }, null, 2));
    } finally {
        if (sessionId) await pool.query("delete from portal_sessions where id=$1", [sessionId]).catch(() => {});
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
