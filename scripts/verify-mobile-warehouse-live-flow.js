const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    APP_USER_ROLES,
    upsertInventoryLine,
    savePortalOrderDraftForAccount,
    releasePortalOrderForAccount,
    getPortalOrderById,
    updateAdminPortalOrderStatus,
    savePortalInboundForAccount,
    updateAdminPortalInboundStatus
} = require("../server");

const ACCOUNT_ID = 1510;
const ACCOUNT_NAME = "CODEX PORTAL SYSTEM TEST";
const MODE = String(process.env.MOBILE_E2E_MODE || "verify").trim().toLowerCase();
const RUN_KEY = String(process.env.MOBILE_E2E_RUN_KEY || "").trim().toUpperCase();
const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "mobile-e2e@wms365.co",
    full_name: "Mobile E2E Verifier"
};
const PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function assertRunKey() {
    if (!/^TEST[0-9A-Z]{6,18}$/.test(RUN_KEY)) throw new Error("MOBILE_E2E_RUN_KEY must be TEST plus 6-18 letters or digits.");
}

function names() {
    const short = RUN_KEY.slice(-8);
    const warehouseCode = `MOB${short}`;
    return {
        short,
        warehouseCode,
        storageLocation: `${warehouseCode}-A01`,
        receivingLocation: `${warehouseCode}-REC`,
        sku: `TEST-MOBILE-${RUN_KEY}`,
        poNumber: `TEST-MOBILE-SHIP-${RUN_KEY}`,
        inboundReference: `TEST-MOBILE-RECEIVE-${RUN_KEY}`,
        tracking: `TEST-TRACK-${RUN_KEY}`
    };
}

async function findFixture(client, fixture) {
    const orderResult = await client.query(
        "select id,order_code,status,account_name,shipment_email_status from portal_orders where po_number=$1 and account_name=$2 order by id desc limit 2",
        [fixture.poNumber, ACCOUNT_NAME]
    );
    const inboundResult = await client.query(
        "select id,inbound_code,status,account_name from portal_inbounds where reference_number=$1 and account_name=$2 order by id desc limit 2",
        [fixture.inboundReference, ACCOUNT_NAME]
    );
    if (orderResult.rowCount > 1 || inboundResult.rowCount > 1) throw new Error("Test-run key is not unique.");
    return { order: orderResult.rows[0] || null, inbound: inboundResult.rows[0] || null };
}

async function prepare(client, fixture) {
    const existing = await findFixture(client, fixture);
    if (existing.order || existing.inbound) throw new Error("This test-run key already exists; choose a new key.");
    const warehouseResult = await client.query(
        `insert into fulfillment_locations
            (code,name,partner_name,location_type,address1,city,state,postal_code,country)
         values ($1,$2,'WMS365 Test','OWN_WAREHOUSE','1510 Test Drive','Mississauga','ON','L5T 1V6','Canada') returning id`,
        [fixture.warehouseCode, `Mobile E2E ${RUN_KEY}`]
    );
    const warehouseId = warehouseResult.rows[0].id;
    await client.query(
        `insert into company_fulfillment_locations
            (account_name,fulfillment_location_id,is_primary,allow_inbound,allow_outbound,allow_storage)
         values ($1,$2,false,true,true,true)`,
        [ACCOUNT_NAME, warehouseId]
    );
    for (const [code, type, pickable] of [[fixture.storageLocation, "STORAGE", true], [fixture.receivingLocation, "RECEIVING_STAGE", false]]) {
        await client.query("insert into bin_locations (code,note,location_type,is_pickable) values ($1,$2,$3,$4)", [code, `Mobile E2E ${RUN_KEY}`, type, pickable]);
    }
    await client.query(
        "insert into item_catalog (account_name,sku,description,tracking_level) values ($1,$2,$3,'CASE')",
        [ACCOUNT_NAME, fixture.sku, `Mobile E2E item ${RUN_KEY}`]
    );
    await upsertInventoryLine(client, { accountName: ACCOUNT_NAME, location: fixture.storageLocation, sku: fixture.sku, quantity: 10, trackingLevel: "CASE" }, {
        transactionType: "RECEIVING", sourceType: "MOBILE_E2E_FIXTURE", sourceId: RUN_KEY, appUser: ACTOR, idempotencyKey: `${RUN_KEY}-seed`
    });
    const today = new Date().toISOString().slice(0, 10);
    let order = await savePortalOrderDraftForAccount(client, ACCOUNT_NAME, {
        poNumber: fixture.poNumber, shippingReference: fixture.poNumber, contactName: "Test Receiver", contactPhone: "905-555-0151",
        requestedShipDate: today, orderType: "RETAIL_WHOLESALE", shipmentMethod: "LTL", fulfillmentLocationId: warehouseId,
        shipToName: "WMS365 Test Receiver", shipToAddress1: "1510 Test Street", shipToCity: "Mississauga", shipToState: "ON",
        shipToPostalCode: "L5T 1V6", shipToCountry: "Canada", lines: [{ sku: fixture.sku, quantity: 2 }]
    }, null, { enforceInventoryAvailability: true, activityTitlePrefix: "mobile E2E test", activityActor: ACTOR.email });
    order = await releasePortalOrderForAccount(client, ACCOUNT_NAME, order.id, { activityActor: ACTOR.email, rushExempt: true, rushExemptNote: "Designated test-company E2E verification." });
    order = await updateAdminPortalOrderStatus(client, order.id, "PICKED", { idempotencyKey: `${RUN_KEY}-picked` }, ACTOR);
    order = await updateAdminPortalOrderStatus(client, order.id, "STAGED", { idempotencyKey: `${RUN_KEY}-staged` }, ACTOR);
    let inbound = await savePortalInboundForAccount(client, ACCOUNT_NAME, {
        referenceNumber: fixture.inboundReference, expectedDate: today, contactName: "Test Sender", carrierName: "Test Carrier",
        fulfillmentLocationId: warehouseId, lines: [{ sku: fixture.sku, quantity: 3 }]
    }, { activityTitlePrefix: "mobile E2E test", activityActor: ACTOR.email, creatorEmail: ACTOR.email, taskAppUser: ACTOR });
    inbound = await updateAdminPortalInboundStatus(client, inbound.id, "ARRIVED", ACTOR, { note: `Mobile E2E ${RUN_KEY} ready for receiving` });
    return { orderCode: order.orderCode, orderId: order.id, orderStatus: order.status, inboundCode: inbound.inboundCode, inboundId: inbound.id, inboundStatus: inbound.status };
}

