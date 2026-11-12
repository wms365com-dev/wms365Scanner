const { Client } = require("pg");

const ACCOUNT = "SPECTRUM DYES & PIGMENTS INC.";
const ACCOUNT_ID = 3918;
const LOCATION = {
    code: "GW3PL-MEADOWPINE",
    name: "Grey Wolf 3PL & Logistics Inc - Meadowpine",
    partnerName: "Grey Wolf 3PL & Logistics Inc",
    locationType: "THIRD_PARTY_3PL",
    address1: "2425 Meadowpine Blvd",
    address2: "Unit #2",
    city: "Mississauga",
    state: "Ontario",
    postalCode: "L5N 6C3",
    country: "Canada"
};

function normalize(value) {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function locationMatches(row) {
    return row.code === LOCATION.code
        && row.name === LOCATION.name
        && row.partner_name === LOCATION.partnerName
        && row.location_type === LOCATION.locationType
        && row.address1 === LOCATION.address1
        && row.address2 === LOCATION.address2
        && row.city === LOCATION.city
        && row.state === LOCATION.state
        && normalize(row.postal_code) === normalize(LOCATION.postalCode)
        && row.country === LOCATION.country
        && row.is_active === true
        && row.is_default === false;
}

function assignmentMatches(row) {
    return row.account_name === ACCOUNT
        && row.is_primary === false
        && row.allow_inbound === true
        && row.allow_outbound === true
        && row.allow_storage === true
        && row.allow_returns === true
        && row.customer_portal_visible === true;
}

async function readState(client) {
    const account = await client.query(
        `select id,name,is_active from owner_accounts where id=$1 and name=$2`,
        [ACCOUNT_ID, ACCOUNT]
    );
    if (account.rowCount !== 1 || account.rows[0].is_active !== true) {
        throw new Error("Pinned Spectrum account identity is unavailable or inactive.");
    }

    const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema='public' and table_name='company_fulfillment_locations'
           and column_name='customer_portal_visible'`
    );
    if (columns.rowCount !== 1) throw new Error("Customer portal warehouse visibility is unavailable.");

    const locations = await client.query(
        `select * from fulfillment_locations
         where code=$1
            or (upper(address1)=upper($2) and upper(city)=upper($3)
                and regexp_replace(upper(postal_code),'[^A-Z0-9]','','g')=$4)
         order by id`,
        [LOCATION.code, LOCATION.address1, LOCATION.city, normalize(LOCATION.postalCode)]
    );
    if (locations.rowCount > 1) throw new Error("Multiple warehouse records match the Meadowpine identity.");
    const location = locations.rows[0] || null;
    let repairExistingLocation = false;
    if (location && !locationMatches(location)) {
        const existingAssignments = await client.query(
            `select account_name,is_primary,allow_inbound,allow_outbound,allow_storage,
                    allow_returns,customer_portal_visible
             from company_fulfillment_locations where fulfillment_location_id=$1 order by account_name`,
            [location.id]
        );
        repairExistingLocation = existingAssignments.rowCount === 0
            && location.code === LOCATION.code
            && location.name === LOCATION.name
            && location.partner_name === LOCATION.partnerName
            && location.location_type === LOCATION.locationType
            && location.address1 === LOCATION.address1
            && location.city === LOCATION.city
            && location.country === LOCATION.country
            && location.is_active === true
            && location.is_default === false;
        if (!repairExistingLocation) {
            throw new Error(JSON.stringify({
                error: "EXISTING_MEADOWPINE_CONFLICT",
                warehouseId: Number(location.id),
                assignmentCount: existingAssignments.rowCount
            }));
        }
    }

    const assignment = location
        ? await client.query(
            `select * from company_fulfillment_locations
             where account_name=$1 and fulfillment_location_id=$2`,
            [ACCOUNT, location.id]
        )
        : { rows: [], rowCount: 0 };
    if (assignment.rowCount > 1) throw new Error("Duplicate Spectrum warehouse assignments exist.");

    const primaries = await client.query(
        `select fl.id,fl.code,fl.contact_name,fl.contact_email,fl.contact_phone
         from company_fulfillment_locations cfl
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and cfl.is_primary=true`,
        [ACCOUNT]
    );
    if (primaries.rowCount !== 1 || primaries.rows[0].code !== "GW3PL-MISS") {
        throw new Error("Spectrum primary warehouse changed; refusing to alter assignments.");
    }
    return { location, assignment: assignment.rows[0] || null, primary: primaries.rows[0], repairExistingLocation };
}

async function visibleWarehouses(client) {
    return (await client.query(
        `select fl.id,fl.code,fl.name,fl.address1,fl.address2,fl.city,fl.state,fl.postal_code,
                cfl.is_primary,cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage,
                cfl.allow_returns,cfl.customer_portal_visible
         from company_fulfillment_locations cfl
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and fl.is_active=true and cfl.customer_portal_visible=true
         order by cfl.is_primary desc,fl.code`,
        [ACCOUNT]
    )).rows;
}

async function main() {
    const apply = process.argv.includes("--apply");
    if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("Unknown option.");
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Production database connection is unavailable.");
    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 10000 });
    await client.connect();
    try {
        await client.query(apply ? "begin" : "begin read only");
        if (apply) {
            const lock = await client.query(
                "select pg_try_advisory_xact_lock(hashtext('spectrum-meadowpine-warehouse'),3918) locked"
            );
            if (!lock.rows[0].locked) throw new Error("Another Spectrum warehouse setup is active.");
        }
        const before = await readState(client);
        if (!apply) {
            const visible = await visibleWarehouses(client);
            await client.query("rollback");
            console.log(JSON.stringify({ mode: "READ_ONLY", account: ACCOUNT, accountId: ACCOUNT_ID,
                primary: before.primary.code, meadowpineExists: Boolean(before.location),
                meadowpineAssigned: Boolean(before.assignment), addressCorrectionRequired: before.repairExistingLocation,
                customerVisibleWarehouses: visible.map((row) => row.code) }));
            return;
        }

        let locationId = before.location?.id;
        if (locationId) {
            await client.query(
                `update fulfillment_locations set
                    name=$2,partner_name=$3,location_type=$4,address1=$5,address2=$6,
                    city=$7,state=$8,postal_code=$9,country=$10,is_active=true,is_default=false,
                    contact_name=$11,contact_email=$12,contact_phone=$13,
                    note=$14,updated_at=now()
                 where id=$1`,
                [locationId, LOCATION.name, LOCATION.partnerName, LOCATION.locationType,
                    LOCATION.address1, LOCATION.address2, LOCATION.city, LOCATION.state,
                    LOCATION.postalCode, LOCATION.country,
                    before.primary.contact_name || "", before.primary.contact_email || "",
                    before.primary.contact_phone || "",
                    "Grey Wolf Meadowpine warehouse; address verified by owner on 2026-10-19."]
            );
        } else if (!locationId) {
            const inserted = await client.query(
                `insert into fulfillment_locations (
                    code,name,partner_name,location_type,address1,address2,city,state,postal_code,country,
                    contact_name,contact_email,contact_phone,note,is_active,is_default
                 ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,false)
                 returning id`,
                [LOCATION.code, LOCATION.name, LOCATION.partnerName, LOCATION.locationType,
                    LOCATION.address1, LOCATION.address2, LOCATION.city, LOCATION.state,
                    LOCATION.postalCode, LOCATION.country,
                    before.primary.contact_name || "", before.primary.contact_email || "",
                    before.primary.contact_phone || "",
                    "Grey Wolf Meadowpine warehouse; customer-visible assignment is managed per company."]
            );
            locationId = inserted.rows[0].id;
        }

        await client.query(
            `insert into company_fulfillment_locations (
                account_name,fulfillment_location_id,is_primary,allow_inbound,allow_outbound,
                allow_storage,allow_returns,customer_portal_visible,note
             ) values ($1,$2,false,true,true,true,true,true,$3)
             on conflict (account_name,fulfillment_location_id) do update set
                is_primary=false,allow_inbound=true,allow_outbound=true,allow_storage=true,
                allow_returns=true,customer_portal_visible=true,note=excluded.note,updated_at=now()`,
            [ACCOUNT, locationId, "Spectrum may select and use Meadowpine for inbound and outbound portal transactions."]
        );

        const after = await readState(client);
        const visible = await visibleWarehouses(client);
        const meadowpineVisible = visible.find((row) => Number(row.id) === Number(locationId));
        if (!after.location || !locationMatches(after.location) || !after.assignment
            || !assignmentMatches(after.assignment) || !meadowpineVisible
            || meadowpineVisible.code !== LOCATION.code || !meadowpineVisible.allow_inbound
            || !meadowpineVisible.allow_outbound
            || after.location.contact_name !== after.primary.contact_name
            || after.location.contact_email !== after.primary.contact_email
            || after.location.contact_phone !== after.primary.contact_phone) {
            throw new Error("Post-write warehouse or customer portal verification failed.");
        }
        await client.query("commit");
        console.log(JSON.stringify({ mode: "APPLIED", account: ACCOUNT, accountId: ACCOUNT_ID,
            warehouseId: Number(locationId), code: LOCATION.code, primaryPreserved: after.primary.code,
            customerPortalVisible: true, warehouseContactMatchesPrimary: true,
            customerVisibleWarehouses: visible.map((row) => row.code) }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.code || error.message || error);
    process.exitCode = 1;
});
