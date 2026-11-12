const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const SOURCE_SKU = "TP-WW-6PK-UPC";
const EACH_SKU = "WW-6PK-EA";
const REFERENCES = [3, 5, 23, 26, 27].map((number) => `WF-CONS-20261007-${String(number).padStart(2, "0")}-A643D570`);

async function main({ apply = false } = {}) {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", ["wellforia-consumer-six-pack-eaches-20261007"]);
        const [account, sourceItem, eachItem, orders] = await Promise.all([
            client.query("select name,is_active from owner_accounts where name=$1", [ACCOUNT]),
            client.query("select * from item_catalog where account_name=$1 and sku=$2 for update", [ACCOUNT, SOURCE_SKU]),
            client.query("select * from item_catalog where account_name=$1 and sku=$2 for update", [ACCOUNT, EACH_SKU]),
            client.query(
                `select o.id,o.order_code,o.po_number,o.status,l.id as line_id,l.sku,l.requested_quantity
                 from portal_orders o join portal_order_lines l on l.order_id=o.id
                 where o.account_name=$1 and o.po_number=any($2::text[])
                 order by o.po_number for update of o,l`,
                [ACCOUNT, REFERENCES]
            )
        ]);
        if (account.rowCount !== 1 || account.rows[0].is_active !== true) throw new Error("Exact active Wellforia tenant verification failed.");
        if (sourceItem.rowCount !== 1 || sourceItem.rows[0].blocked === true) throw new Error("The source six-pack item is missing or blocked.");
        if (orders.rowCount !== REFERENCES.length) throw new Error(`Expected ${REFERENCES.length} consumer six-pack drafts; found ${orders.rowCount}.`);
        if (orders.rows.some((row) => row.status !== "DRAFT" || Number(row.requested_quantity) !== 1 || ![SOURCE_SKU, EACH_SKU].includes(row.sku))) {
            throw new Error("A target consumer order is no longer an unchanged one-unit draft.");
        }
        if (eachItem.rowCount === 1) {
            const item = eachItem.rows[0];
            if (item.tracking_level !== "UNIT" || item.unit_uom !== "EA" || Number(item.units_per_case) !== 1 || item.blocked === true) {
                throw new Error(`${EACH_SKU} exists with incompatible item settings.`);
            }
        }
        const summary = {
            mode: apply ? "APPLY" : "PREFLIGHT",
            account: ACCOUNT,
            sourceItem: { sku: SOURCE_SKU, trackingLevel: sourceItem.rows[0].tracking_level, unitsPerCase: sourceItem.rows[0].units_per_case },
            eachItemExists: eachItem.rowCount === 1,
            targetSku: EACH_SKU,
            orders: orders.rows.map((row) => ({ orderCode: row.order_code, reference: row.po_number, currentSku: row.sku, quantity: Number(row.requested_quantity) }))
        };
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return summary;
        }
        if (eachItem.rowCount === 0) {
            const source = sourceItem.rows[0];
            await client.query(
                `insert into item_catalog (
                    account_name,sku,upc,description,tracking_level,uom_label,unit_uom,units_per_case,
                    each_length,each_width,each_height,case_length,case_width,case_height,image_url,
                    lot_tracked,expiration_tracked,item_type,item_category,blocked,costing_method,
                    unit_cost,unit_price,replenishment_system,vendor_no,vendor_item_no,lead_time_days
                 ) values ($1,$2,$3,$4,'UNIT','Each','EA',1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16,$17,$18,$19,$20,$21,$22)`,
                [
                    ACCOUNT,EACH_SKU,source.upc || "","Whoopsie Wipes 6 Pack - Each",
                    source.each_length,source.each_width,source.each_height,source.case_length,source.case_width,source.case_height,
                    source.image_url || "",source.lot_tracked === true,source.expiration_tracked === true,
                    source.item_type || "INVENTORY",source.item_category || "",source.costing_method || "FIFO",
                    source.unit_cost,source.unit_price,source.replenishment_system || "PURCHASE",source.vendor_no || "",
                    source.vendor_item_no || "",source.lead_time_days
                ]
            );
        }
        const updated = await client.query(
            `update portal_order_lines l set sku=$3,updated_at=now()
             from portal_orders o
             where o.id=l.order_id and o.account_name=$1 and o.po_number=any($2::text[])
               and o.status='DRAFT' and l.sku=any($4::text[]) and l.requested_quantity=1`,
            [ACCOUNT, REFERENCES, EACH_SKU, [SOURCE_SKU, EACH_SKU]]
        );
        if (updated.rowCount !== REFERENCES.length) throw new Error(`Expected to update ${REFERENCES.length} lines; updated ${updated.rowCount}.`);
        await client.query(
            `insert into import_backups (backup_type,created_by,source_ip,backup_payload)
             values ('WELLFORIA_CONSUMER_EACH_CORRECTION','Codex approved live correction','local-agent',$1::jsonb)`,
            [JSON.stringify(summary)]
        );
        await client.query("commit");
        const verification = await pool.query(
            `select o.order_code,o.po_number,o.status,l.sku,l.requested_quantity
             from portal_orders o join portal_order_lines l on l.order_id=o.id
             where o.account_name=$1 and o.po_number=any($2::text[]) order by o.po_number`,
            [ACCOUNT, REFERENCES]
        );
        const itemVerification = await pool.query(
            `select sku,description,tracking_level,uom_label,unit_uom,units_per_case,blocked
             from item_catalog where account_name=$1 and sku=$2`,
            [ACCOUNT, EACH_SKU]
        );
        if (verification.rowCount !== REFERENCES.length || verification.rows.some((row) => row.status !== "DRAFT" || row.sku !== EACH_SKU || Number(row.requested_quantity) !== 1)) {
            throw new Error("Post-commit order verification failed.");
        }
        const result = { ...summary, item: itemVerification.rows[0], correctedOrders: verification.rows, sideEffects: { inventoryConverted: 0, released: 0, allocated: 0, emailed: 0, printed: 0 } };
        console.log(JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        try { await client.query("rollback"); } catch {}
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

module.exports = { main };

if (require.main === module) {
    main({ apply: process.argv.includes("--apply") }).catch((error) => {
        console.error(error.stack || error.message || error);
        process.exit(1);
    });
}
