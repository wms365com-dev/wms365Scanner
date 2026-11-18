const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("manual pallet labels identify the company field", () => {
    assert.match(
        source,
        /<p class="pallet-label-vendor">Company: \$\{esc\(saved\.accountName\)\}<\/p>/
    );
});

test("inbound pallet labels identify the company field", () => {
    assert.match(
        source,
        /<p class="pallet-label-vendor">Company: \$\{esc\(inbound\.accountName \|\| ""\)\}<\/p>/
    );
});

test("pallet labels never render an unlabelled company value", () => {
    assert.doesNotMatch(source, /<p class="pallet-label-vendor">\$\{esc\((?:saved|inbound)\.accountName/);
});
