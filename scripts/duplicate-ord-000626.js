const {
    APP_USER_ROLES,
    duplicateWarehousePortalOrder,
    getPortalOrderById,
    withTransaction
} = require("../server");

const ORDER_CODE = "ORD-000626";
const APPLY = process.argv.includes("--apply");
const actor = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "k.prathab@gmail.com",
    full_name: "WMS365 owner-approved order duplication"
};

function lineSignature(order) {
    return (order.lines || []).map((line) => ({
        line: Number(line.lineNumber),
        sku: String(line.sku || ""),
        quantity: Number(line.quantity)
    }));
}

async function inspect(client, { lock = false } = {}) {
    const sourceResult = await client.query(
        `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id,
                fl.code warehouse_code,fl.name warehouse_name,fl.is_active warehouse_active
         from portal_orders o
         join fulfillment_locations fl on fl.id=o.fulfillment_location_id
         where upper(o.order_code)=upper($1)
         ${lock ? "for update of o" : ""}`,
        [ORDER_CODE]
    );
    if (sourceResult.rowCount !== 1) {
        throw new Error(sourceResult.rowCount ? `${ORDER_CODE} is not unique.` : `${ORDER_CODE} was not found.`);
    }
    const identity = sourceResult.rows[0];
    if (!identity.account_name || !identity.fulfillment_location_id || !identity.warehouse_active) {
        throw new Error("The source company or warehouse assignment is not active and complete.");
    }
    if (!["DRAFT", "RELEASED", "PICKED", "STAGED", "SHIPPED"].includes(identity.status)) {
        throw new Error(`${ORDER_CODE} is ${identity.status} and cannot be duplicated.`);
    }
    const source = await getPortalOrderById(client, identity.id, identity.account_name);
    if (!source || !source.lines?.length) throw new Error("The source order has no readable order lines.");

    const linked = await client.query(
        `select o.id,o.order_code,o.account_name,o.status,o.fulfillment_location_id
         from portal_orders o where o.duplicated_from_order_id=$1`,
        [identity.id]
    );
    if (linked.rowCount > 1) throw new Error("More than one linked duplicate already exists; review is required.");
    const expectedCode = `${ORDER_CODE.replace(/-R$/i, "")}-R`;
    const collision = await client.query(
        `select id,order_code,duplicated_from_order_id from portal_orders
         where upper(order_code)=upper($1) and id<>$2`,
        [expectedCode, linked.rows[0]?.id || 0]
    );
    if (collision.rowCount) throw new Error(`${expectedCode} already exists without the expected source link.`);

    let duplicate = null;
    if (linked.rowCount === 1) {
        const row = linked.rows[0];
        duplicate = await getPortalOrderById(client, row.id, identity.account_name);
        if (!duplicate || row.account_name !== identity.account_name
            || String(row.fulfillment_location_id) !== String(identity.fulfillment_location_id)) {
            throw new Error("The existing duplicate does not match the source company and warehouse.");
        }
    }
    return { identity, source, duplicate, expectedCode };
}

async function verifyDraft(client, before, duplicate) {
    if (!duplicate || duplicate.orderCode !== before.expectedCode || duplicate.status !== "DRAFT") {
        throw new Error("The duplicate did not verify as the expected draft order.");
    }
    if (duplicate.accountName !== before.source.accountName
        || String(duplicate.fulfillmentLocationId) !== String(before.source.fulfillmentLocationId)) {
        throw new Error("The duplicate company or warehouse does not match the source order.");
    }
    if (JSON.stringify(lineSignature(duplicate)) !== JSON.stringify(lineSignature(before.source))) {
        throw new Error("The duplicate line items do not match the source order.");
    }
    const sideEffects = await client.query(
        `select
            (select count(*)::integer from portal_order_allocations where order_id=$1) allocations,
            (select count(*)::integer from warehouse_shipments where order_id=$1) shipments`,
        [duplicate.id]
    );
    if (sideEffects.rows[0].allocations || sideEffects.rows[0].shipments) {
        throw new Error("The duplicate draft unexpectedly has allocations or shipment records.");
    }
    return sideEffects.rows[0];
}

async function main(args = process.argv.slice(2)) {
    const apply = args.includes("--apply") || APPLY;
    const result = await withTransaction(async (client) => {
        if (!apply) await client.query("set transaction read only");
        const before = await inspect(client, { lock: apply });
        let duplicate = before.duplicate;
        let alreadyExists = !!duplicate;
        if (apply && !duplicate) {
            const created = await duplicateWarehousePortalOrder(client, before.identity.id, actor);
            duplicate = created.order;
            alreadyExists = created.alreadyExists;
        }
        const sideEffects = duplicate ? await verifyDraft(client, before, duplicate) : null;
        const sourceCheck = await client.query("select status from portal_orders where id=$1", [before.identity.id]);
        if (sourceCheck.rows[0]?.status !== before.identity.status) throw new Error("The source order status changed unexpectedly.");
        return {
            mode: apply ? "APPLIED" : "PREFLIGHT",
            source: {
                id: before.identity.id,
                orderCode: before.identity.order_code,
                accountName: before.identity.account_name,
                warehouseCode: before.identity.warehouse_code,
                warehouseName: before.identity.warehouse_name,
                status: before.identity.status,
                lineCount: before.source.lines.length,
                totalQuantity: before.source.lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0)
            },
            duplicate: duplicate ? {
                id: duplicate.id,
                orderCode: duplicate.orderCode,
                status: duplicate.status,
                lineCount: duplicate.lines.length,
                totalQuantity: duplicate.lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0),
                allocations: sideEffects.allocations,
                shipments: sideEffects.shipments,
                alreadyExists
            } : { orderCode: before.expectedCode, status: "NOT_CREATED" }
        };
    });
    console.log(JSON.stringify(result));
    return result;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}

module.exports = { main };
