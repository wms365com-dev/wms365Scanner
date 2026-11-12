"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { easternSlot } = require("./scheduler");

test("accepts each approved weekday Eastern slot", () => {
    for (const iso of [
        "2026-10-19T10:00:00Z", "2026-10-19T12:30:00Z", "2026-10-19T15:00:00Z",
        "2026-10-19T17:30:00Z", "2026-10-19T20:00:00Z"
    ]) assert.ok(easternSlot(new Date(iso)));
});

test("rejects unapproved times and weekends", () => {
    assert.equal(easternSlot(new Date("2026-10-19T20:30:00Z")), null);
    assert.equal(easternSlot(new Date("2026-10-18T15:00:00Z")), null);
});

test("stays Eastern-time aware after daylight saving time", () => {
    assert.equal(easternSlot(new Date("2026-11-02T11:00:00Z")), "2026-11-02T06:00");
    assert.equal(easternSlot(new Date("2026-11-02T10:00:00Z")), null);
});
