const fs = require("node:fs");
const {
    APP_USER_ROLES,
    updateAdminPortalOrderStatus,
    withTransaction
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ORDER_CODE = "ORD-001362";
const ACCOUNT = "PURE FOODS BY ESTEE";
const WAREHOUSE = "GW3PL-MISS";
const PO_NUMBER = "0000165969";
const SHIP_DATE = "2026-10-14";
const CARRIER = "Priority Logistics";
const SOURCE_PDF = "C:\\Users\\T470\\Downloads\\CamScanner 2026-10-15 13.22.pdf";
const OWNER_APPROVED_MISSING_LOAD_PHOTO = true;
const EXPECTED_LINES = new Map([
    ["133", 20],
    ["135", 30],
    ["138", 30],
    ["143", 5],
    ["145", 5]
]);
const ACTOR = {
    id: null,
    email: "wms365-operations@wms365.co",
    full_name: "WMS365 Operations - Owner Approved Shipment",
    role: APP_USER_ROLES.SUPER_ADMIN
};

async function facts(client, lock = false) {
    const result = await client.query(`
        select o.id,o.order_code,o.account_name,o.status,o.po_number,o.shipment_method,
               o.confirmed_ship_date::text,o.shipped_at,o.shipped_carrier_name,
               o.shipped_tracking_reference,o.shipment_email_status,
               o.outbound_total_pallets,fl.code as warehouse_code
        from portal_orders o
        join fulfillment_locations fl on fl.id=o.fulfillment_location_id
        where o.order_code=$1${lock ? " for update of o" : ""}
    `, [ORDER_CODE]);
    if (result.rowCount !== 1) throw new Error(`${ORDER_CODE}: expected one order, found ${result.rowCount}.`);
    const order = result.rows[0];
    if (order.account_name !== ACCOUNT || order.warehouse_code !== WAREHOUSE || order.po_number !== PO_NUMBER) {
        throw new Error("Company, warehouse, or PO identity mismatch.");
    }
    if (!["RELEASED", "PICKING", "PICKED", "STAGED", "SHIPPED"].includes(order.status)) {
        throw new Error(`Order status ${order.status} is not shippable.`);
    }
    const lines = (await client.query(`
        select l.id,l.sku,l.requested_quantity,
               coalesce(sum(a.allocated_quantity),0)::integer as allocated_quantity
        from portal_order_lines l
        left join portal_order_allocations a on a.order_line_id=l.id
        where l.order_id=$1
        group by l.id,l.sku,l.requested_quantity
        order by l.id
    `, [order.id])).rows;
    if (lines.length !== EXPECTED_LINES.size) throw new Error("Order line count does not match the signed documents.");
    for (const line of lines) {
        if (EXPECTED_LINES.get(line.sku) !== Number(line.requested_quantity)) {
            throw new Error(`Ordered quantity changed for SKU ${line.sku}.`);
        }
        if (order.status !== "SHIPPED" && Number(line.allocated_quantity) !== Number(line.requested_quantity)) {
            throw new Error(`SKU ${line.sku} is not fully allocated.`);
        }
    }
    const documents = (await client.query(
        "select id,file_name,document_category from portal_order_documents where order_id=$1 order by id",
        [order.id]
    )).rows;
    return { order, lines, documents };
}

function summary(state) {
    return {
        order: state.order,
        lines: state.lines.map((line) => ({
            sku: line.sku,
            ordered: Number(line.requested_quantity),
            allocated: Number(line.allocated_quantity)
        })),
        documents: state.documents
    };
}

async function main() {
    const before = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        return facts(client);
    });
    console.log(JSON.stringify({
        phase: "preflight",
        reviewedFacts: {
            shipDate: SHIP_DATE,
            carrier: CARRIER,
            pallets: 1,
            weight: 500,
            weightUom: "LB",
            ownerApprovedMissingLoadPhoto: OWNER_APPROVED_MISSING_LOAD_PHOTO
        },
        ...summary(before)
    }, null, 2));
    if (!APPLY) return;

    await withTransaction(async (client) => {
        let state = await facts(client, true);
        if (state.order.status === "SHIPPED") return;
        const key = `owner-pure-foods-${ORDER_CODE.toLowerCase()}-shipped-${SHIP_DATE}`;
        if (state.order.status === "RELEASED") {
            await updateAdminPortalOrderStatus(client, state.order.id, "PICKING", { idempotencyKey: `${key}-picking` }, ACTOR);
            state = await facts(client, true);
        }
        if (state.order.status === "PICKING") {
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
        const needsPdf = !existingCategories.has("SHIPMENT_BOL") || !existingCategories.has("SHIPMENT_PACKING_SLIP");
        if (needsPdf && !fs.existsSync(SOURCE_PDF)) throw new Error("Signed shipment PDF is unavailable.");
        const bytes = needsPdf ? fs.readFileSync(SOURCE_PDF) : null;
        if (!existingCategories.has("SHIPMENT_BOL")) documents.push({
            fileName: `${ORDER_CODE}-signed-bol.pdf`,
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
        if (!OWNER_APPROVED_MISSING_LOAD_PHOTO) throw new Error("A loaded shipment photo is required.");

        await updateAdminPortalOrderStatus(client, state.order.id, "SHIPPED", {
            idempotencyKey: `${key}-shipped`,
            confirmedShipDate: SHIP_DATE,
            shipmentMethod: "LTL_FREIGHT",
            carrierName: CARRIER,
            trackingReference: "",
            packingSlipQuantityConfirmed: true,
            missingShipmentProofOverride: true,
            missingShipmentProofOverrideReason: "Owner explicitly approved shipment closure without a loaded shipment photo on October 15, 2026.",
            note: "Signed BOL confirms carrier pickup by Priority Logistics on October 14, 2026 at 11:15 AM. Full shipment: 90 cases on one pallet, 500 lb. Owner approved closure without a load photo.",
            outboundPallets: {
                totalPalletsOut: 1,
                existingPalletsOut: 1,
                newPalletsUsed: 0,
                mixedPalletsBuilt: 0,
                palletNote: "Signed BOL confirms one pallet, 500 lb. Handwritten dimensions: 42 x 42 x 31."
            },
            shippedLines: state.lines.map((line) => ({
                orderLineId: line.id,
                sku: line.sku,
                shippedQuantity: Number(line.requested_quantity)
            })),
            documents
        }, ACTOR);
    });

    const after = await withTransaction(async (client) => {
        await client.query("set transaction read only");
        const state = await facts(client);
        const shipmentLines = (await client.query(
            "select sku,shipped_quantity from portal_order_shipment_lines where order_id=$1 order by sku",
            [state.order.id]
        )).rows;
        const ledger = (await client.query(`
            select sku,sum(quantity_delta)::integer as quantity_delta
            from inventory_transactions
            where account_name=$1 and source_id=$2 and source_type='PORTAL_ORDER'
              and transaction_type='SHIPPING'
            group by sku order by sku
        `, [ACCOUNT, String(state.order.id)])).rows;
        return { ...state, shipmentLines, ledger };
    });
    if (after.order.status !== "SHIPPED" || after.order.confirmed_ship_date !== SHIP_DATE
        || after.order.shipped_carrier_name !== CARRIER || Number(after.order.outbound_total_pallets) !== 1) {
        throw new Error("Post-shipment order verification failed.");
    }
    if (after.shipmentLines.length !== EXPECTED_LINES.size
        || after.shipmentLines.some((line) => Number(line.shipped_quantity) !== EXPECTED_LINES.get(line.sku))) {
        throw new Error("Post-shipment line verification failed.");
    }
    if (after.ledger.length !== EXPECTED_LINES.size
        || after.ledger.some((line) => -Number(line.quantity_delta) !== EXPECTED_LINES.get(line.sku))) {
        throw new Error("Inventory shipping ledger verification failed.");
    }
    console.log(JSON.stringify({ phase: "verified", ...summary(after), shipmentLines: after.shipmentLines, ledger: after.ledger }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
