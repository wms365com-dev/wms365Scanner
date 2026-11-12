"use strict";
const { Client } = require("pg");

const ORDER_CODE = "ORD-001697";
const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const BOL_NUMBER = "507698764";

async function main() {
    const db = new Client({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, ssl: false });
    await db.connect();
    try {
        await db.query("begin");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${ORDER_CODE}:shipment-pallet-metadata`]);
        const orderResult = await db.query(
            `select id,account_name,status,outbound_total_pallets,outbound_existing_pallets,outbound_new_pallets,
                    routing_total_weight,routing_weight_uom,shipped_tracking_reference
             from portal_orders where order_code=$1 for update`,
            [ORDER_CODE]
        );
        if (orderResult.rowCount !== 1) throw new Error("Expected one exact order.");
        const order = orderResult.rows[0];
        if (order.account_name !== ACCOUNT || order.status !== "SHIPPED" || Number(order.outbound_total_pallets) !== 2
            || Number(order.outbound_existing_pallets) !== 2 || Number(order.outbound_new_pallets) !== 0
            || Number(order.routing_total_weight) !== 900 || order.routing_weight_uom !== "LB"
            || order.shipped_tracking_reference !== BOL_NUMBER) throw new Error("Parent shipment facts do not match the reviewed shipment.");
        const shipmentResult = await db.query("select * from warehouse_shipments where order_id=$1 for update", [order.id]);
        if (shipmentResult.rowCount !== 1 || shipmentResult.rows[0].status !== "SHIPPED"
            || shipmentResult.rows[0].bol_reference !== BOL_NUMBER || Number(shipmentResult.rows[0].total_weight) !== 900) {
            throw new Error("Exact warehouse shipment identity was not verified.");
        }
        await db.query(
            `update warehouse_shipments set total_pallets=2,existing_pallets=2,new_pallets=0,mixed_pallets=2,updated_at=now()
             where id=$1`,
            [shipmentResult.rows[0].id]
        );
        const verified = await db.query(
            `select id,status,carrier_name,tracking_reference,bol_reference,total_pallets,existing_pallets,
                    new_pallets,mixed_pallets,total_weight,weight_uom,shipped_at
             from warehouse_shipments where id=$1`,
            [shipmentResult.rows[0].id]
        );
        const row = verified.rows[0];
        if (Number(row.total_pallets) !== 2 || Number(row.existing_pallets) !== 2 || Number(row.new_pallets) !== 0
            || Number(row.mixed_pallets) !== 2) throw new Error("Shipment pallet metadata verification failed.");
        await db.query("commit");
        console.log(JSON.stringify({ status: "CORRECTED", orderCode: ORDER_CODE, shipment: row }));
    } catch (error) {
        try { await db.query("rollback"); } catch {}
        throw error;
    } finally {
        await db.end();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