async function apply(client, fixture) {
    const found = await findFixture(client, fixture);
    if (!found.order || !found.inbound) throw new Error("Prepared test fixture was not found.");
    if (found.order.account_name !== ACCOUNT_NAME || found.inbound.account_name !== ACCOUNT_NAME) throw new Error("Test fixture tenant mismatch.");
    if (found.inbound.status === "ARRIVED") {
        const lines = await client.query("select id,sku,expected_quantity from portal_inbound_lines where inbound_id=$1", [found.inbound.id]);
        if (lines.rowCount !== 1 || lines.rows[0].sku !== fixture.sku || Number(lines.rows[0].expected_quantity) !== 3) throw new Error("Inbound line mismatch.");
        await updateAdminPortalInboundStatus(client, found.inbound.id, "RECEIVED", ACTOR, {
            receivingLocation: fixture.receivingLocation,
            lines: [{ id: lines.rows[0].id, receivedQuantity: 3, receivedLocation: fixture.receivingLocation, palletReference: `TEST-PALLET-${RUN_KEY}` }]
        });
    }
    let order = await getPortalOrderById(client, found.order.id, ACCOUNT_NAME);
    if (order.status === "STAGED") {
        if (order.lines.length !== 1 || order.lines[0].sku !== fixture.sku || Number(order.lines[0].quantity) !== 2) throw new Error("Order line mismatch.");
        order = await updateAdminPortalOrderStatus(client, order.id, "SHIPPED", {
            idempotencyKey: `${RUN_KEY}-shipped`, confirmedShipDate: new Date().toISOString().slice(0, 10), shipmentMethod: "LTL_FREIGHT",
            carrierName: "TEST CARRIER", trackingReference: fixture.tracking, packingSlipQuantityConfirmed: true, moveShortageToInvestigation: false,
            note: `Designated test-company mobile closeout ${RUN_KEY}.`,
            outboundPallets: { totalPalletsOut: 1, existingPalletsOut: 1, newPalletsUsed: 0, mixedPalletsBuilt: 0, palletNote: "TEST pallet" },
            shippedLines: [{ orderLineId: order.lines[0].id, sku: fixture.sku, shippedQuantity: 2 }],
            documents: [
                { fileName: `${RUN_KEY}-signed-bol.png`, fileType: "image/png", documentCategory: "SHIPMENT_BOL", dataUrl: PIXEL_PNG },
                { fileName: `${RUN_KEY}-checked-packing-slip.png`, fileType: "image/png", documentCategory: "SHIPMENT_PACKING_SLIP", dataUrl: PIXEL_PNG },
                { fileName: `${RUN_KEY}-loaded-freight.png`, fileType: "image/png", documentCategory: "SHIPMENT_LOAD_PHOTO", dataUrl: PIXEL_PNG }
            ]
        }, ACTOR);
        await client.query("update portal_orders set shipment_email_status='SKIPPED',shipment_email_last_error=$2 where id=$1", [order.id, `Designated test-company E2E ${RUN_KEY}; external email prohibited`]);
    }
    return { orderCode: found.order.order_code, inboundCode: found.inbound.inbound_code };
}

