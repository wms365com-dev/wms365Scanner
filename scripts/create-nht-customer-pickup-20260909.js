const { Client } = require("pg");
const { APP_USER_ROLES, savePortalOrderDraftForAccount } = require("../server");

const ACCOUNT = "NORTH HIMALAYAN TRADERS";
const WAREHOUSE_ID = 143;
const REFERENCE = "NHT-PICKUP-20260909";
const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "operations@wms365.co",
    full_name: "WMS365 Operations"
};
const LINES = [
    { sku: "SALTEREX-CMPRSD2026/04", quantity: 1 },
    { sku: "SALTEREX-NATRL2026/04", quantity: 1 }
];

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("begin");
    try {
        const warehouse = await client.query(
            `select fl.id,fl.code,fl.name,fl.address1,fl.city,fl.state,fl.postal_code,fl.country
             from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and fl.id=$2 and cfl.allow_outbound=true`,
            [ACCOUNT, WAREHOUSE_ID]
        );
        if (warehouse.rowCount !== 1) throw new Error("North Himalayan Traders is not assigned to the expected Edwards warehouse.");
        const extraWarehouse = await client.query(
            "select count(*)::integer count from company_fulfillment_locations where account_name=$1 and fulfillment_location_id<>$2",
            [ACCOUNT, WAREHOUSE_ID]
        );
        if (Number(extraWarehouse.rows[0].count) !== 0) throw new Error("Unexpected additional warehouse assignment found.");

        const duplicate = await client.query(
            `select order_code,status from portal_orders where account_name=$1
             and (po_number=$2 or shipping_reference=$2) for update`,
            [ACCOUNT, REFERENCE]
        );
        if (duplicate.rowCount) throw new Error(`Order already exists: ${duplicate.rows[0].order_code} (${duplicate.rows[0].status}).`);

        for (const line of LINES) {
            const available = await client.query(
                `select coalesce(sum(i.quantity),0)::integer quantity
                 from inventory_lines i left join bin_locations b on b.code=i.location
                 where i.account_name=$1 and i.sku=$2 and i.quantity>0
                   and coalesce(b.is_pickable,true)=true
                   and coalesce(b.location_type,'STORAGE')='STORAGE'
                   and (b.account_name='' or b.account_name=$1)
                   and (b.fulfillment_location_id is null or b.fulfillment_location_id=$3)`,
                [ACCOUNT, line.sku, WAREHOUSE_ID]
            );
            if (Number(available.rows[0].quantity) < line.quantity) throw new Error(`Insufficient Edwards pickable stock for ${line.sku}.`);
        }

        const location = warehouse.rows[0];
        const order = await savePortalOrderDraftForAccount(client, ACCOUNT, {
            fulfillmentLocationId: WAREHOUSE_ID,
            poNumber: REFERENCE,
            shippingReference: "Customer Pickup",
            contactName: "Atif Raza",
            contactPhone: "416-822-1904",
            requestedShipDate: "2026-09-09",
            orderType: "RETAIL_WHOLESALE",
            shipmentMethod: "CUSTOMER_PICKUP",
            rushApproved: false,
            rushExempt: false,
            orderNotes: "Customer pickup requested for September 9, 2026. Contact: info@northhimalayantraders.com | www.northhimalayantraders.com. Same-day customer pickup requires explicit RUSH approval before release.",
            shipToName: "North Himalayan Traders Inc. - Customer Pickup",
            shipToAddress1: location.address1,
            shipToCity: location.city,
            shipToState: location.state,
            shipToPostalCode: location.postal_code,
            shipToCountry: location.country,
            shipToPhone: "416-822-1904",
            lines: LINES
        }, null, {
            activityTitlePrefix: "warehouse sales",
            activityActor: ACTOR.full_name,
            uploadedBy: ACTOR.email,
            enforceInventoryAvailability: true
        });

        const check = await client.query(
            `select o.id,o.order_code,o.status,o.po_number,o.shipping_reference,o.requested_ship_date,
                    o.order_type,o.shipment_method,o.fulfillment_location_id,o.contact_name,o.contact_phone,
                    o.ship_to_name,o.ship_to_address1,o.ship_to_city,o.ship_to_state,o.ship_to_postal_code,
                    o.rush_approved,o.rush_exempt,
                    json_agg(json_build_object('sku',l.sku,'quantity',l.requested_quantity) order by l.line_number) lines
             from portal_orders o join portal_order_lines l on l.order_id=o.id
             where o.id=$1 group by o.id`,
            [order.id]
        );
        const saved = check.rows[0];
        if (!saved || saved.status !== "DRAFT" || Number(saved.fulfillment_location_id) !== WAREHOUSE_ID
            || saved.lines.length !== 2 || saved.lines.some((line) => Number(line.quantity) !== 1)) {
            throw new Error(`Order verification failed: ${JSON.stringify(saved)}`);
        }
        await client.query("commit");
        console.log(JSON.stringify({ success: true, order: saved }, null, 2));
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
