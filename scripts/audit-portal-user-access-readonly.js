const { Pool } = require("pg");

async function main() {
    const email = String(process.argv[2] || "").trim().toLowerCase();
    if (!email || !email.includes("@")) throw new Error("Provide the portal user's email address.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const accessResult = await pool.query(
            `select p.id, p.email, p.account_name, p.is_active, p.portal_permissions,
                    p.last_login_at, p.created_at, p.updated_at,
                    o.is_active as company_active, o.wms_access_mode,
                    o.wms_subscription_status, o.feature_flags
             from portal_vendor_access p
             left join owner_accounts o on o.name=p.account_name
             where lower(p.email)=lower($1)
             limit 1`,
            [email]
        );
        if (accessResult.rowCount !== 1) {
            console.log(JSON.stringify({ email, found: false }, null, 2));
            return;
        }
        const access = accessResult.rows[0];
        const [warehousesResult, sessionsResult, resetsResult] = await Promise.all([
            pool.query(
                `select fl.id, fl.code, fl.name, fl.address1, fl.city, fl.state, fl.postal_code,
                        fl.is_active, cfl.is_primary, cfl.allow_inbound, cfl.allow_outbound,
                        cfl.allow_storage, cfl.allow_returns
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1
                 order by cfl.is_primary desc, fl.name`,
                [access.account_name]
            ),
            pool.query(
                `select count(*)::int as active_sessions, max(last_seen_at) as last_session_seen_at
                 from portal_sessions
                 where portal_access_id=$1 and expires_at>now()`,
                [access.id]
            ),
            pool.query(
                `select count(*) filter (where used_at is null and expires_at>now())::int as usable_reset_links
                 from portal_password_reset_tokens
                 where portal_access_id=$1`,
                [access.id]
            )
        ]);
        console.log(JSON.stringify({
            email: access.email,
            found: true,
            active: access.is_active,
            accountName: access.account_name,
            companyActive: access.company_active === true,
            accessMode: access.wms_access_mode || "",
            subscriptionStatus: access.wms_subscription_status || "",
            permissions: access.portal_permissions || {},
            lastLoginAt: access.last_login_at,
            activeSessions: sessionsResult.rows[0]?.active_sessions || 0,
            lastSessionSeenAt: sessionsResult.rows[0]?.last_session_seen_at || null,
            usableResetLinks: resetsResult.rows[0]?.usable_reset_links || 0,
            warehouses: warehousesResult.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
