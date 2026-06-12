const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureReceivingDestinationLocation } = require("./server");

function createRecordingClient() {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            calls.push({ sql: String(sql), params });
            return { rows: [], rowCount: 0 };
        }
    };
}

test("receiving directly into BULK keeps the location pickable storage", async () => {
    const client = createRecordingClient();
    await ensureReceivingDestinationLocation(client, "BULK");

    const updateCall = client.calls.find((call) => /update bin_locations/i.test(call.sql));
    assert.ok(updateCall, "expected bin location update");
    assert.equal(updateCall.params[0], "BULK");
    assert.match(updateCall.sql, /then 'STORAGE'/);
    assert.match(updateCall.sql, /then true/);
    assert.doesNotMatch(updateCall.sql, /set\s+location_type\s*=\s*'RECEIVING_STAGE'/i);
});

test("receiving into default receiving stage remains non-pickable", async () => {
    const client = createRecordingClient();
    await ensureReceivingDestinationLocation(client, "RECEIVING-STAGE");

    const updateCall = client.calls.find((call) => /update bin_locations/i.test(call.sql));
    assert.ok(updateCall, "expected bin location update");
    assert.equal(updateCall.params[0], "RECEIVING-STAGE");
    assert.match(updateCall.sql, /location_type = 'RECEIVING_STAGE'/);
    assert.match(updateCall.sql, /is_pickable = false/);
});
