const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Pool } = require("pg");

const ACCOUNT = "WELLFORIA HEALTH INC";
const WAREHOUSE = "GW3PL-MISS";
const ALLOWED_SKUS = new Set(["WW-12PK-EA", "TP-WW-6PK-UPC"]);

function normalize(value) {
    return String(value || "").trim();
}

function key(value) {
    return normalize(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function decodePayload(encoded) {
    if (!encoded) throw new Error("The source payload is required.");
    const json = zlib.gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
    const payload = JSON.parse(json);
    if (!Array.isArray(payload.orders) || payload.orders.length === 0) throw new Error("No source orders were supplied.");
    const digest = crypto.createHash("sha256").update(JSON.stringify(payload.orders)).digest("hex");
    if (digest !== payload.ordersSha256) throw new Error("The source order digest does not match.");
    return payload;
}

function validateOrders(orders) {
    const references = new Set();
    for (const order of orders) {
        for (const field of ["reference", "name", "phone", "address1", "city", "state", "postalCode", "country", "requestedShipDate", "sku"]) {
            if (!normalize(order[field])) throw new Error(`Source row ${order.sourceRow}: ${field} is required.`);
        }
        if (!ALLOWED_SKUS.has(normalize(order.sku).toUpperCase())) throw new Error(`Source row ${order.sourceRow}: unsupported SKU ${order.sku}.`);
        if (!Number.isInteger(order.quantity) || order.quantity <= 0) throw new Error(`Source row ${order.sourceRow}: quantity must be a positive integer.`);
        const reference = normalize(order.reference).toUpperCase();
        if (references.has(reference)) throw new Error(`Duplicate source reference ${reference}.`);
        references.add(reference);
    }
}

async function loadState(client, orders) {
    const references = orders.map((order) => normalize(order.reference).toUpperCase());
    const [account, warehouse, items, duplicateReferences, recentCandidates] = await Promise.all([
        client.query("select name,is_active from owner_accounts where name=$1", [ACCOUNT]),
        client.query(
            `select fl.id,fl.code,fl.name,fl.is_active,cfl.is_primary,cfl.allow_storage
             from company_fulfillment_locations cfl
             join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
             where cfl.account_name=$1 and fl.code=$2`,
            [ACCOUNT, WAREHOUSE]
        ),
        client.query(
            `select sku,description,tracking_level,unit_uom,units_per_case,blocked
             from item_catalog where account_name=$1 and sku=any($2::text[]) order by sku`,
            [ACCOUNT, [...ALLOWED_SKUS]]
        ),
        client.query(
            `select order_code,po_number,shipping_reference,status
             from portal_orders
             where account_name=$1 and (upper(po_number)=any($2::text[]) or upper(shipping_reference)=any($2::text[]))`,
            [ACCOUNT, references]
        ),
        client.query(
            `select o.order_code,o.status,o.ship_to_name,o.ship_to_phone,o.ship_to_postal_code,
                    l.sku,l.requested_quantity
             from portal_orders o
             join portal_order_lines l on l.order_id=o.id
             where o.account_name=$1 and o.created_at >= now() - interval '45 days'`,
            [ACCOUNT]
        )
    ]);
    return { account: account.rows, warehouse: warehouse.rows, items: items.rows, duplicateReferences: duplicateReferences.rows, recentCandidates: recentCandidates.rows };
}

function assertState(state, orders) {
    if (state.account.length !== 1 || state.account[0].name !== ACCOUNT || state.account[0].is_active !== true) throw new Error("Exact active Wellforia tenant verification failed.");
    if (state.warehouse.length !== 1 || state.warehouse[0].code !== WAREHOUSE || state.warehouse[0].is_active !== true || state.warehouse[0].allow_storage !== true) throw new Error("Exact active Mississauga warehouse verification failed.");
    if (state.items.length !== ALLOWED_SKUS.size) throw new Error("One or more required Wellforia SKUs are missing.");
    if (state.items.some((item) => item.blocked)) throw new Error("A required Wellforia SKU is blocked.");
    if (state.duplicateReferences.length) throw new Error(`Existing WMS references block this import: ${state.duplicateReferences.map((row) => row.order_code).join(", ")}.`);
    const duplicateRecipients = [];
    for (const order of orders) {
        const match = state.recentCandidates.find((row) =>
            key(row.ship_to_name) === key(order.name)
            && key(row.ship_to_phone) === key(order.phone)
            && key(row.ship_to_postal_code) === key(order.postalCode)
            && normalize(row.sku).toUpperCase() === normalize(order.sku).toUpperCase()
            && Number(row.requested_quantity) === order.quantity
        );
        if (match) duplicateRecipients.push({ sourceRow: order.sourceRow, orderCode: match.order_code, status: match.status });
    }
    if (duplicateRecipients.length) throw new Error(`Possible recipient duplicates block this import: ${duplicateRecipients.map((row) => `row ${row.sourceRow} -> ${row.orderCode}`).join(", ")}.`);
}

async function insertDraft(client, warehouseId, order, payload) {
    const email = normalize(order.email).replace(/\s+/g, "");
    const noteParts = [
        `Imported from ${normalize(payload.sourceFileName)}`,
        `source row ${order.sourceRow}`,
        `source SHA-256 ${normalize(payload.sourceFileSha256)}`,
        email ? `consumer email ${email}` : "consumer email not supplied"
    ];
    const inserted = await client.query(
        `insert into portal_orders (
            account_name,status,po_number,shipping_reference,contact_name,contact_phone,
            requested_ship_date,order_type,shipment_method,order_notes,
            ship_to_name,ship_to_address1,ship_to_address2,ship_to_city,ship_to_state,
            ship_to_postal_code,ship_to_country,ship_to_phone,fulfillment_location_id,
            ship_to_address_status
         ) values ($1,'DRAFT',$2,$2,$3,$4,$5,'B2C_ONLINE','PARCEL',$6,$3,$7,$8,$9,$10,$11,$12,$4,$13,'SAVED')
         returning id`,
        [
            ACCOUNT,
            normalize(order.reference).toUpperCase(),
            normalize(order.name),
            normalize(order.phone),
            normalize(order.requestedShipDate),
            noteParts.join(" | "),
            normalize(order.address1),
            normalize(order.address2),
            normalize(order.city),
            normalize(order.state).toUpperCase(),
            normalize(order.postalCode).toUpperCase(),
            normalize(order.country).toUpperCase(),
            warehouseId
        ]
    );
    const id = inserted.rows[0].id;
    const orderCode = `ORD-${String(id).padStart(6, "0")}`;
    await client.query("update portal_orders set order_code=$2,updated_at=now() where id=$1", [id, orderCode]);
    await client.query(
        `insert into portal_order_lines (order_id,line_number,sku,requested_quantity) values ($1,1,$2,$3)`,
        [id, normalize(order.sku).toUpperCase(), order.quantity]
    );
    return { id: String(id), orderCode, reference: normalize(order.reference).toUpperCase(), sku: normalize(order.sku).toUpperCase(), quantity: order.quantity };
}

async function main({ apply = false, payloadBase64 = "" } = {}) {
    const payload = decodePayload(payloadBase64 || process.env.WELLFORIA_CONSUMER_ORDER_PAYLOAD_B64 || "");
    validateOrders(payload.orders);
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL || "";
    if (!connectionString) throw new Error("Database connection is not configured.");
    const pool = new Pool({ connectionString, ssl: false });
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`wellforia-consumer-import:${payload.ordersSha256}`]);
        const state = await loadState(client, payload.orders);
        assertState(state, payload.orders);
        const summary = {
            mode: apply ? "APPLY" : "PREFLIGHT",
            account: state.account[0],
            warehouse: state.warehouse[0],
            sourceFileName: payload.sourceFileName,
            sourceFileSha256: payload.sourceFileSha256,
            sourceOrderDigest: payload.ordersSha256,
            orderCount: payload.orders.length,
            quantityBySku: payload.orders.reduce((result, order) => {
                result[order.sku] = (result[order.sku] || 0) + order.quantity;
                return result;
            }, {}),
            items: state.items
        };
        if (!apply) {
            await client.query("rollback");
            console.log(JSON.stringify(summary, null, 2));
            return summary;
        }
        const created = [];
        for (const order of payload.orders) created.push(await insertDraft(client, state.warehouse[0].id, order, payload));
        await client.query("commit");
        const verification = await pool.query(
            `select o.order_code,o.po_number,o.status,o.fulfillment_location_id,l.sku,l.requested_quantity
             from portal_orders o join portal_order_lines l on l.order_id=o.id
             where o.account_name=$1 and upper(o.po_number)=any($2::text[])
             order by o.id`,
            [ACCOUNT, created.map((order) => order.reference)]
        );
        if (verification.rowCount !== created.length || verification.rows.some((row) => row.status !== "DRAFT" || String(row.fulfillment_location_id) !== String(state.warehouse[0].id))) {
            throw new Error("Post-commit verification failed; manual review is required.");
        }
        const result = { ...summary, created, verifiedCount: verification.rowCount, sideEffects: { released: 0, allocated: 0, emailed: 0, printed: 0 } };
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
