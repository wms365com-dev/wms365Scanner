const test = require("node:test");
const assert = require("node:assert/strict");

const { getPortalKittingCompletionCopyRecipients } = require("./server.js");

test("Healtea kitting completion privately copies Landrey without cross-company exposure", () => {
    assert.deepEqual(
        getPortalKittingCompletionCopyRecipients({ accountName: "HEALTEA", status: "COMPLETED" }),
        ["landry@drinkhealtea.com"]
    );
    assert.deepEqual(
        getPortalKittingCompletionCopyRecipients({ accountName: "HEALTEA", status: "IN_PROGRESS" }),
        []
    );
    assert.deepEqual(
        getPortalKittingCompletionCopyRecipients({ accountName: "ANOTHER CUSTOMER", status: "COMPLETED" }),
        []
    );
});
