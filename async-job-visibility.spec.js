const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const portal = fs.readFileSync(path.join(__dirname, "portal.html"), "utf8");
const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("customer import jobs are company scoped and visible in the portal", () => {
    assert.match(server, /\/api\/portal\/jobs/);
    assert.match(server, /where account_name = \$1 order by created_at desc/);
    assert.match(portal, /data-view="jobs"/);
    assert.match(portal, /function renderJobs/);
    assert.match(portal, /\/api\/portal\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/errors\.csv/);
});

test("warehouse import jobs respect assigned company access", () => {
    assert.match(server, /\/api\/admin\/async-jobs/);
    assert.match(server, /getAccessibleCompanyNamesForAppUser\(pool, req\.appUser\)/);
    assert.match(server, /account_name = any/);
    assert.match(warehouse, /function loadAsyncJobs/);
    assert.match(warehouse, /\/api\/admin\/async-jobs/);
});

