const { Client } = require("pg");
const {
    getPortalFulfillmentLocationsForAccount,
    getPortalInventorySummary
} = require("../server");

const ACCOUNT = "PURE FOODS BY ESTEE";
const PORTAL_WAREHOUSE_CODE = "GW3PL-MISS";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        await client.query("begin transaction read only");
        const assignments = (await client.query(
            `select cfl.account_name,cfl.fulfillment_location_id,cfl.is_primary,
                    cfl.allow_inbound,cfl.allow_outbound,cfl.allow_storage,
                    cfl.customer_portal_visible,cfl.portal_inventory_rollup_location_id,
                    fl.code,fl.name,fl.address1,fl.city,fl.state
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 order by cfl.is_primary desc,fl.code`,
            [ACCOUNT]
        )).rows;
        const stock = (await client.query(
            `select fl.id as fulfillment_location_id,fl.code,fl.name,
                    count(distinct i.sku)::integer as sku_count,
                    coalesce(sum(case when coalesce(bl.is_pickable,true)=true
                        and coalesce(bl.location_type,'STORAGE') not in ('INVESTIGATION','DAMAGED','QUARANTINE','HOLD','QC_HOLD','RECEIVING','STAGING')
                        then i.quantity else 0 end),0)::integer as pickable_quantity
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             left join inventory_lines i on i.account_name=cfl.account_name
                and (upper(i.location)=upper(fl.code) or upper(i.location) like upper(fl.code)||'-%')
             left join bin_locations bl on bl.code=i.location
             where cfl.account_name=$1
             group by fl.id,fl.code,fl.name order by fl.code`,
            [ACCOUNT]
        )).rows;
        const users = (await client.query(
            `select email,is_active from portal_vendor_access where account_name=$1 order by email`,
            [ACCOUNT]
        )).rows;
        const portalLocations = await getPortalFulfillmentLocationsForAccount(client, ACCOUNT);
        const portalWarehouse = portalLocations.find((row) => row.locationCode === PORTAL_WAREHOUSE_CODE);
        if (!portalWarehouse || portalLocations.length !== 1) {
            throw new Error(`Expected only ${PORTAL_WAREHOUSE_CODE} in the Pure Foods customer portal.`);
        }
        const portalInventory = await getPortalInventorySummary(ACCOUNT, client, {
            fulfillmentLocationId: portalWarehouse.fulfillmentLocationId
        });
        const invalidAvailability = portalInventory.filter((item) => (
            !Array.isArray(item.warehouseAvailability)
            || item.warehouseAvailability.length !== 1
            || String(item.warehouseAvailability[0].fulfillmentLocationId) !== String(portalWarehouse.fulfillmentLocationId)
        ));
        const exposedEdwardsBins = portalInventory.flatMap((item) => item.locations || [])
            .filter((location) => /^WHS01(?:-|$)/i.test(String(location)));
        const mississauga = assignments.find((row) => row.code === PORTAL_WAREHOUSE_CODE);
        const invalidAssignments = assignments.filter((row) => row.code === PORTAL_WAREHOUSE_CODE
            ? row.customer_portal_visible !== true || row.is_primary !== true || row.portal_inventory_rollup_location_id !== null
            : row.customer_portal_visible !== false
                || String(row.portal_inventory_rollup_location_id) !== String(mississauga?.fulfillment_location_id));
        if (invalidAssignments.length || invalidAvailability.length || exposedEdwardsBins.length) {
            throw new Error("Pure Foods customer-facing inventory pool verification failed.");
        }
        console.log(JSON.stringify({
            mode: "READ_ONLY_VERIFIED",
            account: ACCOUNT,
            assignments,
            stock,
            portalUsers: users,
            portalLocations,
            portalInventory: {
                skuCount: portalInventory.length,
                pooledSkuCount: portalInventory.filter((item) => item.warehouseAvailability?.[0]?.pooledInventory === true).length,
                onHandQuantity: portalInventory.reduce((sum, item) => sum + Number(item.onHandQuantity || 0), 0),
                reservedQuantity: portalInventory.reduce((sum, item) => sum + Number(item.reservedQuantity || 0), 0),
                availableQuantity: portalInventory.reduce((sum, item) => sum + Number(item.availableQuantity || 0), 0),
                exposedEdwardsBins
            }
        }, null, 2));
        await client.query("rollback");
    } catch (error) {
        try { await client.query("rollback"); } catch {}
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
