const { Pool } = require("pg");
const { getPortalOrderReleaseRecipients } = require("../server");

function normalizeOrderCode(value) {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    if (!digits) throw new Error("Provide an order code such as ORD-000615.");
    return `ORD-${digits.padStart(6, "0")}`;
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const orderCode = normalizeOrderCode(process.argv[2]);
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        const orderResult = await client.query(
            `select o.id, o.order_code, o.account_name, o.status, o.po_number,
                    o.requested_ship_date, o.routing_requested_delivery_date,
                    o.fulfillment_location_id, fl.code as warehouse_code,
                    fl.name as warehouse_name, fl.contact_email as warehouse_contact_email,
                    o.outbound_total_pallets, o.picked_pallet_details,
                    o.routing_total_weight, o.routing_weight_uom, o.routing_email,
                    o.released_at, o.picked_at, o.staged_at, o.routed_at, o.routed_by,
                    o.pick_ticket_email_status, o.pick_ticket_email_scheduled_at,
                    o.pick_ticket_email_sent_at, o.pick_ticket_email_last_error,
                    o.created_at, o.updated_at
             from portal_orders o
             left join fulfillment_locations fl on fl.id = o.fulfillment_location_id
             where o.order_code = $1
             limit 1`,
            [orderCode]
        );
        if (orderResult.rowCount !== 1) throw new Error(`${orderCode} was not found.`);
        const order = orderResult.rows[0];
        const recipients = await getPortalOrderReleaseRecipients(client, order.account_name, {
            fulfillmentLocationIds: order.fulfillment_location_id ? [order.fulfillment_location_id] : []
        });
        const emailResult = await client.query(
            `select status, provider, to_addresses, cc_addresses, bcc_addresses,
                    subject, source_type, source_ref, message_id, error_message,
                    created_at, sent_at
             from email_delivery_log
             where source_ref = $1 or subject ilike $2
             order by created_at asc`,
            [orderCode, `%${orderCode}%`]
        );
        const routingResult = await client.query(
            `select status, recipient_email, sent_at, appointment_date,
                    window_start, window_end, responded_at, created_at
             from order_routing_requests
             where order_id = $1
             order by created_at asc`,
            [order.id]
        );
        const activityResult = await client.query(
            `select type, title, details, created_at
             from activity_log
             where title ilike $1 or details ilike $1
             order by created_at asc`,
            [`%${orderCode}%`]
        );
        const palletDetails = Array.isArray(order.picked_pallet_details) ? order.picked_pallet_details : [];
        const palletWeightTotal = palletDetails.reduce((total, pallet) => total + (Number(pallet?.weight) || 0), 0);
        const requestedDeliveryDate = order.routing_requested_delivery_date || order.requested_ship_date || null;
        const missing = [];
        if (order.status !== "STAGED") missing.push(`Move order from ${order.status} to STAGED after physical picking and staging are complete.`);
        if (!order.routing_email) missing.push("Routing email");
        if (!(Number(order.outbound_total_pallets) > 0 || palletDetails.length > 0)) missing.push("Total pallet count");
        if (!(Number(order.routing_total_weight) > 0 || palletWeightTotal > 0)) missing.push("Shipment weight");
        if (!requestedDeliveryDate) missing.push("Requested delivery date");
        if (order.routed_at) missing.push("None: this order has already been routed.");

        console.log(JSON.stringify({
            order: {
                ...order,
                picked_pallet_details: palletDetails,
                derived_pallet_count: palletDetails.length,
                derived_weight_total: palletWeightTotal,
                requested_delivery_date_used_for_routing: requestedDeliveryDate
            },
            responsibleWarehouseRecipients: recipients,
            emailDeliveries: emailResult.rows,
            routingRequests: routingResult.rows,
            activity: activityResult.rows,
            routingReadiness: {
                ready: order.status === "STAGED"
                    && Boolean(order.routing_email)
                    && (Number(order.outbound_total_pallets) > 0 || palletDetails.length > 0)
                    && (Number(order.routing_total_weight) > 0 || palletWeightTotal > 0)
                    && Boolean(requestedDeliveryDate)
                    && !order.routed_at,
                missing
            }
        }, null, 2));
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