async function verify(client, fixture) {
    const found = await findFixture(client, fixture);
    if (!found.order || !found.inbound) throw new Error("Test fixture was not found for verification.");
    const [receipt, stock, shipmentLines, documents, transactions] = await Promise.all([
        client.query("select received_quantity,received_location from portal_inbound_lines where inbound_id=$1", [found.inbound.id]),
        client.query("select location,quantity from inventory_lines where account_name=$1 and sku=$2 and location in ($3,$4) order by location", [ACCOUNT_NAME, fixture.sku, fixture.receivingLocation, fixture.storageLocation]),
        client.query("select shipped_quantity from portal_order_shipment_lines where order_id=$1", [found.order.id]),
        client.query("select document_category,count(*)::integer count from portal_order_documents where order_id=$1 group by document_category order by document_category", [found.order.id]),
        client.query("select transaction_type,quantity_delta from inventory_transactions where account_name=$1 and sku=$2 order by id", [ACCOUNT_NAME, fixture.sku])
    ]);
    const byLocation = Object.fromEntries(stock.rows.map(row => [row.location, Number(row.quantity)]));
    const result = {
        accountId: ACCOUNT_ID, accountName: ACCOUNT_NAME, runKey: RUN_KEY,
        inbound: { code: found.inbound.inbound_code, status: found.inbound.status, receivedQuantity: Number(receipt.rows[0]?.received_quantity || 0), location: receipt.rows[0]?.received_location || "" },
        order: { code: found.order.order_code, status: found.order.status, emailStatus: found.order.shipment_email_status, orderedQuantity: 2, shippedQuantity: Number(shipmentLines.rows[0]?.shipped_quantity || 0) },
        inventory: { storage: byLocation[fixture.storageLocation] || 0, receiving: byLocation[fixture.receivingLocation] || 0 },
        documents: documents.rows,
        ledger: transactions.rows.map(row => ({ type: row.transaction_type, delta: Number(row.quantity_delta) }))
    };
    if (result.inbound.status !== "RECEIVED_PENDING_PUTAWAY" || result.inbound.receivedQuantity !== 3 || result.inbound.location !== fixture.receivingLocation) throw new Error(`Inbound verification failed: ${JSON.stringify(result)}`);
    if (result.order.status !== "SHIPPED" || result.order.emailStatus !== "SKIPPED" || result.order.shippedQuantity !== 2) throw new Error(`Shipment verification failed: ${JSON.stringify(result)}`);
    if (result.inventory.storage !== 8 || result.inventory.receiving !== 3) throw new Error(`Inventory verification failed: ${JSON.stringify(result)}`);
    if (result.documents.length !== 3 || result.documents.some(row => Number(row.count) !== 1)) throw new Error(`Proof verification failed: ${JSON.stringify(result)}`);
    return result;
}

async function main() {
    assertRunKey();
    if (!["prepare", "apply", "verify"].includes(MODE)) throw new Error("MOBILE_E2E_MODE must be prepare, apply, or verify.");
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const company = await requireDesignatedTestCompany(client);
        if (Number(company.id) !== ACCOUNT_ID || company.name !== ACCOUNT_NAME) throw new Error("Pinned designated test company identity mismatch.");
        const fixture = names();
        if (MODE === "verify") {
            await client.query("begin read only");
            const result = await verify(client, fixture);
            await client.query("commit");
            console.log(JSON.stringify(result));
            return;
        }
        await client.query("begin");
        const result = MODE === "prepare" ? await prepare(client, fixture) : await apply(client, fixture);
        await client.query("commit");
        console.log(JSON.stringify({ accountId: ACCOUNT_ID, accountName: ACCOUNT_NAME, runKey: RUN_KEY, ...fixture, ...result }));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch(error => { console.error(error.stack || error.message || error); process.exitCode = 1; });
