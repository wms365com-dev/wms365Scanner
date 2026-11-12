const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildUserFacingError } = require("./server.js");

test("unexpected server errors hide technical details and include a support reference", () => {
    const result = buildUserFacingError(
        new Error("password authentication failed for database"),
        { path: "/api/portal/orders" },
        500
    );
    assert.doesNotMatch(result.message, /password|database/i);
    assert.match(result.message, /could not complete/i);
    assert.match(result.message, /support@wms365\.co/i);
    assert.ok(result.requestId);
});

test("business validation messages remain specific", () => {
    const result = buildUserFacingError(
        new Error("Attach at least one BOL or packing slip before submitting this inbound."),
        { path: "/api/portal/inbounds" },
        400
    );
    assert.equal(result.message, "Attach at least one BOL or packing slip before submitting this inbound.");
});

test("database conflicts are translated into recovery guidance", () => {
    const error = new Error("duplicate key value violates unique constraint");
    error.code = "23505";
    const result = buildUserFacingError(error, { path: "/api/app/items" }, 500);
    assert.equal(result.message, "This record already exists. Review the information and try again.");
});

test("all primary user surfaces include friendly request fallbacks", () => {
    for (const file of ["portal.html", "index.html", "mobile-pick.html", "mobile-count.html"]) {
        const source = fs.readFileSync(path.join(__dirname, file), "utf8");
        assert.match(source, /could not connect/i, file);
        assert.match(source, /try again/i, file);
        assert.doesNotMatch(source, /Request failed \(\$\{r\.status\}\)/, file);
    }
});
