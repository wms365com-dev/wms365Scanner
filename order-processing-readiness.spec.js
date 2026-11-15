"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("active processing windows use an explicit server-derived label", () => {
    assert.match(source, /function formatPortalOrderProcessingLabel\(order = \{\}\)/);
    assert.match(source, /formatPortalOrderReadyLabel\(order\)[\s\S]*return `Processing until \$\{readyText\}`/);
    assert.doesNotMatch(source, />Not ready<\/span>/);
});

test("allocation completeness is distinct from processing readiness", () => {
    assert.match(source, /function portalOrderIsFullyAllocated\(order = \{\}\)/);
    assert.match(source, /allocatedQuantity\) \|\| 0\) >= ordered/);
    assert.match(source, /<span class="pill success">Fully allocated<\/span>/);
    assert.match(source, /fullyAllocated \? "Fully allocated"/);
});

test("terminal and draft records suppress processing and allocation workflow badges", () => {
    assert.match(source, /!\["DRAFT", "CANCELLED", "ARCHIVED", "SHIPPED"\]\.includes\(norm\(order\.status\)\)[\s\S]*portalOrderIsNotYetReady/);
    assert.match(source, /if \(\["DRAFT", "CANCELLED", "ARCHIVED", "SHIPPED"\]\.includes\(norm\(order\.status\)\)\) return false/);
});
