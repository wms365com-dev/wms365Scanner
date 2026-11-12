const { Client } = require("pg");
const { getPortalOrderById } = require("../server");

const APPLY = process.argv.includes("--apply");
const CONFIRMATION = "APPROVED_HEALTEA_TEMP_OVERSELL_2026_09_10";
const ACCOUNT_NAME = "HEALTEA";
const SKU = "20628693486143";
const WAREHOUSE_CODE = "GW3PL-MISS";
const MAX_OVERSELL_QUANTITY = 61;
const EXPIRES_AT = "2026-09-15T04:00:00.000Z";
const REASON = "Temporary two-business-day release exception approved by WMS365 ownership on 2026-09-10. The 61-case cap matches legacy staged reservations under review; physical inventory must still be confirmed before shipment.";

async function readAudit(client) {
    const company = await client.query(
        "select name, is_active from owner_accounts where name=$1",
        [ACCOUNT_NAME]
    );
    const item = await client.query(
        `select account_name, sku, description, tracking_level, blocked
         from item_catalog where account_name=$1 and sku=$2`,
        [ACCOUNT_NAME, SKU]
    );
    const warehouse = await client.query(
        `select fl.id, fl.code, fl.name, cfl.allow_outbound
         from company_fulfillment_locations cfl
         join fulfillment_locations fl on fl.id=cfl.fulfillment_location_id
         where cfl.account_name=$1 and fl.code=$2 and fl.is_active=true`,
        [ACCOUNT_NAME, WAREHOUSE_CODE]
    );
    const inventory = await client.query(
        `select coalesce(sum(i.quantity),0)::integer as on_hand_quantity
         from inventory_lines i
         left join bin_locations b on b.code=i.location
         where i.account_name=$1 and i.sku=$2
           and coalesce(b.is_pickable,true)=true
           and coalesce(b.location_type,'STORAGE') not in ('HOLD','INVESTIGATION','DAMAGED','QUARANTINE','QC','QA_HOLD')`,
        [ACCOUNT_NAME, SKU]
    );
    const commitments = await client.query(
        `select coalesce(sum(a.allocated_quantity),0)::integer as allocated_quantity,
                coalesce(sum(case when a.is_oversell=true then a.allocated_quantity else 0 end),0)::integer as oversell_quantity
         from portal_order_allocations a
         join portal_orders o on o.id=a.order_id
         where o.account_name=$1 and a.sku=$2 and o.status=any($3::text[])`,
        [ACCOUNT_NAME, SKU, ["RELEASED", "PICKED", "STAGED"]]
    );
    const policies = await client.query(
        `select p.id, p.account_name, p.sku, p.fulfillment_location_id, fl.code as warehouse_code,
                p.starts_at, p.expires_at, p.max_oversell_quantity, p.reason, p.created_by,
                p.is_active,
                (p.is_active=true and p.starts_at<=now() and p.expires_at>now()) as currently_effective
         from temporary_sku_oversell_policies p
         left join fulfillment_locations fl on fl.id=p.fulfillment_location_id
         where p.account_name=$1 and p.sku=$2
         order by p.created_at desc, p.id desc`,
        [ACCOUNT_NAME, SKU]
    );
    const draft = await client.query(
        `select distinct o.id, o.order_code
         from portal_orders o
         join portal_order_lines l on l.order_id=o.id
         where o.account_name=$1 and l.sku=$2 and o.status='DRAFT'
         order by o.id desc limit 1`,
        [ACCOUNT_NAME, SKU]
    );
    return {
        company: company.rows[0] || null,
        item: item.rows[0] || null,
        warehouse: warehouse.rows[0] || null,
        inventory: inventory.rows[0] || null,
        commitments: commitments.rows[0] || null,
        policies: policies.rows,
        draft: draft.rows[0] || null
    };
}

function assertSetup(audit) {
    if (!audit.company || audit.company.is_active !== true) throw new Error("Healtea is not active.");
    if (!audit.item || audit.item.blocked === true) throw new Error(`${SKU} is missing or blocked for Healtea.`);
    if (!audit.warehouse || audit.warehouse.allow_outbound !== true) throw new Error("Healtea is not enabled for outbound orders at Grey Wolf Mississauga.");
    if (Number(audit.inventory?.on_hand_quantity || 0) <= 0) throw new Error(`${SKU} has no pickable inventory row to anchor a temporary oversell allocation.`);
}

