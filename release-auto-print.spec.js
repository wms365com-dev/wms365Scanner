const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    parseReleaseAutoPrintAccounts,
    isReleaseAutoPrintEnabled,
    enqueueReleaseAutoPrint,
    getReleaseAutoPrintRetrySeconds
} = require("./release-auto-print");

test("the allowlist enables Wellforia and excludes Rancher's", () => {
    const accounts = parseReleaseAutoPrintAccounts("WELLFORIA HEALTH INC");
    assert.equal(isReleaseAutoPrintEnabled(accounts, "wellforia health inc"), true);
    assert.equal(isReleaseAutoPrintEnabled(accounts, "RANCHER'S CHIPS"), false);
});

test("attachments never enable printing for an unlisted account", async () => {
    const accounts = parseReleaseAutoPrintAccounts("WELLFORIA HEALTH INC");
    let writes = 0;
    const queued = await enqueueReleaseAutoPrint({ query: async () => { writes += 1; } }, {
        id: 101182,
        accountName: "RANCHER'S CHIPS",
        documents: [{ documentCategory: "SHIPPING_LABEL" }]
    }, accounts);
    assert.equal(queued, false);
    assert.equal(writes, 0);
});

test("eligible orders use a unique conflict-safe outbox insert", async () => {
    const accounts = parseReleaseAutoPrintAccounts("WELLFORIA HEALTH INC");
    let statement = "";
    let parameters = [];
    const queued = await enqueueReleaseAutoPrint({ query: async (sql, params) => {
        statement = sql;
        parameters = params;
        return { rowCount: 1, rows: [{ order_id: 101182 }] };
    } }, { id: 101182, accountName: "WELLFORIA HEALTH INC" }, accounts);
    assert.equal(queued, true);
    assert.match(statement, /on conflict \(order_id\) do nothing/i);
    assert.deepEqual(parameters, [101182, "WELLFORIA HEALTH INC"]);
});

test("retry delay is exponential and capped at thirty minutes", () => {
    assert.equal(getReleaseAutoPrintRetrySeconds(1), 30);
    assert.equal(getReleaseAutoPrintRetrySeconds(2), 60);
    assert.equal(getReleaseAutoPrintRetrySeconds(20), 1800);
});

test("server integration triggers only the generated pick ticket after email success", () => {
    const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const emailProcessor = source.slice(
        source.indexOf("async function processScheduledPortalOrderReleaseEmail"),
        source.indexOf("function ensurePortalOrderPickTicketEmailSchedulerStarted")
    );
    const sentAt = emailProcessor.indexOf("pick_ticket_email_status = 'SENT'");
    const enqueueAt = emailProcessor.indexOf("enqueuePortalOrderReleaseAutoPrint");
    assert.ok(sentAt >= 0 && enqueueAt > sentAt);
    assert.match(emailProcessor, /documentType:\s*PORTAL_ORDER_PRINT_DOCUMENT_TYPES\.PICK_TICKET/);
    assert.match(emailProcessor, /Uploaded attachments excluded/);
    assert.doesNotMatch(emailProcessor, /PORTAL_ORDER_DOCUMENT_CATEGORIES\.SHIPPING_LABEL/);
});
