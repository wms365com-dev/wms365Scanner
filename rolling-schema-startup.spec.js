"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    DATABASE_SCHEMA_REQUIRED_COLUMNS,
    DATABASE_SCHEMA_REQUIRED_TABLES,
    DATABASE_SCHEMA_VERSION,
    databaseSchemaContractIsCurrent,
    recordDatabaseSchemaVersion
} = require("./server");

function fakePool(responses) {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            calls.push({ sql: String(sql), params });
            const response = responses.shift();
            if (!response) throw new Error("Unexpected schema query.");
            return response;
        }
    };
}

test("current schema marker skips the legacy contract without business-table DDL", async () => {
    const pool = fakePool([
        { rows: [{ ready: true }] },
        { rows: [{ current: true }] }
    ]);
    assert.equal(await databaseSchemaContractIsCurrent(pool), true);
    assert.equal(pool.calls.length, 2);
    assert.equal(pool.calls.some((call) => /alter table/i.test(call.sql)), false);
    assert.deepEqual(pool.calls[1].params, [DATABASE_SCHEMA_VERSION]);
});

test("legacy current schema is detected read-only before the marker is created", async () => {
    const pool = fakePool([
        { rows: [{ ready: false }] },
        { rows: [{ tables_ready: true, columns_ready: true }] }
    ]);
    assert.equal(await databaseSchemaContractIsCurrent(pool), true);
    assert.equal(DATABASE_SCHEMA_REQUIRED_TABLES.length >= 25, true);
    assert.equal(DATABASE_SCHEMA_REQUIRED_COLUMNS.length >= 8, true);
    assert.equal(pool.calls.some((call) => /information_schema\.columns/i.test(call.sql)), true);
    assert.equal(pool.calls.some((call) => /alter table/i.test(call.sql)), false);
});

test("missing schema contract falls through to the serialized migration path", async () => {
    const pool = fakePool([
        { rows: [{ ready: false }] },
        { rows: [{ tables_ready: true, columns_ready: false }] }
    ]);
    assert.equal(await databaseSchemaContractIsCurrent(pool), false);
});

test("schema version recording is idempotent and isolated to migration metadata", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [] }]);
    await recordDatabaseSchemaVersion(pool);
    assert.match(pool.calls[0].sql, /create table if not exists wms365_schema_versions/i);
    assert.match(pool.calls[1].sql, /on conflict \(version\) do nothing/i);
    assert.deepEqual(pool.calls[1].params, [DATABASE_SCHEMA_VERSION]);
});