async function applyPolicy(client, warehouseId) {
    await client.query("begin");
    try {
        await client.query(
            `update temporary_sku_oversell_policies
             set is_active=false, updated_at=now()
             where account_name=$1 and sku=$2 and fulfillment_location_id=$3 and is_active=true`,
            [ACCOUNT_NAME, SKU, warehouseId]
        );
        const inserted = await client.query(
            `insert into temporary_sku_oversell_policies (
                account_name, sku, fulfillment_location_id, starts_at, expires_at,
                max_oversell_quantity, reason, created_by, is_active
             ) values ($1,$2,$3,now(),$4::timestamptz,$5,$6,$7,true)
             returning id`,
            [ACCOUNT_NAME, SKU, warehouseId, EXPIRES_AT, MAX_OVERSELL_QUANTITY, REASON, "WMS365 owner request"]
        );
        await client.query(
            `insert into activity_log (type,title,details)
             values ('inventory',$1,$2)`,
            [
                `Enabled temporary oversell for ${ACCOUNT_NAME} / ${SKU}`,
                `${WAREHOUSE_CODE} | Maximum ${MAX_OVERSELL_QUANTITY} cases | Expires after Monday, September 14, 2026 Eastern | On-hand inventory was not changed.`
            ]
        );
        await client.query("commit");
        return String(inserted.rows[0].id);
    } catch (error) {
        await client.query("rollback");
        throw error;
    }
}

async function main() {
    const connectionString = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required.");
    if (APPLY && process.env.CONFIRM_HEALTEA_TEMP_OVERSELL !== CONFIRMATION) {
        throw new Error(`Set CONFIRM_HEALTEA_TEMP_OVERSELL=${CONFIRMATION} before applying this live policy.`);
    }
    const client = new Client({ connectionString, ssl: false });
    await client.connect();
    try {
        const before = await readAudit(client);
        assertSetup(before);
        if (!APPLY) {
            console.log(JSON.stringify({
                mode: "audit",
                ok: true,
                requestedPolicy: {
                    accountName: ACCOUNT_NAME,
                    sku: SKU,
                    warehouseCode: WAREHOUSE_CODE,
                    maxOversellQuantity: MAX_OVERSELL_QUANTITY,
                    expiresAt: EXPIRES_AT
                },
                before
            }, null, 2));
            return;
        }

        const policyId = await applyPolicy(client, before.warehouse.id);
        const after = await readAudit(client);
        const policy = after.policies.find((entry) => String(entry.id) === policyId);
        if (!policy?.currently_effective) throw new Error("The new temporary oversell policy is not effective.");

        let draftVerification = null;
        if (after.draft) {
            const order = await getPortalOrderById(client, after.draft.id, ACCOUNT_NAME, "/api/admin/portal-order-documents");
            const warning = order?.stockWarnings?.find((entry) => entry.sku === SKU) || null;
            if (!warning || warning.blocking !== false || warning.temporaryOversellAllowed !== true) {
                throw new Error(`${after.draft.order_code} did not receive the expected non-blocking temporary oversell notice.`);
            }
            draftVerification = {
                orderCode: after.draft.order_code,
                status: order.status,
                warning,
                releaseRemainsManual: true
            };
        }

        const onHandQuantity = Number(after.inventory.on_hand_quantity) || 0;
        const allocatedQuantity = Number(after.commitments.allocated_quantity) || 0;
        const physicalAvailable = Math.max(onHandQuantity - allocatedQuantity, 0);
        console.log(JSON.stringify({
            mode: "apply",
            ok: true,
            policy,
            inventoryUnchanged: before.inventory.on_hand_quantity === after.inventory.on_hand_quantity,
            physicalAvailable,
            temporaryAdditionalReleaseCapacity: MAX_OVERSELL_QUANTITY,
            effectiveReleaseCapacity: physicalAvailable + MAX_OVERSELL_QUANTITY,
            draftVerification,
            isolation: {
                accountName: ACCOUNT_NAME,
                sku: SKU,
                warehouseCode: WAREHOUSE_CODE,
                otherCompaniesChanged: false,
                otherSkusChanged: false
            }
        }, null, 2));
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
    process.exitCode = 1;
});
