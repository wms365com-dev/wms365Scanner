const { Client } = require("pg");

const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";

async function main({ client: borrowedClient = null, print = true, statuses = ["RELEASED", "STAGED"] } = {}) {
    if (!Array.isArray(statuses) || !statuses.length
        || statuses.some((status) => !["RELEASED", "PICKED", "STAGED"].includes(status))) {
        throw new Error("Invalid Rancher's label queue statuses");
    }
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!borrowedClient && !connectionString) throw new Error("Database connection unavailable");
    const client = borrowedClient || new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    if (!borrowedClient) await client.connect();
    try {
        await client.query("begin read only");
        const integration = await client.query(
            "select id from store_integrations where id=4 and account_name=$1 and store_identifier=$2 and provider='SHOPIFY' and is_active",
            [ACCOUNT, STORE]
        );
        const warehouse = await client.query(
            "select id from fulfillment_locations where id=1 and code='GW3PL-MISS'"
        );
        if (integration.rowCount !== 1 || warehouse.rowCount !== 1) throw new Error("Ranchers integration or warehouse identity mismatch");
        const orders = await client.query(
            `select o.id,o.order_code,o.status,o.po_number,o.shipping_reference,o.requested_ship_date,
                    o.created_at,o.ship_to_name,o.ship_to_phone,o.ship_to_address1,o.ship_to_address2,
                    o.ship_to_city,o.ship_to_state,o.ship_to_postal_code,o.ship_to_country,
                    o.contact_phone,o.order_notes,o.shipment_method,o.shipped_tracking_reference,
                    si.external_order_id,tc.shopify_order_number,tc.recipient_email,
                    coalesce(d.label_count,0)::integer uploaded_label_count,
                    coalesce(a.allocated_qty,0)::integer allocated_qty,
                    coalesce(sh.tracking_reference,'') shipment_tracking
             from portal_orders o
             join store_order_imports si on si.portal_order_id=o.id and si.integration_id=4
             left join lateral (
                 select c.shopify_order_number,c.recipient_email
                 from shopify_tracking_order_contacts c
                 where c.order_id=o.id and c.integration_id=4
                 limit 1
             ) tc on true
             left join lateral (
                 select count(*)::integer label_count from portal_order_documents d
                 where d.order_id=o.id and d.document_category='SHIPPING_LABEL'
             ) d on true
             left join lateral (
                 select coalesce(sum(x.allocated_quantity),0)::integer allocated_qty
                 from portal_order_allocations x where x.order_id=o.id
             ) a on true
             left join lateral (
                 select s.tracking_reference from warehouse_shipments s
                 where s.order_id=o.id order by s.id desc limit 1
             ) sh on true
             where o.account_name=$1 and o.fulfillment_location_id=1
               and o.status=any($2::text[])
             order by coalesce(o.requested_ship_date,o.created_at::date),o.created_at,o.id`,
            [ACCOUNT, statuses]
        );
        const ids = orders.rows.map(o => o.id);
        const lines = ids.length ? await client.query(
            `select l.order_id,l.line_number,l.sku,l.requested_quantity,
                    c.description,c.tracking_level,c.unit_uom,c.units_per_case,c.upc
             from portal_order_lines l
             join portal_orders o on o.id=l.order_id
             left join item_catalog c on c.account_name=o.account_name and c.sku=l.sku
             where l.order_id=any($1::bigint[])
             order by l.order_id,l.line_number,l.id`, [ids]
        ) : { rows: [] };
        await client.query("rollback");
        const snapshot = { readAt: new Date().toISOString(), account: ACCOUNT,
            store: STORE, warehouse: "GW3PL-MISS", integrationId: 4,
            orders: orders.rows, lines: lines.rows };
        if (print) console.log(JSON.stringify(snapshot));
        return snapshot;
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        if (!borrowedClient) await client.end();
    }
}

module.exports = { main };
