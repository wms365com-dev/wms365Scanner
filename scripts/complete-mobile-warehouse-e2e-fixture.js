const { Client } = require("pg");
const { requireDesignatedTestCompany } = require("./designated-test-company");
const {
    APP_USER_ROLES,
    getPortalOrderById,
    updateAdminPortalInboundStatus,
    updateAdminPortalOrderStatus
} = require("../server");

const FIXTURE = {
    accountId: 1510,
    accountName: "CODEX PORTAL SYSTEM TEST",
    sku: "TEST-MOBILE-MV9NEVHC",
    storageLocation: "MOB9NEVHC-A01",
    receivingLocation: "MOB9NEVHC-REC",
    orderId: 1627,
    orderCode: "ORD-001627",
    inboundId: 216,
    inboundCode: "INB-000216"
};

const ACTOR = {
    role: APP_USER_ROLES.SUPER_ADMIN,
    email: "mobile-e2e@wms365.co",
    full_name: "Mobile E2E Verifier"
};

const PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function main() {
    const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        await client.query("begin");
        const company = await requireDesignatedTestCompany(client);
        if (Number(company.id) !== FIXTURE.accountId || company.name !== FIXTURE.accountName) {
            throw new Error("Pinned designated test company identity mismatch.");
        }

        const inboundResult = await client.query(
            "select id,inbound_code,status,account_name from portal_inbounds where id=$1 and inbound_code=$2",
            [FIXTURE.inboundId, FIXTURE.inboundCode]
        );
        if (inboundResult.rowCount !== 1 || inboundResult.rows[0].account_name !== FIXTURE.accountName) {
            throw new Error("Pinned test inbound identity mismatch.");
        }
        if (inboundResult.rows[0].status === "ARRIVED") {
            const lineResult = await client.query(
                "select id,sku,expected_quantity from portal_inbound_lines where inbound_id=$1 order by id",
                [FIXTURE.inboundId]
            );
            if (lineResult.rowCount !== 1 || lineResult.rows[0].sku !== FIXTURE.sku || Number(lineResult.rows[0].expected_quantity) !== 3) {
                throw new Error("Test inbound line does not match the reviewed fixture.");
            }
            await updateAdminPortalInboundStatus(client, FIXTURE.inboundId, "RECEIVED", ACTOR, {
                receivingLocation: FIXTURE.receivingLocation,
                lines: [{
                    id: lineResult.rows[0].id,
                    receivedQuantity: 3,
                    receivedLocation: FIXTURE.receivingLocation,
                    palletReference: "TEST-PALLET-1"
                }]
            });
        }

        let order = await getPortalOrderById(client, FIXTURE.orderId, FIXTURE.accountName);
        if (!order || order.orderCode !== FIXTURE.orderCode || order.accountName !== FIXTURE.accountName) {
            throw new Error("Pinned test order identity mismatch.");
        }
        if (order.status === "STAGED") {
            if (order.lines.length !== 1 || order.lines[0].sku !== FIXTURE.sku || Number(order.lines[0].quantity) !== 2) {
                throw new Error("Test outbound line does not match the reviewed fixture.");
            }
            order = await updateAdminPortalOrderStatus(client, order.id, "SHIPPED", {
                idempotencyKey: "mobile-e2e-mv9nevhc-shipped",
                confirmedShipDate: "2026-10-15",
                shipmentMethod: "LTL_FREIGHT",
                carrierName: "TEST CARRIER",
                trackingReference: "TEST-MOBILE-MV9NEVHC",
                packingSlipQuantityConfirmed: true,
                moveShortageToInvestigation: false,
                note: "Designated test-company mobile closeout. One of two cases shipped to verify short-ship editing.",
                outboundPallets: {
                    totalPalletsOut: 1,
                    existingPalletsOut: 1,
                    newPalletsUsed: 0,
                    mixedPalletsBuilt: 0,
                    palletNote: "TEST pallet"
                },
                shippedLines: [{
                    orderLineId: order.lines[0].id,
                    sku: FIXTURE.sku,
                    shippedQuantity: 1
                }],
                documents: [
                    { fileName: "TEST-signed-bol.png", fileType: "image/png", documentCategory: "SHIPMENT_BOL", dataUrl: PIXEL_PNG },
                    { fileName: "TEST-checked-packing-slip.png", fileType: "image/png", documentCategory: "SHIPMENT_PACKING_SLIP", dataUrl: PIXEL_PNG },
                    { fileName: "TEST-loaded-freight.png", fileType: "image/png", documentCategory: "SHIPMENT_LOAD_PHOTO", dataUrl: PIXEL_PNG }
                ]
            }, ACTOR);
            await client.query(
                `update portal_orders set shipment_email_status='SKIPPED',
                    shipment_email_last_error='Designated test-company E2E; external email prohibited'
                 where id=$1`,
                [order.id]
            );
        }

        const verification = await Promise.all([
            client.query("select status from portal_inbounds where id=$1", [FIXTURE.inboundId]),
            client.query("select quantity from inventory_lines where account_name=$1 and location=$2 and sku=$3", [FIXTURE.accountName, FIXTURE.receivingLocation, FIXTURE.sku]),
            client.query("select status,shipment_email_status from portal_orders where id=$1", [FIXTURE.orderId]),
            client.query("select shipped_quantity from portal_order_shipment_lines where order_id=$1", [FIXTURE.orderId]),
            client.query("select document_category,count(*)::integer count from portal_order_documents where order_id=$1 group by document_category order by document_category", [FIXTURE.orderId]),
            client.query("select quantity from inventory_lines where account_name=$1 and location=$2 and sku=$3", [FIXTURE.accountName, FIXTURE.storageLocation, FIXTURE.sku])
        ]);
        const result = {
            accountId: FIXTURE.accountId,
            accountName: FIXTURE.accountName,
            inbound: { code: FIXTURE.inboundCode, status: verification[0].rows[0]?.status, receivedQuantity: Number(verification[1].rows[0]?.quantity || 0) },
            order: { code: FIXTURE.orderCode, status: verification[2].rows[0]?.status, emailStatus: verification[2].rows[0]?.shipment_email_status, orderedQuantity: 2, shippedQuantity: Number(verification[3].rows[0]?.shipped_quantity || 0), remainingStorageQuantity: Number(verification[5].rows[0]?.quantity || 0) },
            documents: verification[4].rows
        };
        if (result.inbound.status !== "RECEIVED_PENDING_PUTAWAY" || result.inbound.receivedQuantity !== 3) throw new Error(`Inbound verification failed: ${JSON.stringify(result)}`);
        if (result.order.status !== "SHIPPED" || result.order.emailStatus !== "SKIPPED" || result.order.shippedQuantity !== 1 || result.order.remainingStorageQuantity !== 9) throw new Error(`Shipment verification failed: ${JSON.stringify(result)}`);
        if (result.documents.length !== 3 || result.documents.some((row) => Number(row.count) !== 1)) throw new Error(`Document verification failed: ${JSON.stringify(result)}`);
        await client.query("commit");
        console.log(JSON.stringify(result));
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
