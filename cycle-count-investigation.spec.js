const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("recounts preserve the original count and increment the attempt", () => {
    assert.match(source, /\/api\/inventory-counts\/:id\/recount/);
    assert.match(source, /async function createInventoryCountRecount/);
    assert.match(source, /where id = \$1 or recount_of_id = \$1/);
    assert.match(source, /recountOfId: countId/);
    assert.match(source, /attemptNumber: \(Number\(latestAttempt/);
});

test("approved count posting can atomically move stock to investigation", () => {
    assert.match(source, /moveToInvestigation/);
    assert.match(source, /inventory-count-investigation-\$\{countId\}/);
    assert.match(source, /await moveInventoryToInvestigationHold\(client/);
    assert.match(source, /evidence=coalesce\(evidence, '\{\}'::jsonb\) \|\| \$4::jsonb/);
});

