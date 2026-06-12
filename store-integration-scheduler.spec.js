const test = require("node:test");
const assert = require("node:assert/strict");

const {
    STORE_INTEGRATION_SCHEDULE_TIME_ZONE,
    computeNextStoreIntegrationSyncAt
} = require("./server");

test("daily store integration sync runs at 9 AM in the WMS365 business timezone during daylight saving time", () => {
    assert.equal(STORE_INTEGRATION_SCHEDULE_TIME_ZONE, "America/New_York");
    assert.equal(
        computeNextStoreIntegrationSyncAt("DAILY_0900", { now: new Date("2026-06-12T12:30:00.000Z") }),
        "2026-06-12T13:00:00.000Z"
    );
});

test("daily store integration sync rolls to the next business day after the local run time passes", () => {
    assert.equal(
        computeNextStoreIntegrationSyncAt("DAILY_0900", { now: new Date("2026-06-12T13:05:00.000Z") }),
        "2026-06-13T13:00:00.000Z"
    );
});

test("daily store integration sync respects standard time offset", () => {
    assert.equal(
        computeNextStoreIntegrationSyncAt("DAILY_0900", { now: new Date("2026-01-10T13:30:00.000Z") }),
        "2026-01-10T14:00:00.000Z"
    );
});
