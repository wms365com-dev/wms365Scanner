"use strict";

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { buildPortalOrderBillOfLadingPdfAttachment, getPortalOrderById } = require("../server");

const APPLY = process.argv.includes("--apply");
const CODE = "ORD-001902";
const ACCOUNT = "ALCONA TRADING LTD";
const LB_TO_KG = 0.45359237;
const EXPECTED_LB = [2324, 2325, 2321, 2320];
const FILE = "WMS365_BOL_ORD-001902_2026-11-05_1130AM_BISON_REVISED_KG.pdf";

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false, max: 1 });
    const db = await pool.connect();
    try {
        await db.query("begin");
        if (!APPLY) await db.query("set transaction read only");
        await db.query("select pg_advisory_xact_lock(hashtext($1))", [`${CODE}-bol-kg-correction`]);

        const found = await db.query(`
            select o.*, s.id as shipment_id, s.status as shipment_status,
                   s.total_weight as shipment_total_weight, s.weight_uom as shipment_weight_uom
            from portal_orders o
            join warehouse_shipments s on s.order_id = o.id
            where o.order_code = $1
            order by s.id desc limit 1
            ${APPLY ? "for update of o, s" : ""}
        `, [CODE]);
        if (found.rowCount !== 1) throw new Error("Exact order and shipment identity were not found.");
        const row = found.rows[0];
        if (row.account_name !== ACCOUNT || row.status !== "SHIPPED" || row.shipment_status !== "SHIPPED"
            || row.shipped_carrier_name !== "Bison" || row.routing_weight_uom !== "LB"
            || row.shipment_weight_uom !== "LB" || Number(row.routing_total_weight) !== 9290
            || Number(row.shipment_total_weight) !== 9290) {
            throw new Error("The reviewed Alcona shipment state or pound weights changed.");
        }
        const sourcePallets = Array.isArray(row.picked_pallet_details) ? row.picked_pallet_details : [];
        if (sourcePallets.length !== 4 || sourcePallets.some((p, i) => Number(p.weight) !== EXPECTED_LB[i])) {
            throw new Error("The reviewed pallet weights changed.");
        }
        const pallets = sourcePallets.map((pallet, index) => ({
            ...pallet,
            weight: Number((EXPECTED_LB[index] * LB_TO_KG).toFixed(2)),
            weightUom: "KG",
            sourceWeightLb: EXPECTED_LB[index]
        }));
        const totalKg = Number(pallets.reduce((sum, pallet) => sum + pallet.weight, 0).toFixed(2));

        if (!APPLY) {
            await db.query("rollback");
            console.log(JSON.stringify({ mode: "PREFLIGHT", order: CODE, pallets, totalKg }, null, 2));
            return;
        }

        await db.query(`
            update portal_orders
            set picked_pallet_details = $2::jsonb, routing_total_weight = $3,
                routing_weight_uom = 'KG', updated_at = now()
            where id = $1
        `, [row.id, JSON.stringify(pallets), totalKg]);
        await db.query(`
            update warehouse_shipments
            set total_weight = $2, weight_uom = 'KG', updated_at = now()
            where id = $1
        `, [row.shipment_id, totalKg]);

        const order = await getPortalOrderById(db, row.id, ACCOUNT);
        const bolOrder = {
            ...order,
            status: "STAGED",
            shippedAt: null,
            pickedPalletDetails: pallets,
            routingTotalWeight: totalKg,
            routingWeightUom: "KG",
            orderNotes: `Revised kilograms-only BOL. Source scale weights: ${EXPECTED_LB.join(", ")} lb. `
                + `Converted pallet weights: ${pallets.map((p) => `${p.location || "blank"} ${p.weight.toFixed(2)} kg`).join("; ")}. `
                + `Total ${totalKg.toFixed(2)} kg. Carrier Bison.`,
            warehouseShipments: order.warehouseShipments.map((shipment) => shipment.id === String(row.shipment_id)
                || Number(shipment.id) === Number(row.shipment_id)
                ? { ...shipment, status: "STAGED", shippedAt: null, totalWeight: totalKg, weightUom: "KG" }
                : shipment)
        };
        const pdf = buildPortalOrderBillOfLadingPdfAttachment(bolOrder);
        if (pdf.content.subarray(0, 4).toString() !== "%PDF") throw new Error("Revised BOL PDF is invalid.");
        const existing = await db.query(
            "select id from portal_order_documents where order_id=$1 and file_name=$2",
            [row.id, FILE]
        );
        if (existing.rowCount > 1) throw new Error("Revised BOL identity is not unique.");
        if (existing.rowCount) {
            await db.query(`update portal_order_documents set file_size=$3,file_data=$4,
                document_category='SHIPMENT_BOL',uploaded_by=$5,warehouse_shipment_id=$6
                where order_id=$1 and file_name=$2`,
            [row.id, FILE, pdf.content.length, pdf.content, "WMS365 kilograms-only correction", row.shipment_id]);
        } else {
            await db.query(`insert into portal_order_documents
                (order_id,file_name,file_type,file_size,file_data,document_category,uploaded_by,warehouse_shipment_id)
                values($1,$2,'application/pdf',$3,$4,'SHIPMENT_BOL',$5,$6)`,
            [row.id, FILE, pdf.content.length, pdf.content, "WMS365 kilograms-only correction", row.shipment_id]);
        }
        const verify = await db.query(`
            select o.status,o.routing_total_weight,o.routing_weight_uom,o.picked_pallet_details,
                   s.status shipment_status,s.total_weight,s.weight_uom,
                   d.id document_id,d.file_size
            from portal_orders o
            join warehouse_shipments s on s.id=$2
            join portal_order_documents d on d.order_id=o.id and d.file_name=$3
            where o.id=$1
        `, [row.id, row.shipment_id, FILE]);
        const final = verify.rows[0];
        if (!final || final.status !== "SHIPPED" || final.shipment_status !== "SHIPPED"
            || final.routing_weight_uom !== "KG" || final.weight_uom !== "KG"
            || Number(final.routing_total_weight) !== totalKg || Number(final.total_weight) !== totalKg
            || !final.document_id || Number(final.file_size) !== pdf.content.length) {
            throw new Error("Kilograms-only correction verification failed.");
        }
        await db.query("commit");
        console.log(JSON.stringify({ mode: "APPLIED", order: CODE, status: "SHIPPED",
            totalKg, pallets, fileName: FILE, pdfSha256: crypto.createHash("sha256").update(pdf.content).digest("hex"),
            emailSent: false }, null, 2));
    } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
    } finally {
        db.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
