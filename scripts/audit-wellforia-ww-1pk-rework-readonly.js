const { Pool } = require("pg");

const ACCOUNT_SEARCH = "%WELLFORIA%";
const SOURCE_SKU = "TP-WW-6PK-UPC";
const TARGET_SKU = "WW-1PK-UPC";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const accounts = await pool.query(
            `select distinct account_name from (
                select account_name from portal_vendor_access
                union all select account_name from item_catalog
                union all select account_name from inventory_lines
                union all select account_name from company_fulfillment_locations
            ) accounts where account_name ilike $1 order by account_name`,
            [ACCOUNT_SEARCH]
        );
        const globalSkuAccounts = await pool.query(
            `select distinct account_name,sku,'ITEM' as source from item_catalog where sku=any($1::text[])
             union all
             select distinct account_name,sku,'INVENTORY' as source from inventory_lines where sku=any($1::text[])
             order by account_name,sku,source`,
            [[SOURCE_SKU, TARGET_SKU]]
        );
        if (accounts.rowCount !== 1) {
            console.log(JSON.stringify({ mode: "READ_ONLY", matchingAccounts: accounts.rows, globalSkuAccounts: globalSkuAccounts.rows }, null, 2));
            return;
        }
        const account = accounts.rows[0].account_name;
        const [items, assignments, inventory, requests, commitments, recipients] = await Promise.all([
            pool.query(
                `select sku,upc,description,tracking_level,unit_uom,units_per_case,blocked
                 from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
                [account, [SOURCE_SKU, TARGET_SKU]]
            ),
            pool.query(
                `select fl.id,fl.code,fl.name,cfl.is_primary,cfl.allow_storage
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1 and fl.is_active=true order by cfl.is_primary desc,fl.code`,
                [account]
            ),
            pool.query(
                `select i.id,i.sku,i.location,i.quantity,i.tracking_level,i.lot_number,i.expiration_date,
                        b.is_pickable,b.location_type,b.fulfillment_location_id,fl.code as warehouse_code,fl.name as warehouse_name
                 from inventory_lines i
                 left join bin_locations b on b.code=i.location
                 left join fulfillment_locations fl on fl.id=b.fulfillment_location_id
                 where i.account_name=$1 and i.sku=any($2::text[])
                 order by i.sku,b.is_pickable desc,i.quantity desc,i.id`,
                [account, [SOURCE_SKU, TARGET_SKU]]
            ),
            pool.query(
                `select request_code,status,source_sku,source_quantity,target_sku,target_quantity,
                        fulfillment_location_id,created_at,completed_at
                 from portal_kitting_requests
                 where account_name=$1 and (source_sku=any($2::text[]) or target_sku=any($2::text[]))
                 order by created_at desc limit 20`,
                [account, [SOURCE_SKU, TARGET_SKU]]
            ),
            pool.query(
                `select a.sku,a.location,sum(a.allocated_quantity)::integer as allocated_quantity,
                        string_agg(k.request_code,', ' order by k.request_code) as request_codes
                 from portal_kitting_allocations a
                 join portal_kitting_requests k on k.id=a.kitting_request_id
                 where k.account_name=$1 and k.status in ('SUBMITTED','IN_PROGRESS') and a.sku=$2
                 group by a.sku,a.location order by a.location`,
                [account, SOURCE_SKU]
            ),
            pool.query(
                `select email,'PORTAL_USER' as source from portal_vendor_access
                 where account_name=$1 and is_active=true
                 union all
                 select email,'OWNER_EMAIL' as source from owner_accounts where name=$1 and coalesce(email,'')<>''
                 union all
                 select billing_email,'BILLING_EMAIL' as source from owner_accounts where name=$1 and coalesce(billing_email,'')<>''
                 union all
                 select ap_email,'AP_EMAIL' as source from owner_accounts where name=$1 and coalesce(ap_email,'')<>''
                 union all
                 select portal_login_email,'PORTAL_LOGIN' as source from owner_accounts where name=$1 and coalesce(portal_login_email,'')<>''
                 order by email,source`,
                [account]
            )
        ]);
        console.log(JSON.stringify({
            mode: "READ_ONLY",
            account,
            sourceSku: SOURCE_SKU,
            targetSku: TARGET_SKU,
            items: items.rows,
            assignments: assignments.rows,
            inventory: inventory.rows,
            relatedKittingRequests: requests.rows,
            activeKittingCommitments: commitments.rows,
            configuredCustomerRecipients: recipients.rows,
            globalSkuAccounts: globalSkuAccounts.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
