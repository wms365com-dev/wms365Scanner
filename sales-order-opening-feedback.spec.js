"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const warehouse = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("successful sales-order opens clear the matching transient list message", () => {
    assert.match(warehouse, /const openingMessage = `Opening sales order \$\{orderLabel\}\.\.\.`/);
    assert.match(warehouse, /showSalesOrderDocument\(order, \{ scroll \}\);[\s\S]*?clearMessageIfCurrent\(messageElement, openingMessage\)/);
    assert.match(warehouse, /progressMessage: openingMessage/);
});

test("superseded navigation clears its own opening message without reopening stale detail", () => {
    assert.match(warehouse, /if \(requestSerial !== salesOrderOpenRequestSerial\) \{[\s\S]*?clearMessageIfCurrent\(messageElement, openingMessage\);[\s\S]*?return null/);
});

test("message cleanup is conditional and cannot erase a newer error or confirmation", () => {
    assert.match(warehouse, /function clearMessageIfCurrent\(element, expectedText\)/);
    assert.match(warehouse, /if \(!element \|\| element\.textContent !== expectedText\) return false/);
    assert.match(warehouse, /element\.removeAttribute\("aria-live"\)/);
    assert.doesNotMatch(warehouse, /clearMessageIfCurrent\(messageElement\s*\)/);
});

