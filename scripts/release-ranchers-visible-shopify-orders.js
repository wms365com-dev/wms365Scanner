"use strict";

const assert = require("node:assert/strict");
const { Client } = require("pg");
const { releasePortalOrderForAccount } = require("../server");

const APPLY = process.argv.includes("--apply");
const ACCOUNT = "RANCHER'S CHIPS";
const STORE = "f1acxk-dc.myshopify.com";
const TARGETS = ["13548", "13547", "13546", "13544", "13543", "13533", "13532", "13528", "13526", "13525"];

function clean(value) {
    return String(value || "").trim().replace(/^(\"|')(.*)\1$/, "$2");
}

async function main() {
    const connectionString = clean(process.env.DATABASE_PRIVATE_URL) || clean(process.env.DATABASE_URL);
    if (!connectionString) throw new Error("Database connection is unavailable.");
    const db = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 15000 });
    await db.connect();
    try {
        const scope = (await db.query(
            `select id, account_name, provider, store_identifier, is_active
             from store_integrations where id=4`,
        )).rows[0];
        if (!scope || scope.account_name !== ACCOUNT || scope.provider !== "SHOPIFY"
            || scope.store_identifier !== STORE || scope.is_active !== true) {
            throw new Error("Rancher's integration identity check failed.");
        }
        const warehouse = (await db.query(
            `select id, code, is_active from fulfillment_locations where id=1`
        )).rows[0];
        if (!warehouse || warehouse.code !== "GW3PL-MISS" || warehouse.is_active !== true) {
            throw new Error("Rancher's warehouse identity check failed.");
        }

        const rows = (await db.query(
            `select o.id, o.order_code, o.status, o.fulfillment_location_id,
                    replace(so.shopify_order_number, '#', '') as shopify_order_number
             from portal_orders o
             join store_order_imports si on si.portal_order_id=o.id and si.integration_id=4
             join shopify_tracking_order_contacts so on so.order_id=o.id and so.integration_id=4
             where o.account_name=$1
               and replace(so.shopify_order_number, '#', '')=any($2::text[])
             order by o.order_code`,
            [ACCOUNT, TARGETS]
        )).rows;
        assert.equal(rows.length, TARGETS.length, "Not every requested Shopify order has one WMS import.");
        assert.deepEqual([...new Set(rows.map((row) => row.shopify_order_number))].sort(), [...TARGETS].sort());
        for (const row of rows) {
            assert.equal(Number(row.fulfillment_location_id), 1, `${row.order_code} is not assigned to GW3PL-MISS.`);
            assert.ok(["DRAFT", "RELEASED"].includes(row.status), `${row.order_code} is ${row.status}, not releasable.`);
        }

        const results = [];
        for (const row of rows) {
            if (row.status === "RELEASED") {
                results.push({ shopifyOrder: `#${row.shopify_order_number}`, wmsOrder: row.order_code, result: "ALREADY_RELEASED" });
                continue;
            }
            if (!APPLY) {
                results.push({ shopifyOrder: `#${row.shopify_order_number}`, wmsOrder: row.order_code, result: "READY_TO_RELEASE" });
                continue;
            }
            await db.query("begin");
            await db.query("set local lock_timeout='5s'");
            await db.query("set local statement_timeout='30s'");
            try {
                const locked = (await db.query(
                    `select status from portal_orders
                     where id=$1 and account_name=$2 and fulfillment_location_id=1 for update`,
                    [row.id, ACCOUNT]
                )).rows[0];
                if (locked?.status === "RELEASED") {
                    await db.query("rollback");
                    results.push({ shopifyOrder: `#${row.shopify_order_number}`, wmsOrder: row.order_code, result: "ALREADY_RELEASED" });
                    continue;
                }
                assert.equal(locked?.status, "DRAFT", `${row.order_code} changed before release.`);
                const released = await releasePortalOrderForAccount(db, ACCOUNT, row.id, {
                    rushExempt: true,
                    rushExemptNote: "Normal Shopify import release after verified stock receipt.",
                    activityActor: "Owner requested Rancher's Shopify order reconciliation",
                    activityTitlePrefix: "Shopify stock-backed"
                });
                assert.equal(released.status, "RELEASED");
                const allocation = (await db.query(
                    `select count(*)::int as line_count,
                            count(*) filter (where allocated=requested_quantity)::int as fully_allocated_count
                     from (
                         select l.id, l.requested_quantity,
                                coalesce(sum(a.allocated_quantity),0)::int as allocated
                         from portal_order_lines l
                         left join portal_order_allocations a on a.order_line_id=l.id
                         where l.order_id=$1
                         group by l.id, l.requested_quantity
                     ) lines`,
                    [row.id]
                )).rows[0];
                assert.equal(allocation.line_count, allocation.fully_allocated_count, `${row.order_code} is not fully allocated.`);
                await db.query("commit");
                results.push({ shopifyOrder: `#${row.shopify_order_number}`, wmsOrder: row.order_code, result: "RELEASED" });
            } catch (error) {
                await db.query("rollback").catch(() => {});
                throw error;
            }
        }

        console.log(JSON.stringify({
            ok: true,
            mode: APPLY ? "APPLY" : "READ_ONLY",
            account: ACCOUNT,
            warehouse: "GW3PL-MISS",
            emailsSent: 0,
            shopifyWrites: 0,
            results
        }, null, 2));
    } finally {
        await db.end();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
