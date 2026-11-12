"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const {
    buildPortalOrderBillOfLadingPdfAttachment,
    getPortalOrderById,
    preparePortalOrderBillOfLading,
    releasePortalOrderForAccount,
    updateAdminPortalOrderStatus
} = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "RANCHER'S CHIPS";
const PO = "168187";
const SKU = "RTC-4OZ-EA";
const CASES = 128;
const UNITS_PER_CASE = 12;
const QUANTITY = CASES * UNITS_PER_CASE;
const PALLETS = 3;
const TOTAL_WEIGHT = 1000;
const SHIP_DATE = "2026-10-21";
const CARRIER = "PURITY LIFE";
const ACTOR = { full_name: "Owner-authorized Purity Life pickup" };
const OUTPUT_DIR = path.resolve(__dirname, "..", "outputs", "ranchers-purity-po168187");

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL, max: 1 });
    const db = await pool.connect();
    let result;
    try {
        await db.query("begin");
        if (!APPLY) await db.query("set transaction read only");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", ["ranchers-purity-po168187"]);
        const account = (await db.query("select id,is_active from owner_accounts where name=$1", [ACCOUNT])).rows[0];
        const warehouse = (await db.query(`select fl.id,fl.code,fl.is_active,cfl.allow_outbound,cfl.allow_storage
            from company_fulfillment_locations cfl join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
            where cfl.account_name=$1 and fl.id=1 and fl.code='GW3PL-MISS'`, [ACCOUNT])).rows[0];
        const item = (await db.query(`select sku,description,tracking_level,units_per_case,blocked
            from item_catalog where account_name=$1 and sku=$2`, [ACCOUNT, SKU])).rows[0];
        if (!account?.is_active || !warehouse?.is_active || !warehouse.allow_outbound || !warehouse.allow_storage) throw new Error("Rancher's account or warehouse scope mismatch.");
        if (!item || item.blocked || Number(item.units_per_case) !== UNITS_PER_CASE) throw new Error("Rancher's active 12-pack item mapping mismatch.");
        const duplicate = await db.query(`select id,order_code,status from portal_orders where account_name=$1
            and regexp_replace(upper(coalesce(po_number,'')),'[^A-Z0-9]','','g')=$2`, [ACCOUNT, PO]);
        if (duplicate.rowCount) throw new Error(`PO ${PO} already exists as ${duplicate.rows[0].order_code} (${duplicate.rows[0].status}).`);
        const stock = (await db.query(`select coalesce(sum(i.quantity),0)::int on_hand,
            coalesce(sum((select coalesce(sum(a.allocated_quantity),0) from portal_order_allocations a
              join portal_order_lines l on l.id=a.order_line_id join portal_orders o on o.id=l.order_id
              where a.inventory_line_id=i.id and o.status in ('RELEASED','PICKING','PICKED','STAGED'))),0)::int allocated
            from inventory_lines i where i.account_name=$1 and i.sku=$2`, [ACCOUNT, SKU])).rows[0];
        if (Number(stock.on_hand) - Number(stock.allocated) < QUANTITY) throw new Error("Insufficient unallocated Rancher's inventory.");

        if (!APPLY) {
            await db.query("rollback");
            console.log(JSON.stringify({ mode: "PREFLIGHT", account: ACCOUNT, po: PO, sku: SKU, cases: CASES,
                orderQuantityEaches: QUANTITY, availableEaches: Number(stock.on_hand) - Number(stock.allocated),
                pallets: PALLETS, carrier: CARRIER, totalWeightLb: TOTAL_WEIGHT }));
            return;
        }

        const inserted = await db.query(`insert into portal_orders (
            account_name,status,po_number,shipping_reference,contact_name,requested_ship_date,order_type,
            shipment_method,order_notes,ship_to_name,ship_to_address1,ship_to_city,ship_to_state,
            ship_to_postal_code,ship_to_country,fulfillment_location_id,ship_to_address_status,
            outbound_total_pallets,outbound_existing_pallets,outbound_new_pallets
        ) values ($1,'DRAFT',$2,$2,'Accounts Payable',$3,'FREIGHT_RETAIL','CUSTOMER_PICKUP',$4,
            'Purity Life Grocery - Mississauga','5800 Keaton Crescent','Mississauga','ON','L5R 3K2','CA',$5,
            'SAVED',$6,$6,0) returning id`, [ACCOUNT, PO, SHIP_DATE,
            `Owner-authorized pickup: ${CASES} cases x ${UNITS_PER_CASE} bags (${QUANTITY} eaches) on ${PALLETS} skids. Carrier ${CARRIER}. BOL gross weight ${TOTAL_WEIGHT} lb derived from documented identical-SKU inbound ratio of 3,000 lb / 384 cases.`,
            warehouse.id, PALLETS]);
        const orderId = inserted.rows[0].id;
        const orderCode = `ORD-${String(orderId).padStart(6, "0")}`;
        await db.query("update portal_orders set order_code=$2 where id=$1", [orderId, orderCode]);
        await db.query("insert into portal_order_lines(order_id,line_number,sku,requested_quantity) values($1,1,$2,$3)", [orderId, SKU, QUANTITY]);

        let order = await releasePortalOrderForAccount(db, ACCOUNT, orderId, {
            rushExempt: true,
            rushExemptNote: "Owner-authorized waiting carrier pickup.",
            activityActor: ACTOR.full_name,
            activityTitlePrefix: "Owner-authorized Purity Life pickup"
        });
        order = await updateAdminPortalOrderStatus(db, orderId, "PICKING", { idempotencyKey: `purity-${PO}-picking` }, ACTOR);
        order = await updateAdminPortalOrderStatus(db, orderId, "PICKED", { idempotencyKey: `purity-${PO}-picked` }, ACTOR);
        order = await updateAdminPortalOrderStatus(db, orderId, "STAGED", { idempotencyKey: `purity-${PO}-staged` }, ACTOR);
        if (order.status !== "STAGED" || order.warehouseShipments.length !== 1) throw new Error("Order did not reach one staged warehouse shipment.");
        const allocation = (await db.query(`select coalesce(sum(a.allocated_quantity),0)::int allocated
            from portal_order_lines l left join portal_order_allocations a on a.order_line_id=l.id where l.order_id=$1`, [orderId])).rows[0];
        if (Number(allocation.allocated) !== QUANTITY) throw new Error("Order allocation verification failed.");

        await preparePortalOrderBillOfLading(db, order, order, { shipments: [{
            shipmentId: order.warehouseShipments[0].id,
            shipmentMethod: "CUSTOMER_PICKUP",
            carrier: CARRIER,
            totalPallets: PALLETS,
            totalWeight: TOTAL_WEIGHT,
            weightUom: "LB",
            deliveryDate: SHIP_DATE,
            bolReference: `BOL-${orderCode}`
        }] }, ACTOR);
        order = await getPortalOrderById(db, orderId, ACCOUNT);
        const bolOrder = structuredClone(order);
        bolOrder.orderNotes = `${CASES} CASES x ${UNITS_PER_CASE} BAGS (${QUANTITY} EACHES). ${PALLETS} SKIDS. Customer pickup by Purity Life.`;
        for (const shipment of bolOrder.warehouseShipments) {
            shipment.lines = shipment.lines.map((line) => ({ ...line, quantity: CASES, trackingLevel: "CASE",
                description: `Rancher's Tallow Chips - 4 oz | ${CASES} cases x ${UNITS_PER_CASE}` }));
        }
        const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
        const fileName = `WMS365_BOL_${orderCode}_PO${PO}.pdf`;
        await db.query(`insert into portal_order_documents
            (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
            values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`,
            [orderId, fileName, pdf.content.length, pdf.content, ACTOR.full_name, order.warehouseShipments[0].id]);
        await db.query("commit");
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        const outputPath = path.join(OUTPUT_DIR, fileName);
        fs.writeFileSync(outputPath, pdf.content);
        result = { mode: "APPLIED", orderCode, status: order.status, po: PO, carrier: CARRIER,
            cases: CASES, unitsPerCase: UNITS_PER_CASE, allocatedEaches: QUANTITY, pallets: PALLETS,
            totalWeightLb: TOTAL_WEIGHT, shipped: false, fileName, outputPath,
            pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex") };
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        db.release();
        await pool.end();
    }
    console.log(JSON.stringify(result));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
