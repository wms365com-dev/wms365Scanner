const { Pool } = require("pg");

const ACCOUNT = "PURE FOODS BY ESTEE";
const REQUEST = "KIT-000030";
const TYPE = "PORTAL_KITTING_STATUS";
const DELIVERY_KEY = "KITTING-COMPLETED-KIT-000030-PURE-FOODS-20261026";

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    try {
        const [request, account, portal, preferences, delivery] = await Promise.all([
            pool.query(
                `select request_code,status,target_sku,target_quantity,completed_at,fulfillment_location_id
                 from portal_kitting_requests where request_code=$1 and account_name=$2`,
                [REQUEST, ACCOUNT]
            ),
            pool.query(
                `select id,name,is_active,email,billing_email,ap_email,portal_login_email
                 from owner_accounts where name=$1`,
                [ACCOUNT]
            ),
            pool.query(
                `select id,account_name,email,is_active from portal_vendor_access where account_name=$1`,
                [ACCOUNT]
            ),
            pool.query(
                `select email,notification_type,is_subscribed,unsubscribed_at
                 from customer_email_preferences where account_name=$1 and notification_type in ($2,'*')`,
                [ACCOUNT, TYPE]
            ),
            pool.query(
                `select status,message_id,to_addresses,cc_addresses,bcc_addresses,sent_at
                 from email_delivery_log where delivery_key=$1`,
                [DELIVERY_KEY]
            ),
        ]);
        console.log(JSON.stringify({ mode: "READ_ONLY", request: request.rows, account: account.rows,
            portal: portal.rows, preferences: preferences.rows, priorDelivery: delivery.rows }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
