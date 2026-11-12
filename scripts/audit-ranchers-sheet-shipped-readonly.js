const { Client } = require('pg');

async function main() {
    if (process.env.RAILWAY_PROJECT_ID !== '3f4e7e7e-7eda-4275-8dd0-2c1c3f869698'
        || process.env.RAILWAY_ENVIRONMENT_ID !== 'e1f5b77e-b935-4f41-9cc5-fccb28edbc57'
        || process.env.RAILWAY_SERVICE_ID !== '2b47f53a-a3a2-49e2-8e43-d6eabf89b2b0') {
        throw new Error('WMS365 production target mismatch');
    }
    const codes = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
    if (!Array.isArray(codes) || !codes.length || new Set(codes).size !== codes.length
        || codes.some((code) => !/^ORD-\d{6}$/.test(code))) {
        throw new Error('Invalid order selection');
    }
    const client = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
        await client.query('begin read only');
        const integration = await client.query(
            "select id from store_integrations where id=4 and account_name=$1 and store_identifier='f1acxk-dc.myshopify.com' and provider='SHOPIFY' and is_active",
            ["RANCHER'S CHIPS"]
        );
        const warehouse = await client.query("select id from fulfillment_locations where id=1 and code='GW3PL-MISS'");
        if (integration.rowCount !== 1 || warehouse.rowCount !== 1) throw new Error('Ranchers scope mismatch');
        const orders = await client.query(
            `select o.order_code,o.status,o.shipped_carrier_name,o.shipped_tracking_reference,
                    o.fulfillment_location_id,si.external_order_id,
                    ws.status shipment_status,ws.carrier_name shipment_carrier,ws.tracking_reference shipment_tracking,
                    coalesce(lines.ordered_qty,0)::integer ordered_qty,
                    coalesce(shipped.shipped_qty,0)::integer shipped_qty
             from portal_orders o
             join store_order_imports si on si.portal_order_id=o.id and si.integration_id=4
             left join lateral (
                 select status,carrier_name,tracking_reference from warehouse_shipments
                 where order_id=o.id order by id desc limit 1
             ) ws on true
             left join lateral (
                 select sum(requested_quantity) ordered_qty from portal_order_lines where order_id=o.id
             ) lines on true
             left join lateral (
                 select sum(sl.shipped_quantity) shipped_qty from warehouse_shipment_lines sl
                 join warehouse_shipments s on s.id=sl.shipment_id where s.order_id=o.id
             ) shipped on true
             where o.account_name=$1 and o.order_code=any($2::text[])
             order by o.order_code`,
            ["RANCHER'S CHIPS", codes]
        );
        await client.query('rollback');
        console.log(JSON.stringify({ checked: codes.length, found: orders.rowCount, rows: orders.rows }));
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

module.exports = { main };
