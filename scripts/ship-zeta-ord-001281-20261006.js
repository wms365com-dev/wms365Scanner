const fs = require("fs");
const {
    APP_USER_ROLES,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const ORDER_CODE = "ORD-001281";
const ACCOUNT = "ZETA GROUP (CANADA) LTD.";
const WAREHOUSE = "GW3PL-MISS";
const SHIP_DATE = "2026-10-06";
const CARRIER = "Omar";
const OWNER_APPROVED_MISSING_LOAD_PHOTO = true;
const SOURCE_PDF = "C:\\Users\\T470\\Downloads\\CamScanner 2026-10-09 07.50 (1).pdf";
const APPLY = process.argv.includes("--apply");
const EXPECTED_LINES = new Map([
    ["S041", 38], ["S043", 20], ["S158", 14],
    ["S160", 29], ["S162", 19], ["S163", 6]
]);
const ACTOR = {
    id: null,
    email: "wms365-operations@wms365.co",
    full_name: "WMS365 Operations - Owner Approved Shipment",
    role: APP_USER_ROLES.SUPER_ADMIN
};

async function facts(client, lock = false) {
    const result = await client.query(
        `select o.id,o.order_code,o.account_name,o.status,o.shipment_method,
                o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,
                o.shipped_tracking_reference,o.shipment_email_status,
                o.outbound_total_pallets,fl.code warehouse_code
         from portal_orders o
         left join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where o.order_code=$1${lock ? " for update of o" : ""}`,
        [ORDER_CODE]
    );
    if (result.rowCount !== 1) throw new Error(`${ORDER_CODE}: expected one order, found ${result.rowCount}.`);
    const order = result.rows[0];
    if (order.account_name !== ACCOUNT || order.warehouse_code !== WAREHOUSE) throw new Error("Company or warehouse identity mismatch.");
    if (!["RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) throw new Error(`Order status ${order.status} is not shippable.`);
    const lines = (await client.query(
        `select l.id,l.sku,l.requested_quantity,
                coalesce(sum(a.allocated_quantity),0)::integer allocated_quantity
         from portal_order_lines l
         left join portal_order_allocations a on a.order_line_id=l.id
         where l.order_id=$1
         group by l.id,l.sku,l.requested_quantity order by l.id`,
        [order.id]
    )).rows;
    if (lines.length !== EXPECTED_LINES.size || lines.some((line) => EXPECTED_LINES.get(line.sku) !== Number(line.requested_quantity))) {
        throw new Error("Order lines do not match the reviewed signed documents.");
    }
    if (order.status !== "SHIPPED" && lines.some((line) => Number(line.allocated_quantity) !== Number(line.requested_quantity))) {
        throw new Error("Order is not fully allocated.");
    }
    const documents = (await client.query(
        "select id,file_name,document_category from portal_order_documents where order_id=$1 order by id",
        [order.id]
    )).rows;
    const recipients = (await client.query(
        `select distinct lower(trim(email)) email from (
            select email from portal_vendor_access where account_name=$1 and is_active=true
            union all select portal_login_email from owner_accounts where name=$1
            union all select billing_email from owner_accounts where name=$1
            union all select ap_email from owner_accounts where name=$1
         ) r where trim(coalesce(email,''))<>'' order by 1`,
        [ACCOUNT]
    )).rows.map((row) => row.email);
    const emailHistory = (await client.query(
        `select status,to_addresses,cc_addresses,bcc_addresses,subject,sent_at
         from email_delivery_log where account_name=$1 and source_type='SHIPMENT_CONFIRMATION'
         order by id desc limit 5`,
        [ACCOUNT]
    )).rows;
    return { order, lines, documents, recipients, emailHistory };
}

function summary(state) {
    return {
        order: state.order,
        lines: state.lines.map((line) => ({ sku: line.sku, ordered: Number(line.requested_quantity), allocated: Number(line.allocated_quantity) })),
        documents: state.documents,
        recipientCount: state.recipients.length,
        emailHistory: state.emailHistory
    };
}

async function main() {
    const before = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return facts(client);
    });
    console.log(JSON.stringify({ phase: "preflight", ...summary(before) }, null, 2));
    if (!APPLY) return;
    await withTransaction(async (client) => {
        let state = await facts(client, true);
        if (state.order.status === "SHIPPED") return;
        const key = `owner-zeta-${ORDER_CODE.toLowerCase()}-shipped-${SHIP_DATE}`;
        if (state.order.status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, state.order.id, "PICKED", { idempotencyKey: `${key}-picked` }, ACTOR);
            state = await facts(client, true);
        }
        if (state.order.status === "PICKED") {
            await updateAdminPortalOrderStatus(client, state.order.id, "STAGED", { idempotencyKey: `${key}-staged` }, ACTOR);
            state = await facts(client, true);
        }
        if (state.order.status !== "STAGED") throw new Error(`Expected STAGED, found ${state.order.status}.`);
        const existingCategories = new Set(state.documents.map((document) => document.document_category));
        const documents = [];
        const needsSourcePdf = !existingCategories.has("SHIPMENT_BOL") || !existingCategories.has("SHIPMENT_PACKING_SLIP");
        if (needsSourcePdf && !fs.existsSync(SOURCE_PDF)) throw new Error("Signed shipment PDF is unavailable for required document upload.");
        const bytes = needsSourcePdf ? fs.readFileSync(SOURCE_PDF) : null;
        if (!existingCategories.has("SHIPMENT_BOL")) documents.push({
            fileName: `${ORDER_CODE}-signed-bol-and-shipment-record.pdf`,
            fileType: "application/pdf",
            documentCategory: "SHIPMENT_BOL",
            dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`
        });
        if (!existingCategories.has("SHIPMENT_PACKING_SLIP")) documents.push({
            fileName: `${ORDER_CODE}-checked-packing-slip.pdf`,
            fileType: "application/pdf",
            documentCategory: "SHIPMENT_PACKING_SLIP",
            dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`
        });
        if (!OWNER_APPROVED_MISSING_LOAD_PHOTO && ![...existingCategories, ...documents.map((document) => document.documentCategory)].includes("SHIPMENT_LOAD_PHOTO")) {
            throw new Error("A loaded freight/truck photo is required before this LTL shipment can be closed.");
        }
        await updateAdminPortalOrderStatus(client, state.order.id, "SHIPPED", {
            idempotencyKey: `${key}-shipped`,
            confirmedShipDate: SHIP_DATE,
            shipmentMethod: "LTL_FREIGHT",
            carrierName: CARRIER,
            trackingReference: "",
            packingSlipQuantityConfirmed: true,
            missingShipmentProofOverride: OWNER_APPROVED_MISSING_LOAD_PHOTO,
            missingShipmentProofOverrideReason: "Owner explicitly approved shipment closure without the loaded freight photo on October 15, 2026.",
            note: "Signed carrier acknowledgment confirms pickup on October 6, 2026 by Omar. Three pallets, 1,500 lb. Owner explicitly approved shipment closure without a loaded freight photo on October 15, 2026.",
            outboundPallets: { totalPalletsOut: 3, existingPalletsOut: 3, newPalletsUsed: 0, mixedPalletsBuilt: 0, palletNote: "Signed BOL confirms 3 pallets." },
            shippedLines: state.lines.map((line) => ({ orderLineId: line.id, sku: line.sku, shippedQuantity: Number(line.requested_quantity) })),
            documents
        }, ACTOR);
    });

    const after = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return facts(client);
    });
    console.log(JSON.stringify({ phase: "verified", ...summary(after) }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
