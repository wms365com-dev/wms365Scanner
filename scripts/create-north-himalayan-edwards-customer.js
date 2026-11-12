const { Client } = require("pg");

const ACCOUNT_NAME = "NORTH HIMALAYAN TRADERS";
const LEGAL_NAME = "North Himalayan Traders Inc.";
const WAREHOUSE_CODE = "WHS01";
const LOCATIONS = [
    { code: "WHS01-NHT-A01", type: "STORAGE", pickable: true, note: "North Himalayan Traders pickable storage." },
    { code: "WHS01-NHT-REC", type: "RECEIVING_STAGE", pickable: false, note: "North Himalayan Traders receiving stage; putaway required before allocation." },
    { code: "WHS01-NHT-INV", type: "QA_HOLD", pickable: false, note: "North Himalayan Traders investigation hold; unavailable for order allocation." },
    { code: "WHS01-NHT-DMG", type: "DAMAGED", pickable: false, note: "North Himalayan Traders damaged stock; unavailable for order allocation." }
];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");

    try {
        const duplicateResult = await client.query(
            `select name, legal_name, email, portal_login_email
             from owner_accounts
             where upper(name) like '%NORTH HIMALAYAN%'
                or upper(legal_name) like '%NORTH HIMALAYAN%'
                or lower(email) in ('info@northhimalayantraders.com', 'atif.raza55@yahoo.com')
                or lower(portal_login_email) = 'info@northhimalayantraders.com'
             for update`
        );
        if (duplicateResult.rowCount > 0) {
            throw new Error(`A matching company already exists: ${duplicateResult.rows.map((row) => row.name).join(", ")}.`);
        }

        const warehouseResult = await client.query(
            `select * from fulfillment_locations
             where code = $1 and is_active = true
             limit 1
             for update`,
            [WAREHOUSE_CODE]
        );
        const warehouse = warehouseResult.rows[0];
        if (!warehouse || !/EDWARD/i.test(String(warehouse.name || ""))) {
            throw new Error("The active Edwards warehouse could not be verified as WHS01.");
        }

        const locationConflictResult = await client.query(
            `select code, account_name, fulfillment_location_id
             from bin_locations
             where code = any($1::text[])
               and (account_name <> $2 or fulfillment_location_id <> $3)
             for update`,
            [LOCATIONS.map((entry) => entry.code), ACCOUNT_NAME, warehouse.id]
        );
        if (locationConflictResult.rowCount > 0) {
            throw new Error(`Dedicated location conflict: ${locationConflictResult.rows.map((row) => row.code).join(", ")}.`);
        }

        const featureFlags = {
            CUSTOMER_PORTAL: true,
            ORDER_ENTRY: true,
            INBOUND_NOTICES: true,
            BILLING: true,
            STORE_INTEGRATIONS: false,
            SHOPIFY_INTEGRATION: false,
            SFTP_INTEGRATION: false
        };
        await client.query(
            `insert into owner_accounts (
                name, legal_name, account_code, contact_name, contact_title,
                email, phone, website, billing_email, ap_email, portal_login_email,
                address1, city, state, postal_code, country, note, is_active,
                feature_flags, feature_flags_updated_at, feature_flags_updated_by,
                wms_access_mode, wms_subscription_status, wms_subscription_note
             ) values (
                $1,$2,'NHT','Atif Raza','Director',
                'info@northhimalayantraders.com','+1 416-822-1904','https://www.northhimalayantraders.com',
                'atif.raza55@yahoo.com','atif.raza55@yahoo.com','info@northhimalayantraders.com',
                '388 Hepatica Way','Orleans','ON','K4A 0Z1','Canada',$3,true,
                $4::jsonb,now(),'WMS365 onboarding',
                'AUTO','ACTIVE','Customer assigned exclusively to Grey Wolf Edwards Warehouse.'
             )`,
            [
                ACCOUNT_NAME,
                LEGAL_NAME,
                "Livestock salts. HST/GST 738903632RT0001. Credit application signed 2026-08-17; requested credit limit CAD 1,000 remains subject to approval.",
                JSON.stringify(featureFlags)
            ]
        );

        await client.query(
            `insert into company_fulfillment_locations (
                account_name, fulfillment_location_id, is_primary,
                allow_inbound, allow_outbound, allow_storage, allow_returns, note
             ) values ($1,$2,true,true,true,true,true,$3)`,
            [ACCOUNT_NAME, warehouse.id, "Exclusive company assignment to Grey Wolf Edwards Warehouse."]
        );

        for (const location of LOCATIONS) {
            await client.query(
                `insert into bin_locations (
                    code, note, location_type, is_pickable, equipment_type,
                    account_name, fulfillment_location_id
                 ) values ($1,$2,$3,$4,'',$5,$6)
                 on conflict (code) do update set
                    note = excluded.note,
                    location_type = excluded.location_type,
                    is_pickable = excluded.is_pickable,
                    account_name = excluded.account_name,
                    fulfillment_location_id = excluded.fulfillment_location_id,
                    updated_at = now()`,
                [location.code, location.note, location.type, location.pickable, ACCOUNT_NAME, warehouse.id]
            );
        }

        await client.query(
            `insert into activity_log (type, title, details)
             values ('setup', $1, $2)`,
            [
                `Created customer ${ACCOUNT_NAME}`,
                `Assigned only to ${warehouse.name} (${warehouse.code}); created ${LOCATIONS.length} dedicated customer locations.`
            ]
        );
        await client.query("commit");

        console.log(JSON.stringify({
            ok: true,
            accountName: ACCOUNT_NAME,
            legalName: LEGAL_NAME,
            warehouse: {
                id: String(warehouse.id),
                code: warehouse.code,
                name: warehouse.name,
                address: [warehouse.address1, warehouse.city, warehouse.state, warehouse.postal_code, warehouse.country].filter(Boolean).join(", ")
            },
            locations: LOCATIONS,
            portalUserCreated: false
        }, null, 2));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
