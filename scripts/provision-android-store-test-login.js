const crypto = require("node:crypto");
const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");

const EMAIL = "android-store-test@wms365.invalid";
const ACCOUNT_ID = 1510;
const ACCOUNT_NAME = "CODEX PORTAL SYSTEM TEST";
const APPLY = process.argv.includes("--apply");
const DISABLE = process.argv.includes("--disable");

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${derived}`;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    if (APPLY === DISABLE) throw new Error("Use exactly one of --apply or --disable.");
    const password = String(process.env.ANDROID_STORE_TEST_PASSWORD || "");
    if (APPLY && password.length < 20) throw new Error("A strong temporary password is required.");

    const client = new Client({ connectionString });
    await client.connect();
    try {
        await client.query("begin");
        const company = await requireDesignatedTestCompany(client);
        if (Number(company.id) !== ACCOUNT_ID || company.name !== ACCOUNT_NAME) {
            throw new Error("Pinned test-company identity mismatch.");
        }

        const existing = await client.query("select id from app_users where email=$1 limit 1", [EMAIL]);
        let userId = existing.rows[0]?.id;
        if (DISABLE) {
            if (userId) {
                await client.query("update app_users set is_active=false, updated_at=now() where id=$1", [userId]);
                await client.query("delete from app_sessions where app_user_id=$1", [userId]);
            }
        } else if (userId) {
            await client.query(
                `update app_users set password_hash=$2, full_name='Android Store Test',
                    role='warehouse_admin', is_active=true, updated_at=now() where id=$1`,
                [userId, hashPassword(password)]
            );
        } else {
            const inserted = await client.query(
                `insert into app_users(email,password_hash,full_name,role,is_active)
                 values($1,$2,'Android Store Test','warehouse_admin',true) returning id`,
                [EMAIL, hashPassword(password)]
            );
            userId = inserted.rows[0].id;
        }

        if (userId) {
            await client.query("delete from app_user_company_access where app_user_id=$1", [userId]);
            await client.query("delete from app_user_fulfillment_location_access where app_user_id=$1", [userId]);
            if (!DISABLE) {
                await client.query(
                    "insert into app_user_company_access(app_user_id,account_name) values($1,$2)",
                    [userId, ACCOUNT_NAME]
                );
            }
        }

        await client.query("commit");
        console.log(JSON.stringify({
            mode: DISABLE ? "DISABLED" : "APPLIED",
            email: EMAIL,
            accountId: ACCOUNT_ID,
            accountName: ACCOUNT_NAME,
            role: "warehouse_admin",
            active: !DISABLE,
            externalEmailsSent: 0
        }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
