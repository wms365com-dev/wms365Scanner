const { Client } = require("pg");

const apply = process.argv.includes("--apply");

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query("begin");
        const result = await client.query(
            `select o.id, o.order_code, o.account_name, o.status, o.shipment_method,
                    o.confirmed_ship_date::text as ship_date, o.shipped_carrier_name,
                    o.shipped_tracking_reference, o.outbound_total_pallets,
                    fl.code as warehouse,
                    s.id as shipment_id, s.status as shipment_status,
                    s.shipment_method as shipment_method_record,
                    s.carrier_name, s.tracking_reference, s.total_pallets,
                    s.existing_pallets, s.new_pallets, s.mixed_pallets
             from portal_orders o
             join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             join warehouse_shipments s on s.order_id = o.id and s.fulfillment_location_id = fl.id
             where o.order_code = $1
             for update of o, s`,
            ["ORD-001048"]
        );
        if (result.rowCount !== 1) throw new Error("Expected one linked warehouse shipment");
        const row = result.rows[0];
        if (row.account_name !== "PURE FOODS BY ESTEE" || row.warehouse !== "GW3PL-MISS" ||
            row.status !== "SHIPPED" || row.shipment_status !== "SHIPPED" ||
            row.shipment_method !== "CUSTOMER_PICKUP" || row.ship_date !== "2026-09-29" ||
            row.shipped_carrier_name !== "Customer Pickup" || row.shipped_tracking_reference ||
            Number(row.outbound_total_pallets) !== 1 ||
            row.carrier_name !== "Customer Pickup" || row.tracking_reference) {
            throw new Error("Shipment identity or pickup details changed");
        }
        const lines = await client.query(
            `select sku, shipped_quantity from warehouse_shipment_lines
             where shipment_id = $1 order by sku`,
            [row.shipment_id]
        );
        const expected = { "138": 2, "142": 2, "143": 2, "148": 1 };
        if (lines.rowCount !== 4 || lines.rows.some((line) => Number(line.shipped_quantity) !== expected[line.sku])) {
            throw new Error("Warehouse shipment lines no longer match the checked pick ticket");
        }
        const alreadyCorrect = row.shipment_method_record === "CUSTOMER_PICKUP" &&
            Number(row.total_pallets) === 1 && Number(row.existing_pallets) === 1 &&
            Number(row.new_pallets) === 0 && Number(row.mixed_pallets) === 0;
        if (!alreadyCorrect && (row.shipment_method_record !== "LTL_FREIGHT" ||
            Number(row.total_pallets) !== 0 || Number(row.existing_pallets) !== 0 ||
            Number(row.new_pallets) !== 0 || Number(row.mixed_pallets) !== 0)) {
            throw new Error("Shipment has a conflicting method or pallet count");
        }
        if (apply && !alreadyCorrect) {
            await client.query(
                `update warehouse_shipments
                 set shipment_method = 'CUSTOMER_PICKUP', total_pallets = 1,
                     existing_pallets = 1, new_pallets = 0, mixed_pallets = 0,
                     updated_at = now()
                 where id = $1`,
                [row.shipment_id]
            );
        }
        if (apply) await client.query("commit");
        else await client.query("rollback");
        console.log(JSON.stringify({ order: row.order_code, shipmentId: row.shipment_id,
            alreadyCorrect, corrected: apply && !alreadyCorrect }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
