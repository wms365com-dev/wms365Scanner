"use strict";

const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "NOMMM CANADA INC.";
const LEGAL_NAME = "NOMMM Canada Inc.";
const ACCOUNT_CODE = "NOMMM";
const EMAIL = "lisa@nommm.com";
const PHONE = "6473944809";
const WAREHOUSE_ID = 1;
const WAREHOUSE_CODE = "GW3PL-MISS";
const BINS = [
  { code: "GW3PL-NOMMM-A01", type: "STORAGE", pickable: true, note: "NOMMM dedicated pickable storage." },
  { code: "GW3PL-NOMMM-REC", type: "RECEIVING_STAGE", pickable: false, note: "NOMMM receiving stage; putaway required before allocation." },
  { code: "GW3PL-NOMMM-QA", type: "QA_HOLD", pickable: false, note: "NOMMM quality hold; unavailable for allocation." },
  { code: "GW3PL-NOMMM-DMG", type: "DAMAGED", pickable: false, note: "NOMMM damaged stock; unavailable for allocation." },
];

function connectionString() {
  return process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
}

async function inspect(client, lock = false) {
  const lockSql = lock ? " for update" : "";
  const [warehouse, duplicates, binConflicts] = await Promise.all([
    client.query(
      `select id, code, name, address1, city, state, postal_code, country, is_active
         from fulfillment_locations where id=$1 and code=$2${lockSql}`,
      [WAREHOUSE_ID, WAREHOUSE_CODE]
    ),
    client.query(
      `select name, legal_name, account_code, email
         from owner_accounts
        where upper(name)=upper($1)
           or upper(legal_name)=upper($2)
           or upper(account_code)=upper($3)
           or lower(email)=lower($4)${lockSql}`,
      [ACCOUNT, LEGAL_NAME, ACCOUNT_CODE, EMAIL]
    ),
    client.query(
      `select code, account_name, fulfillment_location_id
         from bin_locations
        where code=any($1::text[])
          and (account_name<>$2 or fulfillment_location_id<>$3)${lockSql}`,
      [BINS.map((bin) => bin.code), ACCOUNT, WAREHOUSE_ID]
    ),
  ]);
  return { warehouse: warehouse.rows[0] || null, duplicates: duplicates.rows, binConflicts: binConflicts.rows };
}

function assertPreflight(state) {
  if (!state.warehouse || !state.warehouse.is_active || state.warehouse.code !== WAREHOUSE_CODE) {
    throw new Error("Pinned Greywolf Mississauga warehouse identity is unavailable or inactive.");
  }
  if (state.duplicates.length) {
    throw new Error(`A matching company record already exists: ${state.duplicates.map((row) => row.name).join(", ")}.`);
  }
  if (state.binConflicts.length) {
    throw new Error(`Dedicated bin conflict: ${state.binConflicts.map((row) => row.code).join(", ")}.`);
  }
}

async function verify(client) {
  const [company, assignment, bins, billing, portal] = await Promise.all([
    client.query(
      `select name, legal_name, account_code, email, phone, address1, city, state, postal_code,
              country, is_active, wms_access_mode, wms_subscription_status, feature_flags
         from owner_accounts where name=$1`,
      [ACCOUNT]
    ),
    client.query(
      `select cfl.is_primary, cfl.allow_inbound, cfl.allow_outbound, cfl.allow_storage,
              cfl.allow_returns, fl.id, fl.code, fl.name, fl.is_active
         from company_fulfillment_locations cfl
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
        where cfl.account_name=$1`,
      [ACCOUNT]
    ),
    client.query(
      `select code, location_type, is_pickable, account_name, fulfillment_location_id
         from bin_locations where account_name=$1 order by code`,
      [ACCOUNT]
    ),
    client.query(
      `select account_name, customer_name, email, phone, payment_terms, currency, is_active
         from customer_billing_profiles where account_name=$1`,
      [ACCOUNT]
    ),
    client.query("select count(*)::int as count from portal_vendor_access where account_name=$1", [ACCOUNT]),
  ]);
  return {
    company: company.rows[0] || null,
    warehouseAssignments: assignment.rows,
    bins: bins.rows,
    billingProfile: billing.rows[0] || null,
    portalUsersCreated: portal.rows[0]?.count || 0,
  };
}

async function main() {
  if (!connectionString()) throw new Error("Database connection is unavailable.");
  const client = new Client({ connectionString: connectionString(), ssl: false });
  await client.connect();
  try {
    const preflight = await inspect(client, false);
    assertPreflight(preflight);
    if (!APPLY) {
      console.log(JSON.stringify({ mode: "preflight", ready: true, warehouse: preflight.warehouse, bins: BINS }, null, 2));
      return;
    }

    await client.query("begin");
    try {
      const locked = await inspect(client, true);
      assertPreflight(locked);
      const featureFlags = {
        CUSTOMER_PORTAL: true,
        ORDER_ENTRY: true,
        INBOUND_NOTICES: true,
        BILLING: true,
        STORE_INTEGRATIONS: false,
        SHOPIFY_INTEGRATION: false,
        SFTP_INTEGRATION: false,
      };
      await client.query(
        `insert into owner_accounts (
           name, legal_name, account_code, contact_name, email, phone, billing_email,
           ap_email, portal_login_email, address1, city, state, postal_code, country,
           note, is_active, feature_flags, feature_flags_updated_at, feature_flags_updated_by,
           wms_access_mode, wms_subscription_status, wms_subscription_note
         ) values (
           $1,$2,$3,'Lisa',$4,$5,$4,$4,$4,'6021 Yonge Street','Toronto','ON','M2M 3W2','Canada',
           'New customer assigned to Greywolf Mississauga.',true,$6::jsonb,now(),'WMS365 onboarding',
           'AUTO','ACTIVE','Assigned exclusively to Greywolf Mississauga warehouse.'
         )`,
        [ACCOUNT, LEGAL_NAME, ACCOUNT_CODE, EMAIL, PHONE, JSON.stringify(featureFlags)]
      );
      await client.query(
        `insert into company_fulfillment_locations (
           account_name, fulfillment_location_id, is_primary, allow_inbound,
           allow_outbound, allow_storage, allow_returns, note
         ) values ($1,$2,true,true,true,true,true,$3)`,
        [ACCOUNT, WAREHOUSE_ID, "Exclusive assignment to Greywolf Mississauga."]
      );
      for (const bin of BINS) {
        await client.query(
          `insert into bin_locations (
             code, note, location_type, is_pickable, equipment_type,
             account_name, fulfillment_location_id
           ) values ($1,$2,$3,$4,'',$5,$6)`,
          [bin.code, bin.note, bin.type, bin.pickable, ACCOUNT, WAREHOUSE_ID]
        );
      }
      await client.query(
        `insert into customer_billing_profiles (
           account_name, customer_name, billing_contact, email, phone, billing_address,
           payment_terms, currency, billing_cycle, notes, is_active
         ) values ($1,$2,'Lisa',$3,$4,$5,'Net 30','CAD','Monthly',$6,true)`,
        [ACCOUNT, LEGAL_NAME, EMAIL, PHONE, "6021 Yonge Street, Toronto, ON M2M 3W2, Canada", "Rates not yet assigned."]
      );
      await client.query(
        `insert into activity_log (type,title,details)
         values ('setup',$1,$2)`,
        [`Created customer ${ACCOUNT}`, `Assigned to ${WAREHOUSE_CODE}; created ${BINS.length} tenant-scoped bins and billing profile.`]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    const verification = await verify(client);
    console.log(JSON.stringify({ mode: "apply", created: true, verification }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }));
  process.exitCode = 1;
});
