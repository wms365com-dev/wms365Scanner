"use strict";

const { Client } = require("pg");

const ACCOUNT = "NOMMM CANADA INC.";

async function main() {
  const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database connection is unavailable.");
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  try {
    await client.query("begin read only");
    const company = await client.query(
      `select name,is_active,email,feature_flags
         from owner_accounts
        where name=$1`,
      [ACCOUNT]
    );
    if (company.rowCount !== 1 || company.rows[0].is_active !== true) {
      throw new Error("Exact active NOMMM tenant verification failed.");
    }
    const integrations = await client.query(
      `select id,provider,integration_name,store_identifier,is_active,sync_schedule,
              nullif(access_token,'') is not null as has_access_token,
              settings,last_sync_status,last_sync_message
         from store_integrations
        where account_name=$1
        order by id`,
      [ACCOUNT]
    );
    const requests = await client.query(
      `select id,integration_id,recipient_email,purpose,expires_at,used_at,created_at
         from integration_credential_requests
        where account_name=$1
        order by id desc
        limit 10`,
      [ACCOUNT]
    );
    console.log(JSON.stringify({
      account: {
        name: company.rows[0].name,
        active: company.rows[0].is_active,
        email: company.rows[0].email,
        featureFlags: company.rows[0].feature_flags
      },
      integrations: integrations.rows,
      credentialRequests: requests.rows
    }, null, 2));
    await client.query("rollback");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
