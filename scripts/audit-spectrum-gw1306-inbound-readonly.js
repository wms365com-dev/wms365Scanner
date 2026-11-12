const { Pool } = require("pg");

const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const REFERENCE = "GW/1306/26";
const CANDIDATE_SKUS = [
    "SPECTRUM BLUE 1003",
    "SPECTRUM RED 2 DCI",
    "SPECTRUM VIOLET 23 BL SI 3672",
    "BLUE 15-3 1003",
    "RED 2",
    "VIOLET 23 BL SI 3672"
];

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    try {
        const [company, items, inbounds, warehouses, stageBins] = await Promise.all([
            pool.query(
                `select name, legal_name, is_active, feature_flags
                 from owner_accounts where name=$1`,
                [ACCOUNT]
            ),
            pool.query(
                `select id, sku, upc, description, tracking_level, uom_label, unit_uom,
                        units_per_case, lot_tracked, expiration_tracked, blocked
                 from item_catalog
                 where account_name=$1
                   and (sku=any($2::text[]) or description ilike any($3::text[]))
                 order by sku`,
                [ACCOUNT, CANDIDATE_SKUS, ["%BLUE 15%", "%PIGMENT RED 2%", "%VIOLET 23%"]]
            ),
            pool.query(
                `select id, inbound_code, status, reference_number, expected_date,
                        fulfillment_location_id, notes
                 from portal_inbounds
                 where account_name=$1
                   and (upper(reference_number)=upper($2) or upper(notes) like '%GW/1306/26%')
                 order by id`,
                [ACCOUNT, REFERENCE]
            ),
            pool.query(
                `select fl.id, fl.code, fl.name, fl.is_active, cfl.is_primary,
                        cfl.allow_inbound, cfl.allow_storage
                 from company_fulfillment_locations cfl
                 join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
                 where cfl.account_name=$1
                 order by cfl.is_primary desc, fl.id`,
                [ACCOUNT]
            ),
            pool.query(
                `select code, location_type, is_pickable, account_name, fulfillment_location_id
                 from bin_locations
                 where fulfillment_location_id=1
                   and (account_name=$1 or account_name='')
                   and location_type in ('RECEIVING_STAGE','STORAGE')
                 order by (location_type='RECEIVING_STAGE') desc, code
                 limit 30`,
                [ACCOUNT]
            )
        ]);
        console.log(JSON.stringify({
            company: company.rows[0] || null,
            matchingItems: items.rows,
            duplicateInbounds: inbounds.rows,
            warehouses: warehouses.rows,
            candidateBins: stageBins.rows
        }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
