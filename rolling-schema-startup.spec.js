"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    DATABASE_SCHEMA_REQUIRED_COLUMNS,
    DATABASE_SCHEMA_REQUIRED_TABLES,
    DATABASE_SCHEMA_VERSION,
    applyPendingAdditiveMigrations,
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
            if (response instanceof Error) throw response;
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

test("fresh database tolerates a missing schema marker table and falls through to migration", async () => {
    const missingMarkerTable = new Error('relation "wms365_schema_versions" does not exist');
    missingMarkerTable.code = "42P01";
    const pool = fakePool([
        { rows: [{ ready: true }] },
        missingMarkerTable,
        { rows: [{ tables_ready: false, columns_ready: false }] }
    ]);
    assert.equal(await databaseSchemaContractIsCurrent(pool), false);
    assert.equal(pool.calls.some((call) => /information_schema\.columns/i.test(call.sql)), true);
});

test("schema version recording is idempotent and isolated to migration metadata", async () => {
    const pool = fakePool([{ rows: [] }, { rows: [] }]);
    await recordDatabaseSchemaVersion(pool);
    assert.match(pool.calls[0].sql, /create table if not exists wms365_schema_versions/i);
    assert.match(pool.calls[1].sql, /on conflict \(version\) do nothing/i);
    assert.deepEqual(pool.calls[1].params, [DATABASE_SCHEMA_VERSION]);
});

test("rolling startup applies only missing objects and is read-only on repeat", async () => {
    const ready = { rows: [{ ready: true }] };
    const installed = [
        ...["customer_portal_visible", "portal_inventory_rollup_location_id", "default_receiving_bin", "default_pickable_bin"]
            .map((column_name) => ({ name: "company_fulfillment_locations", column_name })),
        ...["planned_carrier_name", "planned_service_level"].map((column_name) => ({ name: "portal_orders", column_name })),
        ...["item_kit_components", "idx_item_kit_components_parent", "idx_item_kit_components_component"].map((name) => ({ name }))
    ];
    const pool = fakePool([ready, ready, { rows: [...installed, { name: "portal_inbounds", column_name: "id" }] }, { rows: [] }]);
    assert.equal(await applyPendingAdditiveMigrations(pool), true);
    assert.equal(pool.calls.length, 4);
    assert.match(pool.calls[3].sql, /^alter table portal_inbounds add column if not exists receiving_draft jsonb$/i);
    const current = fakePool([ready, ready, { rows: [...installed, { name: "portal_inbounds", column_name: "receiving_draft" }] }]);
    assert.equal(await applyPendingAdditiveMigrations(current), true);
    assert.equal(current.calls.length, 3);
    assert.ok(current.calls.every((call) => /^\s*select\b/i.test(call.sql)));
});

test("additive fulfillment migration defers fresh databases to the full initializer", async () => {
    const pool = fakePool([{ rows: [{ ready: false }] }, { rows: [{ ready: false }] }]);
    assert.equal(await applyPendingAdditiveMigrations(pool), false);
    assert.equal(pool.calls.length, 2);
    assert.equal(pool.calls.some((call) => /alter table/i.test(call.sql)), false);
});
